import fs from "node:fs";
import path from "node:path";
/**
 * A live session: one conversation of one agent, and the engine that runs its
 * turns over ACP v2.
 *
 * A session does one thing at a time. Input from the user, from peers and from
 * the hub becomes a *turn*, or goes into the one that runs. A turn is one piece
 * of authorized work. A backend execution (run) is bounded by ACP running/idle;
 * it may have no turn owner, or be claimed by a turn when its input is inserted.
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
import { SessionControls, Boundaries, Accepted, Discarded, DeliveredAs, OriginExt, Redelivered, RunExt, TurnExt, TurnFailure, RpcError, failure, errorMessage, isStateUpdate, isTerminal, text } from "@xsb/protocol";
import type { BackendRun, RunUpdate, Boundary, ContentBlock, DiscardReason, ElicitationRequest, ElicitationResponse, McpServer, Origin, OriginMeta, PermissionRequest, PermissionResponse, SessionUpdate, StopReason } from "@xsb/protocol";
import type { ToolContextState, TurnWindow } from "@xsb/protocol";
import type { Client } from "./acp-server.ts";
import type { Backend } from "./backend.ts";
import type { Hub } from "./hub.ts";
import { bridgeServer, XSB_SERVER } from "./mcp.ts";
import { boundedText, contentTokens, contextOverflow, contextRef, textTokens } from "./context.ts";
import { historyUpdate } from "./history.ts";
import { Paths } from "./paths.ts";
import { asPreface, conversationTitle, handoff, isXsbText } from "./prompts.ts";
import type { Gives, Renewal } from "./prompts.ts";
import { turnsSinceCleared } from "./transcript.ts";
import { atomicWrite } from "@xsb/store";
import type { MailItem, SessionRec } from "./state.ts";
import type { WorkflowTold } from "./workflow-state.ts";
import { ops } from "./state.ts";
import type { Deferred } from "./util.ts";
import { deferred, newId, now } from "./util.ts";
import { isVeto } from "./hooks.ts";

export type TurnRequest = {
  interruptionId?: string;
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
const optionId = (option?: { configId?: string; id?: string }) => option?.configId ?? option?.id;

const OWN = new Set(["user_message", "user_message_chunk", "state_update"]);
/** How much of an input too large to give in full the model is shown before the path of the file it is saved in. */
const PASTE_EXCERPT_BYTES = 4000;

/** Whether input is the user's: theirs to stop. Everything else (a peer's, xsb's) is mail, which a stop does not drop. */
const users = (input: Input): boolean => input.origin.kind === "user";

/** One message of input on its way into the conversation. `inserted` settles with its receipt. */
export type Input = Discarded &
  TurnRequest & {
    inserted: Deferred<void>;
    shown?: boolean;
    /** Given to the backend and not answered yet: as a prompt, or into the work under way (`_session/steering`). */
    sent?: "prompt" | "steering";
    /** Execution associated with this request, even if its insertion receipt follows that execution's idle. */
    runId?: string;
    /** The inputs it was given with, in one prompt. */
    batch?: Input[];
    /** What went in front of that prompt (instructions, a handoff, workflow context): owed again if it is refused. */
    prefaces?: string[];
    /** It is in the conversation. */
    in?: boolean;
    /** The insertion receipt was already published before safe context recovery. */
    receipted?: boolean;
    /** User input accepted after a replacement committed joins that replacement's new turn. */
    joinsTaskId?: string;
    /** Earlier user messages the model never got (`SessionRec.owed`), given in front of this one. */
    owedIds?: string[];
    /** How the model is given it, where that differs from what it is (`DeliveredAs`). */
    deliveredAs?: DeliveredAs;
  };
const inputOf = (req: TurnRequest): Input => {
  const messageId = req.origin.messageId ?? newId("m");
  const inserted = deferred<void>();
  return { ...req, messageId, origin: { ...req.origin, messageId }, content: req.prompt, inserted };
};
/** Input given anew, as the first of a turn of its own; it is answered when this one is. */
const again = (input: Input): Input => {
  const fresh = inputOf({ ...input, origin: { ...input.origin, steered: undefined } });
  fresh.runId = undefined;
  fresh.inserted.promise.then(input.inserted.resolve, input.inserted.reject);
  return fresh;
};
const itemsOf = (inputs: Input[]): MailItem[] => inputs.flatMap((i) => (i.item ? [i.item] : []));
/** What the model of a conversation moved from another is told with its first message (`SessionRec.migratedFrom`). */
const migrationPreface = (m: NonNullable<SessionRec["migratedFrom"]>): string =>
  `[xsb] This conversation continues an earlier one with the user ("${m.title}", on the agent program "${m.backend}"). The user moved it here ` +
  `to switch agent programs; you have none of it in your context. Read it with the previous_conversation tool (oldest first, a page at a time) ` +
  `before relying on what was said or decided there; the user may refer to it. It is history: do not redo its work unless asked. ` +
  `Workflows of that conversation did not move.`;

/** How the user's input differs as the model gets it (`DeliveredAs`): images it cannot see, text saved to files, a note in front. */
const deliveredAs = (content: ContentBlock[], given: ContentBlock[], scope: string | undefined, images: boolean): DeliveredAs | undefined => {
  const imagesHidden = images ? 0 : content.filter((b) => b.type === "image").length;
  const spilled = content.flatMap((b, i) => {
    const file = b.type === "text" && given[i] !== b ? /saved whole at (\S+?);/.exec(String(given[i]?.text ?? ""))?.[1] : undefined;
    return file ? [{ chars: String(b.text ?? "").length, file }] : [];
  });
  const out: DeliveredAs = { ...(imagesHidden ? { imagesHidden } : {}), ...(spilled.length ? { spilled } : {}), ...(scope ? { scope } : {}) };
  return Object.keys(out).length ? out : undefined;
};

/** How a turn ended. */
export type TurnEnd = { stopReason: StopReason; failure?: unknown };

