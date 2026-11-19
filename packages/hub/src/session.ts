import fs from "node:fs";
import path from "node:path";
/**
 * A live session: one conversation of one agent, and the engine that runs its
 * turns over ACP v2.
 *
 * A session does one thing at a time. Input from the user, from peers and from
 * the hub becomes a *turn*, or goes into the one that runs. A turn is one piece
 * of the backend's work: it begins with the input the hub gives the idle
 * backend and ends with the backend's `idle` (docs/DESIGN.md 3.1).
 *
 * What goes into a running turn goes to the backend at once, each input on its
 * own, once the backend has the turn's first: the hub does not hold it back,
 * merge it, or reorder it. Input the work did not take before it ended is the
 * next turn's.
 *
 * Every input has a receipt: it is inserted into the backend's conversation
 * (the answer to `session/prompt`, or for `_session/steering` the backend
 * showing it), or it never will be in this turn: -32800, dropped by a stop, or
 * stopped while the hub still held it. The user's is then kept for the next
 * turn; mail waits for a turn of its own.
 */
import { Boundaries, Discarded, OriginExt, TurnExt, TurnFailure, RpcError, failure, errorMessage, isStateUpdate, isTerminal, text } from "@xsb/protocol";
import type { Boundary, ContentBlock, McpServer, Origin, OriginMeta, PermissionRequest, PermissionResponse, SessionUpdate, StopReason } from "@xsb/protocol";
import type { Client } from "./acp-server.ts";
import type { Backend } from "./backend.ts";
import type { Hub } from "./hub.ts";
import { bridgeServer } from "./mcp.ts";
import { sessionTokens } from "./config.ts";
import { historyUpdate } from "./history.ts";
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
export type Input = Discarded &
  TurnRequest & {
    inserted: Deferred<void>;
    shown?: boolean;
    /** Given to the backend and not answered yet: as a prompt, or into the work under way (`_session/steering`). */
    sent?: "prompt" | "steering";
    /** The inputs it was given with, in one prompt. */
    batch?: Input[];
    /** It is in the conversation. */
    in?: boolean;
    /** User input accepted after a replacement committed joins that replacement's new turn. */
    joinsTaskId?: string;
  };
const inputOf = (req: TurnRequest): Input => {
  const messageId = req.origin.messageId ?? newId("m");
  const inserted = deferred<void>();
  return { ...req, messageId, origin: { ...req.origin, messageId }, content: req.prompt, inserted };
};
/** Input given anew, as the first of a turn of its own; it is answered when this one is. */
const again = (input: Input): Input => {
  const fresh = inputOf({ ...input, origin: { ...input.origin, steered: undefined } });
  fresh.inserted.promise.then(input.inserted.resolve, input.inserted.reject);
  return fresh;
};
const itemsOf = (inputs: Input[]): MailItem[] => inputs.flatMap((i) => (i.item ? [i.item] : []));

/** How a turn ended. */
export type TurnEnd = { stopReason: StopReason; failure?: unknown };

export type Turn = {
  id: string;
  protected: boolean;
  /** Unread inputs are moved together when the turn ends. */
  recovered?: Input[];
  order?: Input[];
  /** Work inherited when this turn began, retained after report_result completes it. */
  taskIds?: string[];
  first: Input;
  /** Every input of the turn, in the order it came: in the conversation, on its way, or held by the hub. */
  inputs: Input[];
  /** Inputs the hub holds until the backend has the turn's first. */
  held: Input[];
  /** Something of the turn is in the conversation: its end is the backend's next idle. */
  inserted: boolean;
  /** The mail this turn gives the model. It leaves the inbox when the turn ends. */
  items: MailItem[];
  /** The backend has been prompted. */
  started: boolean;
  /** Who stopped it: the user (their client), or the hub, for the work it ran for was stopped (`halt`). */
  cancelledBy?: "user" | "hub";
  done: Deferred<TurnEnd>;
};

export class LiveSession {
  rec: SessionRec;
  /** What this session's tool bridge presents to the hub. Valid as long as the hub runs. */
  bridgeToken = newId("tok");
  readonly clients = new Set<Client>();
  current?: Turn;
  /** What `session/new` or `session/resume` of the backend answered: config options, commands. */
  setup: { configOptions?: unknown; availableCommands?: unknown } = {};
  /** MCP servers the creating client asked for, passed on next to the hub's own. */
  clientMcp: McpServer[] = [];

