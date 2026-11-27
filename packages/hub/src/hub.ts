import { UrlElicitations } from "./url-elicitation.ts";
import { Lifecycle } from "./lifecycle.ts";
/**
 * The hub: the one long-running process of a project.
 *
 *   outside (editor, CLI) --ACP--> Client (acp-server.ts) ---------------------+
 *                                                                              +--> LiveSession --ACP--> Backend
 *   agent's tool call --MCP--> mcp.ts -> tools.ts -> Kernel --hooks--> Delivery +
 *                                                          \-hooks--> Jobs, Audit, the clients
 *
 * This class is the composition root. It owns the registries (agents,
 * sessions, connected clients) and the two sockets, and wires the rest:
 * `kernel` decides everything about tasks and mail without knowing ACP, and
 * says so on its hooks; the effectors registered there act on it (`delivery`
 * into sessions, `jobs` the tool calls, the audit and the
 * clients' feed). `backends` runs the agent processes, `permissions`
 * finds a human for a backend's question, `assets` is the library they all
 * work from. What an agent is beyond its name comes from its role (roles.ts).
 * All durable state is in `state`.
 */
import fs from "node:fs";
import net from "node:net";
import { Agents, Assets as AssetsExt, Connection, Ledger, PluginPublication, RpcError, Tasks, failure, errorMessage } from "@xsb/protocol";
import type { AgentInfo, AgentSpec, McpServer } from "@xsb/protocol";
import type { Op } from "@xsb/store";
import { Workflows } from "./workflows.ts";
import { nodeAgent } from "./workflow-agent.ts";
import { Store, atomicWrite, syncDirectory } from "@xsb/store";
import { Client } from "./acp-server.ts";
import { Assets } from "./assets.ts";
import { auditHook, auditReports } from "./audit.ts";
import { BackendPool } from "./backends.ts";
import { consultationSettings, DEFAULT_BACKEND, projectLanguage } from "./config.ts";
import { contextPolicy } from "./context.ts";

import { Delivery } from "./delivery.ts";
import { Hooks } from "./hooks.ts";
import { Jobs } from "./jobs.ts";
import { Kernel } from "./kernel.ts";
import type { KernelHooks } from "./kernel.ts";
import { serveMcp } from "./mcp.ts";
import { activePlugins, toolsKey } from "./plugins.ts";
import { contextServer } from "./tool-context.ts";
import type { ContextOwner } from "./tool-context.ts";
import type { Publisher } from "./publications.ts";
import { randomBytes } from "node:crypto";
import { Paths } from "./paths.ts";
import { Permissions } from "./permissions.ts";
import { Elicitations } from "./elicitations.ts";
import { conversationPrompt, conversationRecord, isXsbText } from "./prompts.ts";
import { contextRef } from "./context.ts";
import { turnsSinceCleared } from "./transcript.ts";
import { Boundaries, Question } from "@xsb/protocol";
import type { SessionUpdate } from "@xsb/protocol";
import path from "node:path";
import type { ToolOrigin } from "./prompts.ts";
import { LiveSession } from "./session.ts";
import type { MailItem, SessionRec } from "./state.ts";
import { State, conversed, ops, topicKey } from "./state.ts";
import { newId, now } from "./util.ts";

/** How long deleting a conversation waits for its stopped turns to end: past a session's own 10 s stop timeout. */
const DELETE_STOP_WAIT_MS = 15_000;

type PublicationGrant = { publisher: Publisher; origin: LiveSession; toolKey: string; bound: () => boolean };

export class Hub {
  readonly paths: Paths;
  readonly state: State;
  readonly live = new Map<string, LiveSession>();
  readonly clients = new Set<Client>();
  readonly backends: BackendPool;
  readonly kernel: Kernel;
  readonly delivery: Delivery;
  readonly jobs: Jobs;
  readonly permissions: Permissions;
  readonly elicitations: Elicitations;
  readonly lifecycle: Lifecycle;
  readonly urlElicitations: UrlElicitations;
  readonly assets: Assets;
  readonly workflows: Workflows;
  /** Set by `shutdown`: turns that die with it stay unacknowledged and run again on the next start. */
  stopping = false;

  private servers: net.Server[] = [];
  /** Bridge token -> session: how a tool call is known to come from that session. */
  private bridgeTokens = new Map<string, LiveSession>();
  private contextTokens = new Map<string, ContextOwner>();
  private publicationTokens = new Map<string, PublicationGrant>();
  private mcpClients = new Set<Connection>();
  private failedStorage?: Promise<void>;
  private maintenanceScheduled = false;

