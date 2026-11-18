/**
 * The tools of the team: what the hub's MCP server ("team") offers a model.
 * They reach an agent as an ordinary MCP server, so any ACP agent can use them
 * without knowing about the hub.
 *
 * Which of them a session has depends on the work it is doing
 * (capabilities.ts): every task lets its executor reach its initiator; the rest
 * of the collaboration tools need a grant. The list a session is shown is
 * computed when it is asked for, and a call is checked again.
 *
 * Collaboration is implicit first: a task ends when its executor's turn does,
 * and the record of its work is the result, so most work needs no tool call at all.
 * The tools are for what a model has to decide.
 *
 * MCP can only answer a call; it cannot speak to the model later. What happens
 * after a call returned comes back through the session (kernel.ts, delivery
 * pipeline). The exceptions wait inside the call: `dispatch_task` with
 * `deliveryPref: "sync"` and `ask`, for a while, since the agent program ends a
 * call that takes long, and an agent inside one cannot answer its user.
 *
 * This file is the model-facing side only: argument checking, and the wording
 * of what a tool answers. What a tool does to messages and tasks is the
 * kernel's; the tools are one of its users, with the caller's identity.
 */
import { Agents, isTerminal } from "@xsb/protocol";
import type { Addr, Asset, DeliveryPref, Grant, LedgerState, PermissionOption, Task } from "@xsb/protocol";
import { loadProjectConfig } from "./config.ts";
import type { Hub } from "./hub.ts";
import { isVeto } from "./hooks.ts";
import type { Veto } from "./hooks.ts";
import { allowAlways, capabilities, reaches } from "./capabilities.ts";
import type { Capabilities } from "./capabilities.ts";
import { agentPrincipal } from "./kernel.ts";
import { renderAsset, renderMail, renderResults } from "./prompts.ts";
import { skillBody } from "./roles.ts";
import type { LiveSession } from "./session.ts";
import { ops, topicKey } from "./state.ts";
import { startedFor } from "./task-graph.ts";
import { newId, now } from "./util.ts";

type Ctx = { hub: Hub; session: LiveSession; caps: Capabilities };
type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(ctx: Ctx, args: any): string | Promise<string>;
};

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
});
const str = (description: string) => ({ type: "string", description });
const TOPIC = str("Short, stable label of the matter this belongs to. Reuse the exact topic for everything on the same matter.");

const json = (value: unknown): string => JSON.stringify(value, null, 2);

/** The calling session's address. */
const self = (ctx: Ctx): Addr => ({ agentId: ctx.session.agentId, sessionId: ctx.session.id });

/** What the kernel refused, as the caller is told. */
function allowed<T>(answer: T | Veto): T {
  if (isVeto(answer)) throw new Error(answer.veto);
  return answer;
}

/** How long a call waits for a result (`sync`, `ask`), unless the project says otherwise. */
const AWAIT_SECONDS = 50;
const awaitMs = (ctx: Ctx): number => (loadProjectConfig(ctx.hub.paths).limits?.awaitSeconds ?? AWAIT_SECONDS) * 1000;

/** What each ledger state means, as a model is told. */
const SEEN: Record<LedgerState, string> = {
  inboxed: "kept for the recipient; it reads it with its next turn",
  queued: "waiting behind the recipient's current work; its model has not seen it",
  submitted: "given to the recipient's session, not yet to its model",
  inserted: "in the recipient's conversation; its model has not acted since",
  seen: "seen: the recipient's model went on after it",
  inserted_unprocessed: "in the recipient's conversation, but its turn was stopped before it acted; it sees it when it goes on",
  discarded_unseen: "never reached the recipient's model, and will not",
};

function need(args: any, key: string): string {
  const value = args?.[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`"${key}" is required`);
  return value.trim();
}

function peer(ctx: Ctx, id: string): string {
  if (id === ctx.session.agentId) throw new Error("that is you; address another agent");
  if (!ctx.hub.state.agents.has(id)) {
    const others = [...ctx.hub.state.agents.keys()].filter((a) => a !== ctx.session.agentId);
    throw new Error(`no agent "${id}". Agents: ${others.join(", ") || "none"}`);
  }
  return id;
}

/** Topics this agent already handled, per peer: the hub's own record of who knows what. */
function topicsWith(ctx: Ctx, peerId: string): string[] {
  const out: string[] = [];
  for (const entry of ctx.hub.state.topics.get(ctx.session.agentId)?.values() ?? []) {
    if (entry.peers.has(peerId)) out.push(entry.topic);
  }
  return out;
}

