/**
 * Every ACP extension the system uses, in one place.
 *
 * Rule: one feature, one extension, the same on every ACP edge. The hub is an
 * ACP agent towards the outside (editor, CLI) and an ACP client towards each
 * backend; both edges import these definitions, so an extension cannot mean
 * two things. What ACP v2 has itself (putting a message into running work,
 * receipts of insertion, the state of the work) is used as it is.
 *
 * Wire conventions follow ACP extensibility: custom methods start with `_`,
 * custom data lives under `_meta`, support is advertised in `_meta` during
 * `initialize`, an unknown request answers -32601 and an unknown notification
 * is ignored.
 */
import type { ContentBlock, SessionUpdate } from "./acp.ts";

/** Namespace of the extensions this project defines itself. */
export const NS = "dev.xsb";

/** Backend promise: after cancelled work reports idle, no tool call/reply from it can arrive later. */
export const TurnIsolation = { key: `${NS}/turn-isolation`, version: 1 } as const;

/**
 * Agents: one ACP connection reaches many agents.
 *
 *   advertise  capabilities._meta["dev.xsb/agents"] = { version: 1 }
 *   opt in     capabilities._meta["dev.xsb/agents"] = {}   (receive `update`, see below)
 *   create     session/new starts a main conversation. session/resume opens an existing one.
 *   address    SessionInfo._meta["dev.xsb/agent"] identifies the conversation's agent.
 *   request    _dev.xsb/agents/list returns main agents and started, active workflow instances.
 *   notify     _dev.xsb/agents/update and _dev.xsb/agents/removed update that directory.
 *   change     _dev.xsb/agents/set { agentId, avatar?, backend? } sets a main conversation's icon, or its backend (idle
 *              only: the next turn starts a session of the new backend, handed the conversation); answers the AgentInfo.
 *
 * A client that opted in is an observer: it also receives permission requests
 * of sessions nobody is attached to, so an unattended agent is never stuck.
 */
export type AgentSpec = {
  /** Set only for an execution instance of a workflow node. */
  workflowOwner?: string;
  workflowNode?: string;
  conversation?: boolean;
  /** Bundled avatar ID. Empty or absent uses the default. */
  avatar?: string;
  id: string;
  name: string;
  description: string;
  /** Name of a backend of the machine the hub runs on. */
  backend: string;
  /** Absolute working directory. */
  workspace: string;
  createdAt: string;
  /** When the user deleted this conversation. It is out of every list; its files stay until `Agents.purge`. */
  deleted?: string;
};

export type AgentState = "idle" | "running" | "requires_action";

export type AgentInfo = AgentSpec & {
  state: AgentState;
  /** The agent's conversation, once it has one: the one session the user, its peers and xsb talk to it in. */
  mainSessionId?: string;
  /** Snapshot for turn-bound operations. Recheck at execution time. */
  currentTurnId?: string;
  turnProtected?: boolean;
  /** A workflow node's agent whose node an adopted version dropped: its conversation can be read, not continued. */
  retired?: boolean;
  /**
   * Its conversation has been given to the agent program (a backend session holds it): its backend cannot change in
   * place any more; switching moves the conversation to a new one (`Agents.migrate`). Before that, the backend is
   * not called at all and switching is free.
   */
  backendStarted?: boolean;
  /** The agent asked the user something (`Question`) and waits for the reply; its state stays what its work is. */
  asking?: boolean;
};

/** Current backend-provided settings and token counts for one conversation. */
export const SessionControls = {
  capability: `${NS}/session-controls`,
  get: `_${NS}/session-controls/get`,
  update: `_${NS}/session-controls/update`,
} as const;

export type ComposerState = {
  connected: boolean;
  /** No backend session yet: it is made with the first message, and its settings are offered from then on. */
  lazy?: boolean;
  configOptions: unknown;
  selected: Record<string, string>;
  used?: number;
  size?: number;
};

