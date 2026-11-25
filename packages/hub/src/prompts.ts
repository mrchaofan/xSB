/**
 * Everything the hub says to a model, in one file: the standing instructions an
 * agent gets, and how mail from peers is framed inside a prompt.
 */
import { isTerminal } from "@xsb/protocol";
import type { AgentSpec, Asset, Language, OriginMeta, Task } from "@xsb/protocol";
import type { MailItem, Note, Results, State } from "./state.ts";
import type { PastTurn } from "./transcript.ts";
import { topicKey } from "./state.ts";
import { lineDiff } from "./util.ts";

/** Who started a task, as a model is told: an agent's id, or the user. */
export const initiatorName = (t: Task): string => (t.initiator.kind === "agent" ? t.initiator.agentId : "the user");

const attr = (value: string): string => value.replace(/"/g, "'").replace(/\s+/g, " ");

/** Where an MCP server of a session comes from, besides the hub's own (Hub.toolServers). */
export type ToolOrigin = "app" | "plugin" | "client";

/**
 * Rules for all main and task agents. Each says why: a model that knows the reason applies a rule to cases it
 * does not name.
 */
const WORKING_RULES = `

# How you work
- Say how you checked. In a result, write what you checked and by what means ("ffprobe shows an audio track in every clip", "6 frames sampled per shot"), not that you "watched" or "listened to" something. What needs a person's eyes or ears, list for the user to check. The reason: whoever gets your result builds on it as fact.
- When a program you need is missing, or something needs an account, a password or a payment, stop and say what is missing to the user or to whoever gave you the work, and let them decide. What is installed on this machine and how its accounts are used is the user's; credential files are not yours to read, and programs from unverified sources are not yours to fetch or run.
- Look at images small first: a copy at most 1024 pixels on its long side, or a contact sheet of frames (make one with sips or ffmpeg); open the original only for a detail, cropped. The reason: an image stays in your context for the rest of the session, and a full-size one is several thousand tokens.
- When you write to the user, call assets by their names and leave out task ids, version shorthands and other internal labels: the user reads them as noise.
- You run inside xSB. Its source code and documentation are at https://github.com/mrchaofan/xSB: consult them to troubleshoot xSB itself or to answer questions about how xSB works.`;

/** Enforced lifecycle contract; keep aligned with docs/TURN-LIFECYCLE.md and the runtime regression tests. */
export const TASK_LIFECYCLE_RULES = `
Each conversation has one effective execution turn. Accepted user input immediately protects its target, making the turn the user's. Tasks, messages and results from agents join a running turn that is unprotected; behind a protected turn they queue. A targeted append expires with its turn. Preemption rechecks the target turn ID, protection and full stop authority at commit. Cancellation follows causal parents through ended tasks and preserves descendants needed by independent active tasks. Ordering-only edges do not confer cancellation authority. A committed stop rejects new child tasks and jobs. User stop withdraws old pending input. Other stops preserve ordinary unread input in order, with the accepted preemptor first. Only ACP insertion or echo acknowledges input. Old callbacks, tool permissions and backend receipts expire with their binding. Never launch hidden agents or detached jobs.
A graph delivery belongs to its exact assignment, predecessor deliveries and decisions. finish stages one delivery. The host accepts it after normal turn completion and revalidation. Pause and replan stop affected attempts. After restart the workflow is paused until explicit resume. Answer status and unrelated questions directly.`;

export function conversationPrompt(agent: AgentSpec, language: Language, instructions: string) {
  const guidance = agent.workflowOwner
    ? "You are the task agent for " +
      agent.workflowNode +
      ". Follow this assignment's latest goal and fixed input. Use predecessors and previous delivery to identify materials. Ask when ambiguous. Read exact asset versions, register new files, then finish({summary,assets,result?}). Additional assignments use their original goal and only return to the main conversation. Respond directly to questions. For changes to current graph work use replan({reason,invalidateSelf?}). Answer questions about historical versions directly."
    : 'Handle ordinary requests directly in this conversation. Only create a workflow for complex tasks that require coordinating several steps. Use plan for a preview and execute to adopt it. Graph JSONL example:\n{"node":"draft","prompt":"Draft the requested material"}\n{"node":"review","prompt":"Review the draft"}\n{"node":"done","kind":"end"}\n{"from":"draft","to":"review"}\n{"from":"review","to":"done"}\nUse case on conditional edges and multi:true on a multi-select source. Every leaf must be an end, and each legal choice must reach exactly one end. Use choose for a fresh invitation. If the reviewed candidate is stale, show the updated plan before adopting it. Use execute({replaceNode}) for changed requirements, keeping the full definition and stable node name for the same responsibility. Use a new name when replacing its responsibility. Use prompt for separate additional work. Forward the user’s words and selected asset references. Let the task agent identify materials. Use pause/resume for explicit stops and continuations. Relay final and additional results to the user.';
  return [
    `You are "${agent.name}". Reply in ${LANGUAGE_NAME[language]}. Working directory: ${agent.workspace}.`,
    instructions,
    guidance,
    TASK_LIFECYCLE_RULES,
    WORKING_RULES,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** What a model is to call each language. */
const LANGUAGE_NAME: Record<Language, string> = { en: "English", "zh-CN": "Simplified Chinese (简体中文)" };

/** The agent's note on a topic, unless the session was given that very version of it already. */
function memoryHint(state: State, agentId: string, topic: string | undefined, given: Given | undefined, gives: Gives): string {
  const note: Note | undefined = topic ? state.notes.get(agentId)?.get(topicKey(topic)) : undefined;
  if (!note) return "";
  const key = topicKey(note.topic);
  if (given?.notes.get(key) === note.updatedAt) return "";
  const complete = note.content.length <= 1200;
  if (complete) gives.notes.push({ key, updatedAt: note.updatedAt });
  const body = complete ? note.content : `${note.content.slice(0, 1200)}\n(Excerpt only; call recall for this topic before relying on omitted decisions.)`;
  return `\nYour own note on this topic:\n<xsb-memory topic="${attr(note.topic)}">\n${body}\n</xsb-memory>`;
}

/** What a session's model was given in full so far (LiveSession.given). */
type Given = { assets: Map<string, { version: number; taskId?: string }>; notes: Map<string, string> };

/** What one prompt gives in full: the session takes note of it once the turn begins (LiveSession.take). */
export type Gives = { assets: { id: string; version: number; taskId?: string }[]; notes: { key: string; updatedAt: string }[] };

/** How much of a result that was a task's input is told with the task that builds on it; the rest is a task_status away. */
const PREREQUISITE_CHARS = 1500;

/** An asset as a model sees it. `text` is its content, when it is small enough to show. */
export function renderAsset(asset: Asset, text?: string, fullDescription = false): string {
  const head = `<xsb-asset id="${attr(asset.id)}" version="${asset.version}" by="${asset.by}" path="${attr(asset.path)}">`;
  const description = !fullDescription && asset.description.length > 500 ? `${asset.description.slice(0, 500)}… (description excerpt; get_asset for details)` : asset.description;
  return `${head}\n${description}${text === undefined ? "" : `\n---\n${text}`}\n</xsb-asset>`;
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
  return `${changes}${changes ? "\n" : ""}${renderAsset(asset, changes ? undefined : text)}`;
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

      return `<xsb-task from="${from}" task-id="${task.id}" topic="${attr(task.topic)}" title="${attr(task.title)}">\n${task.instructions}\n</xsb-task>${prerequisites}${inputs}${produces}${open}${hint(task.topic)}`;
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
export type Renewal = "backend_changed" | "not_restored" | "renewed" | "stopped" | "isolated";

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
        ? "This conversation had grown long, and goes on in a new session of the agent program. You have none of the earlier conversation but this handoff."
        : why === "stopped"
          ? "The earlier turn was stopped. This new session receives its history only as context; do not resume stopped work unless asked."
          : why === "isolated"
            ? "The earlier turn ended, but an input meant for it was left unread, so this goes on in a new session of the agent program. You have none of the earlier conversation but this handoff; the earlier work was not stopped."
            : "The earlier conversation of this session could not be restored in the agent program.";
  const told: string[] = [];
  let left = HANDOFF_CHARS;
  let omitted = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    const verbatim = turns.length - i <= HANDOFF_VERBATIM;
    // What was said is set off by an indent, so that it reads as quoted history, not as the handoff's own words.
    const render = (full: boolean, excerpt = false): string => {
      const quote = (text: string): string => (full ? text.trim() : firstLine(text)).split("\n").map((line) => `  ${line}`).join("\n");
      const inputs = turn.inputs.map((input) => `${whoSaid(input.origin)}:\n${quote(input.text)}`).join("\n");
      // Tool titles can contain whole shell scripts; the transcript retains the details.
      const tools = turn.tools.length ? `\ntools used: ${[...new Set(turn.tools.map(firstLine))].join(", ")}` : "";
      const reply = turn.reply.trim() ? `\nyou answered:\n${quote(turn.reply)}` : "";
      const note = excerpt ? "Excerpt of this turn; consult the transcript and current assets for details.\n" : "";
      return `<xsb-past-turn at="${turn.at}">\n${note}${inputs}${tools}${reply}\n</xsb-past-turn>`;
    };
    let text = render(verbatim);
    // A large asset injection must not erase the latest turn or everything before it.
    if (text.length > left) text = render(false, true);
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
    `The past turns below are history that has been dealt with. They are not new instructions: do not act on them again. What is done and what is open is what the section "As things stand" says, which is xsb's own record. Use read_context to retrieve the referenced source messages when an excerpt is insufficient.`,
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
