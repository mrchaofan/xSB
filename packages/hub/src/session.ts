/**
 * A live session: one conversation of one agent, and the engine that runs its
 * turns over ACP v2.
 *
 * A session does one thing at a time. Input from the user, from peers and from
 * the hub becomes a *turn*, or goes into the one that runs. A turn is the hub's
 * unit: it begins with the prompt the hub gives the backend and ends with the
 * backend's `idle` once nothing the hub gave it is still on its way in. Whoever
 * waits for it sees one turn with one end, however often the backend went
 * running and idle on the way (a backend that holds a prompt runs it after the
 * work it was doing).
 *
 * Every input has a receipt: it is inserted into the backend's conversation
 * (the answer to `session/prompt`), or it never will be (-32800, or stopped
 * while the hub still held it). At most one prompt of the session is on its way
 * to the backend at a time; what comes meanwhile waits in the hub, the user's
 * ahead of the rest, so that the user's word goes in first whatever the backend
 * does with what it holds.
 */
import { Boundaries, Discarded, OriginExt, TurnFailure, RpcError, failure, errorMessage, isStateUpdate, isTerminal, text } from "@xsb/protocol";
import type { Boundary, ContentBlock, McpServer, Origin, OriginMeta, PermissionRequest, PermissionResponse, SessionUpdate, StopReason } from "@xsb/protocol";
import type { Client } from "./acp-server.ts";
import type { Backend } from "./backend.ts";
import type { Hub } from "./hub.ts";
import { bridgeServer } from "./mcp.ts";
import { sessionTokens } from "./config.ts";
import { Paths } from "./paths.ts";
import { asPreface, handoff } from "./prompts.ts";
import type { Gives, Renewal } from "./prompts.ts";
import { turnsSinceCleared } from "./transcript.ts";
import type { MailItem, SessionRec } from "./state.ts";
import { ops } from "./state.ts";
import type { Deferred } from "./util.ts";
import { deferred, newId, now } from "./util.ts";

export type TurnRequest = {
  origin: OriginMeta;
  prompt: ContentBlock[];
  /** What the prompt gives in full (prompts.ts, `renderMail`). */
  gives?: Gives;
  /** The mail it delivers, if it came from the inbox. */
  item?: MailItem;
  /** The client that sent it. It is not sent its own message back unless it asked to be (`Client.echo`). */
  from?: Client;
};

/** How many of the agent's latest assets a handoff lists. */
const HANDOFF_ASSETS = 30;

/** Who an input is attributed to in the ledger. */
const fromOf = (origin: OriginMeta): Origin => (origin.kind === "agent" ? { kind: "agent", agentId: origin.agentId, sessionId: origin.sessionId } : { kind: origin.kind });

/** Updates of a backend the hub does not pass on: it reports input and the state of its turns itself. */
const OWN = new Set(["user_message", "user_message_chunk", "state_update"]);

/** Whether input is the user's: theirs to stop. Everything else (a peer's, xsb's) is mail, which a stop does not drop. */
const users = (input: Input): boolean => input.origin.kind === "user";

/** One message of input on its way into the conversation. `inserted` settles with its receipt. */
export type Input = Discarded & TurnRequest & { inserted: Deferred<void>; shown?: boolean };
const inputOf = (req: TurnRequest): Input => {
  const messageId = req.origin.messageId ?? newId("m");
  const inserted = deferred<void>();
  return { ...req, messageId, origin: { ...req.origin, messageId }, content: req.prompt, inserted };
};

/** How a turn ended. */
export type TurnEnd = { stopReason: StopReason; failure?: unknown };

export type Turn = {
  first: Input;
  /** Every input of the turn, in the order it came. */
  inputs: Input[];
  /** Inputs the hub holds until the backend takes the one on its way, the user's first. */
  waiting: Input[];
  /** The inputs of the prompt on its way to the backend. */
  submitting?: Input[];
  /** Something of the turn is in the conversation: its end is the backend's next idle with nothing on the way. */
  inserted: boolean;
  /** The mail this turn gives the model. It leaves the inbox when the turn ends. */
  items: MailItem[];
  /** The backend has been prompted. */
  started: boolean;
  /** Who stopped it: the user (their client), or the hub, for the work it ran for was stopped (`halt`). */
  cancelledBy?: "user" | "hub";
  /** The agent's messages of the turn by id, and the last one: what the turn ends up saying. */
  messages: Map<string, string>;
  lastMessage?: string;
  done: Deferred<TurnEnd>;
};

