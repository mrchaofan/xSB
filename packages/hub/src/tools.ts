/**
 * The tools agents collaborate with. They reach an agent as an ordinary MCP
 * server, so any ACP agent can use them without knowing about the hub.
 *
 * MCP can only answer a call; it cannot speak to the model later. Everything
 * that happens after a call returned (a task's result, a message from a peer,
 * a set of awaited results) therefore comes back through the session itself,
 * as a prompt or a steer tagged with its origin. That is why `dispatch_task`
 * returns at once and why there is no blocking wait: an agent that is not
 * stuck inside a tool call stays free to talk to its user.
 *
 * This file is the model-facing side only: argument checking, and the wording
 * of what a tool answers. What a tool does to mail and tasks is in mailroom.ts.
 */
import { Agents, isTerminal } from "@xsb/protocol";
import type { Asset, Task } from "@xsb/protocol";
import type { Hub } from "./hub.ts";
import { renderAsset, renderResults } from "./prompts.ts";
import { skillBody } from "./roles.ts";
import type { LiveSession } from "./session.ts";
import { ops, topicKey } from "./state.ts";
import { now } from "./util.ts";

type Ctx = { hub: Hub; session: LiveSession };
type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(ctx: Ctx, args: any): string;
};

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
});
const str = (description: string) => ({ type: "string", description });
const TOPIC = str("Short, stable label of the matter this belongs to. Reuse the exact topic for everything on the same matter.");

const json = (value: unknown): string => JSON.stringify(value, null, 2);

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
  for (const entry of ctx.hub.state.ledger.get(ctx.session.agentId)?.values() ?? []) {
    if (entry.peers.has(peerId)) out.push(entry.topic);
  }
  return out;
}

/** Say so when a topic that has history with one peer is now sent to another. */
function continuityNote(ctx: Ctx, topic: string | undefined, to: string): string | undefined {
  if (!topic) return "No topic given. Add one next time so this can be found and continued with the same peer.";
  const peers = ctx.hub.state.ledger.get(ctx.session.agentId)?.get(topicKey(topic))?.peers;
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
  if (!task || (task.from.agentId !== me && (mustOwn || task.to.agentId !== me))) {
    throw new Error(`no task "${id}" ${mustOwn ? "dispatched by you" : "of yours"}`);
  }
  return task;
}