  constructor(project: string) {
    this.paths = new Paths(project);
    const store = new Store(this.paths.dir);
    const legacy = fs.existsSync(path.join(this.paths.dir, "project.json")) ? undefined : store.read("conversations/agents.jsonl").map(r => r.agent).find(a => a?.conversation && typeof a.workspace === "string")?.workspace;
    this.paths.prepare(legacy);
    this.state = new State(store, this.paths);
    this.state.load();
    this.resumeCleanup();
    const movedBindings = [...this.state.sessions.values()].filter(rec => rec.backendSessionId &&
      (rec.backendWorkspace ? rec.backendWorkspace !== this.state.agents.get(rec.agentId)?.workspace : this.paths.moved || this.paths.previousRoots.length > 0));
    if (movedBindings.length) this.state.commit(movedBindings.map(rec => ops.putSession({ ...rec, backendSessionId: undefined, backendFresh: undefined, renew: "project_moved", used: undefined })));
    this.backends = new BackendPool((line) => this.log(line), {
      url: (backend, request, signal) => this.urlElicitations.request(backend, request, signal),
      urlComplete: (backend, id) => this.urlElicitations.complete(backend, id),
    });
    const hooks: KernelHooks = new Hooks(auditReports(this.state.store, (line) => this.log(line)));
    this.kernel = new Kernel(this.state, hooks, (to) => this.delivery.recipient(to));
    this.lifecycle = new Lifecycle(hooks);
    this.urlElicitations = new UrlElicitations(this);
    this.delivery = new Delivery(this);
    this.jobs = new Jobs(this);
    auditHook(hooks, this.state.store);
    // UserFeedHook: what the clients are shown of tasks and of the ledger.
    hooks.on("task.changed", (task) => this.broadcast(Tasks.update, { task }));
    hooks.on("message.ledger", (entry) => this.broadcast(Ledger.update, { entry }));
    // A conversation that was working when its tool servers changed takes them when that work is over.
    hooks.on("acp.turn_ended", ({ agentId }) => {
      if (this.toolsPending.has(agentId)) setImmediate(() => this.retool(agentId));
    });
    this.permissions = new Permissions(this);
    this.elicitations = new Elicitations(this);
    this.assets = new Assets(this);
    this.workflows = new Workflows(this);
    hooks.on("acp.turn_changed", ({ sessionId }) => this.workflows.runtimeChanged(sessionId));
    // One conversation per agent (docs/DESIGN.md): sessions a client once opened besides it are history, not live.
    for (const rec of this.state.sessions.values()) if (rec.main) this.track(new LiveSession(this, this.titled(rec)));
    this.state.store.onFailure = error => { void this.storageFailed(error); };
    this.state.onMaintenanceNeeded = () => {
      if (this.maintenanceScheduled || this.stopping) return;
      this.maintenanceScheduled = true;
      setImmediate(() => {
        this.maintenanceScheduled = false;
        if (!this.stopping) {
          try { this.state.compact(); } catch (error) { this.log(`storage maintenance failed: ${errorMessage(error)}`); }
        }
      });
    };
  }

  log(line: string): void {
    process.stderr.write(`${now()} ${line}\n`);
  }

  // ---- lifecycle ----------------------------------------------------------

  async start(): Promise<void> {
    fs.mkdirSync(this.paths.run, { recursive: true });
    fs.mkdirSync(this.paths.shared, { recursive: true });
    fs.mkdirSync(this.paths.assets, { recursive: true });
    // A saved question ID belongs to the retired MCP call. Close its historical card once.
    for (const session of this.live.values()) {
      const id = session.rec.question;
      if (id) this.state.atomic(() => {
        session.save({ question: undefined });
        session.emit({ sessionUpdate: "session_info_update", _meta: { [Question.key]: { id, state: "cancelled" } } });
      });
    }
    this.elicitations.restart();
    this.workflows.restart();
    await this.listen(this.paths.socket("acp"), (socket) => {
      const client = new Client(this, new Connection(socket, socket, "client"));
      this.clients.add(client);
      void client.conn.closed.then(() => this.clients.delete(client));
    });
    await this.listen(this.paths.socket("mcp"), (socket) => {
      const conn = new Connection(socket, socket, "mcp");
      this.mcpClients.add(conn);
      void conn.closed.then(() => this.mcpClients.delete(conn));
      serveMcp(
        this,
        conn,
        (token) => this.bridgeTokens.get(token),
        (token) => this.contextTokens.get(token),
        (token) => this.publisher(token),
      );
    });
    // Whoever stopped the last hub may have said that its unfinished work is not to be taken up again.
    if (fs.existsSync(this.paths.abandonMark)) {
      const { mail, tasks } = this.kernel.abandon();
      fs.rmSync(this.paths.abandonMark);
      this.log(`gave up what the last stop left unfinished, as asked: ${mail} mail items, ${tasks} tasks`);
    }
    const pending = this.state.mail.size;
    // What a conversation had taken in when xsb stopped is not given again: its turn was cut short, and it says so.
    for (const [sessionId, items] of this.kernel.resume()) this.live.get(sessionId)?.interrupted(items.length);
    this.log(`hub up: ${this.state.agents.size} agents, ${pending} mail items pending`);
  }