/** What the turn ends up saying: its last agent message. */
export const lastText = (turn: Turn): string => (turn.lastMessage ? (turn.messages.get(turn.lastMessage) ?? "") : "");

export class LiveSession {
  rec: SessionRec;
  /** What this session's tool bridge presents to the hub. Valid as long as the hub runs. */
  readonly bridgeToken = newId("tok");
  readonly clients = new Set<Client>();
  current?: Turn;
  /** What `session/new` or `session/resume` of the backend answered: config options, commands. */
  setup: { configOptions?: unknown; availableCommands?: unknown } = {};
  /** MCP servers the creating client asked for, passed on next to the hub's own. */
  clientMcp: McpServer[] = [];

  private hub: Hub;
  /** Input that waits for a turn of its own. */
  private queue: Input[] = [];
  private backend?: Backend;
  private binding?: Promise<void>;
  /** Text to put in front of the next prompt. */
  private prefaces: string[] = [];
  /** What this session was last told of the project's spending: it is told again when that changes. */
  private toldSpend?: string;
  /**
   * What the model of this session has been given in full, so that it is not given the same again: asset id ->
   * the version and the task it came with, and memory notes by topic key -> the version (updatedAt) it saw. Only
   * for as long as the backend session has it: a boundary empties both, and so does a restart of the hub.
   */
  readonly given = { assets: new Map<string, { version: number; taskId?: string }>(), notes: new Map<string, string>() };
  /** Context in use at the end of the backend's last report, in tokens. */
  private used?: number;
  /** The backend's work is idle, as it last said, and why it stopped. */
  private backendIdle = true;
  private lastStop: { stopReason: StopReason; error?: { code: number; message: string; data?: unknown } | null } = { stopReason: "end_turn" };
  /**
   * The backend went running since the hub last gave it a prompt. Its answer to the prompt and its report of the work
   * for it may come in either order: an idle that comes before the answer is the end of that work only if it ran.
   */
  private ranSince = false;

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

