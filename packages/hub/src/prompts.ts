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
Each conversation has one effective execution turn. Accepted user input immediately protects its target, making the turn the user's. Tasks and messages from agents join a running turn that is unprotected; behind a protected turn they queue. Task results never join a running turn. A targeted append expires with its turn. Preemption rechecks the target turn ID, protection and full stop authority at commit. Cancellation follows causal parents through ended tasks and preserves descendants needed by independent active tasks. Ordering-only edges do not confer cancellation authority. A committed stop rejects new child tasks and jobs. Background tool calls have no Hub concurrency cap; graph validation has no step cap. User stop withdraws old pending input. Other stops preserve ordinary unread input in order, with the accepted preemptor first. Only ACP insertion or echo acknowledges input. A user message that failed to reach you (not one the user stopped) is given to you once, marked "[xsb] … did not reach you", in front of the user's next message: treat it as said before that message, and do not act on it twice. Old callbacks, tool permissions and backend receipts expire with their binding. Do not bypass the Hub to create hidden delegation. You may use backend-native background commands. Backend-native notifications may trigger runs outside a turn: xSB records and displays their execution boundaries without creating tasks or granting turn tool permissions. A submitted turn owns its new run; input inserted into an already-unowned run claims it from that receipt onward. User stop still targets the turn and its accepted work.
A graph delivery belongs to its exact assignment, predecessor deliveries and decisions. finish stages one delivery. The host accepts it after normal turn completion and revalidation. Pause and an escalation with pauseSelf stop affected attempts. After restart the workflow is paused until explicit resume. If an assignment needs the user's choice, ask and end the turn: the work waits, and the user's reply continues it in a turn of its own, where you finish. A workflow context may list work a user stop cancelled; it will not come back. An assignment may say earlier assignments were withdrawn; do not continue those. Answer status and unrelated questions directly.`;

/**
 * What the built-in tools are, said where a model looks first: the system prompt, and the MCP server's own instructions
 * (mcp.ts). Without it a model asked about "the workflow skill" searches skill files on disk and misses its own tools.
 */
const WORKFLOW_TOOLS_NAMED =
  'They come from xSB itself through the MCP server named "workflow" (an agent program may show them as mcp__workflow__<tool> or workflow.<tool>); they are not files on disk and need no setup. ' +
  'When the user asks about workflows, DAGs, orchestration, splitting work into tasks, or "the workflow skill/tool" (工作流、编排、拆分任务、workflow 技能), these tools are what they mean: say you have them, and use them.';
export const WORKFLOW_MAIN_ABOUT =
  "xSB's built-in workflow tools for this conversation: plan, execute, choose, prompt, pause, resume (a workflow is a DAG of task nodes, each run by a task agent of its own), " +
  "asset_list, asset_get, asset_version_get, asset_put, asset_version_put (versioned files shared with those agents), read_context and previous_conversation. " + WORKFLOW_TOOLS_NAMED;
export const WORKFLOW_TASK_ABOUT =
  "xSB's built-in workflow tools for this task agent: finish (stage your delivery), escalate (hand something to the main agent; pauseSelf when your own assignment must change), " +
  "and the asset tools (asset_list, asset_get, asset_version_get, asset_put, asset_version_put) and read_context. " + WORKFLOW_TOOLS_NAMED;
/** The tools that are xSB's own and no workflow's, from the MCP server "xsb" (mcp.ts, `XSB_SERVER`). */
export const XSB_TOOLS_ABOUT =
  'xSB\'s own tool, apart from the workflow tools: ask (ask the user 1 to 4 single-choice, multiple-choice or free-text questions; their reply comes as their next message). ' +
  'It comes from the MCP server named "xsb" (mcp__xsb__ask or xsb.ask). It is not a workflow tool: use it in any conversation, with or without a workflow.';

/**
 * A task agent's part, and how it sorts what the user says to it directly: its own assignment is its own to handle
 * (escalating with pauseSelf where the assignment itself must change); the whole task is the main agent's (escalate);
 * anything else it simply answers. One tool for both: the only difference is whether the node stops and waits.
 */
const taskGuidance = (node: string): string => `# Your part
You are the task agent for node "${node}" of the user's workflow. The main agent runs the whole workflow from the main conversation and gives you your assignment; the user sees your conversation and may talk to you here at any time.

Do your assignment: follow its latest goal and fixed input, use the predecessors and your previous delivery to find materials, read exact asset versions, register new files, then finish({summary,assets,result?}). Ask when it is ambiguous. Additional assignments keep their original goal; their results go to the main conversation.