export const Agents = {
  capability: `${NS}/agents`,
  sessionKey: `${NS}/agent`,
  mainKey: `${NS}/main`,
  list: `_${NS}/agents/list`,
  update: `_${NS}/agents/update`,
  removed: `_${NS}/agents/removed`,
  set: `_${NS}/agents/set`,
  asks: `_${NS}/agents/asks`,
  /**
   * Move a main conversation that has been given to its agent program onto another backend: a new conversation, whose
   * model can read the old one with its `previous_conversation` tool. Refused while a turn of it runs.
   *   request  _dev.xsb/agents/migrate { agentId, backend } -> { agent: AgentInfo }   (the new conversation)
   */
  migrate: `_${NS}/agents/migrate`,
  /**
   * Delete a main conversation: out of the list, its backends stopped, its workflow paused, input still queued for it
   * dropped. Refused while it or an agent of its workflow is working. Its files stay until `purge`.
   *   request  _dev.xsb/agents/delete { agentId } -> {}   (then `removed` for it and its workflow's agents)
   */
  delete: `_${NS}/agents/delete`,
  /**
   * Clean up the project: remove for good what deleted conversations left — their transcripts, drafts, the assets
   * only they made, their records — and compact the logs.
   *   request  _dev.xsb/agents/purge {} -> { conversations: number, bytes: number }
   */
  purge: `_${NS}/agents/purge`,
} as const;

/**
 * Plugins (the hub's plugins.ts) are read from their folders when a backend starts. After the folders or their
 * settings changed, a client may tell the hub instead of restarting it:
 *
 *   request    _dev.xsb/tools/apply {} -> { waiting: number }
 *              a conversation whose tools or prompt would now differ resumes its backend session in a new process;
 *              an idle one at once, a working one once its work is over (`waiting` of them). Others are left alone.
 */
export const ToolServers = {
  apply: `_${NS}/tools/apply`,
} as const;


/**
 * Backends: what an agent can run on, on the machine the hub runs on.
 *
 *   advertise  capabilities._meta["dev.xsb/backends"] = { version: 1 }
 *   request    _dev.xsb/backends/list {} -> { backends: BackendInfo[] }
 *
 * Whether a backend is installed is the hub's answer because the hub is the
 * process that starts it: a client's PATH may differ.
 */
export const Backends = {
  capability: `${NS}/backends`,
  list: `_${NS}/backends/list`,
} as const;

export type BackendInfo = {
  name: string;
  command: string;
  args: string[];
  /** The command is on the hub's PATH. */
  installed: boolean;
  /** How to get it, when the hub knows. */
  installHint?: string;
};

/**
 * Tasks: observe work one agent dispatched to another.
 *
 *   advertise  capabilities._meta["dev.xsb/tasks"] = { version: 1 }
 *   request    _dev.xsb/tasks/list { agentId?, status? } -> { tasks: Task[] }
 *              _dev.xsb/tasks/cancel { taskId }           -> { task: Task, with: Task[] }   (the user stops any task)
 *   notify     _dev.xsb/tasks/update { task: Task }      (hub -> observers)
 */
/** One session of one agent: where mail comes from and goes to. */
export type Addr = { agentId: string; sessionId: string };

/** What an agent's id may be. It names a directory and is a word of a command line, so it starts with a letter or a digit. */
export const AGENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
/** What a role, a skill, an MCP server and an asset type may be called. */
export const NAME = /^[\w-]+$/;

/**
 * `interrupted`: xsb was quit while the task was unfinished and the user chose not to have it continued. It has
 * ended without a result; whoever dispatched it decides whether it is still needed.
 */
export type TaskStatus = "blocked" | "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export const isTerminal = (s: TaskStatus): boolean => s === "completed" || s === "failed" || s === "cancelled" || s === "interrupted";

/** Whom something is attributed to: who started a task, who stopped it, who sent a message. */
export type Principal = { kind: "user" } | { kind: "agent"; agentId: string } | { kind: "system" };