/** Say so when a topic that has history with one peer is now sent to another. */
function continuityNote(ctx: Ctx, topic: string | undefined, to: string): string | undefined {
  if (!topic) return "No topic given. Add one next time so this can be found and continued with the same peer.";
  const peers = ctx.hub.state.topics.get(ctx.session.agentId)?.get(topicKey(topic))?.peers;
  if (!peers || peers.size === 0 || peers.has(to)) return undefined;
  const history = [...peers].map(([id, p]) => `${id} (${p.count}x, last ${p.lastAt})`).join(", ");
  return `Topic "${topic}" has so far been handled with ${history}, not with "${to}". If you meant to continue with the same peer, cancel this and send it there.`;
}

/**
 * Say so when a task asks an agent for something the team's contracts do not
 * back: a type the agent has no procedure for, or one of the types that
 * procedure is made from missing among the inputs. A hint, like the one about
 * topics: whether to act on it is the model's call.
 */
function contractNote(ctx: Ctx, to: string, produces: string | undefined, inputs: Asset[]): string | undefined {
  if (!produces) return undefined;
  const makers = ctx.hub.team().filter((c) => c.produces === produces);
  const contract = makers.find((c) => c.agents.includes(to));
  if (!contract) {
    const others = makers.flatMap((c) => c.agents);
    const who = others.length ? `On this team it is produced by: ${others.join(", ")}.` : `Nobody on this team has one; check the spelling of the type against list_agents.`;
    return `"${to}" has no procedure for producing "${produces}" and works without one. ${who}`;
  }
  const missing = contract.inputs.filter((type) => !inputs.some((a) => a.type === type));
  return missing.length
    ? `"${to}" produces "${produces}" from ${contract.inputs.join(", ")}, but \`inputs\` has no ${missing.join(", ")} asset. If one exists, cancel this and dispatch again with it.`
    : undefined;
}

function ownTask(ctx: Ctx, id: string, mustOwn = false): Task {
  const task = ctx.hub.state.tasks.get(id);
  const me = ctx.session.agentId;
  const mine = task?.from?.agentId === me;
  if (!task || (!mine && (mustOwn || task.to.agentId !== me))) {
    throw new Error(`no task "${id}" ${mustOwn ? "dispatched by you" : "of yours"}`);
  }
  return task;
}

const ALLOW: PermissionOption[] = [
  { optionId: "once", name: "Allow once", kind: "allow_once" },
  { optionId: "always", name: "Always allow", kind: "allow_always" },
  { optionId: "no", name: "Reject", kind: "reject_once" },
];

/**
 * Whether this agent may reach `to` with `cap` (capabilities.ts). What its role is not allowed is put to the user,
 * and the call waits for the answer, however long; allowed always, it is written to the project's config.
 */
async function authorize(ctx: Ctx, cap: Grant["cap"], to: string[]): Promise<void> {
  const asked = to.filter((id) => !reaches(ctx.caps[cap], id));
  if (!asked.length) return;
  const what = cap === "dispatch" ? "give a task to" : "send a message to";
  const answer = await ctx.hub.permissions.request(ctx.session, {
    sessionId: ctx.session.id,
    title: `${ctx.session.agentId} wants to ${what} ${asked.join(", ")}`,
    subject: { type: "tool_call", toolCall: { toolCallId: newId("perm"), title: `team/${cap === "dispatch" ? "dispatch_task" : "send_message"}` } },
    options: ALLOW,
  });
  const chosen = answer.outcome.outcome === "selected" ? answer.outcome.optionId : undefined;
  if (chosen === "always") allowAlways(ctx.hub, ctx.session.agentId, cap, asked);
  if (chosen !== "once" && chosen !== "always") throw new Error(`the user did not allow you to ${what} ${asked.join(", ")}.`);
}

const DELIVERY = {
  type: "string",
  enum: ["sync", "wake", "lazy"],
  description:
    'How the result reaches you. "sync": this call waits for it, up to a minute, for a short task you need the answer of to go on. "wake": as soon as it is there, waking you. "lazy" (default): kept for your next turn, waking nobody.',
};

/**
 * Whether the task's result is promised to its dispatcher through a subscription:
 * a gate still waits for it, or the joined results are on their way. Reading it
 * early through task_status would make the join arrive as a repeat.
 */
function heldForJoin(ctx: Ctx, task: Task): boolean {
  const mine = (owner: { sessionId: string }, ids: string[]): boolean =>
    owner.sessionId === ctx.session.id && ids.includes(task.id);
  for (const gate of ctx.hub.state.gates.values()) if (mine(gate.owner, gate.taskIds)) return true;
  for (const item of ctx.hub.state.mail.values()) {
    if (item.kind === "results" && item.results!.mode && mine(item.to, item.results!.taskIds)) return true;
  }
  return false;
}

