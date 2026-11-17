/**
 * Every ACP extension the system uses, in one place.
 *
 * Rule: one feature, one extension, the same on every ACP edge. The hub is an
 * ACP agent towards the outside (editor, CLI) and an ACP client towards each
 * backend; both edges import these definitions, so an extension cannot mean
 * two things. Where the ecosystem already has an extension for the feature it
 * is adopted as is instead of minted again (steering).
 *
 * Wire conventions follow ACP extensibility: custom methods start with `_`,
 * custom data lives under `_meta`, support is advertised in `_meta` during
 * `initialize`, an unknown request answers -32601 and an unknown notification
 * is ignored.
 */

/** Namespace of the extensions this project defines itself. */
export const NS = "dev.xsb";

/**
 * Steering: put a message into the turn that is running ("interject").
 *
 * Adopted from the existing ACP steering wire protocol (served by
 * claude-agent-acp), not invented here.
 *
 *   request   _session/steering { sessionId, prompt: ContentBlock[],
 *                                 _meta?: { steering?: { idleBehavior?: "promptRequired" } } }
 *   response  { outcome: "injected" }          the running turn received it
 *             { outcome: "startedNewTurn" }    session was idle, a detached turn started
 *             { outcome: "promptRequired", reason: "noRunningTurn" }
 *                                              idle and the caller opted to send the prompt itself
 *   advertise InitializeResponse._meta.steering.supported = true
 *
 * The steered message's output arrives through `session/update` of the running
 * turn; the turn's `session/prompt` settles once the steered work is done.
 *
 * The hub adds one thing for a message that is waiting for its turn: steered
 * under the `messageId` it was prompted with (`_meta["dev.xsb/origin"]`), it is
 * that message, sent now. It leaves the queue, and the `session/prompt` that
 * queued it answers `{ stopReason: "cancelled" }`.
 */
export const Steering = {
  method: "_session/steering",
  metaKey: "steering",
} as const;

export type SteeringOutcome =
  | { outcome: "injected" }
  | { outcome: "startedNewTurn" }
  | { outcome: "promptRequired"; reason: "noRunningTurn" };

/**
 * Agents: one ACP connection reaches many agents.
 *
 *   advertise  agentCapabilities._meta["dev.xsb/agents"] = { version: 1 }
 *   opt in     clientCapabilities._meta["dev.xsb/agents"] = {}   (receive `update`, see below)
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
  /** The session the agent receives its peers' messages in, once it has one. */
  mainSessionId?: string;
  /** The sessions the agent works on its peers' tasks in, one per topic (the latest of a topic last). */
  workSessions?: { sessionId: string; topic: string; retired: boolean }[];
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
 *   advertise  agentCapabilities._meta["dev.xsb/roles"] = { version: 1 }
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

/** Where a new agent of a role works: in the project directory, with the others who do, or in a directory of its own. */
export type Workplace = "project" | "own";

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
  workspace?: Workplace;
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
  workspace?: Workplace;
  instructions?: string;
  mcpServers?: Record<string, McpServerSpec>;
  skills?: { name: string; content: string }[];
};

export type McpServerCheck = { server: string; tools?: { name: string; description?: string }[]; error?: string };

/**
 * Teams: the sets of roles xsb ships, and which of them the project uses.
 * Using a team copies nothing: its roles are among the project's from then on
 * (`RoleDetail.preset`), as they ship with the hub that runs.
 *
 *   advertise  agentCapabilities._meta["dev.xsb/teams"] = { version: 1 }
 *   request    _dev.xsb/teams/list {}     -> { teams: TeamInfo[] }
 *              _dev.xsb/teams/use  { id } -> {}
 *              _dev.xsb/teams/drop { id } -> {}    refused while an agent has a role only that team gives
 *              _dev.xsb/teams/derive { id, base } -> { team: TeamInfo }
 *                                  start a team of the user's (~/.xsb/presets) that extends `base`
 *   The list says, besides the teams, what is wrong among the preset directories that belongs to no team
 *   (`problems`). Teams come from xsb (`builtin`) and from the user's ~/.xsb/presets (`user`), organised alike.
 *
 * A team ships once per language (`Language`); the project's language decides which is read.
 *
 * Observers hear of the roles that came, changed or went as `roles/update` and `roles/removed`.
 */
export const Teams = {
  capability: `${NS}/teams`,
  list: `_${NS}/teams/list`,
  use: `_${NS}/teams/use`,
  drop: `_${NS}/teams/drop`,
  derive: `_${NS}/teams/derive`,
} as const;