/**
 * How a task ended. `completed` / `failed`: its assignee finished it (or a job's tool answered). `cancelled`: its
 * dispatcher or the user stopped it. `cascaded`: it went with a task it was started for (`cause`). `error`: xsb could
 * not run it. `interrupted`: xsb was quit while it was unfinished, and the user chose not to have it continued.
 * `superseded`: its dispatcher gave the same agent a new task in its place (`dispatch_task` with `onBusy: "replace"`).
 */
export type EndReason = "completed" | "failed" | "cancelled" | "cascaded" | "error" | "interrupted" | "superseded";

/**
 * How a message is to reach its recipient once it is in its inbox (where it counts as delivered). `sync`: as what a
 * tool call that waits for it returns. `wake`: a turn of its own, now if the recipient is idle, after its
 * running turn if not (only the user's word goes into running work).
 * `lazy` (the default for a task's result): it waits, and comes with the recipient's next turn.
 */
export type DeliveryPref = "sync" | "wake" | "lazy";

/**
 * A capability a task gives its executor beyond reaching its own initiator, which every task gives: to dispatch
 * tasks (`dispatch`), or to message agents (`message`), to any agent or to those in `to`.
 */
export type Grant = { cap: "dispatch" | "message"; to?: string[] };

export type Task = {
  id: string;
  title: string;
  topic: string;
  instructions: string;
  /** Who started it: the user, or an agent. */
  initiator: Principal;
  /** The session of the agent that dispatched it, where its result goes. None for the user's: the user is told by its own session. */
  from?: Addr;
  to: Addr;
  /** Tasks that must be finished before this one starts. */
  after: string[];
  /**
   * The tasks this one was started for: those the session it was dispatched from had been handed and had not finished
   * then (none: the session's own work, such as what the user asked there). Set by the hub, never changed. A task that
   * is cancelled takes along what it alone was holding up (docs/TASK-GRAPH.md).
   */
  parents?: string[];
  /** Type of the asset the task has to register before it ends. */
  produces?: string;
  /** Ids of the assets the task works from. */
  inputs?: string[];
  /**
   * Set when the task is a job: not an agent's turn but one call of a tool of
   * the dispatcher's own MCP servers, run by the hub in the background.
   */
  tool?: { server: string; name: string; arguments: unknown };
  /** How its result reaches its initiator. Absent: `lazy`. */
  deliveryPref?: DeliveryPref;
  /** The initiating session's work generation; old results must not wake work the user stopped. */
  workGeneration?: number;
  status: TaskStatus;
  /** Once it has ended: why, and who ended it (for `cascaded`, who stopped the task it went with, `cause`). */
  ended?: { reason: EndReason; stopper: Principal; cause?: string };
  /**
   * It is being stopped, and ends as this says once its executor confirmed the stop (or xsb restarted). Written in
   * the transaction that decided the stop, so a crash does not lose it. `quiet`: its initiator is not told.
   */
  stopping?: { status: "cancelled" | "failed"; reason: EndReason; stopper: Principal; cause?: string; result: string; quiet?: boolean };
  /** Its remaining descendants were stopped after it ended; its recorded outcome stays intact. */
  cascadeStopped?: boolean;
  result?: string;
  /** The assets the assignee named as what the task delivered (`id@version`), when it finished it. */
  assets?: string[];
  createdAt: string;
  updatedAt: string;
};

export const Tasks = {
  capability: `${NS}/tasks`,
  list: `_${NS}/tasks/list`,
  /** `{ taskId }` -> `{ task, with: Task[] }`: the user stops a task, and what went with it. */
  cancel: `_${NS}/tasks/cancel`,
  update: `_${NS}/tasks/update`,
} as const;

