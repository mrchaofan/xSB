/**
 * Everything the hub says to a model, in one file: the standing instructions an
 * agent gets, and how mail from peers is framed inside a prompt.
 */
import { isTerminal } from "@xsb/protocol";
import type { AgentSpec, Asset, Language, Task } from "@xsb/protocol";
import type { Contract, Skill } from "./roles.ts";
import type { MailItem, Note, Results, State } from "./state.ts";
import { topicKey } from "./state.ts";

const attr = (value: string): string => value.replace(/"/g, "'").replace(/\s+/g, " ");

export function memoryDigest(state: State, agentId: string, limit = 30): string {
  const notes = [...(state.notes.get(agentId)?.values() ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const ledger = state.ledger.get(agentId);
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

/** What a model is to call each language. */
const LANGUAGE_NAME: Record<Language, string> = { en: "English", "zh-CN": "Simplified Chinese (简体中文)" };

export function systemPrompt(
  agent: AgentSpec,
  instructions: string,
  skills: Skill[],
  team: Contract[],
  dirs: { shared: string; assets: string },
  state: State,
  language: Language,
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
You are one of several peer agents coordinated by xsb. A human user can talk to each agent directly, and agents talk to each other with the tools of the "xsb" MCP server:

- list_agents: who is on the team, and which topics you already handled with each of them.
- send_message: tell or ask a peer something. A peer only receives what you send with this tool; your ordinary reply text goes to whoever is in your own session.
- dispatch_task: hand a peer a piece of work. It returns immediately. The result comes back to you later as an <xsb-task-result> message. Give \`after\` when the task must not start before other tasks have finished; the peer then receives their results too.
- await_tasks: when you need the results of several tasks before you can continue, call this once with their ids and then END YOUR TURN. You receive all results together in one message when the condition holds. Never poll, and never sleep to wait.
- start_job: run one slow tool call (rendering, generation, anything that takes minutes) in the background. Like a task it returns immediately, its result comes back as an <xsb-task-result>, and it can be awaited and cancelled. Never sit in a slow tool call when it can be a job.
- get_task, cancel_task: inspect or stop tasks and jobs you started.
- put_asset, find_assets, get_asset: the shared asset library (see Assets).
- remember, recall: your long-term memory, kept per topic.

Messages wrapped in <xsb-message>, <xsb-task>, <xsb-task-result> or <xsb-task-results> come from peers or from xsb, not from the user. When you work on an <xsb-task>, the final message of that turn is returned to the sender as the task's result, so make it complete and self-contained. Say in it plainly what you could not do, did not finish or did not verify: the sender builds on what you report.

While tasks you dispatched are still running, the user may talk to you. Answer them normally; pending results will still arrive. If a set of results comes with conditions you set yourself, check them by reasoning over what you received, and dispatch follow-up work if they are not met.

# Topics and continuity
Give every message and task a short, stable \`topic\` and reuse the exact same topic for everything that belongs to the same matter. A topic stays with the peer who already handled it: when two peers could do a job, continue with the one who has the history, not the other. Before contacting a peer about something that may have history, call recall. After a decision, an agreement or a handoff, call remember to rewrite the note for that topic so it stays current: what was decided, who owns it, what is open.

# Assets
Everything the team has to agree on (a character, a style, a location, a script, a shot list, a finished shot) lives in the asset library, once, under an id like \`character/lin\`. It is the single source of truth:
- Before you describe or create something that may already be defined, call find_assets. If it exists, use it as it is.
- Refer to assets by id. When you dispatch work that depends on assets, list them in \`inputs\`; the peer receives them with the task. When the work has to result in an asset, say which type in \`produces\`.
- When you made something others will build on, register it with put_asset. Changing a definition means registering a new version of the same id, not a new id.
- A task that comes with a type to produce is not finished until you registered an asset of that type.
- The assets a task comes with are its facts. When one is wrong or not enough, say so in your result; do not quietly redefine it.${teamIndex}

# Files
Your working directory is ${agent.workspace}. Work in progress stays there.${sharing.length ? ` Also working in this directory: ${sharing.join(", ")}. They see what you change in it.` : ""} What others need goes into the asset library (${dirs.assets}); loose files that are no asset go in ${dirs.shared}. Refer to files by absolute path.${skillIndex}

# Your memory at the start of this session
${memoryDigest(state, agent.id)}`;
}

function memoryHint(state: State, agentId: string, topic: string | undefined): string {
  const note: Note | undefined = topic ? state.notes.get(agentId)?.get(topicKey(topic)) : undefined;
  return note ? `\n<xsb-memory topic="${attr(note.topic)}">\n${note.content}\n</xsb-memory>` : "";
}

/** An asset as a model sees it. `text` is its content, when it is small enough to show. */
export function renderAsset(asset: Asset, text?: string): string {
  const head = `<xsb-asset id="${attr(asset.id)}" version="${asset.version}" by="${asset.by}" path="${attr(asset.path)}">`;
  return `${head}\n${asset.description}${text === undefined ? "" : `\n---\n${text}`}\n</xsb-asset>`;
}

function resultBlock(state: State, task: Task): string {
  const by = task.tool ? `${task.tool.server}/${task.tool.name}` : task.to.agentId;
  const head = `task-id="${task.id}" by="${attr(by)}" topic="${attr(task.topic)}" title="${attr(task.title)}" status="${task.status}"`;
  if (!isTerminal(task.status)) return `<xsb-task-result ${head} />`;
  // What the task was to deliver is checked here, not left to the wording of its result.
  const assets = [...state.assets.values()].flat().filter((a) => a.taskId === task.id);
  const registered = assets.length ? `\nAssets registered by this task:\n${assets.map((a) => renderAsset(a)).join("\n")}` : "";
  const missing =
    task.produces && !assets.some((a) => a.type === task.produces)
      ? `\nNo "${attr(task.produces)}" asset was registered, although the task had to produce one.`
      : "";
  return `<xsb-task-result ${head}>\n${task.result ?? ""}${registered}${missing}\n</xsb-task-result>`;
}

/** What the hub adds to a task beyond the dispatcher's words. */
export type TaskContext = {
  /** The assets the task works from, with the text of those small enough to show. */
  inputs: { asset: Asset; text?: string }[];
  /** The assignee's own procedure for the asset type the task has to produce. */
  skill?: Skill & { body: string };
};

/** The prompt text a mail item becomes for its recipient. `context` is given for a task. */
export function renderMail(state: State, item: MailItem, context?: TaskContext): string {
  const from = item.from.kind === "agent" ? item.from.agentId : item.from.kind === "system" ? "xsb" : "user";
  const to = item.to.agentId;
  switch (item.kind) {
    case "message": {
      const topic = item.topic ? ` topic="${attr(item.topic)}"` : "";
      return `<xsb-message from="${from}"${topic} id="${item.id}">\n${item.content ?? ""}\n</xsb-message>${memoryHint(state, to, item.topic)}`;
    }
    case "task": {
      const task = state.tasks.get(item.taskId!)!;
      const deps = task.after
        .map((id) => state.tasks.get(id))
        .filter((t): t is Task => !!t)
        .map((t) => resultBlock(state, t));
      const prerequisites = deps.length
        ? `\nThis task was held until the following tasks finished. Their results are your input; if one of them failed or is not sufficient, say so in your result instead of guessing.\n${deps.join("\n")}`
        : "";
      const inputs = context?.inputs.length
        ? `\nThis task works from the following assets. They are the reference: keep to them, and do not redefine what they define.\n${context.inputs.map((i) => renderAsset(i.asset, i.text)).join("\n")}`
        : "";
      const produces = task.produces
        ? `\nThis task has to produce a "${attr(task.produces)}" asset. Register it with put_asset before you end your turn and name its id in your result.`
        : "";
      const skill = context?.skill
        ? `\nYour skill for this (files it refers to are in ${context.skill.dir}):\n<xsb-skill name="${attr(context.skill.name)}">\n${context.skill.body.trim()}\n</xsb-skill>`
        : "";
      return `<xsb-task from="${from}" task-id="${task.id}" topic="${attr(task.topic)}" title="${attr(task.title)}">\n${task.instructions}\n</xsb-task>${prerequisites}${inputs}${produces}${skill}${memoryHint(state, to, task.topic)}`;
    }
    case "results":
      return renderResults(state, item.results!) + memoryHint(state, to, item.topic);
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

export const STEER_CONTINUATION =
  "[xsb] A new message arrived while you were working and your turn was paused for it. Take it into account, then carry on with whatever you had not finished.";

export const CONTEXT_LOST =
  "[xsb] The earlier conversation of this session could not be restored, so you are starting with a fresh context. Your memory notes are listed in your instructions; use recall for details before relying on anything you do not see here.";
