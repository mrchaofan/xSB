/**
 * The hub as an ACP v2 agent: what an editor, the CLI or the desktop app talks to.
 *
 * Standard ACP covers one client talking to one agent's sessions. A client
 * that knows nothing else gets exactly that, against the default agent: a
 * prompt is answered once it is inserted into the conversation, and the work
 * is reported by `state_update`, as with any ACP v2 agent. The extensions in
 * @xsb/protocol add the rest: choosing an agent, watching agents and tasks,
 * stopping tasks, editing roles, and reading the asset library and the
 * machine's backends.
 */
import fs from "node:fs";
import path from "node:path";
import { Agents, Assets, Backends, History, Boundaries, LANGUAGES, LanguageExt, OriginExt, PROTOCOL_VERSION, Roles, RpcError, Tasks, Teams, errorMessage, failure, isTerminal } from "@xsb/protocol";
import type { Connection, HistoryImage, McpServerCheck, OriginMeta, RoleDetail, PresetProblem, TeamInfo } from "@xsb/protocol";
import { backends, describeBackends, loadProjectConfig, projectLanguage, saveProjectConfig } from "./config.ts";
import type { Hub } from "./hub.ts";
import { isVeto } from "./hooks.ts";
import { USER } from "./kernel.ts";
import { mcpRequest } from "./mcp-client.ts";
import { Paths } from "./paths.ts";
import { describeRole, loadRole, roleNames, saveRole } from "./roles.ts";
import type { Role } from "./roles.ts";
import type { LiveSession } from "./session.ts";
import { catalog, check, clashes, derive, teamRole, teamRoleNames } from "./presets.ts";
import { copyTemplate, planSync, projectCatalog, snapshot, syncTemplate } from "./templates.ts";
import type { Catalog, TeamEntry } from "./presets.ts";
import { historyPage, historyImage } from "./history.ts";
import { VERSION } from "./util.ts";

/** One connected ACP client, as the hub sees it. */
export class Client {
  readonly conn: Connection;
  /** Opted in to hub-wide events and to permission requests of unattended sessions. */
  observer = false;
  /** Opted in to being sent its own input when it becomes part of a turn (see `OriginExt`). */
  echo = false;
  history = false;
  private hub: Hub;
  private attached = new Set<LiveSession>();