/**
 * The ledger: what became of every message given to an agent's session (the user's, a peer's, xsb's), so that
 * whether its model saw it can be answered.
 *
 *   notify     _dev.xsb/messages/update { entry: LedgerEntry }   (hub -> observers)
 *
 *   inboxed               kept for the agent; comes with its next turn            (a notification that wakes nobody)
 *   queued                waits in xsb behind the running turn; the model knows nothing of it
 *   submitted             given to the session, not yet to the model               (held until the backend can take it)
 *   inserted              in the model's conversation, not yet acted upon
 *   seen                  the model went on after it
 *   inserted_unprocessed  in the conversation, but the turn was stopped before the model went on; it is seen
 *                         when the session goes on, and discarded if it never does
 *   discarded_unseen      never reached the model, and never will
 *
 * The signals are ACP v2's: "inserted" is the answer to `session/prompt` (its insertion), "discarded_unseen" the
 * -32800 of a prompt cancelled before it; "seen" is anything the backend reports after an insertion, or its idle that
 * ended the work normally.
 */
export type LedgerState = "inboxed" | "queued" | "submitted" | "inserted" | "seen" | "inserted_unprocessed" | "discarded_unseen";
export type LedgerEntry = { messageId: string; agentId: string; sessionId: string; from: Origin; taskId?: string; state: LedgerState; ts: string };
export const Ledger = {
  update: `_${NS}/messages/update`,
  /**
   * What became of messages, by id: `_dev.xsb/messages/status { messageIds }` -> `{ states: { [id]: LedgerState | "unknown" } }`.
   * "unknown": xsb never accepted it (a client may then send it again under the same id).
   */
  status: `_${NS}/messages/status`,
} as const;

/**
 * Context boundaries: where what the model of a session sees starts anew. The transcript keeps everything that was
 * said; a boundary in it says that the model does not see what comes before.
 *
 *   in the transcript, and live   session/update { sessionUpdate: "session_info_update", _meta: { "dev.xsb/boundary": Boundary } }
 *   request                       _dev.xsb/sessions/clear { sessionId } -> {}
 *                                 the user clears the context: the next turn starts a new backend session that
 *                                 is given nothing of what came before. Refused while the session works.
 *
 * A transcript is append-only: a boundary is a record added after what it closes, never a change to it. Whatever
 * decides what a model sees reads a transcript from its end and stops at the first `cleared`. The other kinds
 * mark where the backend session was replaced without the user asking for it (another backend, or one that could
 * not be restored): the model is given a handoff instead, made from what precedes them up to the last `cleared`.
 * `renewed`: the conversation grew past the project's limit, and goes on in a new backend session, handed what came
 * before.
 */
/**
 * Why what precedes a boundary is no longer what the model works from: the user cleared it; the backend changed;
 * the backend session could not be restored; it had grown too long (`renewed`); it went on after a stop; work was
 * isolated after an input it held expired (`isolated`); or the backend compacted it itself (`compacted`, no handoff:
 * the backend's own summary stands in for it).
 */
export type BoundaryKind = "cleared" | "backend_changed" | "not_restored" | "renewed" | "stopped" | "isolated" | "compacted" | "migrated";
export type Boundary = {
  kind: BoundaryKind;
  /** The backend the session continues on. */
  backend?: string;
  /** `migrated`: the title of the conversation this one continues. */
  from?: string;
  /** Whether the model was given a handoff of what precedes this boundary. */
  handoff: boolean;
};

/**
 * A turn that mail started (a task, a message, results) and that failed. Nobody waits on such a turn, so its failure
 * is recorded in the transcript and shown to whoever watches the session:
 *   session/update { sessionUpdate: "session_info_update", _meta: { "dev.xsb/turn_failed": { message, data? } } }
 * `data` is the error's, with a `reason` a client can word for its reader (errors.ts).
 */
export const TurnFailure = { key: `${NS}/turn_failed` } as const;

/**
 * Input the model never saw: the turn it was for was stopped before it got there. So that what a reader of the
 * transcript sees is what the model saw, the input is recorded, and shown, as discarded:
 *   session/update { sessionUpdate: "session_info_update", _meta: { "dev.xsb/discarded": Discarded } }
 * A message that was already shown (`user_message_chunk` with the same `messageId`) is that message, now discarded;
 * one that was not (it waited for its turn) is shown for the first time, as discarded.
 *
 * A stop discards what was not inserted yet: what the hub still held, and what the backend answered with -32800. The
 * ledger (`Ledger`) says what became of every message; this record is what a transcript shows of the user's.
 */
