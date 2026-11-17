/**
 * A live session: one conversation of one agent, and the engine that runs its
 * turns.
 *
 * A session does one thing at a time. Input from the user, from peers and from
 * the hub lands in one queue and is run in order, each as a *turn*. A turn is
 * the hub's unit: whoever waits for it (a `session/prompt` caller, a task) sees
 * one turn with one end, whatever the backend needed to get there.
 */
import { OriginExt, RpcError, failure, errorMessage, text } from "@xsb/protocol";
import type {
  ContentBlock,
  McpServer,
  OriginMeta,
  PermissionRequest,
  PermissionResponse,
  SessionUpdate,
  SteeringOutcome,
  StopReason,
} from "@xsb/protocol";
import type { Client } from "./acp-server.ts";
import type { Backend } from "./backend.ts";
import type { Hub } from "./hub.ts";
import { bridgeServer } from "./mcp.ts";
import { Paths } from "./paths.ts";
import { CONTEXT_LOST, asPreface } from "./prompts.ts";
import type { MailItem, SessionRec } from "./state.ts";
import { ops } from "./state.ts";
import type { Deferred } from "./util.ts";
import { deferred, newId, now } from "./util.ts";

export type TurnRequest = {
  origin: OriginMeta;
  prompt: ContentBlock[];
  /** The mail this turn delivers, if it came from the mailbox. */
  item?: MailItem;
  /** The client that sent it. It is not sent its own message back unless it asked to be (`Client.echo`). */
  from?: Client;
};

type Queued = TurnRequest & { done: Deferred<{ stopReason: StopReason }> };

export type Turn = {
  req: Queued;
  /** What the backend is prompted with. Messages steered in before that happens are added to it. */
  prompt: ContentBlock[];
  /** The backend has been prompted. */
  started: boolean;
  cancelled: boolean;
  /** Agent text since the last tool call: what the turn ends up saying. */
  lastText: string;
};

export class LiveSession {
  rec: SessionRec;
  /** What this session's tool bridge presents to the hub. Valid as long as the hub runs. */
  readonly bridgeToken = newId("tok");
  readonly clients = new Set<Client>();
  current?: Turn;
  /** What `session/new` of the backend answered: modes, config options. */
  setup: { modes?: unknown; configOptions?: unknown } = {};
  /** MCP servers the creating client asked for, passed on next to the hub's own. */
  clientMcp: McpServer[] = [];

  private hub: Hub;
  private queue: Queued[] = [];
  private backend?: Backend;
  private binding?: Promise<void>;
  /** Text to put in front of the next prompt. */
  private prefaces: string[] = [];

  constructor(hub: Hub, rec: SessionRec) {
    this.hub = hub;
    this.rec = rec;
  }

  get id(): string {
    return this.rec.id;
  }
  get agentId(): string {
    return this.rec.agentId;
  }
  get busy(): boolean {
    return !!this.current || this.queue.length > 0;
  }

  // ---- backend binding ----------------------------------------------------

  /** The backend process with this session open in it. */
  async ensureBackend(): Promise<Backend> {
    const backend = await this.hub.backends.for(this.hub.agent(this.agentId));
    if (this.backend !== backend) {
      this.binding ??= this.bind(backend).finally(() => (this.binding = undefined));
      await this.binding.catch((e) => {
        throw this.explain(e, backend);
      });
    }
    return backend;
  }

