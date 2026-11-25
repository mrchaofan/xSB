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
import { Agents, Connection, Ledger, RpcError, Tasks, failure } from "@xsb/protocol";
import type { AgentInfo, AgentSpec, McpServer } from "@xsb/protocol";
import type { Op } from "@xsb/store";
import { Workflows } from "./workflows.ts";
import { Store } from "@xsb/store";
import { Client } from "./acp-server.ts";
import { Assets } from "./assets.ts";
import { auditHook, auditReports } from "./audit.ts";
import { BackendPool } from "./backends.ts";
import { DEFAULT_BACKEND, projectLanguage } from "./config.ts";
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
import { randomBytes } from "node:crypto";
import { Paths } from "./paths.ts";
import { Permissions } from "./permissions.ts";
import { conversationPrompt } from "./prompts.ts";
import type { ToolOrigin } from "./prompts.ts";
import { LiveSession } from "./session.ts";
import type { MailItem, SessionRec } from "./state.ts";
import { State, ops, topicKey } from "./state.ts";
import { newId, now } from "./util.ts";

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
  readonly assets: Assets;
  readonly workflows: Workflows;
  /** Set by `shutdown`: turns that die with it stay unacknowledged and run again on the next start. */
  stopping = false;

  private servers: net.Server[] = [];
  /** Bridge token -> session: how a tool call is known to come from that session. */
  private bridgeTokens = new Map<string, LiveSession>();
  private contextTokens = new Map<string, ContextOwner>();
  private mcpClients = new Set<Connection>();

  constructor(project: string) {
    this.paths = new Paths(project);
    this.state = new State(new Store(this.paths.dir));
    this.state.load();
    this.backends = new BackendPool((line) => this.log(line));
    const hooks: KernelHooks = new Hooks(auditReports(this.state.store, (line) => this.log(line)));
    this.kernel = new Kernel(this.state, hooks, (to) => this.delivery.recipient(to));
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
    this.assets = new Assets(this);
    this.workflows = new Workflows(this);
    // One conversation per agent (docs/DESIGN.md): sessions a client once opened besides it are history, not live.
    for (const rec of this.state.sessions.values()) if (rec.main) this.track(new LiveSession(this, rec));
  }

  log(line: string): void {
    process.stderr.write(`${now()} ${line}\n`);
  }

  // ---- lifecycle ----------------------------------------------------------

  async start(): Promise<void> {
    fs.mkdirSync(this.paths.run, { recursive: true });
    fs.mkdirSync(this.paths.shared, { recursive: true });
    fs.mkdirSync(this.paths.assets, { recursive: true });
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
    this.contextTokens.clear();
    for (const conn of this.mcpClients) conn.close();
    for (const server of this.servers) server.close();
    for (const client of this.clients) client.conn.close();
    await this.backends.close();
    fs.rmSync(this.paths.socket("acp"), { force: true });
    fs.rmSync(this.paths.socket("mcp"), { force: true });
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
    const state = this.permissions.waitingOn(agent.id) ? "requires_action" : session?.busy ? "running" : "idle";
    const turn = session?.current;
    return {
      ...agent,
      ...(rec?.title && !agent.workflowOwner && { name: rec.title }),
      state,
      mainSessionId: rec?.id,
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
  ): { server: McpServer; from: ToolOrigin; about?: string }[] {
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
    this.backends.stop(agentId);
  }

  systemPromptFor(agent: AgentSpec, clientMcp: McpServer[] = []): string {
    const tools = this.toolServers(agent, clientMcp)
      .map((t) => [t.server.name, t.about].filter(Boolean).join(" — "))
      .join("\n");
    return conversationPrompt(
      agent,
      projectLanguage(this.paths),
      [this.instructions(agent.id), tools].filter(Boolean).join("\n"),
    );
  }

  createConversation(
    backend = DEFAULT_BACKEND,
    title?: string,
    task?: { owner: string; node: string; bind(agentId: string, sessionId: string): Op },
    clientMcp?: McpServer[],
  ): LiveSession {
    const id = newId(task ? "node" : "chat"),
      sessionId = newId("ses");
    const spec: AgentSpec = {
      id,
      conversation: true,
      name: title?.trim() || (projectLanguage(this.paths) === "zh-CN" ? "新会话" : "New session"),
      description: "",
      backend,
      workspace: this.paths.project,
      createdAt: now(),
      ...(task && { workflowOwner: task.owner, workflowNode: task.node }),
    };
    this.backends.spec(spec);
    const rec: SessionRec = {
      id: sessionId,
      agentId: id,
      main: true,
      clientMcp: task ? this.session(task.owner).clientMcp : clientMcp,
      title: title?.trim() || undefined,
      createdAt: now(),
      updatedAt: now(),
    };
    this.state.commit([ops.putAgent(spec), ops.putSession(rec), ...(task ? [task.bind(id, sessionId)] : [])]);
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
  mainSession(agentId: string, clientMcp: McpServer[] = []): LiveSession {
    const rec = this.state.mainSession(agentId);
    if (rec) return this.live.get(rec.id)!;
    this.agent(agentId);
    const made: SessionRec = { id: newId("ses"), agentId, main: true, createdAt: now(), updatedAt: now() };
    this.state.commit([ops.putSession(made)]);
    const session = this.track(new LiveSession(this, made));
    session.clientMcp = clientMcp;
    this.agentChanged(agentId);
    return session;
  }

  private track(session: LiveSession): LiveSession {
    this.live.set(session.id, session);
    this.bridgeTokens.set(session.bridgeToken, session);
    return session;
  }

  /** Revoke an unresponsive backend's existing tool bridges before accepting a new run. */
  rotateBridge(session: LiveSession): void {
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
}
