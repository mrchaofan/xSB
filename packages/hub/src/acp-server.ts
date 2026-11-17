/**
 * The hub as an ACP agent: what an editor or the CLI talks to.
 *
 * Standard ACP v1 covers one client talking to one agent's sessions. A client
 * that knows nothing else gets exactly that, against the default agent. The
 * extensions in @xsb/protocol add the rest: choosing an agent, steering, and
 * watching agents and tasks, editing roles, and reading the asset library and
 * the machine's backends.
 */
import fs from "node:fs";
import path from "node:path";
import { Agents, Assets, Backends, Boundaries, LANGUAGES, LanguageExt, OriginExt, PROTOCOL_VERSION, Roles, RpcError, SpendExt, Steering, Tasks, Teams, errorMessage, failure, textOf } from "@xsb/protocol";
import type { Connection, McpServerCheck, OriginMeta, RoleDetail, PresetProblem, TeamInfo } from "@xsb/protocol";
import { backends, describeBackends, loadProjectConfig, projectLanguage, saveProjectConfig } from "./config.ts";
import type { Hub } from "./hub.ts";
import { mcpRequest } from "./mcp-client.ts";
import { Paths } from "./paths.ts";
import { describeRole, loadRole, roleNames, saveRole } from "./roles.ts";
import type { Role } from "./roles.ts";
import type { LiveSession } from "./session.ts";
import { catalog, check, clashes, derive, teamRole, teamRoleNames } from "./presets.ts";
import type { Catalog, TeamEntry } from "./presets.ts";
import { VERSION } from "./util.ts";

/** One connected ACP client, as the hub sees it. */
export class Client {
  readonly conn: Connection;
  /** Opted in to hub-wide events and to permission requests of unattended sessions. */
  observer = false;
  /** Opted in to being sent its own input when it becomes part of a turn (see `OriginExt`). */
  echo = false;
  private hub: Hub;
  private attached = new Set<LiveSession>();