export type Turn = {
  id: string;
  protected: boolean;
  /** The workflow context put in front of this turn's first prompt; a later turn gets its own. */
  workflowPreface?: string;
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
  /** The end of this turn's last owned run; unrelated backend runs cannot end it. */
  runEnd?: TurnEnd;
  /** The mail this turn gives the model. It leaves the inbox when the turn ends. */
  items: MailItem[];
  /** The backend has been prompted. */
  started: boolean;
  /** Once work/output is observed, replaying the prompt could repeat side effects. */
  executed?: boolean;
  recovering?: boolean;
  recoveryAttempts?: number;
  /** Refusal text is shown only if recovery cannot continue, instead of flashing a terminal error on success. */
  refusalChunks?: SessionUpdate[];
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
  private turnWindows: TurnWindow[] = [];
  /** What `session/new` or `session/resume` of the backend answered: config options, commands. */
  setup: { configOptions?: unknown; availableCommands?: unknown } = {};
  /** MCP servers the creating client asked for, passed on next to the hub's own. */
  clientMcp: McpServer[] = [];
  /** The tools and prompt its backend session was last started with (Hub.toolsKeyFor): plugin changes compare to it. */
  toolsKey?: string;

  private hub: Hub;
  /** Input that waits for a turn of its own. */
  private queue: Input[] = [];
  /** What the user said that a stop kept from the model: it goes first when the next turn starts. */
  private carried: Input[] = [];
  /** Inputs whose end is recorded already, in the conversation (`user_message_chunk`) or discarded: recorded once. */
  private settled = new Set<string>();
  /** The input whose prompt carries the owed messages, until it is in the conversation. */
  private owedCarrier?: Input;
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
  private handoffPreface?: string;
  /**
   * What the model of this session has been given in full, so that it is not given the same again: asset id ->
   * the version and the task it came with, and memory notes by topic key -> the version (updatedAt) it saw. Only
   * for as long as the backend session has it: a boundary empties both, and so does a restart of the hub. Likewise
   * what a main conversation was told of its workflow (workflows.ts `context`).
   */
  readonly given: { assets: Map<string, { version: number; taskId?: string }>; notes: Map<string, string>; workflow?: WorkflowTold } =
    { assets: new Map(), notes: new Map() };
  /** Context in use at the end of the backend's last report, in tokens. */
  private used?: number;
  private contextSize?: number;
  private usageRevision = 0;
  private estimated = 0;
  private standingTokens = 0;
  private currentRun?: BackendRun;
  private announcedRun?: BackendRun;
  private lastRun?: RunUpdate;

  constructor(hub: Hub, rec: SessionRec) {
    this.hub = hub;
    this.rec = rec;
    this.clientMcp = rec.clientMcp ?? [];
    this.used = rec.used;
    this.contextSize = rec.contextSize;
  }

  get id(): string {
    return this.rec.id;
  }

  toolContext(): ToolContextState {
    return { agentId: this.agentId, sessionId: this.id, turnId: this.current?.id ?? null, active: !!this.current && this.acceptsTools, turns: this.turnWindows.map((t) => ({ ...t })) };
  }

  private turnChanged(): void {
    const time = Date.now();
    const last = this.turnWindows.at(-1);
    if (last && last.endedAt === undefined) last.endedAt = time;
    if (this.current) this.turnWindows.push({ id: this.current.id, startedAt: time });
    if (this.turnWindows.length > 128) this.turnWindows.shift();
    this.hub.kernel.hooks.emit("acp.turn_changed", { agentId: this.agentId, sessionId: this.id });
  }
  get agentId(): string {
    return this.rec.agentId;
  }
  get busy(): boolean {
    return !!this.current || this.queue.length > 0;
  }

  get acceptsTools(): boolean {
    const ownedExecution = this.currentRun ? this.currentRun.turnId === this.current?.id : !this.current || !this.lastRun;
    return !this.userStopping && !this.current?.cancelledBy && !this.current?.recovering &&
      ownedExecution && !this.hub.kernel.sourceStopped({ agentId: this.agentId, sessionId: this.id });
  }

  protect(): void {
    if (this.current && !this.current.cancelledBy && !this.userStopping && !this.hub.kernel.sourceStopped({ agentId: this.agentId, sessionId: this.id })) this.current.protected = true;
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
    this.finishRun({ stopReason: "cancelled" });
    this.lastRun = undefined;
    const agent = this.hub.agent(this.agentId);

    const instructions = this.hub.systemPromptFor(agent, this.clientMcp);
    this.standingTokens = backend.caps.systemPrompt ? textTokens(instructions) : 0;
    if (textTokens(instructions) + this.hub.policy(this.agentId).reserveTokens > this.hub.policy(this.agentId).promptTokens) {
      throw new RpcError(-32602, "The agent's standing instructions exceed the context budget. Shorten the role instructions or memory, or configure limits.promptTokens.", { errorKind: "input_too_large" });
    }
    const { paths } = this.hub;
    this.toolsKey = this.hub.toolsKeyFor(this);
    const params = {
      cwd: agent.workspace,
      // The hub's own tools, then the others the agent has (Hub.toolServers): the system prompt says where each comes from.
      mcpServers: [bridgeServer(paths.socket("mcp"), this.bridgeToken), bridgeServer(paths.socket("mcp"), this.bridgeToken, XSB_SERVER), ...this.hub.toolServers(agent, this.clientMcp).map((t) => this.hub.withToolContext(t.server, this))],
      ...(backend.caps.systemPrompt ? { systemPrompt: { mode: "append", content: [text(instructions)] } } : {}),
      ...(backend.caps.additionalDirectories
        ? { additionalDirectories: [paths.shared, paths.assets, ] }
        : {}),
    };

    const prior = this.rec.backendSessionId;
    // A backend session of another backend is not that backend's to restore: the conversation is handed over instead.
    let renewal: Renewal | undefined = prior && this.rec.backend && this.rec.backend !== agent.backend ? "backend_changed" : undefined;
    // A conversation that grew too long goes on in a new backend session, handed what came before (`renew`).
    if (!prior && this.rec.renew) renewal = this.rec.renew === true ? "renewed" : this.rec.renew;
    if (prior && !renewal) {
      try {
        // Every ACP v2 agent resumes; the history is not replayed (the hub has it).
        backend.open(prior, this);
        try {
          this.setup = await backend.conn.request("session/resume", { sessionId: prior, ...params });
        } catch (e) {
          backend.close(prior);
          throw e;
        }
        // Settings the backend no longer offers are dropped (`restoreConfig`); they do not undo the resume.
        await this.restoreConfig(backend, prior);
        this.backend = backend;
        this.estimated = this.used ?? this.standingTokens;
        this.notifyControls();
        // A resumed adapter without systemPrompt must also receive updated lifecycle/role instructions.
        if (!backend.caps.systemPrompt) this.prefaces.push(asPreface(instructions));
        this.pendingHandoff();
        if (!this.rec.backend || !this.rec.backendWorkspace) this.save({ backend: agent.backend, backendWorkspace: agent.workspace });
        return;
      } catch (e) {
        this.hub.log(`${this.id}: backend session ${prior} not restored (${errorMessage(e)}), starting a new one`);
        renewal = "not_restored";
      }
    }

    const created = await backend.conn.request("session/new", params);
    this.setup = created;
    if (renewal !== "backend_changed") await this.restoreConfig(backend, created.sessionId);
    // Without the system prompt capability the instructions ride on the first prompt.
    if (!backend.caps.systemPrompt) this.prefaces.push(asPreface(instructions));
    // A backend session that was given nothing held nothing, and a conversation with nothing in it has nothing to
    // tell: the new backend session then replaces the old one without a boundary or a handoff.
    const fresh = !!prior && !!this.rec.backendFresh;
    const checkpoint = renewal && !fresh ? this.handoff(renewal) : undefined;
    const checkpointRef = checkpoint === undefined ? undefined : contextRef(this.hub.paths, this.agentId, checkpoint).ref;
    this.save({ backendSessionId: created.sessionId, backendWorkspace: agent.workspace, backendFresh: true, backend: agent.backend, renew: undefined, used: undefined, contextSize: undefined,
      contextEpoch: (this.rec.contextEpoch ?? 0) + 1,
      ...(checkpointRef ? { contextCheckpoint: checkpointRef, contextHandoffPending: checkpointRef } : {}),
      ...(renewal === "backend_changed" ? { contextRenewAt: undefined, contextRecovery: undefined, selectedConfig: undefined } : {}) });
    backend.open(created.sessionId, this);
    this.backend = backend;
    this.estimated = this.standingTokens;
    if (renewal && checkpoint !== undefined) {
      this.forget();
      // The handoff is made before the boundary is written: what it tells is what precedes the boundary.
      this.handoffPreface = boundedText(this.hub.paths, this.agentId, checkpoint!, Math.min(6000, this.hub.policy(this.agentId).promptTokens / 4));
      this.prefaces.push(this.handoffPreface);
      this.boundary({ kind: renewal, backend: agent.backend, handoff: true });
      this.hub.log(`${this.id}: ${renewal === "backend_changed" ? `now on backend "${agent.backend}"` : renewal === "renewed" ? "renewed, its conversation having grown long" : renewal === "stopped" ? "continued after stopping" : "backend session renewed"}, with a handoff of the conversation`);
    } else {
      if (renewal) this.hub.log(`${this.id}: backend session replaced; it held nothing to hand over`);
      this.pendingHandoff();
    }
    this.notifyControls();
  }

  /** A handoff written for this conversation that no prompt has carried yet goes with the next one; so does word of a move. */
  private pendingHandoff(): void {
    const moved = this.rec.migratedFrom;
    if (moved?.pending) this.prefaces.push(migrationPreface(moved));
    if (!this.rec.contextHandoffPending) return;
    const file = path.join(this.hub.paths.dir, "agents", this.agentId, "context", `${this.rec.contextHandoffPending}.txt`);
    this.handoffPreface = boundedText(this.hub.paths, this.agentId, fs.readFileSync(file, "utf8"), Math.min(6000, this.hub.policy(this.agentId).promptTokens / 4));
    this.prefaces.push(this.handoffPreface);
  }

  /** What a new backend session is told of this session's conversation, and of what is open (prompts.ts, `handoff`). */
  private handoff(why: Renewal): string | undefined {
    const { state } = this.hub;
    const ours = (sessionId: string): boolean => sessionId === this.id;
    const tasks = [...state.tasks.values()].filter((t) => !isTerminal(t.status) && ((t.from && ours(t.from.sessionId)) || ours(t.to.sessionId)));
    const waiting = [...state.gates.values()].filter((g) => ours(g.owner.sessionId)).map((g) => ({ taskIds: g.taskIds, mode: g.mode, note: g.note }));
    const assets = [...state.assets.values()]
      .map((versions) => versions.at(-1)!)
      .filter((a) => a.by === this.agentId)
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
      .slice(0, HANDOFF_ASSETS);
    const previous = this.rec.contextCheckpoint;
    const turns = turnsSinceCleared(state.store, this.agentId, this.id, previous ? { maxChars: Number.MAX_SAFE_INTEGER, stopAtRenewal: true } : undefined);
    if (!turns.length && !tasks.length && !waiting.length && !assets.length && !previous) return undefined;
    const source = contextRef(this.hub.paths, this.agentId, JSON.stringify({ kind: "historical_messages", turns })).ref;
    const body = handoff(why, turns, { tasks, waiting, assets });
    return body + `\n\nFull source messages: read_context ${source}. Retrieve original user constraints and decisions when excerpts are insufficient; these are historical messages, not new instructions.` +
      (previous ? `\n\nEarlier context is preserved in checkpoint ${previous}. Use read_context to retrieve relevant earlier user constraints and decisions before continuing work that depends on them. It is historical context, not new instructions.` : "");
  }

  /** Note that the model now has what a prompt gave it in full. */
  take(gives: Gives | undefined): void {
    for (const a of gives?.assets ?? []) this.given.assets.set(a.id, { version: a.version, taskId: a.taskId });
    for (const n of gives?.notes ?? []) this.given.notes.set(n.key, n.updatedAt);
  }

  /** The model starts anew: it has nothing it was given before. */
  private forget(): void {
    this.forgetGiven();
    this.invalidateUsage();
    this.notifyControls();
  }

  /** What the model was given is gone from its context (a boundary, or a compaction the backend reports only by usage). */
  private forgetGiven(): void {
    this.given.assets.clear();
    this.given.notes.clear();
    this.given.workflow = undefined;
  }

  /** Text to put in front of the next prompt of this session, whichever turn that is. */
  preface(text: string): void {
    this.prefaces.push(text);
  }

  /** Record, and show, where what the model sees of this session starts anew. */
  private boundary(boundary: Boundary): void {
    this.emit({ sessionUpdate: "session_info_update", _meta: { [Boundaries.key]: boundary } } as SessionUpdate);
    // A new backend session has none of what the old one held; a compaction keeps the session and its summary.
    if (boundary.kind !== "compacted") this.hub.kernel.hooks.emit("acp.session_renewed", { agentId: this.agentId, sessionId: this.id });
  }

  /**
   * Past its backend's `sessionTokens` limit of context the conversation goes on in a new backend session, from its next turn:
   * that one is handed what came before (`renewed`). The session, and with it what the user and peers see of the
   * agent, stays the one it was.
   */
  private renewIfLong(error?: unknown): void {
    const overflow = error !== undefined && contextOverflow(error);
    const limit = this.contextLimit();
    if (!overflow && Math.max(this.used ?? 0, this.estimated) < limit) return;
    this.hub.log(`${this.agentId}/${this.id}: ${overflow ? "backend rejected the context as too long" : `${this.used ?? this.estimated} ${this.used === undefined ? "estimated " : ""}tokens of context`}; its next turn starts a new backend session`);
    if (this.rec.backendSessionId) this.backend?.close?.(this.rec.backendSessionId);
    this.hub.backends.stop(this.agentId);
    this.hub.rotateBridge(this);
    this.backend = undefined;
    this.prefaces = [];
    this.forget();
    this.estimated = 0;
    this.save({ backendSessionId: undefined, renew: true, used: undefined, contextSize: undefined });
  }

  private contextLimit(): number {
    return Math.min(this.hub.policy(this.agentId).sessionTokens, this.rec.contextRenewAt ?? Infinity, this.contextSize === undefined ? Infinity : this.contextSize * 0.8);
  }

  private async restoreConfig(backend: Backend, sessionId: string) {
    const options = this.setup.configOptions;
    const modelId = Array.isArray(options) ? optionId(options.find(o => o.category === "model" || optionId(o) === "model")) ?? "model" : "model";
    // Model selection can change the reasoning levels offered by the adapter.
    const entries = Object.entries(this.rec.selectedConfig ?? {}).sort(([a], [b]) => Number(b === modelId) - Number(a === modelId));
    const dropped: string[] = [];
    for (const [configId, value] of entries) {
      try {
        const response = await backend.conn.request("session/set_config_option", { sessionId, configId, type: "id", value });
        this.setup = { ...this.setup, ...response };
      } catch (e) {
        // A choice the backend no longer offers (a model gone after an update) falls back to its default.
        this.hub.log(`${this.id}: setting ${configId}=${value} not restored (${errorMessage(e)})`);
        dropped.push(configId);
      }
    }
    if (dropped.length) {
      const selectedConfig = { ...this.rec.selectedConfig };
      for (const id of dropped) delete selectedConfig[id];
      this.save({ selectedConfig });
    }
  }

  async setConfig(params: { configId: string; type?: string; value: unknown }) {
    const { configId, value } = params;
    const backend = await this.ensureBackend();
    const binding = this.rec.backendSessionId;
    const revision = this.usageRevision;
    const previous = Array.isArray(this.setup.configOptions) ? this.setup.configOptions.find(o => optionId(o) === configId)?.currentValue : undefined;
    const result = await backend.conn.request("session/set_config_option", { type: typeof value === "string" ? "id" : undefined, ...params, sessionId: binding });
    if (!binding || this.backend !== backend || this.rec.backendSessionId !== binding) throw RpcError.invalidParams("Session changed while applying setting");
    this.setup = { ...this.setup, ...result };
    if (typeof configId === "string" && typeof value === "string") {
      const selectedConfig = { ...this.rec.selectedConfig, [configId]: value };
      const options = this.setup.configOptions;
      if (Array.isArray(options)) for (const id of Object.keys(selectedConfig)) {
        const option = options.find(o => optionId(o) === id);
        if (typeof option?.currentValue === "string") selectedConfig[id] = option.currentValue;
        else if (!option) delete selectedConfig[id];
      }
      const model = configId === "model" || (Array.isArray(options) && options.some(o => optionId(o) === configId && o.category === "model"));
      const changedModel = model && previous !== value;
      if (changedModel && this.usageRevision === revision) this.invalidateUsage();
      this.save({ selectedConfig, ...(changedModel ? { contextRenewAt: undefined, contextSize: this.contextSize, used: this.used } : {}) });
    }
    this.notifyControls();
    return result;
  }

  composerState() {
    return { connected: !!this.backend, configOptions: this.backend ? this.setup.configOptions ?? [] : [],
      selected: this.rec.selectedConfig ?? {}, used: this.used, size: this.contextSize };
  }

  notifyControls(): void {
    for (const client of this.clients) if (client.controls) client.conn.notify(SessionControls.update, {
      agentId: this.agentId, controls: this.composerState(),
    });
  }

  invalidateUsage(): void {
    this.used = undefined;
    this.contextSize = undefined;
  }

  recordWorkflow(turnId: string, data: Record<string,unknown>): void {
    this.emit({sessionUpdate:"session_info_update",_meta:{"dev.xsb/workflow-log":{turnId,...data}}} as SessionUpdate);
  }

  toolOutput(value: string): void {
    this.estimated += textTokens(value);
  }

  /**
   * After a restart: the turn in which this conversation had taken in `count` inputs was cut short when xsb stopped.
   * They are not given again (Kernel.resume); the transcript says so, where the user sees it.
   */
  interrupted(count: number): void {
    this.emit({ sessionUpdate: "session_info_update", _meta: { [TurnFailure.key]: {
      message: `xsb stopped while this conversation was working on ${count === 1 ? "an input" : `${count} inputs`} it had already read. They were not given again, so how far the work got is unknown; check its results before going on.`,
      data: { errorKind: "execution_uncertain" } } } } as SessionUpdate);
  }

  observeExecution(): void {
    const turn = this.current;
    if (!turn || turn.executed) return;
    turn.executed = true;
    this.save({ contextExecution: { messageId: turn.first.messageId } });
  }

  /**
   * The user clears the context: the next turn starts a backend session that is given nothing of the conversation
   * so far. The transcript keeps it all, behind a boundary that says the model does not see it.
   */
  clear(): void {
    if (this.busy) throw failure("session_busy", { agent: this.agentId });
    const oldBackend = this.backend, oldSessionId = this.rec.backendSessionId;
    const boundary: Boundary = { kind: "cleared", handoff: false };
    const next: SessionRec = {
      ...this.rec, backendSessionId: undefined, renew: undefined, used: undefined, contextSize: undefined,
      contextRecovery: undefined, contextExecution: undefined, contextCheckpoint: undefined, contextHandoffPending: undefined, updatedAt: now()
    };
    const update: SessionUpdate = { sessionUpdate: "session_info_update", _meta: { [Boundaries.key]: boundary } } as SessionUpdate;
    this.hub.state.commit([ops.putSession(next), { file: Paths.transcript(this.agentId, this.id), rec: { ts: now(), update } }]);
    this.hub.state.afterCommit(() => {
      this.rec = next;
      this.finishRun({ stopReason: "cancelled" });
      this.lastRun = undefined;
      this.prefaces = [];
      if (oldSessionId) oldBackend?.close?.(oldSessionId);
      this.hub.rotateBridge(this);
      this.hub.backends.stop(this.agentId);
      this.backend = undefined;
      this.forget();
      this.estimated = 0;
      for (const client of this.clients) client.conn.notify("session/update", { sessionId: this.id, update });
      this.hub.kernel.hooks.emit("acp.session_renewed", { agentId: this.agentId, sessionId: this.id });
    });
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
    this.finishRun({ stopReason: "error", failure: new Error(`the agent program ${reason}`) });
    this.backend = undefined;
    this.notifyControls();
    if (this.current?.started) this.end({ stopReason: "error", failure: new Error(`the agent program ${reason}`) });
  }

  onBackendPermission(request: PermissionRequest): Promise<PermissionResponse> {
    if (request.sessionId !== this.rec.backendSessionId || !this.current?.started || !this.acceptsTools ||
      this.currentRun?.turnId !== this.current.id) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    this.observeExecution();
    return this.hub.permissions.request(this, request);
  }

  onBackendElicitation(request: ElicitationRequest, signal: AbortSignal): Promise<ElicitationResponse> {
    const target = (request._meta?.[TurnExt.key] as { id?: string } | undefined)?.id ??
      (request._meta?.[OriginExt.key] as OriginMeta | undefined)?.turnId;
    if (signal.aborted || request.sessionId !== this.rec.backendSessionId || !this.current?.started || !this.acceptsTools ||
      this.currentRun?.turnId !== this.current.id || target && target !== this.current.id) return Promise.resolve({ action: "cancel" });
    this.observeExecution();
    return this.hub.elicitations.request(this, request, signal);
  }

  save(patch: Partial<SessionRec>): void {
    const next = { ...this.rec, ...patch, updatedAt: now() };
    this.hub.state.commit([ops.putSession(next)]);
    this.hub.state.afterCommit(() => { this.rec = next; });
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
    if (turn?.recovering) return;
    const executing = this.currentRun ?? this.lastRun;
    const belongs = executing ? executing.turnId === turn?.id && !("state" in executing && executing.state === "idle") : !!turn?.started;
    const said = update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" ? update.content.text :
      update.sessionUpdate === "agent_message" && Array.isArray(update.content) ? update.content.map((b: ContentBlock) => b.type === "text" ? b.text ?? "" : "").join("") : "";
    if (turn && belongs && !turn.runEnd && said?.trim() && contextOverflow(said) && !turn.executed) {
      (turn.refusalChunks ??= []).push(update);
      return;
    }
    if (turn && belongs && !turn.runEnd && (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update" || update.sessionUpdate === "agent_message" || update.sessionUpdate === "agent_thought_chunk" ||
      (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && update.content.text?.trim() && !contextOverflow(update.content.text)))) this.observeExecution();
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
        if (update.state === "running" || update.state === "requires_action") this.startRun();
        else if (update.state === "idle") {
          const stopReason = update.stopReason ?? "end_turn";
          this.finishRun({ stopReason, ...(stopReason === "error" ? { failure: new RpcError(update.error?.code ?? -32603, update.error?.message ?? "the agent failed", update.error?.data) } : {}) }, update._meta?.["_claude/origin"]);
          this.idle();
        }
        break;
      case "session_info_update": {
        const title = typeof update.title === "string" ? conversationTitle(update.title) : "";
        if (!this.hub.agent(this.agentId).workflowOwner && !this.rec.titleEdited && title && title !== this.rec.title && !isXsbText(title)) {
          this.save({ title });
          // Native generators may publish after idle, when no further state change will refresh the client.
          this.hub.agentChanged(this.agentId);
        }
        break;
      }
      case "config_option_update":
        if (Array.isArray(update.configOptions)) {
          this.setup.configOptions = update.configOptions;
          this.notifyControls();
        }
        break;
      case "compaction_update":
        // The backend compacted the conversation itself: from here the model has its summary of what came before.
        if (update.status === "completed") {
          this.forget();
          this.boundary({ kind: "compacted", backend: this.hub.agent(this.agentId).backend, handoff: false });
        }
        break;
      case "usage_update":
        this.usageRevision++;
        if (typeof update.used === "number" && Number.isFinite(update.used) && update.used >= 0) {
          // Native compaction may have removed formerly-inlined assets/notes.
          if (this.used !== undefined && update.used < this.used) this.forgetGiven();
          this.used = update.used;
          this.estimated = update.used;
        }
        if (typeof update.size === "number" && Number.isFinite(update.size) && update.size > 0) this.contextSize = update.size;
        this.notifyControls();
        break;
    }
    // Attribution is supplied by the hub, never trusted from backend metadata. Late output after idle stays settled.
    const run = this.currentRun ? { ...this.currentRun, state: "running" as const } : this.lastRun;
    const attributed = { ...update, _meta: { ...update._meta } };
    if (run) attributed._meta[RunExt.key] = { ...run };
    else delete attributed._meta[RunExt.key];
    this.hub.kernel.hooks.emit("acp.session_update", { agentId: this.agentId, sessionId: this.id, update: attributed });
    if (!OWN.has(update.sessionUpdate)) this.emit(attributed);
  }

  private runStarted(): void {
    const run = this.currentRun!;
    if (this.announcedRun?.id === run.id && this.announcedRun.turnId === run.turnId) return;
    this.announcedRun = { ...run };
    this.emit({ sessionUpdate: "session_info_update", _meta: { [RunExt.key]: { ...run, state: "running" } } });
    this.hub.kernel.hooks.emit("acp.run_started", { agentId: this.agentId, sessionId: this.id, run: { ...run } });
    this.hub.kernel.hooks.emit("acp.turn_changed", { agentId: this.agentId, sessionId: this.id });
  }

  private startRun(): void {
    if (this.currentRun) return;
    const turn = this.current;
    // running is execution evidence, not an insertion receipt. A submitted first prompt can precede its receipt.
    const pendingNext = turn?.inputs.find(i => i.sent === "prompt" && !i.in && !i.runId);
    const request = turn?.runEnd ? pendingNext : turn && !turn.inserted ? turn.first : undefined;
    const owned = turn?.started && (!turn.runEnd || pendingNext) && (turn.inserted || turn.inputs.some(i => i.sent));
    const run: BackendRun = { id: newId("run"), turnId: owned ? turn!.id : null };
    this.currentRun = run;
    if (owned) {
      turn!.runEnd = undefined;
      // Other submitted prompts may still be held for later executions; running does not acknowledge them.
      for (const input of request?.batch ?? (request ? [request] : [])) if (input.sent && !input.in) input.runId = run.id;
    }
    const policy = run.turnId === null ? this.hub.kernel.hooks.decide("acp.pre_unowned_run", { agentId: this.agentId, sessionId: this.id, run: { ...run }, action: "show" }) : undefined;
    if (this.currentRun !== run) return;
    this.runStarted();
    // A synchronous hook can change the owner or replace the binding: cancel only this still-unowned execution.
    if (policy && this.currentRun === run && run.turnId === null && (isVeto(policy) || policy.action !== "show")) this.backend?.cancel(this.rec.backendSessionId!);
  }

  private finishRun(end: TurnEnd, origin?: unknown): void {
    const run = this.currentRun;
    if (!run) return;
    // A decision hook can synchronously close an execution before its start was announced.
    this.runStarted();
    this.currentRun = undefined;
    this.lastRun = { ...run, state: "idle", stopReason: end.stopReason, ...(origin !== undefined ? { origin } : {}) };
    if (this.current?.id === run.turnId) this.current.runEnd = end;
    this.emit({ sessionUpdate: "session_info_update", _meta: { [RunExt.key]: { ...this.lastRun } } });
    this.hub.kernel.hooks.emit("acp.run_ended", { agentId: this.agentId, sessionId: this.id, run: { ...run }, stopReason: end.stopReason, ...(origin !== undefined ? { origin } : {}) });
    this.hub.kernel.hooks.emit("acp.turn_changed", { agentId: this.agentId, sessionId: this.id });
  }

  /** Record an update and show it to every attached client but `except`. */
  emit(update: SessionUpdate, except?: Client): void {
    const file = Paths.transcript(this.agentId, this.id);
    const offset = this.hub.state.store.bytes(file);
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
    this.settled.add(input.messageId);
    this.emitInput(input);
  }

  private emitInput({ messageId, origin, content, from, deliveredAs }: Input): void {
    const meta = { [OriginExt.key]: origin, ...(deliveredAs ? { [DeliveredAs.key]: deliveredAs } : {}) };
    const except = from?.echo ? undefined : from;
    for (const block of content) {
      this.emit({ sessionUpdate: "user_message_chunk", content: block, messageId, _meta: meta }, except);
    }
  }

  /**
   * The user's message, accepted: recorded as waiting, so that what the user sees of it (also after a restart) is
   * what became of it: waiting, in the conversation, or discarded (docs/TURN-LIFECYCLE.md 4).
   */
  accept(messageId: string, origin: OriginMeta, content: ContentBlock[], from?: Client): void {
    if (this.settled.has(messageId)) return;
    // A client that did not opt in to its own input (`OriginExt`) is not sent it, as in plain ACP.
    this.emit({ sessionUpdate: "session_info_update", _meta: { [Accepted.key]: { messageId, origin, content } } } as SessionUpdate, from?.echo ? undefined : from);
  }

  /**
   * The user's message ended before it was this session's input (refused, expired, abandoned, dropped on a restart):
   * recorded as discarded, once. Its content is in its `Accepted` record.
   */
  unaccepted(messageId: string, reason: DiscardReason, detail?: string): void {
    if (this.settled.has(messageId)) return;
    this.settled.add(messageId);
    this.emit({ sessionUpdate: "session_info_update", _meta: { [Discarded.key]: { messageId, origin: { kind: "user", messageId }, content: [], reason, ...(detail ? { detail } : {}) } } } as SessionUpdate);
  }

  /** The insertion of a message this session holds (queued, carried or in the running turn), to wait on. */
  insertionOf(messageId: string): Promise<void> | undefined {
    return [...this.queue, ...this.carried, ...(this.current?.inputs ?? [])].find((i) => i.messageId === messageId)?.inserted.promise;
  }

  // ---- owed: the user's messages that failed to get to the model ----------------

  private owedFile(messageId: string): string {
    return path.join(this.hub.paths.dir, "agents", this.agentId, "context", `owed-${messageId.replace(/[^\w.-]/g, "_")}.json`);
  }

  /** The user's message failed to get into the conversation: the model is given it in front of the user's next one. */
  private owe(input: Input): void {
    const owed = this.rec.owed ?? [];
    if (owed.includes(input.messageId)) return;
    const file = this.owedFile(input.messageId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWrite(file, JSON.stringify(input.content));
    this.save({ owed: [...owed, input.messageId] });
  }

  /**
   * The user sends an owed message again, as a message of its own: it is no longer owed. One that already went to the
   * model with a later message, or is on its way there, is not sent twice.
   */
  resend(messageId: string, as: string): void {
    if (this.owedCarrier?.owedIds?.includes(messageId) && this.owedCarrier.sent && !this.owedCarrier.in) {
      throw new RpcError(-32602, "This message is on its way to the model with the user's latest message; it is not sent again.", { errorKind: "already_redelivered" });
    }
    if ((this.rec.redelivered ?? []).includes(messageId)) {
      throw new RpcError(-32602, "This message already reached the model with a later message; it is not sent again.", { errorKind: "already_redelivered" });
    }
    if ((this.rec.owed ?? []).includes(messageId)) {
      this.save({ owed: this.rec.owed!.filter((id) => id !== messageId) });
      fs.rmSync(this.owedFile(messageId), { force: true });
    }
    // Recorded, so that the transcript (also after a restart) no longer says it will be given with the next message.
    this.emit({ sessionUpdate: "session_info_update", _meta: { [Discarded.key]: { messageId, origin: { kind: "user", messageId }, content: [], owed: false, resentAs: as } } } as SessionUpdate);
  }

  /** The owed messages, for the prompt of a user's input, and the text that introduces them. */
  private owedContent(policy: ReturnType<Hub["policy"]>): { ids: string[]; content: ContentBlock[] } | undefined {
    const ids: string[] = [], content: ContentBlock[] = [];
    for (const id of this.rec.owed ?? []) {
      let blocks: ContentBlock[];
      try { blocks = JSON.parse(fs.readFileSync(this.owedFile(id), "utf8")); } catch { continue; }
      ids.push(id);
      content.push(text(`[xsb] Earlier message ${ids.length} from the user (it failed to reach you then):`), ...this.spill(blocks, policy));
    }
    if (!ids.length) return undefined;
    return { ids, content: [text(`[xsb] ${ids.length === 1 ? "A message" : `${ids.length} messages`} the user sent earlier did not reach you: giving ${ids.length === 1 ? "it" : "them"} to you failed, and you have not seen ${ids.length === 1 ? "it" : "them"} until now. ${ids.length === 1 ? "It comes" : "They come"} first, in order; the user's new message follows. Take ${ids.length === 1 ? "it" : "them"} into account; the user may refer to ${ids.length === 1 ? "it" : "them"}.`), ...content, text("[xsb] The user's new message:")] };
  }

  /** The owed messages went into the conversation with `carrier`: settled, once, and said so. */
  private redelivered(carrier: Input): void {
    const ids = carrier.owedIds ?? [];
    if (this.owedCarrier === carrier) this.owedCarrier = undefined;
    if (!ids.length) return;
    const left = (this.rec.owed ?? []).filter((id) => !ids.includes(id));
    this.save({ owed: left, redelivered: [...(this.rec.redelivered ?? []), ...ids].slice(-200) });
    for (const id of ids) fs.rmSync(this.owedFile(id), { force: true });
    this.emit({ sessionUpdate: "session_info_update", _meta: { [Redelivered.key]: { messageIds: ids, with: carrier.messageId } } } as SessionUpdate);
  }

  /**
   * Record, and show, that the model never saw this input (see `Discarded` in @xsb/protocol); `why` it did not. The
   * user's input that failed to get there (not stopped, not too large) is owed: it goes with the user's next message.
   */
  private discard(input: Input, why?: unknown, reason?: DiscardReason): void {
    if (input.receipted) return; // A failed replacement context cannot invalidate the original insertion receipt.
    const { messageId, origin, content } = input;
    const kind = (why as RpcError | undefined)?.data && typeof (why as RpcError).data === "object" ? ((why as RpcError).data as { errorKind?: string }).errorKind : undefined;
    reason ??= this.userStopping || !why || (why instanceof RpcError && why.code === RpcError.CANCELLED) ? "stopped"
      : kind === "input_too_large" ? "too_large" : /Target turn has ended or changed/.test(errorMessage(why)) ? "expired" : "failed";
    const owed = users(input) && reason === "failed";
    if (owed) this.owe(input);
    if (this.settled.has(messageId) && !input.shown) return void this.receipt(input, false, why);
    this.settled.add(messageId);
    const detail = why && reason !== "stopped" ? errorMessage(why) : undefined;
    this.emit({ sessionUpdate: "session_info_update", _meta: { [Discarded.key]: { messageId, origin, content, reason, ...(detail ? { detail } : {}), ...(owed ? { owed } : {}) } } } as SessionUpdate);
    this.receipt(input, false, why);
  }

  /** The receipt of an input: it is in the conversation, or it never will be. Its sender learns which. */
  private receipt(input: Input, inserted: boolean, why: unknown = RpcError.cancelled()): void {
    if (inserted && input.receipted) return;
    const about = { agentId: this.agentId, sessionId: this.id, from: fromOf(input.origin), ...(input.origin.taskId ? { taskId: input.origin.taskId } : {}) };
    this.hub.kernel.mark(input.messageId, inserted ? "inserted" : "discarded_unseen", about);
    this.hub.kernel.hooks.emit("message.insertion_receipt", { messageId: input.messageId, about, inserted });
    if (inserted) {
      input.receipted = true;
      this.hub.workflows?.inserted(this,input.messageId);
      this.show(input);
      input.inserted.resolve();
    } else {
      if (users(input)) this.hub.workflows?.discarded(this, input.messageId);
      input.inserted.reject(why);
    }
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
      this.discard(q, RpcError.cancelled(), "stopped");
      return false;
    });
    return taken;
  }

  /**
   * Start the next turn, when there is input for one and none runs. What the user said that a stop kept from the
   * model goes first, as a turn of its own, once something else is to run (docs/DESIGN.md 3.1, 8).
   */
  pump(): void {
    // While the hub stops, nothing starts: what waits is in the inbox, and runs on the next start.
    if (this.userStopping || this.current || this.hub.stopping) return;
    if (this.hub.workflows?.available(this) === false) {
      for (const input of [...this.queue.splice(0), ...this.carried.splice(0)]) this.discard(input);
      return;
    }
    // Recheck queued workflow effects after the preceding turn has released this session.
    while (this.queue.length) {
      const input = this.queue[0];
      const staleAttempt = input.origin.kind === "system" && input.messageId.startsWith("attempt_") &&
        this.hub.workflows?.acceptsAttempt(this,input.messageId) === false;
      const staleNotice = input.item?.workflowNotice && !this.hub.workflows.acceptsNotice(this,input.messageId);
      if (!staleAttempt && !staleNotice && !(input.item && this.hub.kernel.settleTerminalInput(input.item))) break;
      if (staleNotice) this.hub.kernel.ack([input.messageId]);
      this.discard(this.queue.shift()!);
    }
    if (!this.queue.length) return;
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
    turn.recoveryAttempts = this.rec.contextRecovery?.messageId === first.messageId ? this.rec.contextRecovery.attempts : 0;
    turn.taskIds = this.hub.kernel.openTasks(this.id).filter((t) => !t.stopping).map((t) => t.id);
    this.current = turn;
    this.turnChanged();
    this.hub.agentChanged(this.agentId);
    this.state("running");
    if (this.rec.contextExecution?.messageId === first.messageId) {
      first.receipted = ["inserted", "seen"].includes(this.hub.state.ledger.get(first.messageId)?.state ?? "");
      first.shown = first.receipted;
      return this.end({ stopReason: "error", failure: new RpcError(-32603,
        "This interrupted input had already produced output or invoked tools. Verify its results before continuing; xSB did not replay it.", { errorKind: "execution_uncertain" }) });
    }
    try {
      const backend = await this.ensureBackend();
      if (this.current !== turn || turn.cancelledBy) {
        if (this.current === turn) this.end({stopReason:"cancelled"});
        return;
      }
      const assignment = this.hub.workflows?.model(this);
      if (assignment) {
        const options = this.setup.configOptions;
        const option = Array.isArray(options) && options.find(o => o.category === "model" || optionId(o) === "model");
        const configId = this.rec.workflowModel?.configId ?? optionId(option || undefined) ?? "model";
        const saved = this.rec.selectedConfig?.[configId];
        const baseline = this.rec.workflowModel ? this.rec.workflowModel.baseline : (saved ?? option?.currentValue);
        const model = assignment.requested ?? assignment.inherited?.[configId] ?? baseline;
        if (model && model !== (saved ?? option?.currentValue)) {
          const response = await backend.conn.request("session/set_config_option",{sessionId:this.rec.backendSessionId,configId,type:"id",value:model});
          if (this.current !== turn || turn.cancelledBy) {
            if (this.current === turn) this.end({stopReason:"cancelled"});
            return;
          }
          this.setup = {...this.setup,...response};
          this.save({selectedConfig:{...this.rec.selectedConfig,[configId]:model}, workflowModel:{configId,baseline}});
          this.notifyControls();
        } else if (!model && this.rec.workflowModel) {
          // An adapter may omit its default. Restore it with a new backend context
          // and the standard handoff when a revised definition drops its model.
          const selectedConfig = {...this.rec.selectedConfig};
          delete selectedConfig[configId];
          backend.close?.(this.rec.backendSessionId!);
          this.hub.backends.stop(this.agentId);
          this.hub.rotateBridge(this);
          this.backend = undefined;
          this.save({backendSessionId:undefined,renew:true,workflowModel:undefined,selectedConfig});
          await this.ensureBackend();
        }
      }
    } catch (e) {
      if (this.current === turn) this.end({ stopReason: "error", failure: e });
      return;
    }
    // Stopped meanwhile: it ended already, or ends now.
    if (this.current !== turn) return;
    if (turn.cancelledBy) return this.end({ stopReason: "cancelled" });
    if (first.item?.workflowNotice && !this.hub.workflows.acceptsNotice(this, first.messageId)) {
      turn.cancelledBy = "hub";
      return this.end({ stopReason: "cancelled" });
    }
    this.workflowContext(turn);
    turn.started = true;
    // What waited in the inbox comes with this turn, in its first prompt.
    const digest = this.hub.delivery.digest(this, Math.max(0, this.hub.policy(this.agentId).promptTokens - this.standingTokens - this.hub.policy(this.agentId).reserveTokens - contentTokens(first.content) - contentTokens(turn.held.flatMap(i => i.content)) - contentTokens(this.prefaces.map(text)))).map((d) => inputOf(d));
    turn.inputs.splice(1, 0, ...digest);
    turn.order!.splice(1, 0, ...digest);
    turn.items.push(...itemsOf(digest));
    this.send([first, ...digest, ...turn.held.splice(0)]);
  }

  private workflowContext(turn:Turn): void {
    const workflowContext = this.hub.workflows?.context(this,turn);
    if (workflowContext) {
      // Of this turn only: a later turn is given its own, up to date (`refused` does not put it back).
      turn.workflowPreface = workflowContext;
      this.preface(workflowContext);
      void turn.first.inserted.promise.then(() => this.recordWorkflow(turn.id,{ context:workflowContext }),() => {});
    }
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
    const policy = this.hub.policy(this.agentId);
    if (this.handoffPreface && this.prefaces.includes(this.handoffPreface)) {
      const left = policy.promptTokens - policy.reserveTokens - this.standingTokens - contentTokens(batch.flatMap((i) => i.content)) -
        contentTokens(this.prefaces.filter((p) => p !== this.handoffPreface).map(text));
      if (textTokens(this.handoffPreface) > left && this.rec.contextCheckpoint) {
        const ref = this.rec.contextCheckpoint;
        const shorter = left >= 512 ? boundedText(this.hub.paths, this.agentId,
          fs.readFileSync(path.join(this.hub.paths.dir, "agents", this.agentId, "context", `${ref}.txt`), "utf8"), left) :
          `[xsb] Handoff ref: ${ref}. Use read_context before relying on earlier work.`;
        this.prefaces = this.prefaces.map((p) => p === this.handoffPreface ? shorter : p);
        this.handoffPreface = shorter;
      }
    }
    // The user's earlier messages that never got to the model go in front of the user's next one, until one is in.
    const carrierBusy = !!this.owedCarrier && !!this.owedCarrier.sent && !this.owedCarrier.in && !!turn.inputs.includes(this.owedCarrier);
    const userInput = batch.find(users);
    const owed = userInput && !carrierBusy ? this.owedContent(policy) : undefined;
    if (userInput) userInput.owedIds = owed?.ids;
    if (owed && userInput) this.owedCarrier = userInput;
    const content = [...this.prefaces.map((p) => text(p)), ...(owed?.content ?? []), ...batch.flatMap(i => {
      // A node's first input has its purpose in the turn's workflow context; the main conversation's does not.
      const scope = users(i) && (i !== turn.first || !this.hub.agent(this.agentId).workflowOwner) ? this.hub.workflows?.interruptionContext(this,i.messageId) : undefined;
      if (scope) void i.inserted.promise.then(()=>this.recordWorkflow(turn.id,{messageId:i.messageId,scope}),()=>{});
      // What the message is to the question the agent asked, if it replies to one (questions.ts): the card shows the user.
      const reply = users(i) ? this.hub.questions?.scope(i.messageId) : undefined;
      if (reply) void i.inserted.promise.then(() => this.hub.questions?.given(i.messageId), () => {});
      const given = users(i) ? this.spill(i.content, policy) : i.content;
      if (users(i)) i.deliveredAs = deliveredAs(i.content, given, scope, backend.caps.image);
      return [...[reply, scope].filter((note): note is string => !!note).map((note) => text(note)), ...given];
    })];
    const tokens = contentTokens(content);
    if (tokens + this.standingTokens + policy.reserveTokens > policy.promptTokens) {
      const error = new RpcError(-32602, "This input exceeds the agent's prompt budget. The original is preserved in the conversation; split the input or use files/assets with references.", { errorKind: "input_too_large" });
      if (turn.inserted) {
        for (const input of batch) { this.drop(input); this.discard(input, error); }
        this.hub.kernel.ack(itemsOf(batch).map((m) => m.id));
        return;
      }
      turn.started = false;
      return this.end({ stopReason: "error", failure: error });
    }
    if (!turn.inserted && !turn.recovering && !this.prefaces.length && (this.used ?? 0) > 0 && this.estimated + tokens + policy.reserveTokens > this.contextLimit()) {
      return void this.recover(turn, new Error("Context window exceeded before submission"), false);
    }
    // They go with this batch; they are spent once it is in (`landed`), and come back if it is not (`refused`).
    const carried = this.prefaces;
    this.prefaces = [];
    for (const input of batch) input.prefaces = carried;
    this.estimated += tokens;
    if (this.rec.backendFresh || !this.rec.conversed) this.save({ backendFresh: undefined, conversed: true });
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
        if (this.backend !== backend || this.rec.backendSessionId !== sessionId) return;
        if (answered) this.landed(batch);
      },
      (e) => {
        if (this.backend === backend && this.rec.backendSessionId === sessionId) this.refused(batch, e, backend);
      },
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
    // A later prompt held by the backend belongs to the next execution of this same logical turn. The first
    // prompt's receipt may simply follow the idle of its own execution, in which case its end must be retained.
    if (turn.runEnd && !turn.cancelledBy && batch.every(i => i.runId !== this.lastRun?.id)) turn.runEnd = undefined;
    turn.inserted = true;
    // Input inserted into an autonomous execution claims it from this point; earlier output keeps its null owner.
    if (this.currentRun?.turnId === null && !turn.runEnd && !turn.cancelledBy) {
      this.currentRun.turnId = turn.id;
      this.runStarted();
    }
    if (this.currentRun?.turnId === turn.id) for (const input of batch) input.runId = this.currentRun.id;
    if (this.rec.contextHandoffPending) this.save({ contextHandoffPending: undefined });
    if (this.rec.migratedFrom?.pending) this.save({ migratedFrom: { ...this.rec.migratedFrom, pending: undefined } });
    for (const input of batch) if (input.owedIds) this.redelivered(input);
    for (const input of batch) {
      input.in = true;
      this.take(input.gives);
      this.receipt(input, true);
    }
    for (const input of turn.held.splice(0)) this.send([input]);
    if (this.runEndedFor(turn)) this.idle();
  }

  /**
   * The backend did not take input. Not taken for a stop (-32800), it is left out of the turn (`leave`); refused for
   * another reason, its sender is told why, and a turn that has nothing in the conversation yet fails with it.
   */
  private refused(batch: Input[], e: unknown, backend: Backend): void {
    const turn = this.current;
    if (!turn || !batch.every((i) => turn.inputs.includes(i) && i.sent && !i.in)) return;
    if (e instanceof RpcError && e.code === RpcError.CANCELLED) {
      this.restorePrefaces(batch, turn);
      for (const input of batch) this.leave(input);
      return this.settle();
    }
    if (contextOverflow(e) && this.canRecover(turn)) return void this.recover(turn, e);
    const failure = this.explain(e, backend);
    // What came in front of it (instructions, a handoff) was not given: it goes in front of the next prompt.
    this.restorePrefaces(batch, turn);
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

  /**
   * The user's input as the model is given it: a text block too large for the prompt budget (a huge paste) is saved,
   * whole, to a file in the agent's context folder, and the model gets its beginning and the file's path to read the
   * rest from. The transcript keeps what the user sent; nothing of it is lost or rejected for its size.
   */
  private spill(content: ContentBlock[], policy: ReturnType<Hub["policy"]>): ContentBlock[] {
    // Room for this input: half of what the prompt budget leaves. Its largest text blocks are saved first, until
    // what remains fits; one block over the room on its own is always saved.
    const room = Math.max(2048, Math.floor((policy.promptTokens - policy.reserveTokens - this.standingTokens) / 2));
    const out = [...content];
    const largest = out.map((block, i) => ({ i, tokens: block.type === "text" ? textTokens(block.text ?? "") : 0 }))
      .filter((x) => x.tokens > PASTE_EXCERPT_BYTES / 2).sort((a, b) => b.tokens - a.tokens);
    for (const { i } of largest) {
      if (contentTokens(out) <= room) break;
      const whole = out[i].text ?? "";
      const { file } = contextRef(this.hub.paths, this.agentId, whole);
      const head = Buffer.from(whole, "utf8").subarray(0, PASTE_EXCERPT_BYTES).toString("utf8").replace(/\uFFFD$/, "");
      out[i] = text(`[xsb] The user's input was too large to give in full (${whole.length.toLocaleString("en")} characters). ` +
        `It is saved whole at ${file}; read that file for all of it. It begins:\n\n${head}\n\n[… continues in ${file}]`);
    }
    return out;
  }

  /** A batch was not taken in: the prefaces it carried are owed still, except this turn's workflow context. */
  private restorePrefaces(batch: Input[], turn: Turn): void {
    const owed = (batch[0]?.prefaces ?? []).filter((p) => p !== turn.workflowPreface && !this.prefaces.includes(p));
    this.prefaces = [...owed, ...this.prefaces];
    for (const input of batch) input.prefaces = undefined;
  }

  /** The backend's work is idle. It ends the turn, unless none of the turn is in the conversation yet. */
  private idle(): void {
    const turn = this.current;
    if (!turn || !this.runEndedFor(turn)) return;
    // The work that ended was not this turn's: the backend has not taken its first input yet.
    if (!turn.inserted && !turn.cancelledBy) return;
    // A prompt receipt can follow idle. Wait for it on normal completion and stop; a failed execution instead
    // cancels and fences the unanswered requests in end(), so a broken backend cannot hold the turn forever.
    if (!turn.runEnd?.failure && turn.inputs.some((i) => i.sent === "prompt" && !i.in)) return;
    this.end(turn.runEnd ?? { stopReason: "cancelled" });
  }

  /** After a stop or a refusal: a turn that has nothing in the conversation or on its way ends at once; else at the backend's idle. */
  private settle(): void {
    const turn = this.current;
    if (!turn) return;
    if (!turn.inserted && !turn.inputs.some((i) => i.sent)) return this.end({ stopReason: "cancelled" });
    if (this.runEndedFor(turn)) this.idle();
  }

  /**
   * Only the end of an owned execution ends this turn. A stop before execution can finish once the backend is idle.
   */
  private runEndedFor(turn: Turn): boolean {
    return !!turn.runEnd || (!this.currentRun && !!turn.cancelledBy);
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
    if (end.failure && contextOverflow(end.failure) && this.canRecover(turn)) return void this.recover(turn, end.failure);
    this.hub.elicitations?.cancel(this);
    if (this.currentRun?.turnId === turn.id) this.finishRun(end);
    if (!turn.cancelledBy) for (const update of turn.refusalChunks ?? []) this.emit(update);
    turn.refusalChunks = [];
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
    // Only an append the backend was given can still surface in a later turn; one the hub held never reached it.
    const expiredAppendSent = out.some((i) => i.item?.targetTurnId && i.sent);
    // Failed with input given and not answered: the backend may still have it, and run it. It is given again (`again`),
    // so the old backend is fenced first, as after a stop: one copy only ever reaches the model. (Read before `leave`
    // forgets what was sent.)
    const unanswered = !!end.failure && turn.started && out.some((i) => i.sent);
    // A prompt the turn ends without having in the conversation took prefaces along: they are owed still.
    const unsent = out.find((i) => i.sent && i.prefaces);
    if (unsent) this.restorePrefaces(unsent.batch ?? [unsent], turn);
    let next: Input[] = [];
    if (!turn.started && end.failure && !this.hub.stopping) {
      // It never reached the backend: nothing else will run what it brought (its tasks fail with it).
      for (const input of out) this.discard(input, end.failure);
    } else if (!turn.started && end.failure) {
      // While the hub stops, what never reached the backend stays in the inbox and runs on the next start.
      for (const input of out) this.leave(input);
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
    this.turnChanged();
    if (unanswered && this.backend) this.backend.cancel(this.rec.backendSessionId!);
    // Turn isolation holds once cancelled work reports idle; a failure's unanswered input is not awaited, so it is
    // fenced whatever the backend promises.
    if ((unanswered || turn.cancelledBy && !this.backend?.caps.orderedCancellation) && this.backend) {
      // Untagged old MCP requests of stopped work cannot be distinguished after a new turn begins on the same bridge.
      // Fence the old transport/token; resume the saved session in a new process to retain backend history.
      // A turn that ended normally has no such requests: its backend reported the end after every tool call returned,
      // so the process, and its prompt cache, stay.
      this.backend.close?.(this.rec.backendSessionId!);
      this.hub.rotateBridge(this);
      this.hub.backends.stop(this.agentId);
      this.backend = undefined;
    }
    if (expiredAppendSent && !turn.cancelledBy && this.backend) {
      // Normal cancellation has already confirmed idle and settled prompt receipts:
      // keep that conversation and its tools, including image context. An unread
      // targeted append on normal completion still needs isolation before new work.
      this.backend.cancel(this.rec.backendSessionId!);
      this.backend.close?.(this.rec.backendSessionId!);
      this.hub.rotateBridge(this);
      this.backend = undefined;
      this.save({ backendSessionId: undefined, renew: "isolated" });
    }
    if (this.used !== undefined && (this.used !== this.rec.used || this.contextSize !== this.rec.contextSize)) this.save({ used: this.used, contextSize: this.contextSize });
    // While the hub stops, nothing is acknowledged: the turn runs again on the next start.
    if (!this.hub.stopping) {
      if (end.failure) this.hub.log(`${this.agentId}/${this.id}: turn failed: ${errorMessage(end.failure)}`);
      // Its failure goes into the transcript, where the user sees it: the prompt that started it may have been answered long ago.
      if (end.failure) this.emit({ sessionUpdate: "session_info_update", _meta: { [TurnFailure.key]: { message: errorMessage(end.failure), data: (end.failure as RpcError).data } } } as SessionUpdate);
      this.hub.state.atomic(() => {
        this.hub.state.afterCommit(() => this.hub.kernel.hooks.emit("acp.turn_ended", { agentId: this.agentId, sessionId: this.id, turnId: turn.id, stopReason: end.stopReason, failed: !!end.failure }));
        this.hub.workflows?.ended(this,turn,end);
        this.hub.delivery.turnEnded(this, turn, end);
        this.hub.state.afterCommit(() => this.hub.agentChanged(this.agentId));
      });
    }
    this.state("idle", end);
    turn.done.resolve(end);
    this.releaseUserStop(false);
    if (!end.failure) this.save({ contextRecovery: undefined });
    if (next.length && !this.hub.stopping) return this.resume(next,turn);
    this.renewIfLong(end.failure);
    this.pump();
  }

  /** Only an explicit refusal with no observed output/tools may replay. No task failure/notification is published yet. */
  private canRecover(turn: Turn): boolean {
    return !turn.cancelledBy && !turn.recovering && !turn.executed && !this.hub.stopping && !this.userStopping &&
      !this.hub.kernel.sourceStopped({ agentId: this.agentId, sessionId: this.id }) &&
      !turn.inputs.some((i) => i.item?.targetTurnId) && (turn.recoveryAttempts ?? 0) < this.hub.policy(this.agentId).recoveryAttempts;
  }

  private async recover(turn: Turn, error: unknown, failed = true): Promise<void> {
    if (this.current !== turn || turn.recovering) return;
    turn.recovering = true;
    this.finishRun({ stopReason: "error", failure: error });
    turn.refusalChunks = [];
    turn.started = false;
    if (failed) turn.recoveryAttempts = (turn.recoveryAttempts ?? 0) + 1;
    const used = this.used;
    const oldSessionId = this.rec.backendSessionId;
    // This is a conservative renewal policy from observed rejection, not a discovered API capacity.
    const renewAt = failed && used && used > 8192 ? Math.floor(used * 0.7) : this.rec.contextRenewAt;
    this.save({ backendSessionId: undefined, renew: true, used: undefined, contextSize: undefined, contextRenewAt: renewAt,
      contextRecovery: { messageId: turn.first.messageId, attempts: turn.recoveryAttempts ?? 0 } });
    this.hub.log(`${this.agentId}/${this.id}: recovering context (${turn.recoveryAttempts ?? 0}); ${errorMessage(error)}`);
    if (oldSessionId) this.backend?.close?.(oldSessionId);
    this.backend = undefined;
    this.hub.backends.stop(this.agentId);
    this.hub.rotateBridge(this);
    this.prefaces = [];
    this.forget();
    this.estimated = 0;
    this.turnChanged();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.ensureBackend(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            if (this.current === turn) this.hub.backends.stop(this.agentId);
            reject(new Error("Context recovery timed out while opening the backend."));
          }, 30_000);
        }),
      ]);
      if (this.current !== turn) return;
      turn.recovering = false;
      if (turn.cancelledBy || this.userStopping || this.hub.kernel.sourceStopped({ agentId: this.agentId, sessionId: this.id })) return this.end({ stopReason: "cancelled" });
      // Existing receipts stay valid; only the new backend's insertion is reset. Keep original order and tasks.
      for (const input of turn.inputs) {
        if (input.item) {
          const rendered = this.hub.delivery.render(input.item, this);
          if (rendered) { input.content = rendered.prompt; input.prompt = rendered.prompt; input.gives = rendered.gives; }
        }
        input.in = false; input.sent = undefined; input.batch = undefined; input.runId = undefined;
      }
      turn.inserted = false;
      turn.started = true;
      turn.runEnd = undefined;
      this.lastRun = undefined;
      turn.held = [];
      this.workflowContext(turn);
      this.send([...turn.inputs]);
    } catch (failure) {
      if (this.current !== turn) return;
      turn.recovering = false;
      this.end({ stopReason: "error", failure });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Input given into work that ended without taking it is the next turn: the backend runs it next (a prompt waits
   * in the backend for the work under way), or it dropped it (input given with `_session/steering`), and it is given
   * again, as a prompt.
   */
  private resume(inputs: Input[], previous: Turn): void {
    const turn: Turn = { id: newId("turn"), protected: inputs.some(users), first: inputs[0], inputs, order: [...inputs], held: [], inserted: false, items: itemsOf(inputs), started: true, done: deferred() };
    turn.taskIds = this.hub.kernel.openTasks(this.id).filter((t) => !t.stopping).map((t) => t.id);
    this.current = turn;
    this.turnChanged();
    this.hub.workflows?.inheritSeen(previous,turn);
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
    // Accepting input does not grant execution permissions to an unowned run. Users still join and protect the
    // logical turn while its first prompt waits for insertion, as they do during context recovery.
    if (!turn || turn.cancelledBy || this.userStopping || (turn.recovering && req.origin.kind !== "user") ||
      this.hub.kernel.sourceStopped({ agentId: this.agentId, sessionId: this.id }) || (targetTurnId && targetTurnId !== turn.id)) return undefined;
    // An agent's word goes into an agent's turn only; once the user's (protected), it waits its turn (`enqueue`).
    if (req.origin.kind === "agent" && !targetTurnId && turn.protected) return undefined;
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
    this.hub.kernel.hooks.emit("acp.turn_changed", { agentId: this.agentId, sessionId: this.id });
    const inputs = [...this.queue, ...this.carried, ...(this.current?.inputs ?? [])];
    return {
      pending: inputs.filter((i) => !i.in && !i.receipted).map((i) => i.messageId),
      sent: inputs.filter((i) => !i.in && !i.receipted && i.sent).map((i) => i.messageId),
      inserted: inputs.filter((i) => i.in || i.receipted).map((i) => i.messageId),
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
    this.hub.elicitations?.cancel(this);
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
    this.hub.elicitations?.cancel(this);
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
    this.hub.elicitations?.cancel(this);
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
