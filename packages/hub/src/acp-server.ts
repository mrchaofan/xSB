/**
 * The hub as an ACP v2 agent: what an editor, the CLI or the desktop app talks to.
 *
 * Each new ACP session starts an independent main conversation. Extensions expose
 * its workflow, active task conversations, workspace assets and installed backends.
 */
import { SessionControls, ToolServers, Workflow, Agents, Assets, Backends, History, Boundaries, LANGUAGES, LanguageExt, OriginExt, PROTOCOL_VERSION, RpcError, Tasks } from "@xsb/protocol";
import type { Connection, HistoryImage, OriginMeta } from "@xsb/protocol";
import { describeBackends, loadProjectConfig, saveProjectConfig } from "./config.ts";
import type { Hub } from "./hub.ts";
import { isVeto } from "./hooks.ts";
import { USER } from "./kernel.ts";
import { Paths } from "./paths.ts";
import { ops } from "./state.ts";
import type { LiveSession } from "./session.ts";
import { historyPage, historyImage } from "./history.ts";
import { newId, VERSION } from "./util.ts";

/** One connected ACP client, as the hub sees it. */
export class Client {
  readonly conn: Connection;
  /** Opted in to hub-wide events and to permission requests of unattended sessions. */
  observer = false;
  /** Opted in to being sent its own input when it becomes part of a turn (see `OriginExt`). */
  echo = false;
  history = false;
  controls = false;
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
      this.controls = meta?.[SessionControls.capability] != null;
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
            [SessionControls.capability]: { version: 1 },
            ["dev.xsb/workflow"]: { version: 1 },
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
      if (p._meta?.[Agents.sessionKey]) throw RpcError.invalidParams("Use session/resume to open an existing conversation");
      const session = hub.createConversation(p._meta?.[Workflow.backend],p.title,undefined,Array.isArray(p.mcpServers) ? p.mcpServers : []);
      this.attach(session);
      return { sessionId: session.id, ...setup(session), _meta: sessionMeta(session) };
    });

    // Resuming with `replayFrom` replays the transcript first, then says where the session's work stands.
    conn.onRequest("session/resume", (p) => {
      const session = hub.session(p.sessionId);
      hub.workflows.accessible(session);
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
      hub.workflows.readable(session);
      if (p.before !== undefined && (!Number.isSafeInteger(p.before) || p.before < 0)) throw RpcError.invalidParams("invalid history cursor");
      const page = historyPage(hub.state.store, session.agentId, session.id, p.before);
      if (p.before === undefined) this.attach(session);
      return { ...page, state: session.busy ? "running" : "idle", agent: hub.agentInfo(hub.agent(session.agentId)) };
    });
    conn.onRequest(History.image, (p: HistoryImage) => {
      const session = hub.session(p.sessionId);
      hub.workflows.readable(session);
      if (!this.attached.has(session)) throw RpcError.notFound("unattached session");
      return historyImage(hub.state.store, session.agentId, p);
    });

    conn.onRequest("session/list", (p) => {
      const agentId = p._meta?.[Agents.sessionKey];
      const sessions = [...hub.live.values()]
        .filter((s) => hub.state.agents.has(s.agentId) && (!agentId || s.agentId === agentId) && hub.agent(s.agentId).conversation && !hub.agent(s.agentId).workflowOwner)
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
      hub.workflows.accessible(session);
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
      const origin = userOrigin(p);
      origin.messageId ??= newId("m");
      hub.workflows.input(session,origin.messageId,p.prompt,p._meta?.[Workflow.target]);
      if (!session.rec.title && !hub.agent(session.agentId).workflowOwner) {
        const first = p.prompt.find((b: any) => b.type === "text")?.text?.trim();
        if (first) { session.save({title:first.slice(0,64)}); hub.agentChanged(session.agentId); }
      }
      return hub.delivery.fromUser(session, p.prompt, origin, this);
    });

    // The user's stop: the session's work, and the tasks it works on (delivery.ts, `userStop`).
    conn.onNotification("session/cancel", (p) => {
      const session = hub.live.get(p?.sessionId);
      if (session) { hub.workflows.accessible(session); hub.workflows.userStop(session); }
    });

    conn.onRequest(Boundaries.clear, (p) => {
      this.own(p.sessionId).clear();
      return {};
    });

    conn.onRequest(SessionControls.get, async (p) => {
      const session = this.own(p.sessionId);
      if (p.discover === true) await session.ensureBackend();
      return session.composerState();
    });

    conn.onRequest("session/set_config_option", p => this.own(p.sessionId).setConfig(p));

    // ---- agents ------------------------------------------------------------

    conn.onRequest(Agents.list, () => ({
      agents: [...hub.state.agents.values()].filter(a => a.conversation && (!a.workflowOwner || hub.workflows.read(a.workflowOwner).instances[a.workflowNode!]?.agentId === a.id || hub.workflows.retired(a.id))).map((a) => hub.agentInfo(a)),
    }));
    conn.onRequest(ToolServers.apply, () => ({ waiting: hub.applyTools() }));

    // The user's choice of icon for a main conversation. Only bundled IDs reach here; "" goes back to the default.
    conn.onRequest(Agents.set, (p) => {
      const agent = hub.state.agents.get(p?.agentId);
      if (!agent || agent.workflowOwner) throw RpcError.notFound(`agent ${p?.agentId}`);
      if (typeof p.avatar !== "string" || p.avatar.length > 64 || !/^[a-z0-9-]*$/.test(p.avatar)) throw RpcError.invalidParams("avatar must be a bundled avatar id");
      const { avatar: _, ...rest } = agent;
      hub.state.commit([ops.putAgent(p.avatar ? { ...rest, avatar: p.avatar } : rest)]);
      hub.agentChanged(agent.id);
      return { agent: hub.agentInfo(hub.agent(agent.id)) };
    });
    conn.onRequest(Workflow.get, p => hub.workflows.get(p.sessionId));
    conn.onRequest(Workflow.list, () => ({ workflows:[...hub.state.workflows.keys()].map(id => hub.workflows.get(id)) }));
    for (const action of ["pause","resume"] as const) conn.onRequest(Workflow[action], p => hub.workflows.clientControl(p.sessionId,action === "pause",p.nodes));

    // ---- backends, assets and tasks ---------------------------------------

    conn.onRequest(Backends.list, () => ({ backends: describeBackends() }));
    conn.onRequest(Assets.list, (p) => {
      const versions = [...hub.state.assets.values()];
      const assets = p.history ? versions.flat() : versions.flatMap(list => {
        const a = list[0];
        const pointer = hub.state.assetPointers.get(a.id);
        return list.filter(asset => pointer === "v"+asset.version);
      });
      return { assets:assets.filter(a => !p.type || a.type === p.type).map(a => ({ ...a, sessionId: a.sessionId ?? hub.state.agents.get(a.by)?.workflowOwner ?? hub.state.mainSession(a.by)?.id })) };
    });
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
    this.hub.workflows.accessible(session);
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
