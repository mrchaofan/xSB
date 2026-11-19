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

/**
 * Agents: one ACP connection reaches many agents.
 *
 *   advertise  capabilities._meta["dev.xsb/agents"] = { version: 1 }
 *   opt in     capabilities._meta["dev.xsb/agents"] = {}   (receive `update`, see below)
 *   address    session/new   params._meta["dev.xsb/agent"] = "<agentId>"
 *              SessionInfo   _meta["dev.xsb/agent"], _meta["dev.xsb/main"]
 *   request    _dev.xsb/agents/list   {}            -> { agents: AgentInfo[] }
 *              _dev.xsb/agents/get    { id }        -> { agent: AgentInfo, instructions, systemPrompt }
 *                                                   `instructions` are the agent's own; `systemPrompt` is
 *                                                   everything a new session of it would be told
 *              _dev.xsb/agents/put    { agent, instructions? } -> { agent: AgentInfo }
 *              _dev.xsb/agents/remove { id }        -> {}
 *              _dev.xsb/agents/restart { id }       -> {}   stop its backend process, so that changed
 *                                                   instructions, tools and skills apply from the next
 *                                                   turn on; a turn that is running fails
 *   notify     _dev.xsb/agents/update  { agent: AgentInfo }   (hub -> opted-in clients)
 *              _dev.xsb/agents/removed { id }
 *              _dev.xsb/agents/asks    { agentId, question }   the agent waits for the user to decide or
 *                                                   confirm something (its tool `ask_user`); the question
 *                                                   itself is in its reply, this is for telling the user
 *
 * A client that opted in is an observer: it also receives permission requests
 * of sessions nobody is attached to, so an unattended agent is never stuck.
 */
export type AgentSpec = {
  /** Bundled avatar ID. Empty or absent inherits the role avatar, then the default. */
  avatar?: string;
  id: string;
  name: string;
  description: string;
  /** Name of a backend of the machine the hub runs on. */
  backend: string;
  /** Absolute working directory. */
  workspace: string;
  /**
   * The role this agent is an instance of: a directory `.xsb/roles/<role>/`
   * that gives it its instructions, its MCP servers and its skills.
   */
  role?: string;
  createdAt: string;
};

export type AgentState = "idle" | "running" | "requires_action";

export type AgentInfo = AgentSpec & {
  state: AgentState;
  /** The agent's conversation, once it has one: the one session the user, its peers and xsb talk to it in. */
  mainSessionId?: string;
  /** Snapshot for turn-bound operations. Recheck at execution time. */
  currentTurnId?: string;
  turnProtected?: boolean;
};

export const Agents = {
  capability: `${NS}/agents`,
  sessionKey: `${NS}/agent`,
  mainKey: `${NS}/main`,
  list: `_${NS}/agents/list`,
  get: `_${NS}/agents/get`,
  put: `_${NS}/agents/put`,
  remove: `_${NS}/agents/remove`,
  restart: `_${NS}/agents/restart`,
  update: `_${NS}/agents/update`,
  removed: `_${NS}/agents/removed`,
  asks: `_${NS}/agents/asks`,
} as const;

/**
 * Roles: what agents are instances of (see `AgentSpec.role`). A role gives its
 * agents instructions, MCP servers and skills.
 *
 *   advertise  capabilities._meta["dev.xsb/roles"] = { version: 1 }
 *   request    _dev.xsb/roles/list   {}       -> { roles: RoleDetail[] }
 *              _dev.xsb/roles/get    { name } -> { role: RoleDetail }
 *              _dev.xsb/roles/put    { role: RoleInput } -> { role: RoleDetail }
 *                                    Fields left out stay as they are. `mcpServers` and `skills`,
 *                                    when given, are the whole set: what is not in it is removed.
 *                                    A change is to the project's own role; a team's role is copied to become one.
 *              _dev.xsb/roles/remove { name } -> {}        the project's own role. Refused while an agent has
 *                                    the role, unless a team's role of that name takes its place; a role
 *                                    that is only a team's goes with the team (`teams/drop`)
 *              _dev.xsb/roles/check  { name, server? } -> { servers: McpServerCheck[] }
 *                                    start the role's MCP servers and ask each for its tools
 *   notify     _dev.xsb/roles/update  { role: RoleDetail } (hub -> observers, after `put`)
 *              _dev.xsb/roles/removed { name }
 *
 * A role is also a directory the user may edit by hand; such an edit is read
 * on its next use but announced to nobody.
 *
 * A change applies to an agent of the role from its next session binding on
 * (`agents/restart` forces one); `description`, `backend` and `workspace` are
 * only defaults for new agents.
 */
export const Roles = {
  capability: `${NS}/roles`,
  list: `_${NS}/roles/list`,
  get: `_${NS}/roles/get`,
  put: `_${NS}/roles/put`,
  remove: `_${NS}/roles/remove`,
  check: `_${NS}/roles/check`,
  update: `_${NS}/roles/update`,
  removed: `_${NS}/roles/removed`,
} as const;

/** How to start a stdio MCP server, as in `.mcp.json`. */
/**
 * How to start an MCP server, in the shape of `.mcp.json`. `about`: one sentence, from whoever provides the server,
 * on what it is and when it is the one to use; agents are told it next to the server's name (where their tools
 * come from), which is what they choose between tools of several sources by.
 */
export type McpServerSpec = { command: string; args?: string[]; env?: Record<string, string>; about?: string };

/**
 * `description`, `produces` and `inputs` are what the skill's SKILL.md declares
 * in its front matter. A skill that produces an asset type is given with every
 * task that has to produce that type, and `inputs` are the types it is made
 * from; any skill can be loaded by the model.
 */