export const Discarded = { key: `${NS}/discarded` } as const;
/**
 * `reason`: why the model did not see it. `owed`: it failed to get there, and xsb gives it to the model in front of the
 * user's next message (`Redelivered` says when it did); a client may also offer to send it again (`OriginExt.resendOf`).
 * `content` may be empty when the message was already recorded (`Accepted`): it is that message.
 */
export type Discarded = { messageId: string; origin: OriginMeta; content: ContentBlock[]; reason?: DiscardReason; detail?: string; owed?: boolean;
  /** The user sent it again, as this message: it is no longer owed. */
  resentAs?: string };
export type DiscardReason = "stopped" | "failed" | "too_large" | "refused" | "expired" | "abandoned";

/**
 * The user's message as xsb accepted it, before it is in the model's conversation: recorded, so that a reader of the
 * transcript sees it waiting (and after a restart, still waiting) until it is inserted (`user_message_chunk`, same
 * `messageId`) or discarded (`Discarded`).
 *   session/update { sessionUpdate: "session_info_update", _meta: { "dev.xsb/accepted": Accepted } }
 */
export const Accepted = { key: `${NS}/accepted` } as const;
export type Accepted = { messageId: string; origin: OriginMeta; content: ContentBlock[] };

/**
 * Messages the model had not seen (`Discarded` with `owed`) went into its conversation along with `with`, in front of it:
 *   session/update { sessionUpdate: "session_info_update", _meta: { "dev.xsb/redelivered": Redelivered } }
 */
export const Redelivered = { key: `${NS}/redelivered` } as const;
export type Redelivered = { messageIds: string[]; with: string };

/**
 * How the model was given an input that differs from what it is (`user_message_chunk` `_meta`), for a reader to see:
 * images it was told of but cannot see, text saved to a file it was given the start of, a note of what the input addresses.
 */
export const DeliveredAs = { key: `${NS}/delivered` } as const;
export type DeliveredAs = { imagesHidden?: number; spilled?: { chars: number; file: string }[]; scope?: string };

/**
 * A question the agent asks the user with the `ask` tool, and what became of it. The tool returns at once; the user's
 * reply is their next message to the agent: answers or a skip (with `Answer` in the prompt's `_meta`), or a message of
 * their own instead. Recorded and shown in the transcript:
 *   session/update { sessionUpdate: "session_info_update", _meta: { "dev.xsb/question": Question } }
 * first with `state: "open"` and the questions, then with the id and how it closed.
 */
export const Question = { key: `${NS}/question` } as const;
export type QuestionItem = {
  question: string;
  /** single: one option; multi: any number of options; text: a free answer. */
  kind: "single" | "multi" | "text";
  options?: string[];
  /** single/multi: the user may also write an answer of their own. */
  other?: boolean;
};
export type QuestionState = "open" | "answered" | "skipped" | "superseded";
/** `reply`: the user's message that closed it (answered, skipped or superseded). */
export type Question = { id: string; state: QuestionState; questions?: QuestionItem[]; answers?: QuestionAnswer[]; reply?: string };
/** One answer per question, in order: an option or text for single and text, a list for multi. */
export type QuestionAnswer = string | string[];
/** `_meta` of the `session/prompt` that answers or skips a question. */
export const Answer = { key: `${NS}/answer` } as const;
export type Answer = { questionId: string; answers?: QuestionAnswer[]; skipped?: boolean };

/** Desktop history pages use byte cursors and image references, leaving ACP replay unchanged. */
export const History = {
  capability: `${NS}/history`,
  page: `_${NS}/history/page`,
  image: `_${NS}/history/image`,
  imageKey: `${NS}/history-image`,
} as const;
export type HistoryImage = { sessionId: string; offset: number; index: number };
export type HistoryPage = { updates: SessionUpdate[]; cursor: number | null; state: "idle" | "running"; agent: AgentInfo };