  /** The agents whose chat this session is reading in its running turn: it may answer them (capabilities.ts). */
  senders(): string[] {
    return (this.current?.items ?? []).flatMap((m) => (m.kind === "message" && m.from.kind === "agent" ? [m.from.agentId] : []));
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
        ? { additionalDirectories: [paths.shared, paths.assets, ...(role ? (role.layers ?? [role.dir]) : [])] }
        : {}),
    };

    const prior = this.rec.backendSessionId;
    // A backend session of another backend is not that backend's to restore: the conversation is handed over instead.
    let renewal: Renewal | undefined = prior && this.rec.backend && this.rec.backend !== agent.backend ? "backend_changed" : undefined;
    // A conversation that grew too long goes on in a new backend session, handed what came before (`renew`).
    if (!prior && this.rec.renew) renewal = "renewed";
    if (prior && !renewal) {
      try {
        // Every ACP v2 agent resumes; the history is not replayed (the hub has it).
        backend.open(prior, this);
        this.setup = await backend.conn.request("session/resume", { sessionId: prior, ...params });
        this.backend = backend;
        if (!this.rec.backend) this.save({ backend: agent.backend });
        return;
      } catch (e) {
        this.hub.log(`${this.id}: backend session ${prior} not restored (${errorMessage(e)}), starting a new one`);
        renewal = "not_restored";
      }
    }

    const created = await backend.conn.request("session/new", params);
    this.setup = created;
    // Without the system prompt capability the instructions ride on the first prompt.
    if (!backend.caps.systemPrompt) this.prefaces.push(asPreface(instructions));
    this.save({ backendSessionId: created.sessionId, backend: agent.backend, renew: undefined });
    backend.open(created.sessionId, this);
    this.backend = backend;
    if (renewal) {
      this.forget();
      // The handoff is made before the boundary is written: what it tells is what precedes the boundary.
      this.prefaces.push(this.handoff(renewal));
      this.boundary({ kind: renewal, backend: agent.backend, handoff: true });
      this.hub.log(`${this.id}: ${renewal === "backend_changed" ? `now on backend "${agent.backend}"` : renewal === "renewed" ? "renewed, its conversation having grown long" : "backend session renewed"}, with a handoff of the conversation`);
    }
  }

  /** What a new backend session is told of this session's conversation, and of what is open (prompts.ts, `handoff`). */
  private handoff(why: Renewal): string {
    const { state } = this.hub;
    const ours = (sessionId: string): boolean => sessionId === this.id;
    const tasks = [...state.tasks.values()].filter((t) => !isTerminal(t.status) && ((t.from && ours(t.from.sessionId)) || ours(t.to.sessionId)));
    const waiting = [...state.gates.values()].filter((g) => ours(g.owner.sessionId)).map((g) => ({ taskIds: g.taskIds, mode: g.mode, note: g.note }));
    const assets = [...state.assets.values()]
      .map((versions) => versions.at(-1)!)
      .filter((a) => a.by === this.agentId)
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
      .slice(0, HANDOFF_ASSETS);
    return handoff(why, turnsSinceCleared(state.store, this.agentId, this.id), { tasks, waiting, assets });
  }

  /** Note that the model now has what a prompt gave it in full. */
  take(gives: Gives | undefined): void {
    for (const a of gives?.assets ?? []) this.given.assets.set(a.id, { version: a.version, taskId: a.taskId });
    for (const n of gives?.notes ?? []) this.given.notes.set(n.key, n.updatedAt);
  }

  /** The model starts anew: it has nothing it was given before. */
  private forget(): void {
    this.given.assets.clear();
    this.given.notes.clear();
    this.used = undefined;
  }

  /** Text to put in front of the next prompt of this session, whichever turn that is. */
  preface(text: string): void {
    this.prefaces.push(text);
  }

  /** Record, and show, where what the model sees of this session starts anew. */
  private boundary(boundary: Boundary): void {
    this.emit({ sessionUpdate: "session_info_update", _meta: { [Boundaries.key]: boundary } } as SessionUpdate);
    this.hub.kernel.hooks.emit("acp.session_renewed", { agentId: this.agentId, sessionId: this.id });
  }

  /**
   * Past `limits.sessionTokens` of context the conversation goes on in a new backend session, from its next turn:
   * that one is handed what came before (`renewed`). The session, and with it what the user and peers see of the
   * agent, stays the one it was.
   */
  private renewIfLong(): void {
    if (this.used === undefined || this.used < sessionTokens(this.hub.paths) || !this.backend) return;
    this.hub.log(`${this.agentId}/${this.id}: ${this.used} tokens of context; its next turn starts a new backend session`);
    this.backend = undefined;
    this.save({ backendSessionId: undefined, renew: true });
  }

  /**
   * The user clears the context: the next turn starts a backend session that is given nothing of the conversation
   * so far. The transcript keeps it all, behind a boundary that says the model does not see it.
   */
  clear(): void {
    if (this.busy) throw failure("session_busy", { agent: this.agentId });
    this.prefaces = [];
    this.forget();
    this.backend = undefined;
    this.save({ backendSessionId: undefined });
    this.boundary({ kind: "cleared", handoff: false });
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

  /** The backend process is gone; the next turn binds to a new one. A turn it was running fails. */
  onBackendGone(backend: Backend, reason: string): void {
    if (this.backend !== backend) return;
    this.backend = undefined;
    if (this.current?.started) this.end({ stopReason: "error", failure: new Error(`the agent program ${reason}`) });
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
    const turn = this.current;
    switch (update.sessionUpdate) {
      case "user_message":
      case "user_message_chunk":
        // The backend's echo of the prompt on its way: it is in, and what it says next follows it in the transcript.
        for (const input of turn?.submitting ?? []) this.show(input);
        break;
      case "state_update":
        if (!isStateUpdate(update)) break;
        this.backendIdle = update.state === "idle";
        if (!this.backendIdle) this.ranSince = true;
        else {
          this.lastStop = { stopReason: update.stopReason ?? "end_turn", error: update.error };
          this.idle();
        }
        break;
      case "agent_message_chunk":
        if (turn && update.content?.type === "text") {
          const id = String(update.messageId ?? "");
          turn.messages.set(id, (turn.lastMessage === id ? (turn.messages.get(id) ?? "") : "") + update.content.text);
          turn.lastMessage = id;
        }
        break;
      case "agent_message":
        if (turn && Array.isArray(update.content)) {
          turn.messages.set(update.messageId, update.content.map((b: ContentBlock) => (b.type === "text" ? b.text : "")).join(""));
          turn.lastMessage = update.messageId;
        }
        break;
      case "session_info_update":
        if (typeof update.title === "string" && update.title !== this.rec.title) this.save({ title: update.title });
        break;
      case "usage_update":
        if (typeof update.used === "number") this.used = update.used;
        break;
    }
    this.hub.kernel.hooks.emit("acp.session_update", { agentId: this.agentId, sessionId: this.id, update });
    if (!OWN.has(update.sessionUpdate)) this.emit(update);
  }

  /** Record an update and show it to every attached client but `except`. */
  emit(update: SessionUpdate, except?: Client): void {
    this.hub.state.store.append(Paths.transcript(this.agentId, this.id), { ts: now(), update }, false);
    for (const client of this.clients) {
      if (client !== except) client.conn.notify("session/update", { sessionId: this.id, update });
    }
  }

  /** The state of the session's work, as its clients see it: the hub's turns, not the backend's runs. */
  private state(state: "running" | "idle", end?: TurnEnd): void {
    const error = end?.failure ? { code: end.failure instanceof RpcError ? end.failure.code : -32603, message: errorMessage(end.failure), data: (end.failure as RpcError).data } : undefined;
    const update = { sessionUpdate: "state_update", state, ...(end ? { stopReason: end.stopReason } : {}), ...(error ? { error } : {}) };
    for (const client of this.clients) client.conn.notify("session/update", { sessionId: this.id, update });
  }

  /** Show an input, once: when it gets into the conversation. */
  private show(input: Input): void {
    if (input.shown) return;
    input.shown = true;
    this.emitInput(input);
  }

  private emitInput({ messageId, origin, content, from }: Input): void {
    for (const block of content) {
      this.emit({ sessionUpdate: "user_message_chunk", content: block, messageId, _meta: { [OriginExt.key]: origin } }, from?.echo ? undefined : from);
    }
  }

  /** Record, and show, that the model never saw this input (see `Discarded` in @xsb/protocol); `why` it did not. */
  private discard(input: Input, why?: unknown): void {
    const { messageId, origin, content } = input;
    this.emit({ sessionUpdate: "session_info_update", _meta: { [Discarded.key]: { messageId, origin, content } } } as SessionUpdate);
    this.receipt(input, false, why);
  }

  /** The receipt of an input: it is in the conversation, or it never will be. Its sender learns which. */
  private receipt(input: Input, inserted: boolean, why: unknown = RpcError.cancelled()): void {
    const about = { agentId: this.agentId, sessionId: this.id, from: fromOf(input.origin), ...(input.origin.taskId ? { taskId: input.origin.taskId } : {}) };
    this.hub.kernel.hooks.emit("message.insertion_receipt", { messageId: input.messageId, about, inserted });
    if (inserted) {
      this.show(input);
      input.inserted.resolve();
    } else input.inserted.reject(why);
  }

  // ---- turns --------------------------------------------------------------

  /** Queue input as a turn of its own (`first`: ahead of what waits; the user's). Resolves once it is inserted. */
  enqueue(req: TurnRequest, first = false): Input {
    const input = inputOf(req);
    if (first) this.queue.unshift(input);
    else this.queue.push(input);
    this.pump();
    return input;
  }

  /** Take queued mail back out before it runs. */
  withdraw(match: (item: MailItem) => boolean): MailItem[] {
    const taken: MailItem[] = [];
    this.queue = this.queue.filter((q) => {
      if (!q.item || !match(q.item)) return true;
      taken.push(q.item);
      q.inserted.reject(RpcError.cancelled());
      return false;
    });
    return taken;
  }

  /** Start the next queued turn, when there is one and none runs. */
  pump(): void {
    if (this.current) return;
    const next = this.queue.shift();
    if (!next) return;
    void this.run(next);
  }

  private async run(first: Input): Promise<void> {
    const turn: Turn = { first, inputs: [first], waiting: [], inserted: false, items: first.item ? [first.item] : [], started: false, messages: new Map(), done: deferred() };
    this.current = turn;
    this.hub.delivery.given(turn.items);
    this.hub.agentChanged(this.agentId);
    this.state("running");
    try {
      await this.ensureBackend();
    } catch (e) {
      return this.end({ stopReason: "error", failure: e });
    }
    if (turn.cancelledBy) return this.end({ stopReason: "cancelled" });
    turn.started = true;
    this.take(first.gives);
    // What waited in the inbox comes with this turn.
    const digest = this.hub.delivery.digest(this).map((d) => {
      const input = inputOf(d);
      turn.inputs.push(input);
      turn.items.push(d.item);
      this.take(d.gives);
      return input;
    });
    const spend = this.hub.spending.line();
    if (spend && spend !== this.toldSpend) this.prefaces.push(spend);
    this.toldSpend = spend;
    this.submit([first, ...digest, ...turn.waiting.splice(0)]);
  }

  /** Give the backend one prompt made of `inputs`; when it is in, what waited meanwhile follows. */
  private submit(inputs: Input[]): void {
    const turn = this.current!;
    const backend = this.backend;
    if (!backend) return this.end({ stopReason: "error", failure: new Error("the agent program is gone") });
    turn.submitting = inputs;
    this.ranSince = false;
    const preface = this.prefaces.splice(0).map((p) => text(p));
    backend.prompt(this.rec.backendSessionId!, [...preface, ...inputs.flatMap((i) => i.content)], inputs[0].origin).then(
      () => {
        if (this.current !== turn) return;
        turn.submitting = undefined;
        turn.inserted = true;
        for (const input of inputs) this.receipt(input, true);
        if (turn.waiting.length) this.submit(turn.waiting.splice(0));
        // The work for it was reported before the answer, and is done; or the turn is being stopped, and the idle that
        // came before the answer (in the same read, notifications are handled before answers) was the stop's.
        else if (this.idleSince(turn)) this.idle();
      },
      (e) => {
        if (this.current !== turn) return;
        turn.submitting = undefined;
        if (e instanceof RpcError && e.code === RpcError.CANCELLED) {
          for (const input of inputs) this.giveBack(input);
          return this.settle();
        }
        const failure = this.explain(e, backend);
        // They did not get in: whoever sent them is answered with why.
        for (const input of inputs) this.discard(input, failure);
        this.end({ stopReason: "error", failure });
      },
    );
  }

  /** The backend's work is idle. The turn ends with it unless something the hub gave is still on its way in. */
  private idle(): void {
    const turn = this.current;
    const { stopReason, error } = this.lastStop;
    if (!turn?.inserted || turn.submitting) return;
    if (stopReason === "error") return this.end({ stopReason, failure: new RpcError(error?.code ?? -32603, error?.message ?? "the agent failed", error?.data) });
    if (turn.waiting.length) return this.submit(turn.waiting.splice(0));
    this.end({ stopReason });
  }

  /** After a stop: a turn that has nothing left on the way ends once the backend is idle (or at once, if nothing went in). */
  private settle(): void {
    const turn = this.current;
    if (!turn || turn.submitting) return;
    if (turn.waiting.length) return this.submit(turn.waiting.splice(0));
    if (!turn.inserted) this.end({ stopReason: "cancelled" });
    else if (this.idleSince(turn)) this.idle();
  }

  /**
   * The backend is idle, and that ends what the hub gave it: it went running after the last prompt, or the turn is
   * being stopped (then nothing will run, and no running will come to say so).
   */
  private idleSince(turn: Turn): boolean {
    return this.backendIdle && (this.ranSince || !!turn.cancelledBy);
  }

  /**
   * Input that did not get in. The user's is discarded: they stopped it. Mail is not theirs: it waits for a turn of
   * its own, and leaves this one.
   */
  private giveBack(input: Input): void {
    const turn = this.current;
    if (users(input) || !input.item) return this.discard(input);
    if (turn) {
      turn.items = turn.items.filter((m) => m !== input.item);
      turn.inputs = turn.inputs.filter((i) => i !== input);
    }
    const again = inputOf({ ...input, origin: { ...input.origin, steered: undefined } });
    again.inserted.promise.then(input.inserted.resolve, input.inserted.reject);
    this.queue.unshift(again);
  }

  private end(end: TurnEnd): void {
    const turn = this.current;
    if (!turn) return;
    this.current = undefined;
    for (const input of [...turn.waiting, ...(turn.submitting ?? [])]) this.giveBack(input);
    if (!turn.started) for (const input of turn.inputs) this.discard(input, end.failure);
    if (this.used !== undefined && this.used !== this.rec.used) this.save({ used: this.used });
    // While the hub stops, nothing is acknowledged: the turn runs again on the next start.
    if (!this.hub.stopping) {
      if (end.failure) this.hub.log(`${this.agentId}/${this.id}: turn failed: ${errorMessage(end.failure)}`);
      // Its failure goes into the transcript, where the user sees it: the prompt that started it may have been answered long ago.
      if (end.failure) this.emit({ sessionUpdate: "session_info_update", _meta: { [TurnFailure.key]: { message: errorMessage(end.failure), data: (end.failure as RpcError).data } } } as SessionUpdate);
      this.hub.kernel.hooks.emit("acp.turn_ended", { agentId: this.agentId, sessionId: this.id, stopReason: end.stopReason, failed: !!end.failure });
      this.hub.delivery.turnEnded(this, turn, end);
      this.hub.agentChanged(this.agentId);
    }
    this.state("idle", end);
    turn.done.resolve(end);
    this.renewIfLong();
    this.pump();
  }

  /**
   * Put input into the running turn: it goes to the backend as soon as nothing else of the session is on its way
   * there, the user's ahead of the rest. Returns undefined when no turn runs. Mail put into the turn is the turn's to
   * give.
   */
  steer(req: TurnRequest): Input | undefined {
    const turn = this.current;
    if (!turn || turn.cancelledBy === "user") return undefined;
    const input = inputOf({ ...req, origin: { ...req.origin, steered: true } });
    const user = req.origin.kind === "user";
    const at = user ? turn.waiting.findIndex((i) => i.origin.kind !== "user") : -1;
    turn.waiting.splice(at < 0 ? turn.waiting.length : at, 0, input);
    turn.inputs.push(input);
    if (req.item) {
      turn.items.push(req.item);
      this.take(req.gives);
      this.hub.delivery.given([req.item]);
    }
    if (turn.started && !turn.submitting && turn.inserted) this.submit(turn.waiting.splice(0));
    return input;
  }

  /**
   * Stop, as Esc does in Claude Code and Codex: the backend stops its work, and what is not in the conversation yet
   * does not get there; the user's is discarded, mail waits for a turn of its own. A turn for mail that has not
   * reached the backend yet is not the user's to stop: only what the user put into it goes.
   */
  cancel(): void {
    const turn = this.current;
    if (!turn) return;
    this.hub.permissions.cancel(this);
    if (!turn.started && !users(turn.first)) {
      for (const input of turn.inputs.filter((i) => i !== turn.first && users(i))) this.discard(input);
      turn.inputs = turn.inputs.filter((i) => i === turn.first || !users(i));
      turn.waiting = turn.waiting.filter((i) => !users(i));
      return;
    }
    turn.cancelledBy = "user";
    for (const input of turn.waiting.splice(0)) this.giveBack(input);
    if (turn.started && this.backend) this.backend.cancel(this.rec.backendSessionId!);
    this.settle();
  }

  /** The hub stops the running turn, for the work it ran for was stopped. What waits to go in goes in after. */
  halt(): void {
    const turn = this.current;
    if (!turn) return;
    turn.cancelledBy ??= "hub";
    this.hub.permissions.cancel(this);
    if (turn.started && this.backend) this.backend.cancel(this.rec.backendSessionId!);
  }
}