function asset(ctx: Ctx, ref: string): Asset {
  const found = ctx.hub.assets.get(ref);
  if (!found) throw new Error(`no asset "${ref}". Look it up with find_assets.`);
  return found;
}

const assetBrief = (a: Asset) => ({ id: a.id, version: a.version, description: a.description, path: a.path, by: a.by });

/** Of a task given to an agent: what became of the message that gave it (the ledger). */
const deliveryOf = (ctx: Ctx, t: Task) => {
  if (t.tool) return {};
  const entry = [...ctx.hub.state.ledger.values()].filter((e) => e.taskId === t.id && e.agentId === t.to.agentId).at(-1);
  return entry ? { given_to_assignee: SEEN[entry.state] } : {};
};

const briefFor = (ctx: Ctx, t: Task) => {
  if (t.result === undefined || !heldForJoin(ctx, t)) return { ...brief(t), ...deliveryOf(ctx, t) };
  const { result, ...rest } = brief(t);
  return { ...rest, result_delivery: "Held for your subscription: it arrives together with the others in one message. Do not act on it before then." };
};

const brief = (t: Task) => ({
  task_id: t.id,
  title: t.title,
  topic: t.topic,
  from: t.initiator.kind === "agent" ? t.initiator.agentId : "the user",
  to: t.tool ? `${t.tool.server}/${t.tool.name}` : t.to.agentId,
  status: t.status,
  ...(t.deliveryPref ? { delivery: t.deliveryPref } : {}),
  ...(t.ended ? { ended: t.ended.reason, ended_by: t.ended.stopper.kind === "agent" ? t.ended.stopper.agentId : t.ended.stopper.kind === "user" ? "the user" : "xsb" } : {}),
  ...(t.after.length ? { after: t.after } : {}),
  ...(t.parents?.length ? { started_for: t.parents } : {}),
  ...(t.result !== undefined ? { result: t.result } : {}),
});

/** What a dispatcher is told of a task that does not start at once: what it replaced, or what it waits behind. */
function busyNote(ctx: Ctx, task: Task, replaced: Task[]): string | undefined {
  const list = (ts: Task[]) => ts.map((t) => `${t.id} "${t.title}"`).join(", ");
  if (replaced.length) return `dispatched; it replaces ${list(replaced)}, which ${task.to.agentId} is stopping (superseded). It starts once that work stopped.`;
  const item = [...ctx.hub.state.mail.values()].find((m) => m.kind === "task" && m.taskId === task.id);
  if (!item || ctx.hub.state.ledger.get(item.id)?.state !== "queued") return undefined;
  const mine = ctx.hub.kernel.openTasks(task.to.sessionId).filter((t) => t.id !== task.id && t.initiator.kind === "agent" && t.initiator.agentId === ctx.session.agentId);
  return mine.length
    ? `queued: ${task.to.agentId} is at work on ${list(mine)} of yours, and starts on this one after it. If this one is meant to take the place of that one, cancel_task that one, or dispatch with onBusy "replace" next time.`
    : `queued: ${task.to.agentId} is busy, and starts on this one after its current work.`;
}

/** A message to a peer, as send_message and broadcast send it. */
function send(ctx: Ctx, to: string, content: string, topic: string | undefined) {
  const note = continuityNote(ctx, topic, to);
  const session = ctx.hub.mainSession(to);
  const { item } = ctx.hub.kernel.post({ to: { agentId: to, sessionId: session.id }, from: { kind: "agent", ...self(ctx) }, kind: "message", topic, content, pref: "wake" });
  const queued = ctx.hub.state.ledger.get(item.id)?.state === "queued";
  // Nothing an agent says goes into another's running work (kernel.ts, `deliveryPolicy`): said to change a task of the
  // sender's that the peer is doing, it comes too late, once that task is done. What does change it is a replacement.
  const mine = queued ? ctx.hub.kernel.openTasks(session.id).filter((t) => t.initiator.kind === "agent" && t.initiator.agentId === ctx.session.agentId) : [];
  const late = mine.length
    ? `${to} is at work on ${mine.map((t) => `${t.id} "${t.title}"`).join(", ")} of yours, and sees this message only once that is done. To change what it does, dispatch_task the new instructions with onBusy "replace".`
    : undefined;
  const delivery = queued ? "queued behind the peer's current work" : "delivered";
  return { message_id: item.id, delivery, ...(late ? { warning: late } : {}), ...(note ? { note } : {}) };
}