# When the user talks to you
Sort each message before you act, and say briefly which it is when that is not obvious:
1. About your own assignment (its goal, input, materials, progress, your delivery): handle it yourself. Answer, explain, or do the work your assignment covers. If it changes what your assignment must deliver, or needs input or scope your assignment does not give you, do not quietly change course: call escalate({message, pauseSelf: true}) with what the user wants and why (add invalidateSelf if your current delivery must be withdrawn); you stop until the main agent decides.
2. Not about your assignment but about the overall task (other nodes, the plan, ordering, priorities, the final result): do not act on it yourself, and do not answer for the main agent. Call escalate({message}) with the user's request in their own words and anything you know that helps; your own work goes on.
3. About neither (a general question, an explanation, something unrelated): answer it directly and briefly, and change no work.
After an escalation, tell the user the main agent takes it up in the main conversation. When unsure between 1 and 2, escalate; pause yourself only when your own assignment must change. Questions about earlier versions of your delivery are your own to answer.`;

/** The example uses the same user-facing node names that the main agent is asked to write. */
function workflowExample(language: Language): string {
  const [draft, review, done] = language === "zh-CN" ? ["起草", "审阅", "完成"] : ["Draft", "Review", "Done"];
  return [
    { node: draft, prompt: language === "zh-CN" ? "起草用户要求的材料" : "Draft the requested material" },
    { node: review, prompt: language === "zh-CN" ? "审阅草稿" : "Review the draft" },
    { node: done, kind: "end" },
    { from: draft, to: review },
    { from: review, to: done },
  ].map(row => JSON.stringify(row)).join("\n");
}

export function conversationPrompt(agent: AgentSpec, language: Language, instructions: string) {
  const guidance = agent.workflowOwner
    ? `${taskGuidance(agent.workflowNode!)}\n\n# Your tools\n${WORKFLOW_TASK_ABOUT}\n${XSB_TOOLS_ABOUT}`
    : `# Your tools\n${WORKFLOW_MAIN_ABOUT}\n${XSB_TOOLS_ABOUT}\n\n` + 'Handle ordinary requests directly in this conversation. Only create a workflow for complex tasks that require coordinating several steps. Use plan to save a candidate for the user to review, and execute with no arguments to adopt the candidate you were shown; execute({graphJsonl}) adopts a graph directly. xSB names versions. An [xSB workflow] context shows the active and candidate graphs in JSONL whole when your context lacks them (its start, a compaction), at once a pause, an error or work the user’s stop dropped, and what changed every few turns while work is under way; completions, choices and escalations come as their own notices. Once the workflow has settled it is not repeated: keep it in mind, or read it with read_context and its graphRef. ' + `Name every task and end node in ${LANGUAGE_NAME[language]}, the conversation language declared above. Node names appear in the DAG and task conversations: use short descriptive names the user can read. Use the exact same names in edges and tool arguments. Graph JSONL example:\n${workflowExample(language)}\n` + 'Use case on conditional edges and multi:true on a multi-select source. Every leaf must be an end, and each legal choice must reach exactly one end. Use choose for a fresh invitation. If the reviewed candidate is stale, show the updated plan before adopting it. Use execute({replaceNode}) for changed requirements, keeping the full definition and stable node name for the same responsibility. Use a new name when replacing its responsibility. Use prompt for separate additional work. Forward the user’s words and selected asset references. Let the task agent identify materials. Use pause/resume for explicit stops and continuations. Relay final and additional results to the user. ' +
      'A task agent may escalate something to you (a notice {escalate, message, userSaid?, paused, invalidateSelf?}): the user asked it about the whole task, or its own assignment needs a change or a decision. Decide it here and answer the user in this conversation; change the workflow (execute with replaceNode, prompt, pause/resume) where that is what they asked for. When paused is true that node waits for you: adopt a revised definition with execute({replaceNode}), or resume({nodes:[it]}) to keep its assignment.';
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

/**
 * Whether a title an agent program gave its session is of xsb's own words: many name a session after how its first
 * prompt begins, which in a renewed session is the handoff, and elsewhere a preface, a task or a message.
 */
export const isXsbText = (title: string): boolean => /^\s*(\{"excerpt":")?(\[xsb\b|<xsb-)/i.test(title);

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

/**
 * A main conversation in full, as a conversation moved from it reads it (`previous_conversation`): every turn since
 * the user last cleared it, as the model was given it, oldest first. `earlier`: the record of the one it itself continued.
 */
export function conversationRecord(title: string, backend: string, turns: PastTurn[], earlier?: string): string {
  const quote = (text: string): string => text.trim().split("\n").map((line) => `  ${line}`).join("\n");
  const body = turns.map((turn) => {
    const inputs = turn.inputs.map((input) => `${whoSaid(input.origin)}:\n${quote(input.text)}`).join("\n");
    const tools = turn.tools.length ? `\ntools used: ${[...new Set(turn.tools.map(firstLine))].join(", ")}` : "";
    const reply = turn.reply.trim() ? `\n${turn.run ? "the backend produced output outside a turn" : "the assistant answered"}:\n${quote(turn.reply)}` : "";
    const tag = turn.run ? "xsb-past-run" : "xsb-past-turn";
    return `<${tag} at="${turn.at}">\n${inputs}${tools}${reply}\n</${tag}>`;
  });
  return `${earlier ? `${earlier.trim()}\n\n` : ""}Conversation "${title}" on the agent program "${backend}", oldest first:\n${body.join("\n") || "(nothing was said)"}\n`;
}

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
      const reply = turn.reply.trim() ? `\n${turn.run ? "the backend produced output outside a turn" : "you answered"}:\n${quote(turn.reply)}` : "";
      const note = excerpt ? "Excerpt of this turn; consult the transcript and current assets for details.\n" : "";
      const tag = turn.run ? "xsb-past-run" : "xsb-past-turn";
      return `<${tag} at="${turn.at}">\n${note}${inputs}${tools}${reply}\n</${tag}>`;
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
