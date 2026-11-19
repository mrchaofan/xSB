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
import { AGENT_ID, Agents, Connection, Ledger, RpcError, Tasks, failure } from "@xsb/protocol";
import type { AgentInfo, AgentSpec, McpServer } from "@xsb/protocol";
import { Store } from "@xsb/store";
import { Client } from "./acp-server.ts";
import { Assets } from "./assets.ts";
import { auditHook, auditReports } from "./audit.ts";
import { BackendPool } from "./backends.ts";
import { DEFAULT_BACKEND, loadProjectConfig, migrateProjectConfig, projectLanguage } from "./config.ts";

import { Delivery } from "./delivery.ts";
import { Hooks } from "./hooks.ts";
import { Jobs } from "./jobs.ts";
import { Kernel } from "./kernel.ts";
import type { KernelHooks } from "./kernel.ts";
import { commonServers, serveMcp } from "./mcp.ts";
import { Paths } from "./paths.ts";
import { Permissions } from "./permissions.ts";
import { systemPrompt } from "./prompts.ts";
import type { ToolOrigin } from "./prompts.ts";
import { catalog } from "./presets.ts";
import { copyTemplate } from "./templates.ts";
import { loadRole } from "./roles.ts";
import type { Contract, Role } from "./roles.ts";
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
  /** Set by `shutdown`: turns that die with it stay unacknowledged and run again on the next start. */
  stopping = false;

  private servers: net.Server[] = [];
  /** Bridge token -> session: how a tool call is known to come from that session. */
  private bridgeTokens = new Map<string, LiveSession>();

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
    this.permissions = new Permissions(this);
    this.assets = new Assets(this);
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
    const migrated = migrateProjectConfig(this.paths);
    if (migrated) this.log(migrated);
    const sources = catalog(projectLanguage(this.paths));
    for (const id of loadProjectConfig(this.paths).teams ?? []) {
      try { copyTemplate(this.paths, sources, id); }
      catch (e) { this.log(`template snapshot ${id}: ${(e as Error).message}`); }
    }
    await this.listen(this.paths.socket("acp"), (socket) => {
      const client = new Client(this, new Connection(socket, socket, "client"));
      this.clients.add(client);
      void client.conn.closed.then(() => this.clients.delete(client));
    });
    await this.listen(this.paths.socket("mcp"), (socket) => {
      serveMcp(this, new Connection(socket, socket, "mcp"), (token) => this.bridgeTokens.get(token));
    });
    // Whoever stopped the last hub may have said that its unfinished work is not to be taken up again.
    if (fs.existsSync(this.paths.abandonMark)) {
      const { mail, tasks } = this.kernel.abandon();
      fs.rmSync(this.paths.abandonMark);
      this.log(`gave up what the last stop left unfinished, as asked: ${mail} mail items, ${tasks} tasks`);
    }
    const pending = this.state.mail.size;
    this.kernel.resume();
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
    return { ...agent, state, mainSessionId: this.state.mainSession(agent.id)?.id };
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
      workspace: input.workspace ?? prior?.workspace ?? this.paths.project,
      ...(roleName ? { role: roleName } : {}),
      createdAt: prior?.createdAt ?? now(),
    };
    this.backends.spec(agent); // refuse a backend this machine does not have
    fs.mkdirSync(agent.workspace, { recursive: true });
    fs.mkdirSync(this.paths.scratch(agent.id), { recursive: true });
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
  toolServers(agent: AgentSpec, clientMcp: McpServer[] = []): { server: McpServer; from: ToolOrigin; about?: string }[] {
    const role = this.role(agent);
    const own = role?.mcpServers ?? [];
    const common = commonServers().filter(({ server }) => !own.some((s) => s.name === server.name));
    return [
      ...common.map(({ server, about }) => ({ server, from: "app" as const, about })),
      ...own.map((server) => ({ server, from: "role" as const, about: role?.servers[server.name]?.about })),
      ...clientMcp.map((server) => ({ server, from: "client" as const })),
    ];
  }

  /** The role's instructions, then the agent's own; and where the tools a session of it gets come from. */
  systemPromptFor(agent: AgentSpec, clientMcp: McpServer[] = []): string {
    const role = this.role(agent);
    const instructions = [role?.instructions, this.instructions(agent.id)].filter((t) => t?.trim()).join("\n\n");
    const tools = this.toolServers(agent, clientMcp).map(({ server, from, about }) => ({ name: server.name, from, about }));
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
    this.bridgeTokens.delete(session.bridgeToken);
    session.bridgeToken = newId("tok");
    this.bridgeTokens.set(session.bridgeToken, session);
  }
}
