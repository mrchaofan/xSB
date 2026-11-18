/**
 * Everything the hub says to a model, in one file: the standing instructions an
 * agent gets, and how mail from peers is framed inside a prompt.
 */
import { isTerminal } from "@xsb/protocol";
import type { AgentSpec, Asset, Language, OriginMeta, Task } from "@xsb/protocol";
import type { Contract, Skill } from "./roles.ts";
import type { MailItem, Note, Results, State } from "./state.ts";
import type { PastTurn } from "./transcript.ts";
import { topicKey } from "./state.ts";
import { lineDiff } from "./util.ts";

/** Who started a task, as a model is told: an agent's id, or the user. */
export const initiatorName = (t: Task): string => (t.initiator.kind === "agent" ? t.initiator.agentId : "the user");

const attr = (value: string): string => value.replace(/"/g, "'").replace(/\s+/g, " ");

export function memoryDigest(state: State, agentId: string, limit = 30): string {
  const notes = [...(state.notes.get(agentId)?.values() ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const ledger = state.topics.get(agentId);
  const lines: string[] = [];
  for (const note of notes.slice(0, limit)) {
    lines.push(`- ${note.topic}${note.peers.length ? ` (with ${note.peers.join(", ")})` : ""}: ${note.content}`);
  }
  const noted = new Set(notes.map((n) => topicKey(n.topic)));
  for (const [key, entry] of ledger ?? []) {
    if (noted.has(key) || lines.length >= limit) continue;
    lines.push(`- ${entry.topic} (with ${[...entry.peers.keys()].join(", ")}): no note yet`);
  }
  return lines.length ? lines.join("\n") : "(empty)";
}

/** Where an MCP server of a session comes from, besides the hub's own (Hub.toolServers). */
export type ToolOrigin = "app" | "role" | "client";

const ORIGIN: Record<ToolOrigin, string> = {
  app: "given to every agent by the app the user runs xsb in",
  role: "your role's",
  client: "added by the client that opened this session",
};

/**
 * Where each tool comes from. Which tool to pick for a request is decided by the tools' own descriptions, which say
 * what each is; this only tells the servers apart from one another and from the agent program's own tools.
 */
function toolSources(tools: { name: string; from: ToolOrigin; about?: string }[]): string {
  const lines = [`- team: the hub of this team (collaboration, tasks, assets, memory).`, ...tools.map((t) => `- ${t.name}: ${ORIGIN[t.from]}.${t.about ? ` ${t.about.trim()}` : ""}`)];
  return `

# Where your tools come from
Besides the tools of the agent program you run in, you have the tools of these MCP servers:
${lines.join("\n")}
What each tool is for, and when to use it, is in its own description; when a request could be served by tools of different sources, take the one whose description names what is asked. Every other tool you have comes with the agent program itself (its own file, shell, browser or computer-use tools, for example) and acts on the user's machine, not on anything of xsb's. When asked where a tool comes from, answer from this list and the tool's description; there is nothing else to look up.`;
}

/**
 * Rules for every agent of every team. Each says why: a model that knows the reason applies a rule to cases it
 * does not name.
 */
const WORKING_RULES = `

# How you work
- Say how you checked. In a result, write what you checked and by what means ("ffprobe shows an audio track in every clip", "6 frames sampled per shot"), not that you "watched" or "listened to" something. What needs a person's eyes or ears, list for the user to check. The reason: whoever gets your result builds on it as fact.
- When a program you need is missing, or something needs an account, a password or a payment, stop and say what is missing to the user or to whoever gave you the work, and let them decide. What is installed on this machine and how its accounts are used is the user's; credential files are not yours to read, and programs from unverified sources are not yours to fetch or run.
- When you need a peer to deliver something, dispatch a task; a message is for telling or adding to what someone knows. The reason: only a task brings its result back to you.
- Keep a note (remember) to decisions: what was decided, who owns it, what is open. Rewrite it when something is decided, not to log progress: a note comes with every later message on its topic, and progress is in the tasks and assets already.
- Look at images small first: a copy at most 1024 pixels on its long side, or a contact sheet of frames (make one with sips or ffmpeg); open the original only for a detail, cropped. The reason: an image stays in your context for the rest of the session, and a full-size one is several thousand tokens.
- When you write to the user, call assets by their names and leave out task ids, version shorthands and other internal labels: the user reads them as noise.`;

/** What a model is to call each language. */
const LANGUAGE_NAME: Record<Language, string> = { en: "English", "zh-CN": "Simplified Chinese (简体中文)" };

export function systemPrompt(
  agent: AgentSpec,
  instructions: string,
  skills: Skill[],
  team: Contract[],
  dirs: { shared: string; assets: string; scratch(id: string): string },
  state: State,
  language: Language,
  tools: { name: string; from: ToolOrigin; about?: string }[] = [],
): string {
  const from = (inputs: string[]): string => (inputs.length ? `, from ${inputs.join(", ")}` : "");
  const teamIndex = team.length
    ? `

# The team
What the team makes, and who makes it. Each line is an asset type, the agents that have a procedure for producing it, and the asset types it is made from. Work flows along these lines: dispatch the making of a type to an agent listed for it, with that type as \`produces\` and the assets it is made from as \`inputs\`.
${team.map((c) => `- ${c.produces}: ${c.agents.map((id) => (id === agent.id ? "you" : id)).join(", ")}${from(c.inputs)}`).join("\n")}`
    : "";
  const sharing = [...state.agents.values()].filter((a) => a.id !== agent.id && a.workspace === agent.workspace).map((a) => a.id);
  const skillIndex = skills.length
    ? `

# Skills
Your role has these skills: written procedures for kinds of work you do. A skill marked with an asset type arrives with every task that has to produce that type; when you make that type without such a task, load the skill yourself first. For any other skill: before doing work it covers, call load_skill and follow it.
${skills.map((s) => `- ${s.name}: ${s.description}${s.produces ? ` (arrives with tasks that produce "${s.produces}")` : ""}`).join("\n")}`
    : "";
  return `# Who you are
You are "${agent.name}" (agent id: ${agent.id}). ${agent.description}

${instructions.trim()}

# Language
The user reads ${LANGUAGE_NAME[language]}. Write everything a person will read in it: what you say to the user, the messages and tasks you send to peers, and the content of what you make (documents, descriptions of assets, notes). Names that tools and files go by stay as they are: asset ids and types, tool and parameter names, paths, code.

# Working with the team
You are one of several peer agents coordinated by xsb. A human user can talk to each agent directly, and agents work together through the tools of the "team" MCP server. Which of them you have depends on the work you are doing: every task lets you reach whoever gave it to you; dispatching tasks and messaging others you can do when the work grants it (your role, the user asking for it, or whoever gave you the task). A tool you do not see is one this work does not give you.

- dispatch_task: hand a peer a piece of work. The peer's answer is the last thing it says when it is done (or what it reports with report_result). Say with \`deliveryPref\` how you want it: "sync" waits for it inside the call, up to a minute, for a short task you need the answer of to go on; "wake" delivers it as soon as it is there, waking you; "lazy" (the default) keeps it for your next turn, waking nobody. The peer sees nothing of your conversation, so the task has to carry everything it needs. Give \`after\` when the task must not start before other tasks have finished; the peer then receives their results too.
- subscribe: when you need the results of several tasks or jobs before you can go on, call this once with their ids and end your turn: they come together in one message, waking you, when all (or any) have finished. For one task, it makes a lazy result wake you.
- ask: ask whoever gave you your task (or, if your work allows it, another agent) a question, and wait in the call for the answer.
- report_result: report a task you were given before your turn ends, or with a result other than your last words (a structured one, or that it failed). Usually not needed: ending your turn ends your task, and what you said last is its result.
- task_status, cancel_task: look at tasks, or stop tasks and jobs you started. A task you cancel ends at once; no result comes back for it.
- send_message, broadcast, message_status: tell one or several peers something; see whether a peer's model has seen a message of yours. A message about work you gave the peer reaches it in its running turn; anything else waits until its turn ends.
- inbox: what is waiting for your next turn (lazy results and notices), if you need it now.
- list_agents: who is on the team, what each of them can produce, and which topics you already handled with each.
- start_job: run one slow tool call (rendering, generation, anything that takes minutes) in the background. Like a task it returns immediately; its result comes back as an <xsb-task-result>, waking you, and it can be subscribed to and cancelled. Sitting in a slow call keeps you from everyone who needs you meanwhile, so make it a job.
- put_asset, find_assets, get_asset: the shared asset library (see Assets).
- remember, recall: your long-term memory, kept per topic.
- escalate_to_user: when the work cannot go on until the user decides or confirms something, ask in your reply as usual and call this so the user is told you are waiting for them; then end your turn. Not for questions you can settle yourself or with a peer.

Messages wrapped in <xsb-message>, <xsb-task>, <xsb-task-result> or <xsb-task-results> come from peers or from xsb, not from the user. An <xsb-memory> block after one is your own note on its topic.

# Tasks you are given
An <xsb-task> ends when your turn ends: what you said last is its result, and it goes to whoever gave it to you as it is. So end your turn with the result, complete and self-contained, and say in it plainly what you could not do, did not finish or did not verify: the sender builds on what you report. When you cannot do the task, say so and why.
- Your turn's end does not end a task while something you started for it is to come back to you (a job, a task whose result wakes you, a subscription): then you finish it in the turn that brings that back.
- A task that has to produce an asset type has to have one registered with put_asset before your turn ends; if not, xsb asks you for it.
- You may have several tasks at a time. One that arrives while you work waits until your turn ends; its dispatcher may also stop what you are doing and give you a new task in its place. A later task that corrects or extends an earlier one changes what you are doing.
- If a task is stopped (by its sender, the user, or with work it was for), the work you are doing for it is stopped too, and so is what you started only for it.

While tasks you dispatched are still running, the user may talk to you. Answer them normally; pending results will still arrive. If a set of results comes with conditions you set yourself, check them by reasoning over what you received, and dispatch follow-up work if they are not met.

# Topics and continuity
Give every message and task a short, stable \`topic\` and reuse the exact same topic for everything that belongs to the same matter. A topic stays with the peer who already handled it: when two peers could do a job, continue with the one who has the history, not the other. Before contacting a peer about something that may have history, call recall. After a decision, an agreement or a handoff, call remember to rewrite the note for that topic so it stays current: what was decided, who owns it, what is open.

# Assets
Everything the team has to agree on (a requirement, a design, a character, a script, a finished piece of work) lives in the asset library, once, under an id like \`character/lin\`. It is the single source of truth:
- Before you describe or create something that may already be defined, call find_assets. If it exists, use it as it is.
- Refer to assets by id. When you dispatch work that depends on assets, list them in \`inputs\`; the peer receives them with the task. When the work has to result in an asset, say which type in \`produces\`.
- When you made something others will build on, register it with put_asset. Changing a definition means registering a new version of the same id, not a new id.
- A task that comes with a type to produce is not finished until you registered an asset of that type.
- The assets a task comes with are its facts. When one is wrong or not enough, say so in your result; do not quietly redefine it.${teamIndex}

# Files
Your working directory is ${agent.workspace}.${sharing.length ? ` Also working in this directory: ${sharing.join(", ")}. They see what you change in it.` : ""} Keep your drafts and intermediate files (generated images and videos included) in your own folder ${dirs.scratch(agent.id)}, not loose in the working directory; where a skill names a relative path for such a file (like \`tmp/…\` or \`shots/…\`), put it under that folder. What others need goes into the asset library (${dirs.assets}); loose files that are no asset go in ${dirs.shared}. Refer to files by absolute path.${skillIndex}${toolSources(tools)}${WORKING_RULES}

# Your memory at the start of this session
${memoryDigest(state, agent.id)}`;
}

/** The agent's note on a topic, unless the session was given that very version of it already. */
function memoryHint(state: State, agentId: string, topic: string | undefined, given: Given | undefined, gives: Gives): string {
  const note: Note | undefined = topic ? state.notes.get(agentId)?.get(topicKey(topic)) : undefined;
  if (!note) return "";
  const key = topicKey(note.topic);
  if (given?.notes.get(key) === note.updatedAt) return "";
  gives.notes.push({ key, updatedAt: note.updatedAt });
  return `\nYour own note on this topic:\n<xsb-memory topic="${attr(note.topic)}">\n${note.content}\n</xsb-memory>`;
}

/** What a session's model was given in full so far (LiveSession.given). */
type Given = { assets: Map<string, { version: number; taskId?: string }>; notes: Map<string, string> };

/** What one prompt gives in full: the session takes note of it once the turn begins (LiveSession.take). */
export type Gives = { assets: { id: string; version: number; taskId?: string }[]; notes: { key: string; updatedAt: string }[] };

/** How much of a result that was a task's input is told with the task that builds on it; the rest is a task_status away. */
const PREREQUISITE_CHARS = 1500;

/** An asset as a model sees it. `text` is its content, when it is small enough to show. */
export function renderAsset(asset: Asset, text?: string): string {
  const head = `<xsb-asset id="${attr(asset.id)}" version="${asset.version}" by="${asset.by}" path="${attr(asset.path)}">`;
  return `${head}\n${asset.description}${text === undefined ? "" : `\n---\n${text}`}\n</xsb-asset>`;
}

function resultBlock(state: State, task: Task, short = false): string {
  const by = task.tool ? `${task.tool.server}/${task.tool.name}` : task.to.agentId;
  const head = `task-id="${task.id}" by="${attr(by)}" topic="${attr(task.topic)}" title="${attr(task.title)}" status="${task.status}"`;
  if (!isTerminal(task.status)) return `<xsb-task-result ${head} />`;
  // What the task delivered is the library's record of the assets its assignee named, not the wording of its result.
  const assets = (task.assets ?? []).map((ref) => {
    const [id, version] = ref.split("@");
    return state.assets.get(id)?.find((a) => a.version === Number(version));
  }).filter((a): a is Asset => !!a);
  const delivered = assets.length ? `\nAssets it delivered:\n${assets.map((a) => renderAsset(a)).join("\n")}` : "";
  const result = task.result ?? "";
  const told = short && result.length > PREREQUISITE_CHARS ? `${result.slice(0, PREREQUISITE_CHARS)}…\n(The result goes on; task_status ${task.id} has all of it.)` : result;
  return `<xsb-task-result ${head}>\n${told}${delivered}\n</xsb-task-result>`;
}

/** What the hub adds to a task beyond the dispatcher's words. */
export type TaskContext = {
  /**
   * The assets the task works from, with the text of those small enough to show; and of a text, the one of the
   * version the session was given before, when that was another (`before`).
   */
  inputs: { asset: Asset; text?: string; before?: { version: number; text?: string } }[];
  /** The assignee's own procedure for the asset type the task has to produce. */
  skill?: Skill & { body: string };
};

/**
 * An input of a task as the session is to be given it: in full the first time; by reference when the session was
 * given this very version before; with what changed when it was given another version.
 */
function renderInput(input: TaskContext["inputs"][number], given: Given | undefined, gives: Gives["assets"], taskId: string): string {
  const { asset, text, before } = input;
  const had = given?.assets.get(asset.id);
  if (text !== undefined && had?.version === asset.version) {
    return `${renderAsset(asset)}\n(Its text is the version you were given${had.taskId ? ` with task ${had.taskId}` : ""} earlier in this conversation, unchanged: it is not repeated here.)`;
  }
  if (text !== undefined) gives.push({ id: asset.id, version: asset.version, taskId });
  const diff = text !== undefined && before?.text !== undefined ? lineDiff(before.text, text) : undefined;
  const changes = diff ? `\nWhat changed since version ${before!.version}, which you were given before:\n<xsb-changes asset="${attr(asset.id)}">\n${diff}\n</xsb-changes>` : "";
  return `${changes}${changes ? "\n" : ""}${renderAsset(asset, text)}`;
}

/**
 * The prompt text a mail item becomes for its recipient, and what it gives in full (assets, notes): the session
 * notes those once the turn begins, and is not given them again (`given`). `context` is given for a task.
 */
export function renderMail(state: State, item: MailItem, context?: TaskContext, given?: Given): { text: string; gives: Gives } {
  const gives: Gives = { assets: [], notes: [] };
  const hint = (topic: string | undefined): string => memoryHint(state, item.to.agentId, topic, given, gives);
  return { text: mailText(state, item, context, given, gives, hint), gives };
}

function mailText(state: State, item: MailItem, context: TaskContext | undefined, given: Given | undefined, gives: Gives, hint: (topic: string | undefined) => string): string {
  const from = item.from.kind === "agent" ? item.from.agentId : item.from.kind === "system" ? "xsb" : "user";
  switch (item.kind) {
    case "message": {
      const topic = item.topic ? ` topic="${attr(item.topic)}"` : "";
      return `<xsb-message from="${from}"${topic} id="${item.id}">\n${item.content ?? ""}\n</xsb-message>${hint(item.topic)}`;
    }
    case "task": {
      const task = state.tasks.get(item.taskId!)!;
      const deps = task.after
        .map((id) => state.tasks.get(id))
        .filter((t): t is Task => !!t)
        .map((t) => resultBlock(state, t, true));
      const prerequisites = deps.length
        ? `\nThis task was held until the following tasks finished. Their results are your input; if one of them failed or is not sufficient, say so in your result instead of guessing.\n${deps.join("\n")}`
        : "";
      const inputs = context?.inputs.length
        ? `\nThis task works from the following assets. They are the reference: keep to them, and do not redefine what they define.\n${context.inputs.map((i) => renderInput(i, given, gives.assets, task.id)).join("\n")}`
        : "";
      const produces = task.produces
        ? `\nThis task has to produce a "${attr(task.produces)}" asset. Register it with put_asset before you end your turn.`
        : "";
      const others = [...state.tasks.values()].filter((t) => !t.tool && t.id !== task.id && t.to.sessionId === item.to.sessionId && t.status === "running");
      const open = others.length
        ? `\nYou still have these tasks open here; see whether this one changes any of them:\n${others.map(taskLine).join("\n")}`
        : "";
      const skill = context?.skill
        ? `\nYour skill for this (files it refers to are in ${context.skill.dir}):\n<xsb-skill name="${attr(context.skill.name)}">\n${context.skill.body.trim()}\n</xsb-skill>`
        : "";
      return `<xsb-task from="${from}" task-id="${task.id}" topic="${attr(task.topic)}" title="${attr(task.title)}">\n${task.instructions}\n</xsb-task>${prerequisites}${inputs}${produces}${skill}${open}${hint(task.topic)}`;
    }
    case "results":
      return renderResults(state, item.results!) + hint(item.topic);
  }
}

/** One task's result as it is, or the results of a join together with what the owner noted for them. */
export function renderResults(state: State, results: Results): string {
  const tasks = results.taskIds.map((id) => state.tasks.get(id)).filter((t): t is Task => !!t);
  const blocks = tasks.map((t) => resultBlock(state, t)).join("\n");
  if (!results.mode) return blocks;
  const note = results.note ? `\nYour own note for this moment: ${results.note}` : "";
  const open = tasks.filter((t) => !isTerminal(t.status));
  const pending = open.length
    ? `\nStill running, their results will arrive separately: ${open.map((t) => t.id).join(", ")}`
    : "";
  return `<xsb-task-results waited-for="${results.mode}">\n${blocks}\n</xsb-task-results>${note}${pending}`;
}

/** A task given to the model, as one line of a list. */
const taskLine = (t: Task): string =>
  `- ${t.id} "${t.title}" from ${initiatorName(t)}, topic "${t.topic}"${t.produces ? `, has to produce "${t.produces}"` : ""}`;

/** What a session is told when its turn ended without what its task has to deliver (kernel.ts, QualityGateHook). */
export const contractReminder = (task: Task, why: string): string =>
  `Your turn ended, but your task "${task.title}" (${task.id}) is not done: ${why} Register it with put_asset now, then end your turn with the result. If it cannot be done, call report_result with failed and say why.`;

export const STEER_CONTINUATION =
  "[xsb] A new message arrived while you were working and your turn was paused for it. Take it into account, then carry on with whatever you had not finished.";

/** The standing instructions, for a backend that takes no system prompt: they ride in front of the session's first prompt. */
export const asPreface = (instructions: string): string =>
  `[xsb] Your standing instructions for this session follow, between the <xsb-instructions> tags. They are from xsb, not from the user, and hold for the whole session. The conversation starts after them.\n<xsb-instructions>\n${instructions}\n</xsb-instructions>`;

/** How much of the past a handoff may tell, in characters: enough for the thread, not so much that it fills the new context. */
const HANDOFF_CHARS = 40_000;
/** The latest turns are told as they were; earlier ones by their first line. */
const HANDOFF_VERBATIM = 6;

const whoSaid = (origin: OriginMeta): string =>
  origin.kind === "user" ? "the user" : origin.kind === "system" ? "xsb" : origin.role === "task" ? `a task from ${origin.agentId}` : origin.role === "task_result" ? "task results" : origin.agentId;
const firstLine = (text: string): string => {
  const line = text.trim().split("\n").find((l) => l.trim()) ?? "";
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
};

/** Why a session goes on in a backend session that has none of its conversation. */
export type Renewal = "backend_changed" | "not_restored" | "renewed";

/**
 * The first thing a backend session is told when it takes over a conversation it has none of: the earlier turns
 * since the user last cleared the context (transcript.ts), and what is open now as the hub knows it. The hub's state
 * is the word on what is done; the turns are history, and the model is told not to act on them again.
 */
export function handoff(why: Renewal, turns: PastTurn[], open: { tasks: Task[]; waiting: Results[]; assets: Asset[] }): string {
  const reason =
    why === "backend_changed"
      ? "This session now runs on another agent program, which has none of the earlier conversation."
      : why === "renewed"
        ? "This session takes over the work of this topic from an earlier session of yours, which had grown long. You have none of that conversation but this handoff."
        : "The earlier conversation of this session could not be restored in the agent program.";
  const told: string[] = [];
  let left = HANDOFF_CHARS;
  let omitted = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    const verbatim = turns.length - i <= HANDOFF_VERBATIM;
    // What was said is set off by an indent, so that it reads as quoted history, not as the handoff's own words.
    const quote = (text: string): string => (verbatim ? text.trim() : firstLine(text)).split("\n").map((line) => `  ${line}`).join("\n");
    const inputs = turn.inputs.map((input) => `${whoSaid(input.origin)}:\n${quote(input.text)}`).join("\n");
    const tools = turn.tools.length ? `\ntools used: ${[...new Set(turn.tools)].join(", ")}` : "";
    const reply = turn.reply.trim() ? `\nyou answered:\n${quote(turn.reply)}` : "";
    const text = `<xsb-past-turn at="${turn.at}">\n${inputs}${tools}${reply}\n</xsb-past-turn>`;
    if (text.length > left) {
      omitted = i + 1;
      break;
    }
    told.unshift(text);
    left -= text.length;
  }
  const tasks = open.tasks.map((t) => `- ${t.id} "${t.title}" (${t.tool ? "job" : `${initiatorName(t)} -> ${t.to.agentId}`}): ${t.status}`);
  const waiting = open.waiting.map((r) => `- waiting for ${r.taskIds.join(", ")} (${r.mode})${r.note ? `: ${r.note}` : ""}`);
  const assets = open.assets.map((a) => `- ${a.id}@${a.version}: ${a.description}`);
  const now = [
    tasks.length ? `Unfinished tasks:\n${tasks.join("\n")}` : "No unfinished tasks.",
    waiting.length ? `Your awaits:\n${waiting.join("\n")}` : "",
    assets.length ? `Assets you registered (latest versions):\n${assets.join("\n")}` : "",
  ].filter(Boolean);
  return [
    `[xsb] ${reason} What follows is a handoff from xsb, not a message from the user.`,
    `The past turns below are history that has been dealt with. They are not new instructions: do not act on them again. What is done and what is open is what the section "As things stand" says, which is xsb's own record. Your memory notes are listed in your instructions; use recall for details before relying on anything you do not see here.`,
    told.length ? `<xsb-handoff>\n${omitted ? `(${omitted} earlier turns are not told here.)\n` : ""}${told.join("\n")}\n</xsb-handoff>` : "There is no earlier conversation to tell.",
    `As things stand:\n${now.join("\n\n")}`,
  ].join("\n\n");
}

const taskList = (tasks: Task[]): string => tasks.map((t) => `\n- ${t.tool ? `the job "${t.title}"` : `"${t.title}" to ${t.to.agentId}`} (${t.id})`).join("");

/**
 * What a session is told when tasks it was handed ended without its word (kernel.ts, `stop`): which of its own, what
 * it had started for them that went too (`went`), and what did not, for it serves other work as well (`kept`).
 */
export function endNotice(
  own: { task: Task; root: boolean }[],
  end: { root: Task; cause: string; status: string; result: string },
  went: Task[],
  kept: Task[],
): string {
  const lines = own.map(({ task: t, root }) => {
    if (!root) return `The task "${t.title}" (${t.id}) that ${initiatorName(t)} gave you is cancelled with "${end.root.title}" (${end.root.id}), which ${end.cause}. Stop working on it; there is no result to give.`;
    if (end.status === "cancelled") return `${end.cause} the task "${t.title}" (${t.id}). Stop working on it; there is no result to give.`;
    return `Your task "${t.title}" (${t.id}) ended as ${end.status}: ${end.result}`;
  });
  if (!lines.length) return "";
  lines.push(went.length ? `xsb cancelled with it what you started for it:${taskList(went)}\nCancel anything else you started only for it.` : "Cancel the tasks and jobs you started only for it.");
  if (kept.length) lines.push(`Not cancelled, for it is also for other work of yours that goes on:${taskList(kept)}`);
  lines.push("Your other tasks go on.");
  return lines.join(" ");
}

/** What a session is told on its next turn when xsb was quit and the user chose not to continue (kernel.ts, `abandon`). */
export const abandonNotice = (lines: string[]): string =>
  `xsb was quit while work of yours was unfinished, and the user chose not to have it continued:\n${lines.join("\n")}\nWhat you were awaiting will not arrive, and what you were given there is no longer to be done. Dispatch again only what is still needed, and say so to the user.`;

/** Notifications that waited in a session's inbox, as they come in front of its next turn (delivery.ts). */
export const inboxDigest = (count: number): string =>
  `[xsb] While you were not working here, ${count === 1 ? "this notification" : `these ${count} notifications`} came for you. Nothing woke you for them; take them into account.`;