  private hub: Hub;
  /** Input that waits for a turn of its own. */
  private queue: Input[] = [];
  /** What the user said that a stop kept from the model: it goes first when the next turn starts. */
  private carried: Input[] = [];
  private priorityTaskId?: string;
  /** A user stop freezes dispatch until the old turn is confirmed idle. */
  private userStopping = false;
  private stopTimer?: NodeJS.Timeout;
  /** The id of the input the backend showed last. */
  private echoed?: string;
  private backend?: Backend;
  private binding?: Promise<void>;
  /** Text to put in front of the next prompt. */
  private prefaces: string[] = [];
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

  get acceptsTools(): boolean {
    return !this.userStopping && !this.current?.cancelledBy && !this.hub.kernel.sourceStopped({ agentId: this.agentId, sessionId: this.id });
  }

  protect(): void {
    if (this.current && this.acceptsTools) this.current.protected = true;
  }

  prioritize(taskId: string, turnId: string): void {
    if (this.current?.id === turnId) this.priorityTaskId = taskId;
  }

  taskIds(): string[] {
    const turn = this.current;
    if (!turn) return [];
    return [...new Set([
      ...(turn.taskIds ?? []),
      ...turn.items.flatMap((m) => m.kind === "task" ? [m.taskId!] : []),
      ...turn.inputs.flatMap((i) => i.origin.role === "task" && i.origin.taskId ? [i.origin.taskId] : []),
    ])];
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
    if (!prior && this.rec.renew) renewal = this.rec.renew === "stopped" ? "stopped" : "renewed";
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
      this.hub.log(`${this.id}: ${renewal === "backend_changed" ? `now on backend "${agent.backend}"` : renewal === "renewed" ? "renewed, its conversation having grown long" : renewal === "stopped" ? "continued after stopping" : "backend session renewed"}, with a handoff of the conversation`);
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
  onBackendUpdate(update: SessionUpdate, backendSessionId?: string): void {
    const turn = this.current;
    if (backendSessionId && backendSessionId !== this.rec.backendSessionId) return;
    const correlation = update._meta?.[TurnExt.key] as { id?: string } | undefined;
    const origin = update._meta?.[OriginExt.key] as OriginMeta | undefined;
    const turnId = correlation?.id ?? origin?.turnId;
    if (turnId && turnId !== turn?.id) return;
    switch (update.sessionUpdate) {
      case "user_message":
      case "user_message_chunk": {
        // The backend shows input as it takes it into the conversation, in the order it was given: it is in. This, not
        // the answer to the prompt, is what places it: an answer is handled after the updates read with it, such as
        // the idle of the work that took it. Input given with `_session/steering` has no other sign.
        const id = String(update.messageId ?? "");
        const input = turn && id !== this.echoed ? turn.inputs.find((i) => i.sent && !i.in) : undefined;
        this.echoed = id;
        if (input) this.landed(input.batch!);
        break;
      }
      case "state_update":
        if (!isStateUpdate(update)) break;
        this.backendIdle = update.state === "idle";
        if (!this.backendIdle) this.ranSince = true;
        else {
          this.lastStop = { stopReason: update.stopReason ?? "end_turn", error: update.error };
          this.idle();
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
    const file = Paths.transcript(this.agentId, this.id);
    const offset = fs.statSync(path.join(this.hub.paths.dir, file), { throwIfNoEntry: false })?.size ?? 0;
    this.hub.state.store.append(file, { ts: now(), update }, false);
    for (const client of this.clients) {
      if (client !== except) {
        const view = client.history ? historyUpdate(update, this.id, offset) : update;
        if (view) client.conn.notify("session/update", { sessionId: this.id, update: view });
      }
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
    if (users(input) && this.priorityTaskId) input.joinsTaskId = this.priorityTaskId;
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
      if (q.item.taskId === this.priorityTaskId) this.priorityTaskId = undefined;
      q.inserted.reject(RpcError.cancelled());
      return false;
    });
    return taken;
  }

  /**
   * Start the next turn, when there is input for one and none runs. What the user said that a stop kept from the
   * model goes first, as a turn of its own, once something else is to run (docs/DESIGN.md 3.1, 8).
   */
  pump(): void {
    if (this.userStopping || this.current || !this.queue.length) return;
    if (this.priorityTaskId) {
      const task = this.hub.state.tasks.get(this.priorityTaskId);
      if (!task || task.stopping || isTerminal(task.status)) this.priorityTaskId = undefined;
    }
    if (this.priorityTaskId) {
      const index = this.queue.findIndex((i) => i.item?.taskId === this.priorityTaskId);
      if (index < 0) return;
      const first = this.queue.splice(index, 1)[0];
      const more = this.queue.filter((i) => i.joinsTaskId === this.priorityTaskId);
      this.queue = this.queue.filter((i) => i.joinsTaskId !== this.priorityTaskId);
      this.priorityTaskId = undefined;
      return void this.run(first, more);
    }
    if (this.carried.length) {
      const [first, ...more] = this.carried.splice(0);
      return void this.run(this.users(again(first)), more);
    }
    void this.run(this.users(this.queue.shift()!));
  }

  private async run(first: Input, more: Input[] = []): Promise<void> {
    const turn: Turn = { id: newId("turn"), protected: [first, ...more].some(users), first, inputs: [first, ...more], order: [first, ...more], held: [...more], inserted: false, items: itemsOf([first, ...more]), started: false, done: deferred() };
    turn.taskIds = this.hub.kernel.openTasks(this.id).filter((t) => !t.stopping).map((t) => t.id);
    this.current = turn;
    this.hub.agentChanged(this.agentId);
    this.state("running");
    try {
      await this.ensureBackend();
    } catch (e) {
      if (this.current === turn) this.end({ stopReason: "error", failure: e });
      return;
    }
    // Stopped meanwhile: it ended already, or ends now.
    if (this.current !== turn) return;
    if (turn.cancelledBy) return this.end({ stopReason: "cancelled" });
    turn.started = true;
    this.ranSince = false;
    // What waited in the inbox comes with this turn, in its first prompt.
    const digest = this.hub.delivery.digest(this).map((d) => inputOf(d));
    turn.inputs.splice(1, 0, ...digest);
    turn.order!.splice(1, 0, ...digest);
    turn.items.push(...itemsOf(digest));
    this.send([first, ...digest]);
  }

  /**
   * Give the backend input as one prompt. Into work under way, a backend with `steering` takes it with
   * `_session/steering`; one without, and one that has no work running, with `session/prompt` (backend.ts). Only
   * the turn's first prompt carries more than one input: what came in the inbox comes with it.
   */
  private send(batch: Input[]): void {
    const turn = this.current!;
    if (turn.cancelledBy) return;
    const backend = this.backend;
    if (!backend) return this.end({ stopReason: "error", failure: new Error("the agent program is gone") });
    const sessionId = this.rec.backendSessionId!;
    const content = [...this.prefaces.splice(0).map((p) => text(p)), ...batch.flatMap((i) => i.content)];
    const prompt = (): Promise<boolean> => {
      if (this.current !== turn || turn.cancelledBy) return Promise.reject(RpcError.cancelled());
      for (const input of batch) input.sent = "prompt";
      return backend.prompt(sessionId, content, { ...batch[0].origin, turnId: turn.id }).then(() => true);
    };
    for (const input of batch) input.batch = batch;
    // The tasks it brings are the executor's from now: its tools (and calls of them) may come before the answer.
    this.hub.delivery.given(itemsOf(batch));
    // Steered: it is in once the backend shows it (`onBackendUpdate`). With no work to steer into, it is a prompt.
    const given = turn.inserted && backend.caps.steering
      ? ((batch[0].sent = "steering"), backend.steer(sessionId, content).then((how) => (how === "idle" ? prompt() : false)))
      : prompt();
    given.then(
      (answered) => {
        if (answered) this.landed(batch);
      },
      (e) => this.refused(batch, e, backend),
    );
  }

  /**
   * Input got into the conversation: the backend showed it, or answered the prompt it was. What the hub held until
   * the turn's first got in goes now, each on its own.
   */
  private landed(batch: Input[]): void {
    const turn = this.current;
    // In already, or its turn is over: what became of it was settled then.
    if (!turn || !batch.every((i) => turn.inputs.includes(i) && i.sent && !i.in)) return;
    turn.inserted = true;
    for (const input of batch) {
      input.in = true;
      this.take(input.gives);
      this.receipt(input, true);
    }
    for (const input of turn.held.splice(0)) this.send([input]);
    if (this.idleSince(turn)) this.idle();
  }

  /**
   * The backend did not take input. Not taken for a stop (-32800), it is left out of the turn (`leave`); refused for
   * another reason, its sender is told why, and a turn that has nothing in the conversation yet fails with it.
   */
  private refused(batch: Input[], e: unknown, backend: Backend): void {
    const turn = this.current;
    if (!turn || !batch.every((i) => turn.inputs.includes(i) && i.sent && !i.in)) return;
    if (e instanceof RpcError && e.code === RpcError.CANCELLED) {
      for (const input of batch) this.leave(input);
      return this.settle();
    }
    const failure = this.explain(e, backend);
    if (!turn.inserted) {
      // The turn could not begin: what it was to begin with fails with it, its tasks too (kept in `items`).
      for (const input of batch) {
        input.sent = undefined;
        turn.inputs = turn.inputs.filter((i) => i !== input);
        this.discard(input, failure);
      }
      return this.end({ stopReason: "error", failure });
    }
    for (const input of batch) {
      this.drop(input);
      this.discard(input, failure);
    }
    this.hub.kernel.ack(itemsOf(batch).map((m) => m.id));
  }

  /** The backend's work is idle. It ends the turn, unless none of the turn is in the conversation yet. */
  private idle(): void {
    const turn = this.current;
    if (!turn || !this.idleSince(turn)) return;
    // The work that ended was not this turn's: the backend has not taken its first input yet.
    if (!turn.inserted && !turn.cancelledBy) return;
    // A prompt receipt can follow idle. Settle its real insertion outcome before discarding it for user stop.
    if ((turn.cancelledBy || this.hub.kernel.sourceStopped({ agentId: this.agentId, sessionId: this.id })) && turn.inputs.some((i) => i.sent === "prompt" && !i.in)) return;
    const { stopReason, error } = this.lastStop;
    if (stopReason === "error") return this.end({ stopReason, failure: new RpcError(error?.code ?? -32603, error?.message ?? "the agent failed", error?.data) });
    this.end({ stopReason });
  }

  /** After a stop or a refusal: a turn that has nothing in the conversation or on its way ends at once; else at the backend's idle. */
  private settle(): void {
    const turn = this.current;
    if (!turn) return;
    if (!turn.inserted && !turn.inputs.some((i) => i.sent)) return this.end({ stopReason: "cancelled" });
    if (this.idleSince(turn)) this.idle();
  }

  /**
   * The backend is idle, and that ends what the hub gave it: it went running since the turn began, or the turn is
   * being stopped (then nothing will run, and no running will come to say so).
   */
  private idleSince(turn: Turn): boolean {
    return this.backendIdle && (this.ranSince || !!turn.cancelledBy);
  }

  /** Take input out of the running turn. */
  private drop(input: Input): void {
    const turn = this.current;
    if (!turn) return;
    turn.inputs = turn.inputs.filter((i) => i !== input);
    turn.held = turn.held.filter((i) => i !== input);
    if (input.item) turn.items = turn.items.filter((m) => m !== input.item);
  }

  /**
   * Input that did not get into the conversation, and will not in this turn. The user's is kept, unanswered, for the
   * next turn (docs/DESIGN.md 3.1, 7). Mail waits for a turn of its own; unless the kernel took it back meanwhile (its
   * task was stopped).
   */
  private leave(input: Input, carry = false): void {
    const turn = this.current;
    this.drop(input);
    input.sent = undefined;
    if (this.userStopping) return this.discard(input);
    if (input.item?.targetTurnId) {
      this.hub.kernel.ack([input.item.id]);
      return this.discard(input, new Error("Target turn has ended or changed."));
    }
    if (carry && users(input)) return void this.carried.push(input);
    if (!users(input) && (!input.item || !this.hub.state.mail.has(input.item.id))) return this.discard(input);
    if (turn) (turn.recovered ??= []).push(input);
  }

  private end(end: TurnEnd): void {
    const turn = this.current;
    if (!turn) return;
    // The backend may report idle before the deferred halt hook runs. The committed
    // stop still owns this turn, including its unread input.
    if (!end.failure && !turn.cancelledBy && this.hub.kernel.sourceStopped({ agentId: this.agentId, sessionId: this.id })) {
      turn.cancelledBy = "hub";
      end = { ...end, stopReason: "cancelled" };
    }
    // What is not in the conversation: on its way, or held by the hub.
    const out = turn.inputs.filter((i) => !i.in);
    const order = turn.order ?? [...turn.inputs];
    const expiredAppend = out.some((i) => i.item?.targetTurnId);
    let next: Input[] = [];
    if (!turn.started && end.failure) {
      // It never reached the backend: nothing else will run what it brought (its tasks fail with it).
      for (const input of out) this.discard(input, end.failure);
    } else {
      // Stopped or failed: the backend drops what it did not take. Ended: it runs it next, a turn of its own (3.1, 5).
      if (turn.cancelledBy || end.failure || !turn.started || expiredAppend) for (const input of out) this.leave(input);
      else next = out;
    }
    const recovered = (turn.recovered ?? []).sort((a, b) => order.indexOf(a) - order.indexOf(b));
    this.queue.unshift(...recovered.map(again));
    if (turn.started || !end.failure) {
      turn.inputs = turn.inputs.filter((i) => i.in);
      turn.items = itemsOf(turn.inputs);
    }
    this.current = undefined;
    if (expiredAppend && !turn.cancelledBy && this.backend) {
      // Normal cancellation has already confirmed idle and settled prompt receipts:
      // keep that conversation and its tools, including image context. An unread
      // targeted append on normal completion still needs isolation before new work.
      this.backend.cancel(this.rec.backendSessionId!);
      this.backend.close?.(this.rec.backendSessionId!);
      this.hub.rotateBridge(this);
      this.backend = undefined;
      this.save({ backendSessionId: undefined, renew: "stopped" });
    }
    if (this.used !== undefined && this.used !== this.rec.used) this.save({ used: this.used });
    // While the hub stops, nothing is acknowledged: the turn runs again on the next start.
    if (!this.hub.stopping) {
      if (end.failure) this.hub.log(`${this.agentId}/${this.id}: turn failed: ${errorMessage(end.failure)}`);
      // Its failure goes into the transcript, where the user sees it: the prompt that started it may have been answered long ago.
      if (end.failure) this.emit({ sessionUpdate: "session_info_update", _meta: { [TurnFailure.key]: { message: errorMessage(end.failure), data: (end.failure as RpcError).data } } } as SessionUpdate);
      this.hub.kernel.hooks.emit("acp.turn_ended", { agentId: this.agentId, sessionId: this.id, turnId: turn.id, stopReason: end.stopReason, failed: !!end.failure });
      this.hub.delivery.turnEnded(this, turn, end);
      this.hub.agentChanged(this.agentId);
    }
    this.state("idle", end);
    turn.done.resolve(end);
    this.releaseUserStop(false);
    if (next.length) return this.resume(next);
    this.renewIfLong();
    this.pump();
  }

  /**
   * Input given into work that ended without taking it is the next turn: the backend runs it next (a prompt waits
   * in the backend for the work under way), or it dropped it (input given with `_session/steering`), and it is given
   * again, as a prompt.
   */
  private resume(inputs: Input[]): void {
    const turn: Turn = { id: newId("turn"), protected: inputs.some(users), first: inputs[0], inputs, order: [...inputs], held: [], inserted: false, items: itemsOf(inputs), started: true, done: deferred() };
    turn.taskIds = this.hub.kernel.openTasks(this.id).filter((t) => !t.stopping).map((t) => t.id);
    this.current = turn;
    this.ranSince = false;
    this.users(inputs[0]);
    this.hub.agentChanged(this.agentId);
    this.state("running");
    for (const input of inputs) {
      if (input.sent === "prompt") continue;
      input.sent = undefined;
      this.send([input]);
    }
  }

  /**
   * The first input of a turn, said by the user without it being a task: the turn is the user's, and the input that
   * of the user's task (docs/DESIGN.md 3.1, 5 and 8), where the record of its work begins (transcript.ts).
   */
  private users(input: Input): Input {
    if (!users(input) || input.item?.kind === "task") return input;
    const taskId = this.hub.delivery.userTurn(this, input);
    if (taskId) input.origin = { ...input.origin, taskId, role: "task" };
    return input;
  }

  /**
   * Put input into the running turn: once the backend has the turn's first input, it goes to the backend at once, on
   * its own (docs/DESIGN.md 3.1, 2-3). Returns undefined when no turn runs, or the running one is being stopped.
   */
  steer(req: TurnRequest, targetTurnId?: string): Input | undefined {
    const turn = this.current;
    if (!turn || !this.acceptsTools || (targetTurnId && targetTurnId !== turn.id)) return undefined;
    if (req.origin.kind === "user") turn.protected = true;
    const input = inputOf({ ...req, origin: { ...req.origin, steered: true } });
    turn.order ??= [...turn.inputs];
    turn.order.push(input);
    turn.inputs.push(input);
    if (req.item) turn.items.push(req.item);
    if (turn.started && turn.inserted) this.send([input]);
    else turn.held.push(input);
    return input;
  }

  /** Snapshot before committing cancellation; incoming work after this point is a new request. */
  beginUserStop(): { pending: string[]; sent: string[]; inserted: string[] } | undefined {
    if (this.userStopping) return undefined;
    this.userStopping = true;
    const inputs = [...this.queue, ...this.carried, ...(this.current?.inputs ?? [])];
    return {
      pending: inputs.filter((i) => !i.in).map((i) => i.messageId),
      sent: inputs.filter((i) => !i.in && i.sent).map((i) => i.messageId),
      inserted: inputs.filter((i) => i.in).map((i) => i.messageId),
    };
  }

  releaseUserStop(pump = true): void {
    this.userStopping = false;
    if (this.stopTimer) clearTimeout(this.stopTimer);
    this.stopTimer = undefined;
    if (pump) this.pump();
  }

  /** Persistent mail/tasks were withdrawn already. Retire local copies and stop the backend last. */
  cancelUserWork(): void {
    this.priorityTaskId = undefined;
    for (const input of [...this.queue.splice(0), ...this.carried.splice(0)]) this.discard(input);
    const turn = this.current;
    if (!turn) return this.releaseUserStop();
    turn.cancelledBy = "user";
    for (const input of turn.inputs.filter((i) => !i.in && !i.sent)) {
      this.drop(input);
      this.discard(input);
    }
    this.hub.permissions.cancel(this);
    if (!turn.started) return this.end({ stopReason: "cancelled" });
    this.stopTimer = setTimeout(() => {
      if (this.current !== turn) return;
      this.hub.log(`${this.agentId}/${this.id}: user stop timed out; closing the old backend`);
      // Close the transport before a new turn can bind: old replies and tools must not reach new work.
      this.hub.rotateBridge(this);
      this.hub.backends.stop(this.agentId);
      this.backend?.stop();
      this.backend = undefined;
      this.save({ backendSessionId: undefined, renew: "stopped" });
      this.end({ stopReason: "cancelled" });
    }, 10_000);
    this.backend?.cancel(this.rec.backendSessionId!);
    this.settle();
  }

  /**
   * Stop, as Esc does in Claude Code and Codex: the backend stops its work. What is not in the conversation yet does
   * not get there in this turn: the user's waits for the next, mail for a turn of its own. A turn for mail that has
   * not reached the backend yet is not the user's to stop: only what the user put into it waits.
   */
  cancel(): void {
    const turn = this.current;
    if (!turn) return;
    this.hub.permissions.cancel(this);
    if (!turn.started && !users(turn.first)) {
      for (const input of turn.held.filter(users)) this.leave(input, true);
      return;
    }
    turn.cancelledBy = "user";
    if (turn.started && this.backend) this.backend.cancel(this.rec.backendSessionId!);
    this.settle();
  }

  /** The hub stops the running turn, for the work it ran for was stopped. */
  halt(targetTurnId: string): void {
    const turn = this.current;
    if (!turn || turn.id !== targetTurnId) return;
    turn.cancelledBy ??= "hub";
    this.hub.permissions.cancel(this);
    if (turn.started && !this.stopTimer) this.stopTimer = setTimeout(() => {
      if (this.current !== turn) return;
      this.hub.log(`${this.agentId}/${this.id}: task stop timed out; closing the old backend`);
      this.hub.rotateBridge(this);
      this.hub.backends.stop(this.agentId);
      this.backend?.stop();
      this.backend = undefined;
      this.save({ backendSessionId: undefined, renew: "stopped" });
      this.end({ stopReason: "cancelled" });
    }, 10_000);
    if (turn.started && this.backend) this.backend.cancel(this.rec.backendSessionId!);
    if (turn.started) this.settle();
  }
}