export const Boundaries = {
  key: `${NS}/boundary`,
  clear: `_${NS}/sessions/clear`,
} as const;

/**
 * Assets: the one library every agent works from (characters, styles, scripts,
 * shots, ...). An asset is a file with an id; registering the same id again
 * adds a version, and earlier versions stay.
 *
 *   advertise  capabilities._meta["dev.xsb/assets"] = { version: 1 }
 *   request    _dev.xsb/assets/list { type? } -> { assets: Asset[] }   (latest versions)
 *   notify     _dev.xsb/assets/update { asset: Asset }                 (hub -> observers, each new version)
 */
export const Assets = {
  capability: `${NS}/assets`,
  list: `_${NS}/assets/list`,
  update: `_${NS}/assets/update`,
} as const;

export type Asset = {
  /** `<type>/<name>`: what everyone refers to it by. */
  id: string;
  type: string;
  name: string;
  version: number;
  description: string;
  /** Absolute path of this version's file. Never rewritten. */
  path: string;
  /** Agent that registered it. */
  by: string;
  sessionId?: string;
  createdAt: string;
};

/**
 * Language: which language the person at a client reads.
 *
 *   declare    capabilities._meta["dev.xsb/language"] = "zh-CN"
 *
 * A client words everything it shows in that language itself, errors
 * included (errors.ts). What it declares matters for the one thing a client
 * cannot word: what the agents say and write. A project keeps one working
 * language (its config's `language`); a project that has none yet takes the
 * language of the first client that declares one. The agents are told it, and
 * the preset teams are read in it.
 */
export const LANGUAGES = ["en", "zh-CN"] as const;
export type Language = (typeof LANGUAGES)[number];

export const LanguageExt = { key: `${NS}/language` } as const;

/**
 * The supported language for what a system reports, most preferred first:
 * BCP 47 tags ("zh-Hans-CN") or POSIX locales ("zh_CN.UTF-8"). English when none is supported.
 */
export function languageOf(tags: (string | undefined)[]): Language {
  for (const tag of tags) {
    const primary = tag?.toLowerCase().split(/[-_.]/)[0];
    const found = LANGUAGES.find((language) => language.toLowerCase().split("-")[0] === primary);
    if (found) return found;
  }
  return "en";
}

/**
 * Origin: who a message in a session came from.
 *
 * A session receives input from its user, from peer agents and from the hub
 * itself. ACP has one input kind (the user message), so the source is carried
 * as `_meta["dev.xsb/origin"]` on
 *   - `session/prompt` params                (towards an agent)
 *   - `user_message_chunk` updates           (towards a client)
 * A party that ignores it sees an ordinary user message.
 *
 *   opt in     capabilities._meta["dev.xsb/origin"] = {}   (of `initialize`)
 *
 * A client that opted in is sent its own input like everyone else's, when it
 * is inserted into the conversation (a turn of its own, or into running
 * work). It tells its own by the `messageId` it chose in
 * `_meta["dev.xsb/origin"].messageId` of `session/prompt`, which is also the
 * `messageId` the prompt is answered with. A client that did not opt in is not
 * sent its own input.
 */
export const OriginExt = {
  capability: `${NS}/origin`,
  key: `${NS}/origin`,
} as const;

/** Correlation for backends that echo it on turn updates. */
export const TurnExt = { key: `${NS}/turn` } as const;

export type Origin =
  | { kind: "user" }
  | { kind: "agent"; agentId: string; sessionId: string }
  | { kind: "system" };

export type OriginMeta = Origin & {
  messageId?: string;
  /** On `session/prompt`: this sends again a message the model did not see (`Discarded`), as a message of its own. */
  resendOf?: string;
  taskId?: string;
  turnId?: string;
  /** What the message is: free text, a task, or a task's result. */
  role?: "message" | "task" | "task_result";
  /** True when it went into running work. */
  steered?: boolean;
};