  constructor(hub: Hub, conn: Connection) {
    this.hub = hub;
    this.conn = conn;
    void conn.closed.then(() => {
      for (const session of this.attached) session.clients.delete(this);
    });

    conn.onRequest("initialize", (p) => {
      this.observer = p.clientCapabilities?._meta?.[Agents.capability] != null;
      this.echo = p.clientCapabilities?._meta?.[OriginExt.capability] != null;
      // The project works in the language of the first user who says which one they read.
      const language = p.clientCapabilities?._meta?.[LanguageExt.key];
      const config = loadProjectConfig(hub.paths);
      if (!config.language && LANGUAGES.includes(language)) saveProjectConfig(hub.paths, { ...config, language });
      if (this.observer) queueMicrotask(() => hub.permissions.route());
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: "xsb", title: "xsb hub", version: VERSION },
        agentCapabilities: {
          loadSession: true,
          // Images are taken for every agent; a backend that cannot read them is told one was there (backend.ts).
          promptCapabilities: { image: true, audio: false, embeddedContext: false },
          mcpCapabilities: { http: false, sse: false },
          sessionCapabilities: { list: {}, resume: {}, close: {} },
          _meta: {
            [Agents.capability]: { version: 1 },
            [Roles.capability]: { version: 1 },
            [Teams.capability]: { version: 1 },
            [Backends.capability]: { version: 1 },
            [Tasks.capability]: { version: 1 },
            [Assets.capability]: { version: 1 },
            [SpendExt.capability]: { version: 1 },
            [OriginExt.capability]: { version: 1 },
          },
        },
        authMethods: [],
        _meta: { [Steering.metaKey]: { supported: true } },
      };
    });
    conn.onRequest("authenticate", () => ({}));

    // ---- sessions (standard) ----------------------------------------------

    conn.onRequest("session/new", async (p) => {
      const agentId = p._meta?.[Agents.sessionKey] ?? hub.defaultAgent();
      if (!agentId) throw failure("no_agents");
      // The agent works in its own workspace; the client's cwd does not move it.
      const session = hub.createSession(agentId, Array.isArray(p.mcpServers) ? p.mcpServers : []);
      await session.ensureBackend();
      this.attach(session);
      return { sessionId: session.id, ...setup(session), _meta: sessionMeta(session) };
    });

    conn.onRequest("session/load", (p) => {
      const session = hub.session(p.sessionId);
      for (const { update } of hub.state.store.read(Paths.transcript(session.agentId, session.id))) {
        conn.notify("session/update", { sessionId: session.id, update });
      }
      this.attach(session);
      return { ...setup(session), _meta: sessionMeta(session) };
    });

    conn.onRequest("session/resume", (p) => {
      const session = hub.session(p.sessionId);
      this.attach(session);
      return { ...setup(session), _meta: sessionMeta(session) };
    });

    conn.onRequest("session/list", (p) => {
      const agentId = p._meta?.[Agents.sessionKey];
      const sessions = [...hub.live.values()]
        .filter((s) => hub.state.agents.has(s.agentId) && (!agentId || s.agentId === agentId))
        .map((s) => ({
          sessionId: s.id,
          cwd: hub.agent(s.agentId).workspace,
          title: s.rec.title ?? `${s.agentId}${s.rec.main ? " (main)" : ""}`,
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
      hub.mail.userWrote(session.agentId, textOf(p.prompt));
      return session.enqueue({ origin: userOrigin(p), prompt: p.prompt, from: this });
    });

    conn.onNotification("session/cancel", (p) => hub.live.get(p?.sessionId)?.cancel());

    // ---- spending ---------------------------------------------------------

    conn.onRequest(SpendExt.get, () => ({ spend: hub.spending.read() }));
    // Only a client reaches this, on the user's word: agents have no tool for it.
    conn.onRequest(SpendExt.budget, (p) => {
      const amount = Number(p?.amount);
      if (!Number.isFinite(amount) || amount < 0) throw RpcError.invalidParams("amount must be a number of yuan, 0 or more");
      return { spend: hub.spending.setBudget(amount) };
    });

    conn.onRequest(Boundaries.clear, (p) => {
      hub.session(p.sessionId).clear();
      return {};
    });

    for (const method of ["session/set_mode", "session/set_config_option"]) {
      conn.onRequest(method, async (p) => {
        const session = this.own(p.sessionId);
        const backend = await session.ensureBackend();
        return backend.conn.request(method, { ...p, sessionId: session.rec.backendSessionId });
      });
    }

    // ---- steering ---------------------------------------------------------

    conn.onRequest(Steering.method, (p) => {
      const session = this.own(p.sessionId);
      if (!Array.isArray(p.prompt) || p.prompt.length === 0) {
        throw RpcError.invalidParams("steer params require a non-empty prompt array");
      }
      const idle = p._meta?.[Steering.metaKey]?.idleBehavior;
      if (idle !== undefined && idle !== "promptRequired") throw RpcError.invalidParams("unsupported steering idleBehavior");
      hub.mail.userWrote(session.agentId, textOf(p.prompt));
      return session.steer(p.prompt, userOrigin(p), idle === "promptRequired" ? "promptRequired" : "start", this);
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
      const cat = catalog(projectLanguage(hub.paths));
      const found = cat.teams.get(id);
      if (!found) throw failure("team_unknown", { team: id, known: [...cat.teams.keys()] });
      return found;
    };
    /** Change which teams the project uses, unless that leaves an agent without its role or two teams clash. */
    const setTeams = (used: string[], changed: string): void => {
      const clash = clashes(catalog(projectLanguage(hub.paths)), used).find((c) => c.teams.includes(changed));
      if (clash) throw failure("team_clash", { team: changed, other: clash.teams.find((t) => t !== changed), role: clash.role });
      const left = roleNames(hub.paths, used);
      const stranded = [...hub.state.agents.values()].filter((a) => a.role && !left.includes(a.role)).map((a) => a.id);
      if (stranded.length) throw failure("team_in_use", { team: changed, agents: stranded });
      saveProjectConfig(hub.paths, { ...loadProjectConfig(hub.paths), teams: used });
      announceRoles(teamRoleNames(catalog(projectLanguage(hub.paths)), changed));
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
      const own = cat.problems.filter((p) => p.team === entry.id && p.source === entry.source);
      return {
        id: entry.id,
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
      const cat = catalog(projectLanguage(hub.paths));
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
      if (!used.includes(team(p.id).id)) setTeams([...used, p.id], p.id);
      return {};
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
          (!p.agentId || t.from.agentId === p.agentId || t.to.agentId === p.agentId) &&
          (!p.status || t.status === p.status),
      ),
    }));
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
  const { modes, configOptions } = session.setup;
  return { ...(modes ? { modes } : {}), ...(configOptions ? { configOptions } : {}) };
}

function sessionMeta(session: LiveSession): Record<string, unknown> {
  return { [Agents.sessionKey]: session.agentId, [Agents.mainKey]: session.rec.main };
}