export const TOOLS: Tool[] = [
  {
    name: "dispatch_task",
    description:
      "Give another agent a task. Its result is the record of the agent's work on it. Say with deliveryPref how you want the result: in this call (sync), waking you (wake), or with your next turn (lazy, the default). To go on only once several tasks are done, dispatch them, subscribe to them and end your turn. A peer that is busy gets the task after its current work (onBusy \"queue\", the default); to change what you asked of it while it works on it, dispatch the new task with onBusy \"replace\".",
    inputSchema: schema(
      {
        to: str("Agent id."),
        title: str("Short title."),
        instructions: str("Everything the peer needs, for it sees nothing of your conversation: the goal, what you already know or decided, the constraints, what done looks like, and what to report back."),
        topic: TOPIC,
        deliveryPref: DELIVERY,
        after: { type: "array", items: { type: "string" }, description: "Task ids that must finish before this task starts. The peer receives their results as input." },
        inputs: { type: "array", items: { type: "string" }, description: "Ids of the assets the task works from (e.g. character/lin). The peer receives them with the task." },
        produces: str("Asset type the task has to result in (e.g. shot_list). The peer must register one; it is asked for it if it does not."),
        onBusy: {
          type: "string",
          enum: ["queue", "replace"],
          description:
            'If the peer is at work on a task of yours. "queue" (default): this task waits until that work is done, and both are done. "replace": this task takes its place: that task is stopped (with what was started for it) and ends as superseded, and the peer starts on this one. Use it when you changed what you want, not to run work alongside.',
        },
      },
      ["to", "title", "instructions"],
    ),
    async run(ctx, args) {
      const to = peer(ctx, need(args, "to"));
      await authorize(ctx, "dispatch", [to]);
      const after: string[] = Array.isArray(args.after) ? args.after : [];
      const deliveryPref: DeliveryPref = ["sync", "wake"].includes(args.deliveryPref) ? args.deliveryPref : "lazy";
      const title = need(args, "title");
      const instructions = need(args, "instructions");
      const topic: string | undefined = args.topic?.trim() || undefined;
      const inputs: string[] = Array.isArray(args.inputs) ? args.inputs : [];
      const produces: string | undefined = args.produces?.trim() || undefined;
      const note = [continuityNote(ctx, topic, to), contractNote(ctx, to, produces, inputs.map((ref) => asset(ctx, ref)))].filter(Boolean).join(" ");
      // An agent has one conversation, and does all its work there, one turn at a time (Hub.mainSession).
      const session = ctx.hub.mainSession(to);
      const task = allowed(ctx.hub.kernel.dispatch(self(ctx), { agentId: to, sessionId: session.id }, { title, topic: topic ?? title, instructions, after, inputs, produces, deliveryPref }));
      const replaced = args.onBusy === "replace" ? ctx.hub.kernel.replace(task) : [];
      const held = task.status === "blocked";
      const answer = { task_id: task.id, status: held ? "held until the tasks in `after` finish" : busyNote(ctx, task, replaced) ?? "dispatched", delivery: deliveryPref, ...(note ? { note } : {}) };
      if (deliveryPref !== "sync") return json(answer);
      const late = json({ ...answer, status: `${answer.status}; not finished within ${awaitMs(ctx) / 1000} seconds. Its result wakes you when it is there: end your turn, or go on with other work.` });
      return ctx.hub.delivery.awaitResult(ctx.session, task.id, awaitMs(ctx), late);
    },
  },
  {
    name: "report_result",
    description:
      "Report a task you were given: before your turn ends, or with a result other than the record of your work, or that it failed. Usually not needed: when your turn ends, the task ends with the record of your work on it.",
    inputSchema: schema(
      {
        task_id: str("Id of the task, from its <xsb-task>. May be left out when you have one task."),
        result: str("The result as its sender will read it: complete and self-contained. Say plainly what you could not do, did not finish or did not verify."),
        assets: { type: "array", items: { type: "string" }, description: "Ids of the assets you registered for it (e.g. shot_list/scene3), the latest version unless you append @<version>." },
        failed: { type: "boolean", description: "The task could not be done, or is no longer to be done." },
      },
      ["result"],
    ),
    run(ctx, args) {
      const me = ctx.session.agentId;
      const open = ctx.hub.kernel.openTasks(ctx.session.id);
      const id: string | undefined = typeof args.task_id === "string" && args.task_id.trim() ? args.task_id.trim() : open.length === 1 ? open[0].id : undefined;
      if (!id) throw new Error(`"task_id" is required: you have ${open.length ? `several tasks (${open.map((t) => t.id).join(", ")})` : "no task"}`);
      const task = ctx.hub.state.tasks.get(id);
      if (!task || task.tool || task.to.agentId !== me) throw new Error(`no task "${id}" given to you`);
      if (task.status === "cancelled") throw new Error(`task ${id} was stopped; there is no result to give`);
      if (isTerminal(task.status)) throw new Error(`task ${id} is ${task.status} already`);
      if (task.status !== "running") throw new Error(`task ${id} has not been given to you yet; it arrives as an <xsb-task>`);
      const result = need(args, "result");
      const failed = args.failed === true;
      const assets = (Array.isArray(args.assets) ? args.assets : []).map((ref: string) => asset(ctx, ref));
      for (const a of assets) if (a.by !== me) throw new Error(`asset ${a.id} was registered by ${a.by}, not by you`);
      if (!failed && task.produces && !assets.some((a: Asset) => a.type === task.produces)) {
        throw new Error(`task ${id} has to produce a "${task.produces}" asset: register it with put_asset and name it in "assets". If it cannot be done, set failed and say why.`);
      }
      ctx.hub.kernel.complete(task, failed ? "failed" : "completed", result, assets);
      const left = ctx.hub.kernel.openTasks(task.to.sessionId).map((t) => t.id);
      // Reporting is the executor's call, and takes nothing along: what it started meanwhile goes on unless it says so.
      const going = startedFor(ctx.hub.state, id).map((t) => `${t.id} "${t.title}"`);
      const to = task.initiator.kind === "agent" ? task.initiator.agentId : "the user";
      return [
        `Task ${id} ${failed ? "reported as failed" : "completed"}; the result goes to ${to}.`,
        ...(left.length ? [`Still open: ${left.join(", ")}.`] : []),
        ...(going.length ? [`Still running, started while you had it: ${going.join(", ")}. Cancel what is no longer needed.`] : []),
      ].join(" ");
    },
  },
  {
    name: "ask",
    description:
      "Ask a question and wait in this call for the answer, up to a minute: by default of whoever gave you your task; another agent only if your work lets you reach it. The answer is what it says back.",
    inputSchema: schema({ question: str("The question, with what the other needs to answer it."), to: str("Agent id. Leave out to ask whoever gave you your task."), topic: TOPIC }, ["question"]),
    async run(ctx, args) {
      const question = need(args, "question");
      const asked: string | undefined = typeof args.to === "string" && args.to.trim() ? peer(ctx, args.to.trim()) : [...ctx.caps.upward][0];
      if (!asked) throw new Error("you have no task given by an agent; name whom to ask in `to`");
      // Upward, it goes to the session of the initiator that gave the task, which has the matter in mind.
      const upward = ctx.hub.kernel.openTasks(ctx.session.id).find((t) => t.initiator.kind === "agent" && t.initiator.agentId === asked && t.from);
      if (!upward) await authorize(ctx, "message", [asked]);
      const topic: string = args.topic?.trim() || upward?.topic || "question";
      const session = upward?.from ? ctx.hub.live.get(upward.from.sessionId)! : ctx.hub.mainSession(asked);
      const task = allowed(ctx.hub.kernel.dispatch(self(ctx), { agentId: asked, sessionId: session.id }, { title: `Question from ${ctx.session.agentId}`, topic, instructions: `${ctx.session.agentId} asks you, and waits for your answer (what you say back is the answer):\n${question}`, after: [], deliveryPref: "sync" }));
      const late = `No answer from ${asked} within ${awaitMs(ctx) / 1000} seconds. It wakes you when it comes (task ${task.id}).`;
      return ctx.hub.delivery.awaitResult(ctx.session, task.id, awaitMs(ctx), late);
    },
  },
  {
    name: "subscribe",
    description:
      "Have the results of tasks you dispatched or jobs you started wake you: together in one message, when all (or any) have finished. Then end your turn; meanwhile you remain available to the user.",
    inputSchema: schema(
      {
        task_ids: { type: "array", items: { type: "string" }, description: "Ids of tasks you dispatched or jobs you started, from this session." },
        mode: { type: "string", enum: ["all", "any"], description: "Wait for all of them (default) or for the first one." },
        note: str("A reminder to yourself, returned with the results: what to do next, and any condition to check before going on."),
      },
      ["task_ids"],
    ),
    run(ctx, args) {
      const ids: string[] = Array.isArray(args.task_ids) ? [...new Set<string>(args.task_ids)] : [];
      if (ids.length === 0) throw new Error(`"task_ids" is required`);
      const tasks = ids.map((id) => ownTask(ctx, id, true));
      for (const t of tasks) if (t.from?.sessionId !== ctx.session.id) throw new Error(`task ${t.id} was dispatched from another session of yours`);
      const note = typeof args.note === "string" ? args.note : undefined;
      const mode = args.mode === "any" ? "any" : "all";
      const { satisfied, finished } = ctx.hub.kernel.subscribe(self(ctx), tasks, mode, note);
      if (satisfied) return `Nothing to wait for, the results are in:\n${renderResults(ctx.hub.state, { taskIds: ids, mode, note })}`;
      return `Subscribed (${finished}/${tasks.length} finished). End your turn now; the results arrive together in one message.`;
    },
  },
  {
    name: "task_status",
    description: "Look up one task: its state, who started and who ended it, whether its assignee has seen it. Without task_id, list your unfinished tasks and what you are subscribed to. Do not poll with it.",
    inputSchema: schema({ task_id: str("Task id. Omit to list.") }),
    run(ctx, args) {
      if (args?.task_id) return json(briefFor(ctx, ownTask(ctx, args.task_id)));
      const me = ctx.session.agentId;
      const open = [...ctx.hub.state.tasks.values()].filter((t) => !isTerminal(t.status));
      return json({
        dispatched_by_you: open.filter((t) => t.from?.agentId === me).map(brief),
        assigned_to_you: open.filter((t) => t.to.agentId === me && !t.tool).map(brief),
        subscribed: [...ctx.hub.state.gates.values()].filter((g) => g.owner.agentId === me).map((g) => ({ task_ids: g.taskIds, mode: g.mode, note: g.note })),
      });
    },
  },
  {
    name: "cancel_task",
    description:
      "Stop a task you dispatched or a job you started. What was started for it alone stops with it, and the work its assignee was doing for it is stopped. No result comes back, and a subscription no longer waits for it.",
    inputSchema: schema({ task_id: str("Task id.") }, ["task_id"]),
    run(ctx, args) {
      const task = ownTask(ctx, need(args, "task_id"), true);
      if (isTerminal(task.status)) return `Task ${task.id} already ${task.status}.`;
      const { stopping, with: went } = allowed(ctx.hub.kernel.stop(task, agentPrincipal(ctx.session.agentId), { status: "cancelled", reason: "cancelled", result: "Cancelled by the dispatcher." }));
      const also = went.length ? ` Stopped with it, as started for it: ${went.map((t) => `${t.id} "${t.title}"`).join(", ")}.` : "";
      return `Task ${task.id} ${stopping ? "is being stopped" : "cancelled"}.${also}`;
    },
  },
  {
    name: "inbox",
    description: "What waits for your next turn: results you asked to get lazily, notices. peek shows them; ack shows them and takes them out, so they do not come again.",
    inputSchema: schema({ action: { type: "string", enum: ["peek", "ack"], description: "peek (default) or ack." } }),
    run(ctx, args) {
      const items = ctx.hub.kernel.inbox(ctx.session.id);
      if (!items.length) return "Your inbox is empty.";
      const text = items.map((item) => renderMail(ctx.hub.state, item).text).join("\n");
      if (args?.action === "ack") {
        ctx.hub.kernel.ack(items.map((i) => i.id));
        for (const item of items) ctx.hub.kernel.mark(item.id, "seen");
      }
      return text;
    },
  },
  {
    name: "list_agents",
    description: "List the other agents on the team: what each does, the asset types it has a procedure for producing, whether it is busy, the topics you already handled with it, and whether your work lets you dispatch to or message it.",
    inputSchema: schema({}),
    run(ctx) {
      const team = ctx.hub.team();
      const agents = [...ctx.hub.state.agents.values()]
        .filter((a) => a.id !== ctx.session.agentId)
        .map((a) => ({
          id: a.id,
          name: a.name,
          ...(a.role ? { role: a.role } : {}),
          description: a.description,
          produces: team.filter((c) => c.agents.includes(a.id)).map((c) => c.produces),
          state: ctx.hub.agentInfo(a).state,
          topics_with_you: topicsWith(ctx, a.id),
          you_may: [...(reaches(ctx.caps.dispatch, a.id) ? ["dispatch"] : []), ...(reaches(ctx.caps.message, a.id) ? ["message"] : []), ...(ctx.caps.upward.has(a.id) ? ["report", "ask"] : [])],
        }));
      return json({ you: ctx.session.agentId, agents });
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to another agent. If the peer is working on a task you gave it, it goes into its running work; otherwise, if it is busy, it is read as its next turn. The result says which; message_status tells later whether its model has seen it.",
    inputSchema: schema({ to: str("Agent id."), content: str("The message."), topic: TOPIC }, ["to", "content"]),
    async run(ctx, args) {
      const to = peer(ctx, need(args, "to"));
      await authorize(ctx, "message", [to]);
      return json(send(ctx, to, need(args, "content"), args.topic?.trim() || undefined));
    },
  },
  {
    name: "broadcast",
    description: "Send the same message to several agents, each as with send_message.",
    inputSchema: schema({ to: { type: "array", items: { type: "string" }, description: "Agent ids." }, content: str("The message."), topic: TOPIC }, ["to", "content"]),
    async run(ctx, args) {
      const to: string[] = Array.isArray(args.to) ? [...new Set<string>(args.to)].map((id) => peer(ctx, id)) : [];
      if (!to.length) throw new Error(`"to" is required`);
      const content = need(args, "content");
      await authorize(ctx, "message", to);
      return json(to.map((id) => ({ to: id, ...send(ctx, id, content, args.topic?.trim() || undefined) })));
    },
  },
  {
    name: "message_status",
    description: "Whether the model of the agent you wrote to has seen a message of yours: give the message_id send_message returned. Do not poll with it.",
    inputSchema: schema({ message_id: str("Id of a message you sent.") }, ["message_id"]),
    run(ctx, args) {
      const id = need(args, "message_id");
      const entry = ctx.hub.state.ledger.get(id);
      if (!entry || entry.from.kind !== "agent" || entry.from.agentId !== ctx.session.agentId) throw new Error(`no message "${id}" sent by you`);
      return json({ message_id: id, to: entry.agentId, state: entry.state, meaning: SEEN[entry.state], since: entry.ts });
    },
  },
  {
    name: "escalate_to_user",
    description:
      "Say that you are waiting for the user to decide or confirm something before the work can go on. Put the question, with its options, in your reply as usual; this tool lets the user know, wherever they are, that you are waiting for them. Call it once, then end your turn.",
    inputSchema: schema({ question: str("The question in one line, as the user will see it in a notification.") }, ["question"]),
    run(ctx, args) {
      ctx.hub.broadcast(Agents.asks, { agentId: ctx.session.agentId, question: need(args, "question") });
      return "The user has been told that you are waiting for them. End your turn now; their answer comes as a new message.";
    },
  },
  {
    name: "start_job",
    description:
      "Run one slow tool call in the background instead of waiting inside it: rendering, generation, anything that takes minutes. Returns immediately with a task id; the tool's result wakes you like a task result, and can be subscribed to with others or stopped with cancel_task.",
    inputSchema: schema(
      {
        server: str("Name of one of your role's MCP servers."),
        tool: str("Name of the tool of that server."),
        arguments: { type: "object", description: "The tool's arguments, exactly as you would pass them in a direct call." },
        title: str("Short title, to recognise the result by."),
        topic: TOPIC,
      },
      ["server", "tool", "title"],
    ),
    run(ctx, args) {
      const title = need(args, "title");
      const server = need(args, "server");
      const agent = ctx.hub.agent(ctx.session.agentId);
      if (!ctx.hub.toolServers(agent).some((t) => t.from === "role" && t.server.name === server)) throw new Error(`your role has no MCP server "${server}"`);
      const tool = { server, name: need(args, "tool"), arguments: args.arguments ?? {} };
      const task = allowed(ctx.hub.kernel.createJob(self(ctx), { title, topic: args.topic?.trim() || title, tool }));
      return json({ task_id: task.id, status: "started; the result will be delivered to you" });
    },
  },
  {
    name: "put_asset",
    description:
      "Register something the team will build on in the shared asset library: a requirement, a design, a character, a script, a finished piece of work. Registering an id that exists adds a new version. Give a file by path, or text as content.",
    inputSchema: schema(
      {
        type: str("Kind of asset, one word. Use the type a task or your team names (see The team in your instructions); otherwise a plain noun such as character, script, image."),
        name: str("Its name within the type, one word. Type and name form the id, e.g. character/lin."),
        description: str("One or two sentences: what it is and what it is for. This is what others find it by."),
        path: str("A file to register, absolute or relative to your working directory. It is copied into the library."),
        content: str("Text to register, instead of a file."),
      },
      ["type", "name", "description"],
    ),
    run(ctx, args) {
      const saved = ctx.hub.assets.put(ctx.session, {
        type: need(args, "type"),
        name: need(args, "name"),
        description: need(args, "description"),
        path: typeof args.path === "string" && args.path.trim() ? args.path.trim() : undefined,
        content: typeof args.content === "string" ? args.content : undefined,
      });
      return json(assetBrief(saved));
    },
  },
  {
    name: "find_assets",
    description: "List the assets in the shared library (latest versions). Call it before defining something that may already be defined.",
    inputSchema: schema({ type: str("Only this type."), query: str("A word to look for in ids and descriptions.") }),
    run(ctx, args) {
      return json({ assets: ctx.hub.assets.find(args.type?.trim() || undefined, args.query).map(assetBrief) });
    },
  },
  {
    name: "get_asset",
    description: "Get one asset: where its file is, and its text when it is a small text asset. Append @<version> to the id for an earlier version.",
    inputSchema: schema({ id: str("Asset id, e.g. character/lin or character/lin@1.") }, ["id"]),
    run(ctx, args) {
      const found = asset(ctx, need(args, "id"));
      return renderAsset(found, ctx.hub.assets.text(found));
    },
  },
  {
    name: "load_skill",
    description: "Load one of your role's skills, the written procedure for a kind of work. Your skills are listed in your instructions.",
    inputSchema: schema({ name: str("Skill name.") }, ["name"]),
    run(ctx, args) {
      const skills = ctx.hub.role(ctx.hub.agent(ctx.session.agentId))?.skills ?? [];
      const skill = skills.find((s) => s.name === need(args, "name"));
      if (!skill) throw new Error(`no skill "${args.name}". Your skills: ${skills.map((s) => s.name).join(", ") || "none"}`);
      return `Files this skill refers to are in ${skill.dir}.\n\n${skillBody(skill).trim()}`;
    },
  },
  {
    name: "remember",
    description:
      "Write your note for a topic, replacing the previous one. Keep it current: what was decided, which peer owns it, what is open. Empty content deletes the note.",
    inputSchema: schema(
      {
        topic: TOPIC,
        content: str("The whole note as it should read now."),
        peers: { type: "array", items: { type: "string" }, description: "Agent ids this topic is handled with." },
      },
      ["topic", "content"],
    ),
    run(ctx, args) {
      const topic = need(args, "topic");
      const content = typeof args.content === "string" ? args.content.trim() : "";
      const me = ctx.session.agentId;
      if (!content) {
        ctx.hub.state.commit([ops.removeNote(me, topic)]);
        return `Note "${topic}" deleted.`;
      }
      const known = ctx.hub.state.topics.get(me)?.get(topicKey(topic))?.peers.keys() ?? [];
      const peers: string[] = Array.isArray(args.peers) && args.peers.length ? args.peers : [...known];
      ctx.hub.state.commit([ops.putNote(me, { topic, content, peers, updatedAt: now() })]);
      return `Note "${topic}" saved.`;
    },
  },
  {
    name: "recall",
    description:
      "Search your memory: your notes, which peer handled which topic, and related tasks. Call it before contacting a peer about something that may have history. Without a query it lists everything.",
    inputSchema: schema({ query: str("Words to look for in topics, notes, peers and task titles.") }),
    run(ctx, args) {
      const me = ctx.session.agentId;
      const query = typeof args?.query === "string" ? args.query.trim().toLowerCase() : "";
      const hit = (...fields: (string | undefined)[]): boolean =>
        !query || fields.some((f) => f?.toLowerCase().includes(query));

      const notes = [...(ctx.hub.state.notes.get(me)?.values() ?? [])].filter((n) => hit(n.topic, n.content, n.peers.join(" ")));
      const topics = [...(ctx.hub.state.topics.get(me)?.values() ?? [])]
        .filter((e) => hit(e.topic, [...e.peers.keys()].join(" ")))
        .map((e) => ({
          topic: e.topic,
          handled_with: [...e.peers].map(([id, p]) => ({ agent: id, interactions: p.count, last: p.lastAt })),
        }));
      const tasks = [...ctx.hub.state.tasks.values()]
        .filter((t) => (t.from?.agentId === me || t.to.agentId === me) && hit(t.topic, t.title))
        .slice(-15)
        .map(({ result, ...rest }) => brief(rest as Task));
      return json({ notes, topics, tasks });
    },
  },
];

export async function callTool(hub: Hub, session: LiveSession, name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { text: `Unknown tool: ${name}`, isError: true };
  const caps = capabilities(hub, session.agentId, session.id, session.senders());
  if (name === "report_result" && !caps.upward.size) return { text: "report_result is not available in the work you are doing now: no agent gave you a task you have open.", isError: true };
  try {
    return { text: await tool.run({ hub, session, caps }, args ?? {}), isError: false };
  } catch (e) {
    return { text: e instanceof Error ? e.message : String(e), isError: true };
  }
}