export type SkillInfo = { name: string; description: string; produces?: string; inputs: string[] };

export type RoleDetail = {
  /** Bundled avatar ID, or "role" for the role's own picture (`avatarFile`); empty or absent uses the default. */
  avatar?: string;
  /** With `avatar` "role": the absolute path of the role's own picture, a PNG in its directory. */
  avatarFile?: string;
  name: string;
  /**
   * Set when a team the project uses has a role of this name: which team, and
   * whether the project has its own role in its place (`roles/remove` then
   * brings the team's back). `teamTitle` and `title` are what the team and the role are called.
   */
  preset?: { team: string; teamTitle: string; own: boolean; title: string };
  description?: string;
  backend?: string;
  grants?: Grant["cap"][];
  instructions: string;
  mcpServers: Record<string, McpServerSpec>;
  /** `dir`: where the skill's files are, on the hub's machine. */
  skills: (SkillInfo & { content: string; dir: string })[];
  /** Ids of the agents that are instances of the role. */
  agents: string[];
};

export type RoleInput = {
  /** Bundled avatar ID; empty or absent uses the default. */
  avatar?: string;
  name: string;
  description?: string;
  backend?: string;
  /** Team policy: what the role's agents may do in every task, beyond reaching its initiator. */
  grants?: Grant["cap"][];
  instructions?: string;
  mcpServers?: Record<string, McpServerSpec>;
  skills?: { name: string; content: string }[];
};

export type McpServerCheck = { server: string; tools?: { name: string; description?: string }[]; error?: string };

/**
 * Teams: the sets of roles xsb ships, and which of them the project uses.
 * Using a team copies nothing: its roles are among the project's from then on
 * (`RoleDetail.preset`), from a frozen project copy of the template.
 *
 *   advertise  capabilities._meta["dev.xsb/teams"] = { version: 2 }
 *   request    _dev.xsb/teams/list {}     -> { teams: TeamInfo[] }
 *              _dev.xsb/teams/use  { id } -> {}    copy on first use; later use preserves the copy
 *              _dev.xsb/teams/drop { id } -> {}    refused while an agent has a role only that team gives
 *              _dev.xsb/teams/derive { id, base } -> { team: TeamInfo }
 *                                  start a team of the user's (~/.xsb/presets) that extends `base`
 *              _dev.xsb/teams/sync-preview { id } -> TeamSyncPlan
 *              _dev.xsb/teams/sync { id, revision, confirm: true } -> TeamSyncPlan
 *                                  replace the project copy and matching custom overrides; changes are lost
 *   The list says, besides the teams, what is wrong among the preset directories that belongs to no team
 *   (`problems`). Teams come from xsb (`builtin`) and from the user's ~/.xsb/presets (`user`), organised alike.
 *
 * The project language selects the initial copy and explicit updates. Team and role folder names identify the
 * origin, with builtin/user source roots distinguishing otherwise equal paths; no extra template id is used.
 *
 * Observers hear of the roles that came, changed or went as `roles/update` and `roles/removed`.
 */
export const Teams = {
  capability: `${NS}/teams`,
  list: `_${NS}/teams/list`,
  use: `_${NS}/teams/use`,
  drop: `_${NS}/teams/drop`,
  derive: `_${NS}/teams/derive`,
  syncPreview: `_${NS}/teams/sync-preview`,
  sync: `_${NS}/teams/sync`,
} as const;

/** Something wrong with a preset team or one of its files (`error`: left out; `warning`: used all the same). */
export type PresetProblem = { team?: string; path: string; code: string; detail: string; severity: "error" | "warning" };

export type TeamSyncPlan = {
  id: string;
  roles: string[];
  /** Project overrides removed for matching role codes. */
  overwritten: string[];
  removed: string[];
  /** Binds confirmation to the previewed source and project files. */
  revision: string;
};

export type TeamInfo = {
  id: string;
  snapshot?: boolean;
  sourceDir?: string;
  syncAvailable?: boolean;
  /** Shipped with xsb, or the user's own (~/.xsb/presets). */
  source: "builtin" | "user";
  /** The team it builds on. */
  extends?: string;
  /** Where it is, in the language read. */
  dir: string;
  /** The language its words are in: the project's, unless the team has none in it. */
  language: Language;
  /** What is wrong with it, as far as can be checked without running it. */
  problems: PresetProblem[];
  /** The programs its roles' MCP servers start. */
  programs: string[];
  title: string;
  description: string;
  /** What its asset types are called: type -> name, in the project's language. */
  assets: Record<string, string>;
  /** The project uses it. */
  used: boolean;
  /**
   * Its roles in order: the project copy when used, otherwise the source template. `name` is what an agent of the role would be called;
   * `requires` are the programs of the machine the role works with, each with how to get it.
   */
  roles: { name: string; role: Omit<RoleDetail, "agents" | "preset">; requires: { command: string; install: string }[] }[];
};

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
export const Ledger = { update: `_${NS}/messages/update` } as const;

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
export type BoundaryKind = "cleared" | "backend_changed" | "not_restored" | "renewed" | "stopped";
export type Boundary = {
  kind: BoundaryKind;
  /** The backend the session continues on. */
  backend?: string;
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
export type Discarded = { messageId: string; origin: OriginMeta; content: ContentBlock[] };

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
  taskId?: string;
  turnId?: string;
  /** What the message is: free text, a task, or a task's result. */
  role?: "message" | "task" | "task_result";
  /** True when it went into running work. */
  steered?: boolean;
};