/**
 * Whether the task's result is promised to its dispatcher through await_tasks:
 * a gate still waits for it, or the joined results are on their way. Reading it
 * early through get_task would make the join arrive as a repeat.
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

const briefFor = (ctx: Ctx, t: Task) => {
  if (t.result === undefined || !heldForJoin(ctx, t)) return brief(t);
  const { result, ...rest } = brief(t);
  return { ...rest, result_delivery: "Held for your await_tasks: it arrives together with the others in one message. Do not act on it before then." };
};

const brief = (t: Task) => ({
  task_id: t.id,
  title: t.title,
  topic: t.topic,
  from: t.from.agentId,
  to: t.tool ? `${t.tool.server}/${t.tool.name}` : t.to.agentId,
  status: t.status,
  ...(t.after.length ? { after: t.after } : {}),
  ...(t.result !== undefined ? { result: t.result } : {}),
});

export const TOOLS: Tool[] = [
  {
    name: "list_agents",
    description: "List the other agents on the team: what each does, the asset types it has a procedure for producing, whether it is busy, and the topics you already handled with it.",
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
        }));
      return json({ you: ctx.session.agentId, agents });
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to another agent. It is queued and read as that agent's next turn. Set interject only when the peer must see it before finishing what it is doing now.",
    inputSchema: schema(
      {
        to: str("Agent id."),
        content: str("The message."),
        topic: TOPIC,
        interject: { type: "boolean", description: "Put it into the peer's running turn instead of waiting for it to end." },
      },
      ["to", "content"],
    ),
    run(ctx, args) {
      const to = peer(ctx, need(args, "to"));
      const content = need(args, "content");
      const topic: string | undefined = args.topic?.trim() || undefined;
      const steer = args.interject === true;
      const note = continuityNote(ctx, topic, to);
      const delivery = !(ctx.hub.findWorkSession(to, topic) ?? ctx.hub.mainSession(to)).busy ? "delivered" : steer ? "interjected" : "queued behind the peer's current work";
      const item = ctx.hub.mail.send(ctx.session, to, content, topic, steer);
      return json({ message_id: item.id, delivery, ...(note ? { note } : {}) });
    },
  },
  {
    name: "dispatch_task",
    description:
      "Give another agent a task. Returns immediately; the result is delivered to you later as a message. To continue only once several tasks are done, dispatch them, then call await_tasks and end your turn.",
    inputSchema: schema(
      {
        to: str("Agent id."),
        title: str("Short title."),
        instructions: str("Everything the peer needs, for it sees nothing of your conversation: the goal, what you already know or decided, the constraints, what done looks like, and what to report back."),
        topic: TOPIC,
        after: {
          type: "array",
          items: { type: "string" },
          description: "Task ids that must finish before this task starts. The peer receives their results as input.",
        },
        inputs: {
          type: "array",
          items: { type: "string" },
          description: "Ids of the assets the task works from (e.g. character/lin). The peer receives them with the task.",
        },
        produces: str("Asset type the task has to result in (e.g. shot_list). The peer must register one; you are told if it did not."),
        parallel: {
          type: "boolean",
          description:
            "The task depends on no other work you gave the same peer (another scene, say), so the peer may work on it alongside that, a few at a time. Leave it out for work that builds on other work (a shot that continues from the last frame of another): that runs one at a time.",
        },
      },
      ["to", "title", "instructions"],
    ),
    run(ctx, args) {
      const to = peer(ctx, need(args, "to"));
      const after: string[] = Array.isArray(args.after) ? args.after : [];
      for (const id of after) if (!ctx.hub.state.tasks.has(id)) throw new Error(`"after" names an unknown task: ${id}`);
      const title = need(args, "title");
      const instructions = need(args, "instructions");
      const topic: string | undefined = args.topic?.trim() || undefined;
      const inputs: string[] = Array.isArray(args.inputs) ? args.inputs : [];
      const produces: string | undefined = args.produces?.trim() || undefined;
      const note = [continuityNote(ctx, topic, to), contractNote(ctx, to, produces, inputs.map((ref) => asset(ctx, ref)))].filter(Boolean).join(" ");
      const parallel = args.parallel === true ? true : undefined;
      const task = ctx.hub.mail.dispatch(ctx.session, to, { title, topic: topic ?? title, instructions, after, inputs, produces, parallel });
      const held = task.status === "blocked";
      return json({
        task_id: task.id,
        status: held ? "held until the tasks in `after` finish" : "dispatched",
        ...(note ? { note } : {}),
      });
    },
  },
  {
    name: "await_tasks",
    description:
      "Register that you need the results of several tasks you dispatched or jobs you started before continuing, then end your turn. You receive them together in one message once all (or any) have finished; they cannot reach you while your turn is still running. Meanwhile you remain available to the user.",
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
      for (const t of tasks) {
        if (t.from.sessionId !== ctx.session.id) throw new Error(`task ${t.id} was dispatched from another session of yours`);
      }
      const note = typeof args.note === "string" ? args.note : undefined;
      const mode = args.mode === "any" ? "any" : "all";
      const { satisfied, finished } = ctx.hub.mail.join(ctx.session, tasks, mode, note);
      if (satisfied) return `Nothing to wait for, the results are in:\n${renderResults(ctx.hub.state, { taskIds: ids, mode, note })}`;
      return `Registered (${finished}/${tasks.length} finished). End your turn now; the results arrive together in one message.`;
    },
  },
  {
    name: "complete_task",
    description:
      "Finish a task you were given: the result goes to whoever dispatched it. Ending your turn does not finish a task; this does. Call it once per task, as soon as that task is done. For a task you cannot do, or that a later one replaced, set failed and say why.",
    inputSchema: schema(
      {
        task_id: str("Id of the task, from its <xsb-task>."),
        result: str("The result as its sender will read it: complete and self-contained. Say plainly what you could not do, did not finish or did not verify."),
        assets: {
          type: "array",
          items: { type: "string" },
          description: "Ids of the assets you registered for it (e.g. shot_list/scene3), the latest version unless you append @<version>. Required when the task has to produce an asset type.",
        },
        failed: { type: "boolean", description: "The task could not be done, or is no longer to be done." },
      },
      ["task_id", "result"],
    ),
    run(ctx, args) {
      const me = ctx.session.agentId;
      const id = need(args, "task_id");
      const task = ctx.hub.state.tasks.get(id);
      if (!task || task.tool || task.to.agentId !== me) throw new Error(`no task "${id}" given to you`);
      if (task.status === "cancelled") throw new Error(`task ${id} was cancelled by ${task.from.agentId}; there is no result to give`);
      if (isTerminal(task.status)) throw new Error(`task ${id} is ${task.status} already`);
      if (task.status !== "running") throw new Error(`task ${id} has not been given to you yet; it arrives as an <xsb-task>`);
      const result = need(args, "result");
      const failed = args.failed === true;
      const assets = (Array.isArray(args.assets) ? args.assets : []).map((ref: string) => asset(ctx, ref));
      for (const a of assets) if (a.by !== me) throw new Error(`asset ${a.id} was registered by ${a.by}, not by you`);
      if (!failed && task.produces && !assets.some((a: Asset) => a.type === task.produces)) {
        throw new Error(`task ${id} has to produce a "${task.produces}" asset: register it with put_asset and name it in "assets". If it cannot be done, set failed and say why.`);
      }
      ctx.hub.mail.complete(task, failed ? "failed" : "completed", result, assets);
      const open = ctx.hub.mail.openTasks(task.to.sessionId).map((t) => t.id);
      return `Task ${id} ${failed ? "finished as failed" : "completed"}; the result goes to ${task.from.agentId}.${open.length ? ` Still open: ${open.join(", ")}.` : ""}`;
    },
  },
  {
    name: "get_task",
    description: "Look up one task, or without task_id list your unfinished tasks and what you are waiting for. Do not poll with it: results are delivered to you.",
    inputSchema: schema({ task_id: str("Task id. Omit to list.") }),
    run(ctx, args) {
      if (args?.task_id) return json(briefFor(ctx, ownTask(ctx, args.task_id)));
      const me = ctx.session.agentId;
      const open = [...ctx.hub.state.tasks.values()].filter((t) => !isTerminal(t.status));
      return json({
        dispatched_by_you: open.filter((t) => t.from.agentId === me).map(brief),
        assigned_to_you: open.filter((t) => t.to.agentId === me && !t.tool).map(brief),
        awaiting: [...ctx.hub.state.gates.values()]
          .filter((g) => g.owner.agentId === me)
          .map((g) => ({ task_ids: g.taskIds, mode: g.mode, note: g.note })),
      });
    },
  },
  {
    name: "cancel_task",
    description: "Cancel a task you dispatched or a job you started. A task ends at once and its assignee is told to stop; a job is stopped. You still receive the result, with status cancelled.",
    inputSchema: schema({ task_id: str("Task id.") }, ["task_id"]),
    run(ctx, args) {
      const task = ownTask(ctx, need(args, "task_id"), true);
      if (isTerminal(task.status)) return `Task ${task.id} already ${task.status}.`;
      return ctx.hub.mail.cancel(task) === "stopping" ? `Task ${task.id} is being stopped.` : `Task ${task.id} cancelled.`;
    },
  },
  {
    name: "start_job",
    description:
      "Run one slow tool call in the background instead of waiting inside it: rendering, generation, anything that takes minutes. Returns immediately with a task id; the tool's result is delivered to you later like a task result, and can be awaited with await_tasks or stopped with cancel_task.",
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
      const task = ctx.hub.mail.startJob(ctx.session, {
        title,
        topic: args.topic?.trim() || title,
        server: need(args, "server"),
        tool: need(args, "tool"),
        arguments: args.arguments ?? {},
      });
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
    name: "ask_user",
    description:
      "Say that you are waiting for the user to decide or confirm something before the work can go on. Put the question, with its options, in your reply to the user as usual; this tool only lets the user know, wherever they are, that you are waiting for them. Call it once, then end your turn.",
    inputSchema: schema({ question: str("The question in one line, as the user will see it in a notification.") }, ["question"]),
    run(ctx, args) {
      ctx.hub.broadcast(Agents.asks, { agentId: ctx.session.agentId, question: need(args, "question") });
      return "The user has been told that you are waiting for them. End your turn now; their answer comes as a new message.";
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
      const known = ctx.hub.state.ledger.get(me)?.get(topicKey(topic))?.peers.keys() ?? [];
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
      const topics = [...(ctx.hub.state.ledger.get(me)?.values() ?? [])]
        .filter((e) => hit(e.topic, [...e.peers.keys()].join(" ")))
        .map((e) => ({
          topic: e.topic,
          handled_with: [...e.peers].map(([id, p]) => ({ agent: id, interactions: p.count, last: p.lastAt })),
        }));
      const tasks = [...ctx.hub.state.tasks.values()]
        .filter((t) => (t.from.agentId === me || t.to.agentId === me) && hit(t.topic, t.title))
        .slice(-15)
        .map(({ result, ...rest }) => brief(rest as Task));
      return json({ notes, topics, tasks });
    },
  },
];

export function callTool(ctx: Ctx, name: string, args: unknown): { text: string; isError: boolean } {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { text: `Unknown tool: ${name}`, isError: true };
  try {
    return { text: tool.run(ctx, args ?? {}), isError: false };
  } catch (e) {
    return { text: e instanceof Error ? e.message : String(e), isError: true };
  }
}