  private listen(path: string, onSocket: (socket: net.Socket) => void): Promise<void> {
    fs.rmSync(path, { force: true });
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      onSocket(socket);
    });
    this.servers.push(server);
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
  }

  async shutdown(): Promise<void> {
    // From here no turn starts and no backend is started (LiveSession.pump, BackendPool.for): what waits, waits for
    // the next start.
    this.stopping = true;
    this.urlElicitations.close();
    this.jobs.close();
    for (const session of this.live.values()) this.elicitations.cancel(session);
    this.contextTokens.clear();
    this.publicationTokens.clear();
    for (const conn of this.mcpClients) conn.close();
    for (const server of this.servers) server.close();
    for (const client of this.clients) client.conn.close();
    await this.backends.close();
    for (const session of this.live.values()) this.lifecycle.emit("session.closed", session.source(), { reason: "shutdown" });
    fs.rmSync(this.paths.socket("acp"), { force: true });
    fs.rmSync(this.paths.socket("mcp"), { force: true });
  }

  /** Storage failure fences every execution without making further persistence calls. */
  storageFailed(error: unknown): Promise<void> {
    if (this.failedStorage) return this.failedStorage;
    this.stopping = true;
    this.bridgeTokens.clear();
    this.contextTokens.clear();
    this.publicationTokens.clear();
    for (const conn of this.mcpClients) conn.close();
    for (const server of this.servers) server.close();
    for (const client of this.clients) client.conn.close();
    this.log(`storage failed; restart required: ${errorMessage(error)}`);
    return this.failedStorage = this.backends.close();
  }

  // ---- agents -------------------------------------------------------------

  agent(id: string): AgentSpec {
    const agent = this.state.agents.get(id);
    if (!agent) throw failure("agent_unknown", { agent: id, known: [...this.state.agents.keys()] });
    return agent;
  }

  agentInfo(agent: AgentSpec): AgentInfo {
    const rec = this.state.mainSession(agent.id);
    const session = rec && this.live.get(rec.id);
    const asking = this.elicitations.waitingOn(agent.id);
    const state = this.permissions.waitingOn(agent.id) || asking ? "requires_action" : session?.busy ? "running" : "idle";
    const turn = session?.current;
    return {
      ...agent,
      ...(rec?.title && !agent.workflowOwner && { name: rec.title }),
      state,
      mainSessionId: rec?.id,
      ...(rec && conversed(rec) ? { conversed: true } : {}),
      ...(asking ? { asking: true } : {}),
      ...(turn ? { currentTurnId: turn.id, turnProtected: turn.protected } : {}),
      ...(agent.workflowOwner && this.workflows.retired(agent.id) ? { retired: true } : {}),
    };
  }

  /** The agent's own instructions, as its file says right now. */
  instructions(agentId: string): string {
    const file = this.paths.instructions(agentId);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  }

  /**
   * The tool servers a conversation gets besides the hub's own: the plugins (plugins.ts, read from their folders on
   * every use) and those of the client that made it. A name taken earlier is not repeated.
   */
  toolServers(
    agent: AgentSpec,
    clientMcp: McpServer[] = [],
  ): { server: McpServer; from: ToolOrigin; pluginId?: string; revision?: string }[] {
    const all = [
      ...activePlugins(this.paths).map((t) => ({ ...t, from: "plugin" as const })),
      ...clientMcp.map((server) => ({ server, from: "client" as const })),
    ];
    const seen = new Set<string>();
    return all.filter((t) => !seen.has(t.server.name) && seen.add(t.server.name));
  }

  /** The context limits of an agent's backend (config.ts, `BACKEND_LIMITS`): set per backend on this machine. */
  policy(agentId: string) {
    return contextPolicy(this.agent(agentId).backend);
  }

  /** What a conversation's backend session is started with that a plugin change can alter: its tools and prompt. */
  toolsKeyFor(session: LiveSession): string {
    const agent = this.agent(session.agentId);
    return toolsKey(this.toolServers(agent, session.clientMcp)) + this.systemPromptFor(agent, session.clientMcp);
  }

  /** Agents whose conversation was working when the tool servers changed (`applyTools`). */
  private toolsPending = new Set<string>();

  /**
   * The plugins may have changed: a conversation whose backend runs with other tools or another prompt than it would
   * now takes them by resuming its backend session in a new process, which keeps what the model saw. An idle one
   * now, a working one once its work is over; one with nothing changed is left alone (its prompt cache with it).
   * Returns how many wait for their work to end.
   */
  applyTools(): number {
    if (this.publicationTokens.size) {
      const active = new Set(activePlugins(this.paths).map(t => toolsKey([t])));
      for (const [token, grant] of this.publicationTokens)
        if (!active.has(grant.toolKey)) this.publicationTokens.delete(token);
    }
    for (const session of this.live.values()) {
      if (!session.rec.main || !this.state.agents.has(session.agentId) || !session.toolsKey) continue;
      if (session.toolsKey === this.toolsKeyFor(session)) continue;
      this.toolsPending.add(session.agentId);
      this.retool(session.agentId);
    }
    return this.toolsPending.size;
  }

  private retool(agentId: string): void {
    const rec = this.state.mainSession(agentId);
    const session = rec && this.live.get(rec.id);
    if (!session) return void this.toolsPending.delete(agentId);
    if (session.busy) return;
    this.toolsPending.delete(agentId);
    this.revokePublications(session.id);
    this.elicitations.cancel(session);
    this.backends.stop(agentId);
  }

  systemPromptFor(agent: AgentSpec, clientMcp: McpServer[] = []): string {
    const frozen = agent.workflowOwner ? this.state.mainSession(agent.id)?.workflowPrompt : undefined;
    if (frozen !== undefined) return frozen;
    // Task tool catalogs are supplied by MCP, not volatile names in the standing prefix.
    const tools = agent.workflowOwner ? "" : this.toolServers(agent, clientMcp).map((t) => t.server.name).join("\n");
    return conversationPrompt(
      agent,
      projectLanguage(this.paths),
      [this.instructions(agent.id), tools].filter(Boolean).join("\n"),
      consultationSettings(this.paths).effective,
    );
  }

  createConversation(
    backend = DEFAULT_BACKEND,
    title?: string,
    task?: { owner: string; node: string; agent?: AgentSpec["workflowAgent"]; bind(agentId: string, sessionId: string): Op },
    clientMcp?: McpServer[],
    initial?: { agentId: string; migratedFrom: SessionRec["migratedFrom"]; update: SessionUpdate },
  ): LiveSession {
    const id = initial?.agentId ?? newId(task ? "node" : "chat"),
      sessionId = newId("ses");
    const spec: AgentSpec = {
      id,
      conversation: true,
      name: title?.trim() || (projectLanguage(this.paths) === "zh-CN" ? "新会话" : "New session"),
      description: "",
      backend,
      workspace: this.paths.project,
      createdAt: now(),
      ...(task && { workflowOwner: task.owner, workflowNode: task.node, ...(task.agent && { workflowAgent: nodeAgent(task.agent) }) }),
    };
    this.backends.spec(spec);
    const rec: SessionRec = {
      id: sessionId,
      agentId: id,
      main: true,
      clientMcp: task ? this.session(task.owner).clientMcp : clientMcp,
      title: title?.trim() || undefined,
      ...(initial && { migratedFrom: initial.migratedFrom }),
      ...(title?.trim() && !task ? { titleEdited: true } : {}),
      conversed: false,
      createdAt: now(),
      updatedAt: now(),
    };
    if (task) rec.workflowPrompt = this.systemPromptFor(spec, rec.clientMcp);
    this.state.commit([ops.putAgent(spec), ops.putSession(rec), ...(task ? [task.bind(id, sessionId)] : []),
      ...(initial ? [{ file: Paths.transcript(id, sessionId), rec: { ts: now(), update: initial.update } }] : [])]);
    const session = this.track(new LiveSession(this, rec));
    this.agentChanged(id);
    return session;
  }

  agentChanged(agentId: string): void {
    const agent = this.state.agents.get(agentId);
    if (
      agent?.workflowOwner &&
      this.workflows.read(agent.workflowOwner).instances[agent.workflowNode!]?.agentId !== agent.id
    )
      return;
    if (agent) this.broadcast(Agents.update, { agent: this.agentInfo(agent) });
  }

  /** Notify the clients that opted in to hub-wide events. */
  broadcast(method: string, params: unknown): void {
    for (const client of this.clients) if (client.observer) client.conn.notify(method, params);
  }

  // ---- sessions -----------------------------------------------------------

  session(id: string): LiveSession {
    const session = this.live.get(id);
    if (!session) throw RpcError.notFound(`session ${id}`);
    return session;
  }

  /**
   * The agent's one conversation: where the user, its peers and xsb reach it, and where it does all its work, one
   * turn at a time. The hub is its only registry: it is made here, once, and never by a delivery or a backend.
   * `clientMcp`: the MCP servers of the client that made it, passed on next to the hub's own.
   */
  /**
   * Move a main conversation onto another backend (`Agents.migrate`): a new conversation on it, whose model reads the
   * old one, as it stands now, with its `previous_conversation` tool; it is told so with its first message. Only the
   * main conversation moves: its workflows stay with it. The old conversation stays, as it was.
   */
  migrate(agentId: string, backend: string): LiveSession {
    const agent = this.agent(agentId);
    const old = this.mainSession(agentId);
    if (old.busy) throw new RpcError(-32602, "The conversation's current turn has not ended; switch its backend once it has.", { errorKind: "turn_running" });
    this.backends.spec({ ...agent, backend });
    const title = old.rec.title ?? agent.name;
    const prior = old.rec.migratedFrom;
    const earlier = prior ? fs.readFileSync(path.join(this.paths.dir, "agents", agentId, "context", `${prior.ref}.txt`), "utf8") : undefined;
    const record = conversationRecord(title, agent.backend, turnsSinceCleared(this.state.store, agentId, old.id), earlier);
    const nextId = newId("chat");
    const { ref } = contextRef(this.paths, nextId, record);
    const created = this.createConversation(backend, title, undefined, undefined, {
      agentId: nextId, migratedFrom: { agentId, sessionId: old.id, title, backend: agent.backend, ref, pending: true },
      update: { sessionUpdate: "session_info_update", _meta: { [Boundaries.key]: { kind: "migrated", backend, from: title, handoff: false } } } as SessionUpdate,
    });
    this.agentChanged(created.agentId);
    return created;
  }

  /** Deleted by the user: the conversation itself, or an agent of a deleted conversation's workflow. */
  isDeleted(agent: AgentSpec): boolean {
    if (agent.deleted) return true;
    const owner = agent.workflowOwner && this.state.sessions.get(agent.workflowOwner)?.agentId;
    return !!owner && !!this.state.agents.get(owner)?.deleted;
  }

  /** A main conversation and the agents of its workflow, retired ones too. */
  private conversationAgents(agentId: string): AgentSpec[] {
    const main = this.state.mainSession(agentId)?.id;
    return [...this.state.agents.values()].filter((a) => a.id === agentId || (main && a.workflowOwner === main));
  }

  /** The live sessions of a main conversation and of its workflow's agents. */
  private conversationSessions(agentId: string): LiveSession[] {
    const members = new Set(this.conversationAgents(agentId).map((a) => a.id));
    return [...this.live.values()].filter((s) => members.has(s.agentId));
  }

  /**
   * Delete a main conversation (`Agents.delete`). What of it is still working is stopped first, by the user's stop
   * (its workflow's agents too, `Workflows.userStop`), and the deletion waits for every turn to end; work that will
   * not end in time refuses the deletion. Its workflow is paused so no node starts again; input still queued for it
   * goes with it. Its files stay until `purgeDeleted`.
   */
  async deleteConversation(agentId: string): Promise<void> {
    const agent = this.agent(agentId);
    if (agent.workflowOwner || agent.deleted) throw RpcError.notFound(`agent ${agentId}`);
    const main = this.state.mainSession(agentId)?.id;
    if (main && this.state.workflows.has(main)) {
      try { this.workflows.control(main, "pause"); } catch { /* no graph running: nothing to pause */ }
    }
    const deadline = Date.now() + DELETE_STOP_WAIT_MS;
    let busy = this.conversationSessions(agentId).filter((s) => s.busy);
    if (busy.length) {
      const live = main && this.live.get(main);
      if (live) this.workflows.userStop(live);
    }
    while (busy.length) {
      if (Date.now() > deadline) throw failure("conversation_busy", { agent: agent.name });
      // A session the first stop did not reach (a retired workflow agent), or that took new work since: stop it too.
      for (const s of busy) this.delivery.userStop(s);
      await Promise.race([...busy.flatMap((s) => s.current ? [s.current.done.promise] : []), new Promise((r) => setTimeout(r, 100))]);
      if (this.agent(agentId).deleted) return;
      busy = this.conversationSessions(agentId).filter((s) => s.busy);
    }
    const members = this.conversationAgents(agentId);
    const sessions = new Set([...this.state.sessions.values()].filter((s) => members.some((a) => a.id === s.agentId)).map((s) => s.id));
    const queued = [...this.state.mail.values()].filter((m) => sessions.has(m.to.sessionId)).map((m) => ops.ack(m.id));
    this.state.commit([...queued, ops.putAgent({ ...this.agent(agentId), deleted: now() })]);
    for (const id of sessions) {
      const session = this.live.get(id);
      if (session) this.elicitations.cancel(session);
      this.revokePublications(id);
    }
    for (const a of members) {
      this.backends.stop(a.id);
      this.broadcast(Agents.removed, { id: a.id });
    }
  }

  /**
   * Clean up the project (`Agents.purge`): what deleted conversations left goes for good — the agents' folders
   * (transcripts, drafts, notes), the asset files only they made, their records — and the logs are compacted.
   */
  purgeDeleted(): { conversations: number; bytes: number } {
    const deleted = [...this.state.agents.values()].filter((a) => a.deleted && !a.workflowOwner);
    const gone = new Set(deleted.flatMap((a) => this.conversationAgents(a.id).map((m) => m.id)));
    if (!gone.size) return { conversations: 0, bytes: 0 };
    for (const session of [...this.live.values()]) {
      if (!gone.has(session.agentId)) continue;
      this.lifecycle.emit("session.closed", session.source(), { reason: "purged" });
      this.live.delete(session.id);
      this.bridgeTokens.delete(session.bridgeToken);
      this.revokePublications(session.id);
    }
    const assets = [...this.state.assets.values()].filter(versions => versions.every(v => gone.has(v.by))).flat();
    const files = [...[...gone].map(id => this.paths.agentDir(id)), ...assets.filter(a => path.resolve(a.path).startsWith(this.paths.dir + path.sep)).map(a => a.path)];
    const bytes = files.reduce((sum, file) => sum + sizeOf(file), 0);
    atomicWrite(this.cleanupFile, JSON.stringify({ agents: [...gone], files }) + "\n");
    this.resumeCleanup();
    this.broadcast(AssetsExt.removed, { ids: [...new Set(assets.map(a => a.id))] });
    return { conversations: deleted.length, bytes };
  }

  private get cleanupFile(): string { return path.join(this.paths.dir, "conversations", "cleanup.json"); }
  private resumeCleanup(): void {
    if (!fs.existsSync(this.cleanupFile)) return;
    const plan = JSON.parse(fs.readFileSync(this.cleanupFile, "utf8"));
    if (Array.isArray(plan.files)) plan.files = plan.files.map((file: string) => this.paths.resolveStored(file));
    if (!Array.isArray(plan.agents) || plan.agents.some((id: unknown) => typeof id !== "string") || !Array.isArray(plan.files) || plan.files.some((file: unknown) => typeof file !== "string" || !path.resolve(file).startsWith(this.paths.dir + path.sep))) throw new Error("Invalid cleanup plan");
    this.state.forget(new Set(plan.agents));
    for (const file of plan.files) fs.rmSync(file, { recursive: true, force: true });
    fs.rmSync(this.cleanupFile);
    syncDirectory(path.dirname(this.cleanupFile));
  }

  mainSession(agentId: string, clientMcp: McpServer[] = []): LiveSession {
    const rec = this.state.mainSession(agentId);
    if (rec) return this.live.get(rec.id)!;
    this.agent(agentId);
    const made: SessionRec = { id: newId("ses"), agentId, main: true, conversed: false, createdAt: now(), updatedAt: now() };
    this.state.commit([ops.putSession(made)]);
    const session = this.track(new LiveSession(this, made));
    session.clientMcp = clientMcp;
    this.agentChanged(agentId);
    return session;
  }

  /** A record an earlier version let be named after xsb's own words is named again, as it was first: after the user's. */
  private titled(rec: SessionRec): SessionRec {
    if (rec.titleEdited || !rec.title || !isXsbText(rec.title)) return rec;
    const said = turnsSinceCleared(this.state.store, rec.agentId, rec.id).flatMap((turn) => turn.inputs);
    const first = said.find((input) => input.origin.kind === "user" && input.text.trim() && !isXsbText(input.text));
    const named = { ...rec, title: first?.text.trim().slice(0, 64) };
    this.state.commit([ops.putSession(named)]);
    return named;
  }

  private track(session: LiveSession): LiveSession {
    this.live.set(session.id, session);
    this.lifecycle.emit("session.opened", session.source(), { restored: !!session.rec.backendSessionId });
    this.bridgeTokens.set(session.bridgeToken, session);
    return session;
  }

  /** Revoke an unresponsive backend's existing tool bridges before accepting a new run. */
  rotateBridge(session: LiveSession): void {
    this.elicitations.cancel(session);
    this.revokePublications(session.id);
    for (const [token, owner] of this.contextTokens)
      if (owner.session === session) this.contextTokens.delete(token);
    this.bridgeTokens.delete(session.bridgeToken);
    session.bridgeToken = newId("tok");
    this.bridgeTokens.set(session.bridgeToken, session);
  }

  /** Every stdio tool receives read-only runtime identity, never messaging rights. */
  withToolContext(server: McpServer, session: LiveSession): McpServer {
    if (server.type !== "stdio") return server;
    for (const [token, owner] of this.contextTokens)
      if (owner.session === session && owner.server === server.name)
        return contextServer(server, this.paths.socket("mcp"), token);
    const token = randomBytes(32).toString("hex");
    this.contextTokens.set(token, { session, server: server.name });
    return contextServer(server, this.paths.socket("mcp"), token);
  }

  /** Each ACP new/resume attempt gets fresh plugin credentials, valid only on that binding. */
  backendToolServers(origin: LiveSession, bound: () => boolean): McpServer[] {
    this.revokePublications(origin.id);
    const session = this.publicationDestination(origin);
    return this.toolServers(this.agent(origin.agentId), origin.clientMcp).map(tool => {
      const server = this.withToolContext(tool.server, origin);
      if (server.type !== "stdio" || !tool.pluginId || !session) return server;
      const token = randomBytes(32).toString("hex");
      this.publicationTokens.set(token, { publisher: { session, pluginId: tool.pluginId }, origin, bound, toolKey: toolsKey([tool]) });
      return { ...server, env: [...(server.env ?? []), { name: PluginPublication.tokenEnv, value: token }] };
    });
  }

  revokePublications(originId: string): void {
    for (const [token, grant] of this.publicationTokens)
      if (grant.origin.id === originId) this.publicationTokens.delete(token);
  }

  /** Route only from a current session to its live, undeleted main conversation. */
  private publicationDestination(origin: LiveSession): LiveSession | undefined {
    const source = this.state.agents.get(origin.agentId);
    if (!source || this.live.get(origin.id) !== origin || this.isDeleted(source) || !this.workflows.available(origin)) return;
    const session = this.live.get(this.workflows.owner(origin));
    if (!session?.rec.main) return;
    const target = this.state.agents.get(session.agentId);
    if (target && !this.isDeleted(target) && this.workflows.owner(session) === session.id) return session;
  }

  private publisher(token: string): Publisher | undefined {
    const grant = this.publicationTokens.get(token);
    if (this.stopping || !grant || !grant.bound()) return;
    if (this.publicationDestination(grant.origin) === grant.publisher.session &&
        activePlugins(this.paths).some(t => toolsKey([t]) === grant.toolKey)) return grant.publisher;
    this.publicationTokens.delete(token);
  }
}

/** Bytes a file or folder takes, 0 if it is not there. */
function sizeOf(file: string): number {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return 0;
  if (!stat.isDirectory()) return stat.size;
  return fs.readdirSync(file).reduce((sum, name) => sum + sizeOf(path.join(file, name)), 0);
}