/** Something wrong with a preset team or one of its files (`error`: left out; `warning`: used all the same). */
export type PresetProblem = { team?: string; path: string; code: string; detail: string; severity: "error" | "warning" };

export type TeamInfo = {
  id: string;
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
   * Its roles as they ship, in order. `name` is what an agent of the role would be called;
   * `requires` are the programs of the machine the role works with, each with how to get it.
   */
  roles: { name: string; role: Omit<RoleDetail, "agents" | "preset">; requires: { command: string; install: string }[] }[];
};

/**
 * Backends: what an agent can run on, on the machine the hub runs on.
 *
 *   advertise  agentCapabilities._meta["dev.xsb/backends"] = { version: 1 }
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
 *   advertise  agentCapabilities._meta["dev.xsb/tasks"] = { version: 1 }
 *   request    _dev.xsb/tasks/list { agentId?, status? } -> { tasks: Task[] }
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

export type Task = {
  id: string;
  title: string;
  topic: string;
  instructions: string;
  from: Addr;
  to: Addr;
  /** Tasks that must be finished before this one starts. */
  after: string[];
  /** Type of the asset the task has to register before it ends. */
  produces?: string;
  /** Ids of the assets the task works from. */
  inputs?: string[];
  /**
   * Set when the task is a job: not an agent's turn but one call of a tool of
   * the dispatcher's own MCP servers, run by the hub in the background.
   */
  tool?: { server: string; name: string; arguments: unknown };
  /** Of a job: the task its dispatcher was working on when it started it. That task does not end before the job. */
  partOf?: string;
  /**
   * The dispatcher said the task depends on no other work of the assignee's, so the assignee may work on it alongside
   * that, in a session of its own, up to the project's `limits.sessionsAtOnce`. Without it, the assignee's peer work
   * runs one turn at a time.
   */
  parallel?: boolean;
  status: TaskStatus;
  result?: string;
  createdAt: string;
  updatedAt: string;
};

export const Tasks = {
  capability: `${NS}/tasks`,
  list: `_${NS}/tasks/list`,
  update: `_${NS}/tasks/update`,
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
 * `renewed` starts a work session that takes over from one that grew too long; its handoff is made from that one.
 */
export type BoundaryKind = "cleared" | "backend_changed" | "not_restored" | "renewed";
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

export const Boundaries = {
  key: `${NS}/boundary`,
  clear: `_${NS}/sessions/clear`,
} as const;

/**
 * Assets: the one library every agent works from (characters, styles, scripts,
 * shots, ...). An asset is a file with an id; registering the same id again
 * adds a version, and earlier versions stay.
 *
 *   advertise  agentCapabilities._meta["dev.xsb/assets"] = { version: 1 }
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
  /** Agent that registered it, and the task it did so for. */
  by: string;
  taskId?: string;
  createdAt: string;
};

/**
 * Language: which language the person at a client reads.
 *
 *   declare    clientCapabilities._meta["dev.xsb/language"] = "zh-CN"
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
 * itself. ACP v1 has one input kind (`user_message_chunk`), so the source is
 * carried as `_meta["dev.xsb/origin"]` on
 *   - `session/prompt` and `_session/steering` params   (towards an agent)
 *   - `user_message_chunk` updates                      (towards a client)
 * A party that ignores it sees an ordinary user message.
 *
 *   opt in     clientCapabilities._meta["dev.xsb/origin"] = {}
 *
 * A client that shows a transcript needs to know when its own message became
 * a turn, not only that it was accepted: a prompt to a busy session waits. A
 * client that opted in is sent its own input like everyone else's, when the
 * turn it starts begins (or, steered, when it reached the running turn). It
 * tells its own from others' by the `messageId` it chose: given in
 * `_meta["dev.xsb/origin"].messageId` of `session/prompt` or
 * `_session/steering`, it is the `messageId` of the `user_message_chunk`.
 * A client that did not opt in is not sent its own input, as in plain ACP.
 */
export const OriginExt = {
  capability: `${NS}/origin`,
  key: `${NS}/origin`,
} as const;

export type Origin =
  | { kind: "user" }
  | { kind: "agent"; agentId: string; sessionId: string }
  | { kind: "system" };

export type OriginMeta = Origin & {
  messageId?: string;
  taskId?: string;
  /** What the message is: free text, a task, or a task's result. */
  role?: "message" | "task" | "task_result";
  /** True when it was steered into a running turn. */
  steered?: boolean;
};
