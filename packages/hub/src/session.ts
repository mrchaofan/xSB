/**
 * A live session: one conversation of one agent, and the engine that runs its
 * turns.
 *
 * A session does one thing at a time. Input from the user, from peers and from
 * the hub lands in one queue and is run in order, each as a *turn*. A turn is
 * the hub's unit: whoever waits for it (a `session/prompt` caller, a task) sees
 * one turn with one end, whatever the backend needed to get there.
 */
import { Boundaries, Discarded, OriginExt, TurnFailure, RpcError, failure, errorMessage, isTerminal, text } from "@xsb/protocol";
import type {
  Boundary,
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
import { asPreface, handoff, resumeNote } from "./prompts.ts";
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
  /** The mail this turn delivers, if it came from the mailbox. */
  item?: MailItem;
  /** The client that sent it. It is not sent its own message back unless it asked to be (`Client.echo`). */
  from?: Client;
};

/** How many of the agent's latest assets a handoff lists. */
const HANDOFF_ASSETS = 30;

type Queued = TurnRequest & { done: Deferred<{ stopReason: StopReason }> };

/** One message of input, as it is shown and, if the model never sees it, discarded (`Discarded` in @xsb/protocol). */
type Input = Discarded;
const inputOf = (origin: OriginMeta, content: ContentBlock[]): Input => {
  const messageId = origin.messageId ?? newId("m");
  return { messageId, origin: { ...origin, messageId }, content };
};

