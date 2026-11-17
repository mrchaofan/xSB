/**
 * The hub: the one long-running process of a project.
 *
 *   outside (editor, CLI) --ACP--> Client (acp-server.ts) --+
 *                                                           +--> LiveSession --ACP--> Backend (claude, codex, ...)
 *   agent's tool call --MCP--> mcp.ts -> tools.ts -> Mailroom +
 *
 * This class is the composition root. It owns the registries (agents,
 * sessions, connected clients) and the two sockets, and hands the rest to the
 * part that knows it: `backends` runs the agent processes, `mail` moves
 * messages, tasks and jobs between sessions, `permissions` finds a human for
 * a backend's question, `assets` is the library they all work from. What an
 * agent is beyond its name comes from its role (roles.ts). All durable state is in `state`.
 */
import fs from "node:fs";
import net from "node:net";
import { AGENT_ID, Agents, Connection, RpcError, SpendExt, failure } from "@xsb/protocol";
import type { AgentInfo, AgentSpec, McpServer } from "@xsb/protocol";
import { Store } from "@xsb/store";
import { Client } from "./acp-server.ts";
import { Assets } from "./assets.ts";
import { BackendPool } from "./backends.ts";
import { DEFAULT_BACKEND, loadProjectConfig, migrateProjectConfig, projectLanguage } from "./config.ts";

/** Past this much context a work session takes no new work, unless the project says otherwise (`limits.sessionTokens`). */
const SESSION_TOKENS = 150_000;
const sessionTokens = (paths: Paths): number => loadProjectConfig(paths).limits?.sessionTokens ?? SESSION_TOKENS;
/** How many work sessions of one agent run at a time for parallel work, unless the project says otherwise. */
const SESSIONS_AT_ONCE = 2;
import { Mailroom } from "./mailroom.ts";
import { commonServers, serveMcp } from "./mcp.ts";
import { Paths } from "./paths.ts";
import { Permissions } from "./permissions.ts";
import { systemPrompt } from "./prompts.ts";
import type { ToolOrigin } from "./prompts.ts";
import { loadRole } from "./roles.ts";
import type { Contract, Role } from "./roles.ts";
import { LiveSession } from "./session.ts";
import type { MailItem, SessionRec } from "./state.ts";
import { Spending } from "./spend.ts";
import { State, ops, topicKey } from "./state.ts";
import { newId, now } from "./util.ts";

export class Hub {
  readonly paths: Paths;
  readonly state: State;
  readonly live = new Map<string, LiveSession>();
  readonly clients = new Set<Client>();
  readonly backends: BackendPool;
  readonly mail: Mailroom;
  readonly permissions: Permissions;
  readonly assets: Assets;
  readonly spending: Spending;
  /** Set by `shutdown`: turns that die with it stay unacknowledged and run again on the next start. */
  stopping = false;

  private servers: net.Server[] = [];
  private unwatchSpend?: () => void;
  /** Bridge token -> session: how a tool call is known to come from that session. */
  private bridgeTokens = new Map<string, LiveSession>();

  constructor(project: string) {
    this.paths = new Paths(project);
    this.state = new State(new Store(this.paths.dir));
    this.state.load();
    this.backends = new BackendPool((line) => this.log(line));
    this.mail = new Mailroom(this);
    this.permissions = new Permissions(this);
    this.assets = new Assets(this);
    this.spending = new Spending(this.paths);
    for (const rec of this.state.sessions.values()) this.track(new LiveSession(this, rec));
  }

  log(line: string): void {
    process.stderr.write(`${now()} ${line}\n`);
  }

  // ---- lifecycle ----------------------------------------------------------