  private async bind(backend: Backend): Promise<void> {
    const agent = this.hub.agent(this.agentId);
    const role = this.hub.role(agent);
    const instructions = this.hub.systemPromptFor(agent, this.clientMcp);
    const { paths } = this.hub;
    const params = {
      cwd: agent.workspace,
      // The hub's own tools, then the others the agent has (Hub.toolServers): the system prompt says where each comes from.
      mcpServers: [bridgeServer(paths.socket("mcp"), this.bridgeToken), ...this.hub.toolServers(agent, this.clientMcp).map((t) => t.server)],
      ...(backend.caps.systemPrompt ? { systemPrompt: { mode: "append", content: [text(instructions)] } } : {}),
      ...(backend.caps.additionalDirectories
        ? { additionalDirectories: [paths.shared, paths.assets, ...(role ? [role.dir] : [])] }
        : {}),
    };

    const prior = this.rec.backendSessionId;
    if (prior) {
      try {
        if (backend.caps.resume) {
          this.setup = await backend.conn.request("session/resume", { sessionId: prior, ...params });
        } else if (backend.caps.loadSession) {
          // The history the backend replays is not routed yet, and need not be: the hub has it.
          this.setup = await backend.conn.request("session/load", { sessionId: prior, ...params });
        } else {
          throw new Error("the backend cannot restore sessions");
        }
        backend.open(prior, this);
        this.backend = backend;
        return;
      } catch (e) {
        this.hub.log(`${this.id}: backend session ${prior} not restored (${errorMessage(e)}), starting a new one`);
        this.prefaces.push(CONTEXT_LOST);
      }
    }

    const created = await backend.conn.request("session/new", params);
    this.setup = created;
    // Without the system prompt capability the instructions ride on the first prompt.
    if (!backend.caps.systemPrompt) this.prefaces.push(asPreface(instructions));
    this.save({ backendSessionId: created.sessionId });
    backend.open(created.sessionId, this);
    this.backend = backend;
  }

  /** ACP's `auth_required` says nothing about which of several agents needs what. */
  private explain(e: unknown, backend?: Backend): unknown {
    if (!(e instanceof RpcError) || e.code !== -32000 || !backend || backend.conn.isClosed) return e;
    return failure("auth_required", {
      detail: e.message,
      agent: this.agentId,
      backend: this.hub.agent(this.agentId).backend,
      info: backend.info,
      authMethods: backend.authMethods,
    });
  }

  /** The backend process is gone; the next turn binds to a new one. */
  onBackendGone(backend: Backend): void {
    if (this.backend === backend) this.backend = undefined;
  }

  onBackendPermission(request: PermissionRequest): Promise<PermissionResponse> {
    return this.hub.permissions.request(this, request);
  }

  save(patch: Partial<SessionRec>): void {
    this.rec = { ...this.rec, ...patch, updatedAt: now() };
    this.hub.state.commit([ops.putSession(this.rec)]);
  }

  // ---- updates ------------------------------------------------------------