  constructor(hub: Hub, conn: Connection) {
    this.hub = hub;
    this.conn = conn;
    void conn.closed.then(() => {
      for (const session of this.attached) session.clients.delete(this);
    });

    conn.onRequest("initialize", (p) => {
      if (p?.protocolVersion < PROTOCOL_VERSION) throw new RpcError(-32022, `xsb speaks ACP v${PROTOCOL_VERSION}`, { supported: [PROTOCOL_VERSION] });
      const meta = p.capabilities?._meta;
      this.observer = meta?.[Agents.capability] != null;
      this.echo = meta?.[OriginExt.capability] != null;
      this.history = meta?.[History.capability] != null;
      // The project works in the language of the first user who says which one they read.
      const language = meta?.[LanguageExt.key];
      const config = loadProjectConfig(hub.paths);
      if (!config.language && LANGUAGES.includes(language)) saveProjectConfig(hub.paths, { ...config, language });
      if (this.observer) queueMicrotask(() => hub.permissions.route());
      return {
        protocolVersion: PROTOCOL_VERSION,
        info: { name: "xsb", title: "xsb hub", version: VERSION },
        capabilities: {
          // Images are taken for every agent; a backend that cannot read them is told one was there (backend.ts).
          session: { prompt: { image: {} }, mcp: { stdio: {} } },
          _meta: {
            [Agents.capability]: { version: 1 },
            [History.capability]: { version: 1 },
            [Roles.capability]: { version: 1 },
            [Teams.capability]: { version: 2 },
            [Backends.capability]: { version: 1 },
            [Tasks.capability]: { version: 1 },
            [Assets.capability]: { version: 1 },
            [OriginExt.capability]: { version: 1 },
          },
        },
        authMethods: [],
      };
    });
    conn.onRequest("authenticate", () => ({}));

    // ---- sessions (standard) ----------------------------------------------

    conn.onRequest("session/new", async (p) => {
      const agentId = p._meta?.[Agents.sessionKey] ?? hub.defaultAgent();
      if (!agentId) throw failure("no_agents");
      // An agent has one conversation: a new session of it is that one (Hub.mainSession). The agent works in its own
      // workspace; the client's cwd does not move it.
      const session = hub.mainSession(agentId, Array.isArray(p.mcpServers) ? p.mcpServers : []);
      await session.ensureBackend();
      this.attach(session);
      return { sessionId: session.id, ...setup(session), _meta: sessionMeta(session) };
    });

    // Resuming with `replayFrom` replays the transcript first, then says where the session's work stands.
    conn.onRequest("session/resume", (p) => {
      const session = hub.session(p.sessionId);
      if (p.replayFrom && p.replayFrom.type !== "start") throw RpcError.invalidParams(`unsupported replayFrom "${p.replayFrom.type}"`);
      if (p.replayFrom) {
        for (const { update } of hub.state.store.read(Paths.transcript(session.agentId, session.id))) {
          conn.notify("session/update", { sessionId: session.id, update });
        }
      }
      conn.notify("session/update", { sessionId: session.id, update: { sessionUpdate: "state_update", state: session.current ? "running" : "idle" } });
      this.attach(session);
      return { ...setup(session), _meta: sessionMeta(session) };
    });

    conn.onRequest(History.page, (p) => {
      const session = hub.session(p.sessionId);
      if (p.before !== undefined && (!Number.isSafeInteger(p.before) || p.before < 0)) throw RpcError.invalidParams("invalid history cursor");
      const page = historyPage(hub.state.store, session.agentId, session.id, p.before);
      if (p.before === undefined) this.attach(session);
      return { ...page, state: session.busy ? "running" : "idle", agent: hub.agentInfo(hub.agent(session.agentId)) };
    });
    conn.onRequest(History.image, (p: HistoryImage) => {
      const session = hub.session(p.sessionId);
      if (!this.attached.has(session)) throw RpcError.notFound("unattached session");
      return historyImage(hub.state.store, session.agentId, p);
    });

    conn.onRequest("session/list", (p) => {
      const agentId = p._meta?.[Agents.sessionKey];
      const sessions = [...hub.live.values()]
        .filter((s) => hub.state.agents.has(s.agentId) && (!agentId || s.agentId === agentId))
        .map((s) => ({
          sessionId: s.id,
          cwd: hub.agent(s.agentId).workspace,
          title: s.rec.title ?? s.agentId,
          updatedAt: s.rec.updatedAt,
          _meta: sessionMeta(s),
        }));
      return { sessions };
    });

    conn.onRequest("session/close", (p) => {
      const session = hub.session(p.sessionId);
      // Closing detaches this client. The session belongs to the agent and lives on.
      session.clients.delete(this);
      this.attached.delete(session);
      return {};
    });

    conn.onRequest("session/prompt", (p) => {
      const session = this.own(p.sessionId);
      if (!Array.isArray(p.prompt)) throw RpcError.invalidParams("prompt must be an array of content blocks");
      if (!p.prompt.length) throw RpcError.invalidParams("prompt must not be empty");
      // Answered once it is in the conversation; the user's word never waits behind work (kernel.ts, `deliveryPolicy`).
      return hub.delivery.fromUser(session, p.prompt, userOrigin(p), this);
    });

    // The user's stop: the session's work, and the tasks it works on (delivery.ts, `userStop`).
    conn.onNotification("session/cancel", (p) => {
      const session = hub.live.get(p?.sessionId);
      if (session) hub.delivery.userStop(session);
    });

    conn.onRequest(Boundaries.clear, (p) => {
      hub.session(p.sessionId).clear();
      return {};
    });

    conn.onRequest("session/set_config_option", async (p) => {
      const session = this.own(p.sessionId);
      const backend = await session.ensureBackend();
      return backend.conn.request("session/set_config_option", { ...p, sessionId: session.rec.backendSessionId });
    });

    // ---- agents ------------------------------------------------------------

    conn.onRequest(Agents.list, () => ({
      agents: [...hub.state.agents.values()].map((a) => hub.agentInfo(a)),
    }));
    conn.onRequest(Agents.put, (p) => {
      if (!p.agent?.id) throw RpcError.invalidParams("agent.id is required");
      return { agent: hub.putAgent(p.agent, p.instructions) };
    });
    conn.onRequest(Agents.get, (p) => {
      const agent = hub.agent(p.id);
      return { agent: hub.agentInfo(agent), instructions: hub.instructions(agent.id), systemPrompt: hub.systemPromptFor(agent) };
    });
    conn.onRequest(Agents.remove, (p) => {
      hub.removeAgent(p.id);
      return {};
    });
    conn.onRequest(Agents.restart, (p) => {
      hub.backends.stop(hub.agent(p.id).id);
      return {};
    });

    // ---- roles ------------------------------------------------------------

    const roleDetail = (role: Role): RoleDetail => ({
      ...describeRole(role),
      agents: [...hub.state.agents.values()].filter((a) => a.role === role.name).map((a) => a.id),
    });
    /** Tell the observers what became of these roles: as they are now, or gone. */
    const announceRoles = (names: string[]): void => {
      const now = roleNames(hub.paths);
      for (const name of new Set(names)) {
        if (now.includes(name)) hub.broadcast(Roles.update, { role: roleDetail(loadRole(hub.paths, name)) });
        else hub.broadcast(Roles.removed, { name });
      }
    };
    conn.onRequest(Roles.list, () => ({ roles: roleNames(hub.paths).map((name) => roleDetail(loadRole(hub.paths, name))) }));
    conn.onRequest(Roles.get, (p) => ({ role: roleDetail(loadRole(hub.paths, p.name)) }));
    conn.onRequest(Roles.put, (p) => {
      const known = Object.keys(backends());
      if (p.role?.backend && !known.includes(p.role.backend)) {
        throw failure("no_such_backend", { backend: p.role.backend, known });
      }
      saveRole(hub.paths, p.role ?? {});
      const role = roleDetail(loadRole(hub.paths, p.role.name));
      hub.broadcast(Roles.update, { role });
      return { role };
    });
    conn.onRequest(Roles.remove, (p) => {
      const role = roleDetail(loadRole(hub.paths, p.name));
      if (role.preset && !role.preset.own) {
        throw failure("role_of_team", { role: role.name, team: role.preset.team });
      }
      if (!role.preset && role.agents.length) throw failure("role_in_use", { role: role.name, agents: role.agents });
      fs.rmSync(hub.paths.roleDir(role.name), { recursive: true });
      announceRoles([role.name]);
      return {};
    });
    conn.onRequest(Roles.check, async (p) => {
      const role = loadRole(hub.paths, p.name);
      const servers = role.mcpServers.filter((s) => !p.server || s.name === p.server);
      if (p.server && !servers.length) throw failure("role_no_server", { role: role.name, server: p.server });
      const check = (server: (typeof servers)[number]): Promise<McpServerCheck> =>
        mcpRequest(server, "tools/list", {}, role.dir, AbortSignal.timeout(15_000)).then(
          (r) => ({ server: server.name, tools: (r.tools ?? []).map((t: any) => ({ name: t.name, description: t.description })) }),
          (e) => ({ server: server.name, error: errorMessage(e) }),
        );
      return { servers: await Promise.all(servers.map(check)) };
    });
    // ---- teams ------------------------------------------------------------

    const team = (id: string): TeamEntry => {
      const cat = projectCatalog(hub.paths);
      const found = snapshot(hub.paths, id) ?? cat.teams.get(id);
      if (!found) throw failure("team_unknown", { team: id, known: [...cat.teams.keys()] });
      return found;
    };
    /** Change which teams the project uses, unless that leaves an agent without its role or two teams clash. */
    const setTeams = (used: string[], changed: string): void => {
      const clash = clashes(projectCatalog(hub.paths, undefined, used), used).find((c) => c.teams.includes(changed));
      if (clash) throw failure("team_clash", { team: changed, other: clash.teams.find((t) => t !== changed), role: clash.role });
      const left = roleNames(hub.paths, used);
      const stranded = [...hub.state.agents.values()].filter((a) => a.role && !left.includes(a.role)).map((a) => a.id);
      if (stranded.length) throw failure("team_in_use", { team: changed, agents: stranded });
      saveProjectConfig(hub.paths, { ...loadProjectConfig(hub.paths), teams: used });
      announceRoles(teamRoleNames(projectCatalog(hub.paths), changed));
    };
    /** A team as a client is told of it: its roles as they apply, what is wrong with it, what it starts. */
    const teamInfo = (cat: Catalog, entry: TeamEntry, used: string[]): TeamInfo => {
      const roles = entry.roles.flatMap((r) => {
        try {
          const role = teamRole(cat, entry.id, r.role);
          return role ? [{ name: r.name, role: describeRole(role), requires: r.requires ?? [] }] : [];
        } catch {
          return []; // said among its problems
        }
      });
      const source = catalog(projectLanguage(hub.paths)).teams.get(entry.id);
      const own = cat.problems.filter((p) => p.team === entry.id && p.source === entry.source);
      return {
        id: entry.id,
        snapshot: entry.snapshot,
        sourceDir: source?.source === entry.source ? source.dir : undefined,
        syncAvailable: source?.source === entry.source,
        source: entry.source,
        ...(entry.extends ? { extends: entry.extends } : {}),
        dir: entry.dir,
        language: entry.language,
        problems: [...own, ...check(cat, entry.id)].map(({ source, ...p }) => p),
        programs: [...new Set(roles.flatMap((r) => Object.values(r.role.mcpServers).map((s) => s.command)))],
        title: entry.title,
        description: entry.description,
        assets: entry.assets,
        used: used.includes(entry.id),
        roles,
      };
    };
    conn.onRequest(Teams.list, (): { teams: TeamInfo[]; problems: PresetProblem[] } => {
      const used = loadProjectConfig(hub.paths).teams ?? [];
      const cat = projectCatalog(hub.paths);
      return {
        teams: [...cat.teams.values()].map((entry) => teamInfo(cat, entry, used)),
        // What belongs to no team in the list: a team left out, or one of the user's that is not the one listed.
        problems: cat.problems.filter((p) => !p.team || cat.teams.get(p.team)?.source !== p.source).map(({ source, ...p }) => p),
      };
    });
    conn.onRequest(Teams.derive, (p) => {
      const language = projectLanguage(hub.paths);
      const made = derive(catalog(language), String(p?.id ?? ""), String(p?.base ?? ""), language);
      const cat = catalog(language);
      return { team: teamInfo(cat, cat.teams.get(made.id) ?? made, loadProjectConfig(hub.paths).teams ?? []) };
    });
    conn.onRequest(Teams.use, (p) => {
      const used = loadProjectConfig(hub.paths).teams ?? [];
      const entry = team(p.id);
      if (!used.includes(entry.id)) {
        // Validate conflicts before any copying; first use never discards a project's own roles.
        const clash = clashes(projectCatalog(hub.paths, undefined, [...used, entry.id]), [...used, entry.id]).find((c) => c.teams.includes(entry.id));
        if (clash) throw failure("team_clash", { team: entry.id, other: clash.teams.find((t) => t !== entry.id), role: clash.role });
        copyTemplate(hub.paths, catalog(projectLanguage(hub.paths)), entry.id);
        setTeams([...used, entry.id], entry.id);
      } else if (!snapshot(hub.paths, entry.id)) copyTemplate(hub.paths, catalog(projectLanguage(hub.paths)), entry.id);
      return {};
    });
    conn.onRequest(Teams.syncPreview, (p) => planSync(hub.paths, String(p?.id ?? "")));
    conn.onRequest(Teams.sync, (p) => {
      const id = String(p?.id ?? "");
      const plan = planSync(hub.paths, id);
      const stranded = [...hub.state.agents.values()].filter((a) => a.role && plan.removed.includes(a.role) && !fs.existsSync(hub.paths.roleDir(a.role))).map((a) => a.id);
      if (stranded.length) throw failure("team_in_use", { team: id, agents: stranded });
      // Existing sessions keep their running backend until the user applies/restarts the role.
      const result = syncTemplate(hub.paths, id, p?.revision, p?.confirm);
      announceRoles([...result.roles, ...result.removed]);
      return result;
    });
    conn.onRequest(Teams.drop, (p) => {
      const used = loadProjectConfig(hub.paths).teams ?? [];
      if (used.includes(team(p.id).id)) setTeams(used.filter((id) => id !== p.id), p.id);
      return {};
    });

    // ---- backends, assets and tasks ---------------------------------------

    conn.onRequest(Backends.list, () => ({ backends: describeBackends() }));
    conn.onRequest(Assets.list, (p) => ({ assets: hub.assets.find(p.type) }));
    conn.onRequest(Tasks.list, (p) => ({
      tasks: [...hub.state.tasks.values()].filter(
        (t) =>
          (!p.agentId || t.from?.agentId === p.agentId || t.to.agentId === p.agentId) &&
          (!p.status || t.status === p.status),
      ),
    }));
    // Only a client reaches this, on the user's word: the user may stop any task.
    conn.onRequest(Tasks.cancel, (p) => {
      const task = hub.state.tasks.get(p?.taskId);
      if (!task) throw RpcError.notFound(`task ${p?.taskId}`);
      if (isTerminal(task.status)) return { task, with: [] };
      const stopped = hub.kernel.stop(task, USER, { status: "cancelled", reason: "cancelled", result: "Cancelled by the user." });
      if (isVeto(stopped)) throw RpcError.invalidParams(stopped.veto);
      return { task: hub.state.tasks.get(task.id), with: stopped.with };
    });
  }

  private attach(session: LiveSession): void {
    session.clients.add(this);
    this.attached.add(session);
    this.hub.permissions.route();
  }

  /** A session this client may drive. Attaching is implicit: the hub is local and single-user. */
  private own(sessionId: string): LiveSession {
    const session = this.hub.session(sessionId);
    if (!this.attached.has(session)) this.attach(session);
    return session;
  }
}

/** Input from a client is the user's; the client may name the message to recognise it when it is echoed. */
function userOrigin(params: any): OriginMeta {
  const messageId = params._meta?.[OriginExt.key]?.messageId;
  return { kind: "user", ...(typeof messageId === "string" ? { messageId } : {}) };
}

function setup(session: LiveSession): Record<string, unknown> {
  const { configOptions, availableCommands } = session.setup;
  return { ...(configOptions ? { configOptions } : {}), ...(availableCommands ? { availableCommands } : {}) };
}

function sessionMeta(session: LiveSession): Record<string, unknown> {
  return { [Agents.sessionKey]: session.agentId, [Agents.mainKey]: session.rec.main };
}