  async start(): Promise<void> {
    fs.mkdirSync(this.paths.run, { recursive: true });
    fs.mkdirSync(this.paths.shared, { recursive: true });
    fs.mkdirSync(this.paths.assets, { recursive: true });
    await this.listen(this.paths.socket("acp"), (socket) => {
      const client = new Client(this, new Connection(socket, socket, "client"));
      this.clients.add(client);
      void client.conn.closed.then(() => this.clients.delete(client));
    });
    await this.listen(this.paths.socket("mcp"), (socket) => {
      serveMcp(this, new Connection(socket, socket, "mcp"), (token) => this.bridgeTokens.get(token));
    });
    const migrated = migrateProjectConfig(this.paths);
    if (migrated) this.log(migrated);
    // Whoever stopped the last hub may have said that its unfinished work is not to be taken up again.
    if (fs.existsSync(this.paths.abandonMark)) {
      const { mail, tasks } = this.mail.abandon();
      fs.rmSync(this.paths.abandonMark);
      this.log(`gave up what the last stop left unfinished, as asked: ${mail} mail items, ${tasks} tasks`);
    }
    this.unwatchSpend = this.spending.watch((spend) => this.broadcast(SpendExt.update, { spend }));
    const pending = this.state.mail.size;
    this.mail.resume();
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
    this.stopping = true;
    this.unwatchSpend?.();
    for (const server of this.servers) server.close();
    for (const client of this.clients) client.conn.close();
    await this.backends.stopAll();
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
    const busy = [...this.live.values()].some((s) => s.agentId === agent.id && s.busy);
    const state = this.permissions.waitingOn(agent.id) ? "requires_action" : busy ? "running" : "idle";
    const workSessions = [...this.state.sessions.values()]
      .filter((s) => s.agentId === agent.id && s.topic)
      .map((s) => ({ sessionId: s.id, topic: s.topic!, retired: !!s.retired }));
    return { ...agent, state, mainSessionId: this.state.mainSession(agent.id)?.id, workSessions };
  }

  /** The agent a client reaches when it names none. Read on every use, like the backend table. */
  defaultAgent(): string | undefined {
    return loadProjectConfig(this.paths).defaultAgent ?? this.state.agents.keys().next().value;
  }

  putAgent(input: Partial<AgentSpec> & { id: string }, instructions?: string): AgentInfo {
    if (!AGENT_ID.test(input.id ?? "")) throw failure("agent_id_invalid");
    if (input.avatar !== undefined && (typeof input.avatar !== "string" || (input.avatar !== "" && !/^[a-z][a-z0-9-]{0,63}$/.test(input.avatar)))) throw RpcError.invalidParams("avatar must be a bundled avatar ID or empty");
    const prior = this.state.agents.get(input.id);
    const roleName = input.role ?? prior?.role;
    const role = roleName ? loadRole(this.paths, roleName) : undefined; // refuse a role that does not exist
    const agent: AgentSpec = {
      id: input.id,
      avatar: input.avatar ?? prior?.avatar,
      name: input.name ?? prior?.name ?? input.id,
      description: input.description ?? prior?.description ?? role?.description ?? "",
      backend: input.backend ?? prior?.backend ?? role?.backend ?? DEFAULT_BACKEND,
      workspace: input.workspace ?? prior?.workspace ?? (role?.workspace === "project" ? this.paths.project : this.paths.defaultWorkspace(input.id)),
      ...(roleName ? { role: roleName } : {}),
      createdAt: prior?.createdAt ?? now(),
    };
    this.backends.spec(agent); // refuse a backend this machine does not have
    fs.mkdirSync(agent.workspace, { recursive: true });
    fs.mkdirSync(this.paths.agentDir(agent.id), { recursive: true });
    if (instructions !== undefined || !fs.existsSync(this.paths.instructions(agent.id))) {
      fs.writeFileSync(this.paths.instructions(agent.id), instructions ?? "");
    }
    this.state.commit([ops.putAgent(agent)]);
    // A changed backend, workspace or role needs a new process.
    const restart = prior && (prior.backend !== agent.backend || prior.workspace !== agent.workspace || prior.role !== agent.role);
    if (restart) this.backends.stop(agent.id);
    this.agentChanged(agent.id);
    return this.agentInfo(agent);
  }

  removeAgent(id: string): void {
    this.agent(id);
    this.backends.stop(id);
    this.state.commit([ops.removeAgent(id)]);
    this.broadcast(Agents.removed, { id });
  }

  /** The agent's own instructions, as its file says right now. */
  instructions(agentId: string): string {
    const file = this.paths.instructions(agentId);
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  }

  /** The agent's role as its files say right now, if it has one. */
  role(agent: AgentSpec): Role | undefined {
    return agent.role ? loadRole(this.paths, agent.role) : undefined;
  }

  /**
   * The team: what its agents can make, as their roles declare it right now.
   * Nothing stores it; it is the contracts of the roles that have agents.
   */
  team(): Contract[] {
    const agents = [...this.state.agents.values()];
    return [...new Set(agents.flatMap((a) => a.role ?? []))].flatMap((name) => {
      const members = agents.filter((a) => a.role === name).map((a) => a.id);
      return loadRole(this.paths, name)
        .skills.filter((s) => s.produces)
        .map((s) => ({ produces: s.produces!, inputs: s.inputs, agents: members }));
    });
  }