  /** An update from the backend. */
  onBackendUpdate(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "user_message_chunk":
        return; // the hub reports user input itself, with its origin
      case "tool_call":
        if (this.current) this.current.lastText = "";
        break;
      case "agent_message_chunk":
        if (this.current && update.content?.type === "text") this.current.lastText += update.content.text;
        break;
      case "session_info_update":
        if (typeof update.title === "string" && update.title !== this.rec.title) this.save({ title: update.title });
        break;
    }
    this.emit(update);
  }

  /** Record an update and show it to every attached client but `except`. */
  emit(update: SessionUpdate, except?: Client): void {
    this.hub.state.store.append(Paths.transcript(this.agentId, this.id), { ts: now(), update }, false);
    for (const client of this.clients) {
      if (client !== except) client.conn.notify("session/update", { sessionId: this.id, update });
    }
  }

  private emitInput(prompt: ContentBlock[], origin: OriginMeta, from?: Client): void {
    const messageId = origin.messageId ?? newId("m");
    for (const content of prompt) {
      this.emit({ sessionUpdate: "user_message_chunk", content, messageId, _meta: { [OriginExt.key]: origin } }, from?.echo ? undefined : from);
    }
  }

  // ---- turns --------------------------------------------------------------

  /** Queue input as a turn of its own. Resolves when that turn ends. */
  enqueue(req: TurnRequest): Promise<{ stopReason: StopReason }> {
    const queued: Queued = { ...req, done: deferred() };
    this.queue.push(queued);
    this.pump();
    return queued.done.promise;
  }

  /** Take queued mail back out before it runs. */
  withdraw(match: (item: MailItem) => boolean): MailItem[] {
    const taken: MailItem[] = [];
    this.queue = this.queue.filter((q) => {
      if (!q.item || !match(q.item)) return true;
      taken.push(q.item);
      q.done.resolve({ stopReason: "cancelled" });
      return false;
    });
    return taken;
  }

  private pump(): void {
    if (this.current) return;
    const next = this.queue.shift();
    if (next) void this.run(next);
  }

  private async run(req: Queued): Promise<void> {
    const turn: Turn = { req, prompt: [...req.prompt], started: false, cancelled: false, lastText: "" };
    this.current = turn;
    this.hub.mail.turnStarted(turn);
    this.hub.agentChanged(this.agentId);
    this.emitInput(req.prompt, req.origin, req.from);

    let stopReason: StopReason = "cancelled";
    let failure: unknown;
    let backend: Backend | undefined;
    try {
      backend = await this.ensureBackend();
      if (!turn.cancelled) {
        turn.started = true;
        const preface = this.prefaces.splice(0).map((p) => text(p));
        stopReason = await backend.prompt(this.rec.backendSessionId!, [...preface, ...turn.prompt], req.origin);
      }
    } catch (e) {
      failure = this.explain(e, backend);
    }

    // From here to `pump` nothing awaits: a steer either reached the turn
    // above or finds none and starts its own.
    this.current = undefined;
    // While the hub stops, nothing is acknowledged: the turn runs again on the next start.
    if (!this.hub.stopping) {
      if (failure) this.hub.log(`${this.agentId}/${this.id}: turn failed: ${errorMessage(failure)}`);
      this.hub.mail.turnEnded(this, turn, stopReason, failure);
      this.hub.agentChanged(this.agentId);
    }
    if (failure) req.done.reject(failure);
    else req.done.resolve({ stopReason });
    this.pump();
  }

  /**
   * Put a message into the running turn (see `Steering` in @xsb/protocol).
   * How it gets there is the backend's business (backend.ts); with no turn
   * running, `whenIdle` decides whether the message starts one.
   *
   * A message that is still waiting for its turn and is steered under its own
   * id is that message, sent now: it leaves the queue, and its `session/prompt`
   * ends as cancelled, for the turn it asked for never runs.
   */
  async steer(prompt: ContentBlock[], origin: OriginMeta, whenIdle: "start" | "promptRequired", from?: Client): Promise<SteeringOutcome> {
    const waiting = origin.messageId ? this.queue.findIndex((queued) => queued.origin.messageId === origin.messageId) : -1;
    if (waiting < 0) return this.steerNow(prompt, origin, whenIdle, from);
    const [queued] = this.queue.splice(waiting, 1);
    try {
      const outcome = await this.steerNow(prompt, origin, whenIdle, from);
      queued.done.resolve({ stopReason: "cancelled" });
      return outcome;
    } catch (e) {
      this.queue.unshift(queued); // it did not get there: it keeps its turn
      throw e;
    }
  }

  private async steerNow(prompt: ContentBlock[], origin: OriginMeta, whenIdle: "start" | "promptRequired", from?: Client): Promise<SteeringOutcome> {
    const turn = this.current;
    const steered = { ...origin, steered: true };
    let how: "injected" | "interrupted" | "idle" = "idle";
    if (turn && !turn.started) {
      turn.prompt.push(...prompt);
      how = "injected";
    } else if (turn && this.backend) {
      how = await this.backend.steer(this.rec.backendSessionId!, prompt, steered);
    }
    if (how === "idle") {
      if (whenIdle === "promptRequired") return { outcome: "promptRequired", reason: "noRunningTurn" };
      void this.enqueue({ origin, prompt, from });
      return { outcome: "startedNewTurn" };
    }
    if (how === "interrupted") this.hub.permissions.cancel(this);
    this.emitInput(prompt, steered, from);
    return { outcome: "injected" };
  }

  /** Stop the running turn. Queued turns stay queued. */
  cancel(): void {
    const turn = this.current;
    if (!turn) return;
    turn.cancelled = true;
    this.hub.permissions.cancel(this);
    if (turn.started) this.backend?.cancel(this.rec.backendSessionId!);
  }
}