export type Turn = {
  req: Queued;
  /** What the backend is prompted with: its own input, then what was steered in before it started. */
  inputs: Input[];
  /** The backend has been prompted. */
  started: boolean;
  /**
   * Who stopped it: the user (their client) or the dispatcher of the task it works on (`cancel_task`). Stopped before
   * it started, it never will; stopped after, it may go on with what was steered into it (Backend.cancel).
   */
  cancelledBy?: "user" | "dispatcher";
  /** A task this turn takes up again that a turn before it was stopped in by the user (`LiveSession.resumes`). */
  resumes?: string;
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
  /**
   * A task whose turn the user stopped. Stopping a turn is not cancelling the work: the task stays open, and the
   * next turn of this session that is not another task's takes it up again and ends it.
   */
  resumes?: string;

  private hub: Hub;
  private queue: Queued[] = [];
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
        ? { additionalDirectories: [paths.shared, paths.assets, ...(role ? (role.layers ?? [role.dir]) : [])] }
        : {}),
    };

    const prior = this.rec.backendSessionId;
    // A backend session of another backend is not that backend's to restore: the conversation is handed over instead.
    let renewal: Renewal | undefined = prior && this.rec.backend && this.rec.backend !== agent.backend ? "backend_changed" : undefined;
    // A work session that continues one that grew too long is handed that one's conversation, once.
    if (!prior && this.rec.continues && !this.rec.backend) renewal = "renewed";
    if (prior && !renewal) {
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
    this.save({ backendSessionId: created.sessionId, backend: agent.backend });
    backend.open(created.sessionId, this);
    this.backend = backend;
    if (renewal) {
      this.forget();
      // The handoff is made before the boundary is written: what it tells is what precedes the boundary.
      this.prefaces.push(this.handoff(renewal));
      this.boundary({ kind: renewal, backend: agent.backend, handoff: true });
      this.hub.log(`${this.id}: ${renewal === "backend_changed" ? `now on backend "${agent.backend}"` : renewal === "renewed" ? `continues ${this.rec.continues}` : "backend session renewed"}, with a handoff of the conversation`);
    }
  }

  /** What a new backend session is told of this session's conversation, and of what is open (prompts.ts, `handoff`). */
  private handoff(why: Renewal): string {
    const { state } = this.hub;
    // A renewed work session is told the conversation of the one it continues; the others their own.
    const source = why === "renewed" ? this.rec.continues! : this.id;
    const ours = (sessionId: string): boolean => sessionId === source || sessionId === this.id;
    const tasks = [...state.tasks.values()].filter((t) => !isTerminal(t.status) && (ours(t.from.sessionId) || ours(t.to.sessionId)));
    const waiting = [...state.gates.values()].filter((g) => ours(g.owner.sessionId)).map((g) => ({ taskIds: g.taskIds, mode: g.mode, note: g.note }));
    const assets = [...state.assets.values()]
      .map((versions) => versions.at(-1)!)
      .filter((a) => a.by === this.agentId)
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
      .slice(0, HANDOFF_ASSETS);
    return handoff(why, turnsSinceCleared(state.store, this.agentId, source), { tasks, waiting, assets });
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
      case "usage_update":
        if (typeof (update as any).used === "number") this.used = (update as any).used;
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

  private emitInput({ messageId, origin, content }: Input, from?: Client): void {
    for (const block of content) {
      this.emit({ sessionUpdate: "user_message_chunk", content: block, messageId, _meta: { [OriginExt.key]: origin } }, from?.echo ? undefined : from);
    }
  }

  /** Record, and show, that the model never saw this input (see `Discarded` in @xsb/protocol). */
  private discard(input: Input): void {
    this.emit({ sessionUpdate: "session_info_update", _meta: { [Discarded.key]: input } } as SessionUpdate);
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

  /**
   * Start the next queued turn, when there is one and it may run now. A work session's turn waits while the agent
   * has as many other work sessions running as the work allows (Hub.mayRun); it is started when one of them ends.
   */
  pump(): void {
    if (this.current) return;
    const next = this.queue[0];
    if (!next || !this.hub.mayRun(this, next.item)) return;
    this.queue.shift();
    void this.run(next);
  }

  private async run(req: Queued): Promise<void> {
    const own = inputOf(req.origin, req.prompt);
    const turn: Turn = { req, inputs: [own], started: false, lastText: "" };
    // Another task's turn leaves the stopped one for later; any other turn takes it up.
    if (this.resumes && !req.item?.taskId) {
      const resumed = this.hub.state.tasks.get(this.resumes);
      if (resumed && !isTerminal(resumed.status)) {
        turn.resumes = resumed.id;
        this.prefaces.push(resumeNote(resumed));
      }
      this.resumes = undefined;
    }
    this.current = turn;
    this.hub.mail.turnStarted(turn);
    this.hub.agentChanged(this.agentId);
    this.emitInput(own, req.from);

    let stopReason: StopReason = "cancelled";
    let failure: unknown;
    let backend: Backend | undefined;
    try {
      backend = await this.ensureBackend();
      if (!turn.cancelledBy) {
        turn.started = true;
        this.take(req.gives);
        const spend = this.hub.spending.line();
        if (spend && spend !== this.toldSpend) this.prefaces.push(spend);
        this.toldSpend = spend;
        const preface = this.prefaces.splice(0).map((p) => text(p));
        stopReason = await backend.prompt(this.rec.backendSessionId!, [...preface, ...turn.inputs.flatMap((input) => input.content)], req.origin);
      }
    } catch (e) {
      failure = this.explain(e, backend);
    }

    // From here to `pump` nothing awaits: a steer either reached the turn
    // above or finds none and starts its own.
    this.current = undefined;
    if (this.used !== undefined && this.used !== this.rec.used) this.save({ used: this.used });
    // While the hub stops, nothing is acknowledged: the turn runs again on the next start.
    if (!this.hub.stopping) {
      if (failure) this.hub.log(`${this.agentId}/${this.id}: turn failed: ${errorMessage(failure)}`);
      // Whoever asked for a turn of their own is answered with the error; a turn that mail started has nobody
      // waiting on it, so the failure goes into the transcript, where the user sees it.
      if (failure && req.item) this.emit({ sessionUpdate: "session_info_update", _meta: { [TurnFailure.key]: { message: errorMessage(failure), data: (failure as RpcError).data } } } as SessionUpdate);
      this.hub.mail.turnEnded(this, turn, stopReason, failure);
      this.hub.agentChanged(this.agentId);
    }
    if (failure) req.done.reject(failure);
    else req.done.resolve({ stopReason });
    this.pump();
    // A place may have come free for another session of the agent that waits for one.
    this.hub.wake(this.agentId, this);
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
    const behind = this.queue[waiting];
    try {
      const outcome = await this.steerNow(prompt, origin, whenIdle, from);
      queued.done.resolve({ stopReason: "cancelled" });
      return outcome;
    } catch (e) {
      // It did not get there: it waits where it waited, before what waited behind it (if that has run, so has all before it).
      const at = behind ? this.queue.indexOf(behind) : this.queue.length;
      this.queue.splice(Math.max(at, 0), 0, queued);
      this.pump();
      throw e;
    }
  }

  private async steerNow(prompt: ContentBlock[], origin: OriginMeta, whenIdle: "start" | "promptRequired", from?: Client): Promise<SteeringOutcome> {
    const turn = this.current;
    // Named before it goes anywhere: if the turn is stopped before the backend is given it, that is what is discarded.
    const steered = inputOf({ ...origin, steered: true }, prompt);
    let how: "injected" | "interrupted" | "idle" = "idle";
    if (turn && !turn.started && !turn.cancelledBy) {
      turn.inputs.push(steered);
      how = "injected";
    } else if (turn && this.backend) {
      how = await this.backend.steer(this.rec.backendSessionId!, prompt, steered.origin);
    }
    if (how === "idle") {
      if (whenIdle === "promptRequired") return { outcome: "promptRequired", reason: "noRunningTurn" };
      void this.enqueue({ origin, prompt, from });
      return { outcome: "startedNewTurn" };
    }
    if (how === "interrupted") this.hub.permissions.cancel(this);
    this.emitInput(steered, from);
    return { outcome: "injected" };
  }

  /**
   * Stop, as Esc does in Claude Code and Codex. `by`: the user, or the dispatcher of the task the turn works on.
   *
   * What the hub still holds is discarded, and shown so: a turn that has not reached the backend yet, with what was
   * steered into it, and, when the user stops, their own messages that wait for a turn. Mail is not theirs: mail that
   * waits stays, and so does a turn for mail that has not started; only what the user steered into it goes. A turn
   * the backend runs is the backend's to stop (Backend.cancel): messages steered into it that it has not been given
   * yet are handed over now and the turn goes on with them, unless it is stopped again before they got there.
   */
  cancel(by: "user" | "dispatcher" = "user"): void {
    if (by === "user") this.dropQueued();
    const turn = this.current;
    if (!turn) return;
    this.hub.permissions.cancel(this);
    const mail = !turn.started && by === "user" && !!turn.req.item;
    // The dispatcher's cancel stands: a stop of the user's after it does not leave the task open (mailroom.ts).
    if (!mail && turn.cancelledBy !== "dispatcher") turn.cancelledBy = by;
    const dropped = turn.started
      ? (this.backend?.cancel(this.rec.backendSessionId!) ?? []).map((steer) => inputOf(steer.origin, steer.prompt))
      : turn.inputs.splice(mail ? 1 : 0);
    for (const input of dropped) this.discard(input);
  }

  /** Drop the user's messages that wait for a turn: their `session/prompt` ends as cancelled. */
  private dropQueued(): void {
    const dropped = this.queue.filter((q) => !q.item);
    if (!dropped.length) return;
    this.queue = this.queue.filter((q) => q.item);
    for (const q of dropped) {
      this.discard(inputOf(q.origin, q.prompt));
      q.done.resolve({ stopReason: "cancelled" });
    }
    if (!this.current) this.hub.agentChanged(this.agentId);
  }
}