  /**
   * The MCP servers a session of the agent gets besides the hub's own: those every agent has (what the client that
   * started the hub gives them, such as the desktop app's browser), the role's (one of the same name takes the place
   * of a common one), and those the client that created the session asked for. Each with where it comes from.
   */
  toolServers(agent: AgentSpec, clientMcp: McpServer[] = []): { server: McpServer; from: ToolOrigin }[] {
    const own = this.role(agent)?.mcpServers ?? [];
    const common = commonServers().filter((server) => !own.some((s) => s.name === server.name));
    return [
      ...common.map((server) => ({ server, from: "app" as const })),
      // A role's servers are told where the project counts what generation costs, and whom they work for.
      ...own.map((server) => ({ server: this.spending.withLedger(server, agent.id), from: "role" as const })),
      ...clientMcp.map((server) => ({ server, from: "client" as const })),
    ];
  }

  /** The role's instructions, then the agent's own; and where the tools a session of it gets come from. */
  systemPromptFor(agent: AgentSpec, clientMcp: McpServer[] = []): string {
    const role = this.role(agent);
    const instructions = [role?.instructions, this.instructions(agent.id)].filter((t) => t?.trim()).join("\n\n");
    const tools = this.toolServers(agent, clientMcp).map(({ server, from }) => ({ name: server.name, from }));
    return systemPrompt(agent, instructions, role?.skills ?? [], this.team(), this.paths, this.state, projectLanguage(this.paths), tools);
  }

  agentChanged(agentId: string): void {
    const agent = this.state.agents.get(agentId);
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

  createSession(agentId: string, clientMcp: McpServer[] = [], work?: { topic: string; continues?: string }): LiveSession {
    this.agent(agentId);
    const rec: SessionRec = {
      id: newId("ses"),
      agentId,
      main: !this.state.mainSession(agentId),
      ...work,
      createdAt: now(),
      updatedAt: now(),
    };
    this.state.commit([ops.putSession(rec)]);
    const session = this.track(new LiveSession(this, rec));
    session.clientMcp = clientMcp;
    this.agentChanged(agentId);
    return session;
  }

  /**
   * The session an agent does a peer's work of a topic in: its work session of that topic, made when there is none.
   * One that has grown past `limits.sessionTokens` takes no new work: a new one continues it, handed its conversation
   * (session.ts), and the old one finishes what it has.
   */
  workSession(agentId: string, topic: string): LiveSession {
    this.mainSession(agentId); // the main session is the first an agent has
    const current = this.findWorkSession(agentId, topic);
    if (current && (current.rec.used ?? 0) < sessionTokens(this.paths)) return current;
    if (current) current.save({ retired: true });
    return this.createSession(agentId, [], { topic: topicKey(topic), continues: current?.id });
  }

  /**
   * Whether a session may run the turn it has next. The user's sessions always may; a work session may while the
   * agent has fewer other work sessions running a turn than the work allows: one, or `limits.sessionsAtOnce` for
   * a task dispatched as `parallel` (and for the results that come back to it).
   */
  mayRun(session: LiveSession, item: MailItem | undefined): boolean {
    if (!session.rec.topic) return true;
    const task = item?.taskId ? this.state.tasks.get(item.taskId) : undefined;
    const allowed = task?.parallel ? (loadProjectConfig(this.paths).limits?.sessionsAtOnce ?? SESSIONS_AT_ONCE) : 1;
    const running = [...this.live.values()].filter((s) => s !== session && s.agentId === session.agentId && s.rec.topic && s.current).length;
    return running < allowed;
  }

  /** Let the agent's other sessions that wait for a place try again. */
  wake(agentId: string, except: LiveSession): void {
    for (const s of this.live.values()) if (s !== except && s.agentId === agentId && s.rec.topic) s.pump();
  }

  /** The agent's current work session of a topic, if it has one. */
  findWorkSession(agentId: string, topic: string | undefined): LiveSession | undefined {
    if (!topic) return undefined;
    const key = topicKey(topic);
    return [...this.live.values()].find((s) => s.agentId === agentId && s.rec.topic === key && !s.rec.retired);
  }

  /** The session an agent receives its peers' mail in. */
  mainSession(agentId: string): LiveSession {
    const rec = this.state.mainSession(agentId);
    return rec ? this.live.get(rec.id)! : this.createSession(agentId);
  }

  private track(session: LiveSession): LiveSession {
    this.live.set(session.id, session);
    this.bridgeTokens.set(session.bridgeToken, session);
    return session;
  }
}
