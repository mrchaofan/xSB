/**
 * Mail and tasks: everything one agent's session sends to another's.
 *
 * A task is either an agent's work or a job: one tool call the hub makes for
 * the dispatcher. A job ends when its call does. An agent's task is not tied to
 * a turn: the assignee works on the tasks it has, as many as it was given and in
 * as many turns as it needs, and ends each with `complete_task`. Which turn
 * serves which task is the model's judgement; the hub keeps the list, checks
 * what a task has to deliver when it is finished, and when a session's turn
 * ends with tasks open and nothing on the way that would wake it, reminds it
 * once and then tells the dispatchers.
 *
 * A message, a task and the results of tasks (one task's own, or a joined
 * set) are all mail items. An item is first recorded in the mailbox log, then handed to the
 * recipient's session as a turn, or put into its running turn when it comes
 * from whoever gave that session the work it has open (`interjects`), and
 * acknowledged when that turn ends. Delivery is therefore at least once: an item that was not acknowledged
 * when the hub stopped is delivered again.
 *
 * Changes that touch several logs (a task ends: its status, the ack of its
 * mail, the gate it closes, the result it sends, the tasks it releases) are
 * one store transaction.
 */
import { Tasks, errorMessage, isTerminal, text, textOf } from "@xsb/protocol";
import type { Addr, Asset, McpServer, OriginMeta, StopReason, Task, TaskStatus } from "@xsb/protocol";
import { loadProjectConfig } from "./config.ts";
import type { Paths } from "./paths.ts";
import type { Op } from "@xsb/store";
import type { Hub } from "./hub.ts";
import { mcpRequest } from "./mcp-client.ts";
import { renderMail, taskReminder } from "./prompts.ts";
import type { TaskContext } from "./prompts.ts";
import { skillBody } from "./roles.ts";
import type { LiveSession, Turn } from "./session.ts";
import type { Gate, MailItem } from "./state.ts";
import { ops } from "./state.ts";
import { doom, releasable } from "./task-graph.ts";
import { newId, now } from "./util.ts";

/** How a task ends, as `finish` records it. `quiet`: whoever dispatched it knows already, and is sent nothing of it. */
type End = { task: Task; status: TaskStatus; result: string; quiet?: boolean };

/** A job as it waits for its place, with what is needed to run it then. */
type Job = { task: Task; server: McpServer; cwd: string };

/** How many calls of one tool run at a time, unless the project says otherwise (`limits.jobsAtOnce`). */
const JOBS_AT_ONCE = 2;
const jobsAtOnce = (paths: Paths): number => loadProjectConfig(paths).limits?.jobsAtOnce ?? JOBS_AT_ONCE;

/** How long a cancelled job's tool has to call off what it started and say so, before its server is stopped. */
const JOB_CANCEL_GRACE_MS = 15_000;

function taskMail(task: Task): MailItem {
  return {
    id: newId("m"),
    to: task.to,
    from: { kind: "agent", ...task.from },
    kind: "task",
    topic: task.topic,
    taskId: task.id,
    ts: now(),
  };
}

export class Mailroom {
  private hub: Hub;
  /** Task id -> how to stop the job that runs for it. */
  private jobs = new Map<string, AbortController>();
  /** Jobs that wait for a place, per tool (`server/tool`), in the order they were started. */
  private waiting = new Map<string, Job[]>();
  /**
   * Open tasks whose session ended a turn without them and with nothing on the way: 1 once the session was
   * reminded, 2 once their dispatchers were told. Forgotten when the task moves again, and on a restart.
   */
  private stalls = new Map<string, 1 | 2>();
  /** Jobs being called off whose dispatcher was told otherwise (`stopTree`): their end sends it nothing. */
  private quietJobs = new Set<string>();

  constructor(hub: Hub) {
    this.hub = hub;
  }

  // ---- sending --------------------------------------------------------------

  /**
   * A message from one agent's session to another agent: to its work session of the topic, or else its main session.
   * How it is delivered is the hub's to decide (`interjects`); the sender is told which.
   */
  send(from: LiveSession, to: string, content: string, topic: string | undefined): { item: MailItem; delivery: "delivered" | "interjected" | "queued" } {
    const session = this.hub.findWorkSession(to, topic) ?? this.hub.mainSession(to);
    const item: MailItem = {
      id: newId("m"),
      to: { agentId: to, sessionId: session.id },
      from: { kind: "agent", agentId: from.agentId, sessionId: from.id },
      kind: "message",
      topic,
      content,
      ts: now(),
    };
    const busy = session.busy;
    this.hub.state.commit([ops.enqueue(item)]);
    const how = this.deliver(item);
    return { item, delivery: how === "steer" ? "interjected" : busy ? "queued" : "delivered" };
  }

  /**
   * What work the session starts now is for: the tasks it was handed and has not finished (task-graph.ts). Which of
   * them, if several, is not guessed; the work goes on as long as one of them does.
   */
  private parentsOf(session: LiveSession): { parents?: string[] } {
    const ids = this.openTasks(session.id).map((t) => t.id);
    return ids.length ? { parents: ids } : {};
  }

  /** Hand a task to another agent. It is held back while a task in `after` is unfinished. */
  dispatch(
    from: LiveSession,
    to: string,
    input: { title: string; topic: string; instructions: string; after: string[]; produces?: string; inputs?: string[]; parallel?: boolean },
  ): Task {
    const held = input.after.some((id) => !this.finished(id));
    const task: Task = {
      id: newId("t"),
      ...input,
      ...this.parentsOf(from),
      from: { agentId: from.agentId, sessionId: from.id },
      // A peer's work goes to the agent's work session of its topic (Hub.workSession).
      to: { agentId: to, sessionId: this.hub.workSession(to, input.topic).id },
      status: held ? "blocked" : "queued",
      createdAt: now(),
      updatedAt: now(),
    };
    if (held) {
      this.saveTask(task);
    } else {
      const item = taskMail(task);
      this.hub.state.commit([ops.putTask(task), ops.enqueue(item)]);
      this.hub.broadcast(Tasks.update, { task });
      this.deliver(item);
    }
    return task;
  }

  /**
   * A job: one call of a tool of the dispatcher's own MCP servers, run by the
   * hub so that the dispatcher does not sit in the call. It is a task in every
   * other respect: its result comes back as mail, and it can be joined and
   * cancelled. A job the hub did not see the end of is not run again (it may
   * have cost money already); it fails, and the dispatcher decides.
   */
  startJob(from: LiveSession, input: { title: string; topic: string; server: string; tool: string; arguments: unknown }): Task {
    const agent = this.hub.agent(from.agentId);
    const server = this.hub.toolServers(agent).find((t) => t.from === "role" && t.server.name === input.server)?.server;
    if (!server) throw new Error(`your role has no MCP server "${input.server}"`);
    const self = { agentId: from.agentId, sessionId: from.id };
    const kind = `${input.server}/${input.tool}`;
    const running = [...this.hub.state.tasks.values()].filter((t) => t.tool && `${t.tool.server}/${t.tool.name}` === kind && t.status === "running").length;
    const waits = running >= jobsAtOnce(this.hub.paths);
    const task: Task = {
      id: newId("t"),
      title: input.title,
      topic: input.topic,
      instructions: "",
      from: self,
      to: self,
      after: [],
      ...this.parentsOf(from),
      tool: { server: input.server, name: input.tool, arguments: input.arguments },
      status: waits ? "queued" : "running",
      createdAt: now(),
      updatedAt: now(),
    };
    this.saveTask(task);
    const job = { task, server, cwd: agent.workspace };
    if (waits) this.waiting.set(kind, [...(this.waiting.get(kind) ?? []), job]);
    else this.runJob(job);
    return task;
  }

  /**
   * Run a job's tool call. When it ends, the next job of the same tool that waits gets its place: at most
   * `jobsAtOnce` calls of one tool run at a time, so that a halt called by the user finds the rest still waiting
   * here, where cancelling one is certain to cost nothing.
   */
  private runJob({ task, server, cwd }: Job): void {
    const kind = `${task.tool!.server}/${task.tool!.name}`;
    if (task.status !== "running") this.saveTask((task = { ...task, status: "running" }));
    const abort = new AbortController();
    this.jobs.set(task.id, abort);
    mcpRequest(server, "tools/call", { name: task.tool!.name, arguments: task.tool!.arguments }, cwd, abort.signal, JOB_CANCEL_GRACE_MS)
      .then(
        // A cancelled call is still answered: what the tool says became of it is the result. One that finished all the same did finish.
        (r): [TaskStatus, string] => {
          const said = textOf(r.content ?? []);
          return abort.signal.aborted && r.isError ? ["cancelled", `${abort.signal.reason} ${said}`] : [r.isError ? "failed" : "completed", said];
        },
        (e): [TaskStatus, string] =>
          abort.signal.aborted ? ["cancelled", `${abort.signal.reason} The tool did not say what became of the call.`] : ["failed", errorMessage(e)],
      )
      .then(([status, result]) => {
        this.jobs.delete(task.id);
        if (this.hub.stopping) return;
        const quiet = this.quietJobs.delete(task.id) && status === "cancelled";
        this.finish([{ task: this.hub.state.tasks.get(task.id)!, status, result, quiet }]);
        const next = this.waiting.get(kind)?.shift();
        if (next) this.runJob(next);
      });
  }

  /**
   * Join: the owner wants the results of `tasks` in one message. Results that
   * arrived but were not read yet are taken back into the join. Returns whether
   * it was already satisfied: then nothing is registered and the caller hands
   * the results over itself.
   */
  join(owner: LiveSession, tasks: Task[], mode: "all" | "any", note: string | undefined): { satisfied: boolean; finished: number } {
    const ids = tasks.map((t) => t.id);
    const gate: Gate = { id: newId("g"), owner: { agentId: owner.agentId, sessionId: owner.id }, taskIds: ids, mode, note, createdAt: now() };
    const unread = owner.withdraw((m) => m.kind === "results" && !m.results!.mode && ids.includes(m.results!.taskIds[0]));
    const acks = unread.map((m) => ops.ack(m.id));
    const finished = tasks.filter((t) => isTerminal(t.status)).length;
    const satisfied = mode === "any" ? finished > 0 : finished === tasks.length;
    // The same wait asked for again is the one already registered: a second gate would deliver the results twice.
    const same = [...this.hub.state.gates.values()].find((g) => g.owner.sessionId === owner.id && g.mode === mode && g.taskIds.length === ids.length && ids.every((id) => g.taskIds.includes(id)));
    this.hub.state.commit(satisfied || same ? acks : [...acks, ops.openGate(gate)]);
    return { satisfied, finished };
  }

  /** Cancel a task on behalf of `by`, a session of its dispatcher's (`stopTree`). */
  cancel(task: Task, by: Addr): { stopping: boolean; with: Task[] } {
    return this.stopTree(task, { status: "cancelled", result: "Cancelled by the dispatcher.", cause: `${by.agentId} cancelled` }, by.sessionId);
  }

  /**
   * Stop `root`, and with it what nothing else holds up (task-graph.ts, `doom`), in one transaction
   * (docs/TASK-GRAPH.md, 4.1). `root` ends as `end` says; the rest are cancelled, saying what they went with.
   *
   * Told, once each: every session handed one of them, with what it started that went too and what did not; then the
   * dispatcher of each, unless that is the `stopper` (it knows) or a session told just now. An agent's task ends at
   * once: the hub does not stop the assignee's turn, which may serve other work too, but tells it, and it stops
   * itself. A job that waits for its place ends at once; one that runs is called off, and ends when its tool has
   * (`stopping`, of the root).
   */
  private stopTree(root: Task, end: { status: TaskStatus; result: string; cause: string }, stopper?: string, acks: Op[] = []): { stopping: boolean; with: Task[] } {
    const { doomed, spared } = doom(this.hub.state, root);
    const list = (tasks: Task[]): string => tasks.map((t) => `\n- ${t.tool ? `the job "${t.title}"` : `"${t.title}" to ${t.to.agentId}`} (${t.id})`).join("");
    const notices: MailItem[] = [];
    for (const sessionId of new Set(doomed.filter((t) => !t.tool && t.status === "running").map((t) => t.to.sessionId))) {
      const own = doomed.filter((t) => !t.tool && t.status === "running" && t.to.sessionId === sessionId);
      const went = doomed.filter((t) => t.from.sessionId === sessionId);
      const kept = spared.filter((t) => t.from.sessionId === sessionId);
      const lines = own.flatMap((t) => {
        if (t !== root) return [`The task "${t.title}" (${t.id}) that ${t.from.agentId} gave you is cancelled with "${root.title}" (${root.id}), which ${end.cause}. Stop working on it; there is no result to give.`];
        if (end.status === "cancelled") return [`${end.cause} the task "${t.title}" (${t.id}). Stop working on it; there is no result to give.`];
        return went.length || kept.length ? [`Your task "${t.title}" (${t.id}) ended as ${end.status}: ${end.result}`] : [];
      });
      if (!lines.length) continue;
      if (went.length) lines.push(`xsb cancelled with it what you started for it:${list(went)}\nCancel anything else you started only for it.`);
      else lines.push("Cancel the tasks and jobs you started only for it.");
      if (kept.length) lines.push(`Not cancelled, for it is also for other work of yours that goes on:${list(kept)}`);
      lines.push("Your other tasks go on.");
      const to = { agentId: own[0].to.agentId, sessionId };
      // Put into the running turn where that does not interrupt it (`interjects`); otherwise it is read next.
      notices.push({ id: newId("m"), to, from: { kind: "system" }, kind: "message", topic: own[0].topic, content: lines.join(" "), steer: true, ts: now() });
    }
    const told = new Set(notices.map((n) => n.to.sessionId));
    const ends: End[] = [];
    let stopping = false;
    for (const task of doomed) {
      const quiet = task.from.sessionId === stopper || told.has(task.from.sessionId);
      const why = task === root ? end.result : `Cancelled with "${root.title}" (${root.id}), which ${end.cause}.`;
      const status = task === root ? end.status : "cancelled";
      this.stalls.delete(task.id);
      if (task.tool) {
        const kind = `${task.tool.server}/${task.tool.name}`;
        const waiting = this.waiting.get(kind) ?? [];
        if (waiting.some((job) => job.task.id === task.id)) {
          this.waiting.set(kind, waiting.filter((job) => job.task.id !== task.id));
          ends.push({ task, status, quiet, result: `${why} It had not started: it waited for its turn in xsb, nothing was submitted, nothing is billed.` });
        } else {
          if (quiet) this.quietJobs.add(task.id);
          this.jobs.get(task.id)?.abort(why);
          stopping ||= task === root;
        }
        continue;
      }
      const queued = this.hub.live.get(task.to.sessionId)?.withdraw((m) => m.taskId === task.id) ?? [];
      acks.push(...queued.map((m) => ops.ack(m.id)));
      const handed = task.status === "running";
      const more = status === "failed" ? "" : handed ? ` ${task.to.agentId} had it, and is told to stop working on it.` : " It had not been handed over.";
      ends.push({ task, status, quiet, result: `${why}${more}` });
    }
    this.finish(ends, acks, notices);
    return { stopping, with: doomed.slice(1) };
  }

  /**
   * The assignee finished a task: its result goes to the dispatcher like any task's. `assets` are what it named as
   * delivered; whether they are what the task had to deliver is checked by the caller (tools.ts).
   */
  complete(task: Task, status: "completed" | "failed", result: string, assets: Asset[]): void {
    this.stalls.delete(task.id);
    this.finish([{ task: { ...task, ...(assets.length ? { assets: assets.map((a) => `${a.id}@${a.version}`) } : {}) }, status, result }]);
  }

  /** The agent tasks a session was handed and has not finished. */
  openTasks(sessionId: string): Task[] {
    return [...this.hub.state.tasks.values()].filter((t) => !t.tool && t.to.sessionId === sessionId && t.status === "running");
  }

  // ---- delivery -------------------------------------------------------------

  /**
   * Give up what the last stop left unfinished, instead of picking it up: the user quit in the middle of it
   * and does not want it to go on by itself. Nothing is delivered again, so nothing runs. A task that had not
   * ended is cancelled; its dispatcher is not sent the result, which would be a turn too, and finds it with get_task.
   */
  abandon(): { mail: number; tasks: number } {
    const { state } = this.hub;
    const mail = [...state.mail.values()];
    const open = [...state.tasks.values()].filter((task) => !isTerminal(task.status));
    const result = "xsb was quit while this was unfinished, and the user chose not to have it continued. It is interrupted; dispatch it again if it is still needed.";
    const list: Op[] = [
      ...mail.map((item) => ops.ack(item.id)),
      ...open.map((task) => ops.putTask({ ...task, status: "interrupted", result, updatedAt: now() })),
      ...[...state.gates.values()].map((gate) => ops.closeGate(gate.id)),
    ];
    if (list.length) state.commit(list);
    // Each dispatcher, and each sender of mail that was dropped, is told on its next turn, not now: a turn now would
    // set to work what the user chose to stop. A later restart before that turn forgets it; the statuses remain.
    const told = new Map<string, string[]>();
    const add = (sessionId: string, line: string): void => void told.set(sessionId, [...(told.get(sessionId) ?? []), line]);
    for (const task of open) add(task.from.sessionId, `- the task "${task.title}" (${task.id})${task.tool ? "" : ` to ${task.to.agentId}`}: interrupted`);
    for (const item of mail) {
      if (item.from.kind === "agent" && item.kind !== "results") add(item.from.sessionId, `- your ${item.kind} to ${item.to.agentId}${item.topic ? ` on "${item.topic}"` : ""}: not delivered`);
    }
    for (const [sessionId, lines] of told) {
      this.hub.live.get(sessionId)?.preface(`[xsb] xsb was quit while work of yours was unfinished, and the user chose not to have it continued:\n${lines.join("\n")}\nWhat you were awaiting will not arrive. Dispatch again only what is still needed, and say so to the user.`);
    }
    return { mail: mail.length, tasks: open.length };
  }

  /** Pick up what the last stop left unfinished: mail is delivered again, jobs are not run again. */
  resume(): void {
    for (const task of [...this.hub.state.tasks.values()]) {
      if (task.tool && task.status === "queued") {
        this.finishTask(task, "failed", "xsb stopped while this job waited for its turn. It had not started, so nothing was billed; start it again if it is still needed.");
      } else if (task.tool && !isTerminal(task.status)) {
        this.finishTask(task, "failed", "xsb stopped while this job ran, so its outcome is unknown. It was not run again; start it again if it is still needed.");
      }
    }
    for (const item of [...this.hub.state.mail.values()]) this.deliver(item);
    // A task handed into a turn that the stop cut short has no mail left to bring it back: the session is reminded.
    for (const session of this.hub.live.values()) this.checkStalled(session, "");
  }

  /**
   * What the hub adds to a task for its assignee: the assets it works from, the skill for what it produces. Of an
   * input the session was given another version of, that version's text too, to tell what changed.
   */
  private taskContext(item: MailItem, session: LiveSession): TaskContext | undefined {
    const task = item.kind === "task" ? this.hub.state.tasks.get(item.taskId!) : undefined;
    const agent = this.hub.state.agents.get(item.to.agentId);
    if (!task || !agent) return undefined;
    const inputs = (task.inputs ?? [])
      .map((ref) => this.hub.assets.get(ref))
      .filter((a) => a !== undefined)
      .map((asset) => {
        const had = session.given.assets.get(asset.id);
        const earlier = had && had.version !== asset.version ? this.hub.assets.get(`${asset.id}@${had.version}`) : undefined;
        return { asset, text: this.hub.assets.text(asset), ...(earlier ? { before: { version: earlier.version, text: this.hub.assets.text(earlier) } } : {}) };
      });
    const skill = this.hub.role(agent)?.skills.find((s) => task.produces && s.produces === task.produces);
    return { inputs, skill: skill && { ...skill, body: skillBody(skill) } };
  }

  /**
   * Whether mail goes into the recipient's running turn instead of waiting for the next one. It does when it comes
   * from whoever gave that session work it has open, or is xsb's word on such work (`steer`), and the turn takes it
   * without being interrupted; with a backend that would have to be, it waits like the rest. Anything else waits,
   * unseen, until the turn ends. Results never go in: await_tasks promises them as a turn of their own.
   */
  private interjects(item: MailItem, session: LiveSession): boolean {
    if (!session.steersNatively || item.kind === "results") return false;
    if (item.steer) return true;
    const sender = item.from.kind === "agent" ? item.from.agentId : undefined;
    return !!sender && this.openTasks(session.id).some((t) => t.from.agentId === sender);
  }

  /** Hand a mail item, already recorded in the mailbox, to its recipient's session: into its running turn (`steer`), or as a turn of its own. */
  private deliver(item: MailItem): "steer" | "queue" | "dropped" {
    const { state } = this.hub;
    if (!state.agents.has(item.to.agentId)) {
      const task = item.kind === "task" ? state.tasks.get(item.taskId!) : undefined;
      if (task) this.finishTask(task, "failed", `Agent "${item.to.agentId}" no longer exists.`, [ops.ack(item.id)]);
      else state.commit([ops.ack(item.id)]);
      return "dropped";
    }
    const session = this.hub.live.get(item.to.sessionId) ?? this.hub.mainSession(item.to.agentId);
    const { text: said, gives } = renderMail(state, item, this.taskContext(item, session), session.given);
    const prompt = [text(said)];
    const origin: OriginMeta = {
      ...item.from,
      messageId: item.id,
      taskId: item.results ? (item.results.mode ? undefined : item.results.taskIds[0]) : item.taskId,
      role: item.kind === "results" ? "task_result" : item.kind,
    };
    const queue = (): void => void session.enqueue({ origin, prompt, item, gives });
    if (!this.interjects(item, session)) {
      queue();
      return "queue";
    }
    session.steer(prompt, origin, "promptRequired").then(
      (answer) => {
        if (answer.outcome === "injected") {
          session.take(gives);
          state.commit([ops.ack(item.id)]);
          this.handed(item);
        }
        else queue();
      },
      (e) => {
        // The message must not be lost with the interjection: it becomes the next turn.
        this.hub.log(`steer into ${session.id} failed (${errorMessage(e)}), queued instead`);
        queue();
      },
    );
    return "steer";
  }

  /** How long what the user writes to one agent is gathered before its dispatchers are told, in one message. */
  ccDelayMs = 20_000;
  private ccs = new Map<string, { to: Addr; agentId: string; topic: string; titles: Set<string>; said: string[]; timer: NodeJS.Timeout }>();

  /**
   * The user wrote to an agent directly, past whoever gave it the work it has open: tell them, so that two people
   * do not steer the same work apart. Only who the tasks came from is asked, not which role anyone has.
   */
  userWrote(agentId: string, text: string): void {
    const open = [...this.hub.state.tasks.values()].filter((t) => !t.tool && t.to.agentId === agentId && t.from.agentId !== agentId && !isTerminal(t.status));
    const line = text.trim().replace(/\s+/g, " ");
    if (!line) return;
    for (const task of open) {
      const key = `${task.from.sessionId}|${agentId}`;
      let cc = this.ccs.get(key);
      if (!cc) {
        const timer = setTimeout(() => {
          this.ccs.delete(key);
          if (this.hub.stopping) return;
          const quoted = cc!.said.map((s) => `"${s.length > 300 ? `${s.slice(0, 300)}…` : s}"`).join("\n");
          this.tell(cc!.to, cc!.topic, `The user wrote directly to ${agentId}, which works on your task ${[...cc!.titles].map((t) => `"${t}"`).join(", ")}:\n${quoted}\nIf this changes what you decided, settle it with the user and ${agentId}; otherwise nothing for you to do.`);
        }, this.ccDelayMs);
        cc = { to: task.from, agentId, topic: task.topic, titles: new Set(), said: [], timer };
        this.ccs.set(key, cc);
      }
      cc.titles.add(task.title);
      if (!cc.said.includes(line)) cc.said.push(line);
    }
  }

  /** A word from xsb to a session, as a message of its own, or put into its running turn (`steer`). */
  tell(to: Addr, topic: string | undefined, content: string, steer = false): void {
    const item: MailItem = { id: newId("m"), to, from: { kind: "system" }, kind: "message", topic, content, ...(steer ? { steer } : {}), ts: now() };
    this.hub.state.commit([ops.enqueue(item)]);
    this.deliver(item);
  }

  // ---- outcomes -------------------------------------------------------------

  /** A session began the turn for a mail item. */
  turnStarted(turn: Turn): void {
    if (turn.req.item) this.handed(turn.req.item);
  }

  /** The model has been given a task: it is its to work on now. */
  private handed(item: MailItem): void {
    const task = item.kind === "task" ? this.hub.state.tasks.get(item.taskId!) : undefined;
    if (task?.status === "queued") this.saveTask({ ...task, status: "running" });
  }

  /** A turn ended: acknowledge its mail, and see whether the session left work open with nothing to bring it back. */
  turnEnded(session: LiveSession, turn: Turn, stopReason: StopReason, failure: unknown): void {
    const item = turn.req.item;
    const task = item?.kind === "task" ? this.hub.state.tasks.get(item.taskId!) : undefined;
    if (failure && task && !isTerminal(task.status)) {
      const result = `The agent could not run the task: ${errorMessage(failure)}`;
      this.stopTree(task, { status: "failed", result, cause: "failed" }, undefined, [ops.ack(item!.id)]);
      return;
    }
    const list: Op[] = item ? [ops.ack(item.id)] : [];
    let notice: MailItem | undefined;
    if (failure && item && item.kind !== "task" && item.from.kind === "agent") {
      // The sender believes the message arrived; tell it otherwise.
      notice = {
        id: newId("m"),
        to: { agentId: item.from.agentId, sessionId: item.from.sessionId },
        from: { kind: "system" },
        kind: "message",
        topic: item.topic,
        content: `Your message ${item.id} to "${session.agentId}" was not processed: ${errorMessage(failure)}`,
        ts: now(),
      };
      list.push(ops.enqueue(notice));
    }
    if (list.length) this.hub.state.commit(list);
    if (notice) this.deliver(notice);
    if (failure) return;
    // The user stopped the turn, not the work: the tasks stay open, and the session is not reminded of them.
    if (stopReason === "cancelled" && turn.cancelledBy === "user") {
      for (const open of this.openTasks(session.id)) {
        this.tell(open.from, open.topic, `The user stopped ${session.agentId}'s turn while it had your task "${open.title}" (${open.id}). The task stays open, and ${session.agentId} goes on with it after hearing from the user. Nothing for you to do, unless you no longer need it: then cancel it.`);
      }
      return;
    }
    this.checkStalled(session, turn.lastText);
  }

  /**
   * Whether the session has open tasks that nothing will bring back: no mail and no turn of the user's waits for it,
   * no join of its own is open, no job it started is still running. Then it is reminded of them once, as a turn;
   * should that turn too end with them so, their dispatchers are told, with what the session said last, and decide.
   * Nothing is ended for the session: it may wait for something the hub does not see, like the user's answer.
   */
  private checkStalled(session: LiveSession, said: string): void {
    const { state } = this.hub;
    const open = this.openTasks(session.id);
    const woken =
      session.busy ||
      [...state.mail.values()].some((m) => m.to.sessionId === session.id) ||
      [...state.gates.values()].some((g) => g.owner.sessionId === session.id) ||
      [...state.tasks.values()].some((t) => t.tool && t.from.sessionId === session.id && !isTerminal(t.status));
    if (woken) {
      for (const t of open) this.stalls.delete(t.id);
      return;
    }
    const first = open.filter((t) => !this.stalls.has(t.id));
    const again = open.filter((t) => this.stalls.get(t.id) === 1);
    for (const t of first) this.stalls.set(t.id, 1);
    for (const t of again) this.stalls.set(t.id, 2);
    const quoted = said.trim() ? `It said last:\n"${said.trim().length > 600 ? `${said.trim().slice(0, 600)}…` : said.trim()}"\n` : "";
    for (const t of again) {
      this.tell(t.from, t.topic, `${session.agentId} ended its turn without finishing your task "${t.title}" (${t.id}), also after xsb reminded it. ${quoted}The task stays open. Wait for it, write to ${session.agentId}, or cancel the task.`);
    }
    if (first.length) this.tell({ agentId: session.agentId, sessionId: session.id }, first[0].topic, taskReminder(open));
  }

  private saveTask(task: Task): void {
    const saved = { ...task, updatedAt: now() };
    this.hub.state.commit([ops.putTask(saved)]);
    this.hub.broadcast(Tasks.update, { task: saved });
  }

  private finished(taskId: string): boolean {
    const task = this.hub.state.tasks.get(taskId);
    return !task || isTerminal(task.status);
  }

  /** One task reached its end (`finish`). */
  private finishTask(task: Task, status: TaskStatus, result: string, acks: Op[] = []): void {
    this.finish([{ task, status, result }], acks);
  }

  /**
   * Tasks reached their end. In one transaction: record each outcome, send each result to whoever dispatched the
   * task (on its own, or with the others once the join that waits for it is satisfied), release the tasks that were
   * held back until these finished (task-graph.ts, `releasable`), and send `notices`. A `quiet` end sends nothing of
   * its own: the join that waits for it waits for the rest only.
   */
  private finish(ends: End[], acks: Op[] = [], notices: MailItem[] = []): void {
    const { state } = this.hub;
    const ended = new Set(ends.map((e) => e.task.id));
    const done = (id: string): boolean => ended.has(id) || this.finished(id);
    const list: Op[] = [...acks];
    const outgoing: MailItem[] = [];
    const changed: Task[] = [];
    const send = (item: MailItem): void => {
      list.push(ops.enqueue(item));
      outgoing.push(item);
    };

    // The joins as they are after this; and the tasks whose result goes out with a join that closes here.
    const gates = new Map(state.gates);
    const joined = new Set<string>();
    for (const { task, status, result, quiet } of ends) {
      const finished: Task = { ...task, status, result, updatedAt: now() };
      list.push(ops.putTask(finished));
      changed.push(finished);
      if (joined.has(task.id)) continue;
      const gate = [...gates.values()].find((g) => g.owner.sessionId === task.from.sessionId && g.taskIds.includes(task.id));
      if (!gate) {
        const from: MailItem["from"] = task.tool ? { kind: "system" } : { kind: "agent", ...task.to };
        if (!quiet) send({ id: newId("m"), to: task.from, from, kind: "results", topic: task.topic, results: { taskIds: [task.id] }, ts: now() });
        continue;
      }
      const waits = quiet ? { ...gate, taskIds: gate.taskIds.filter((id) => id !== task.id) } : gate;
      if (!waits.taskIds.length) {
        gates.delete(gate.id);
        list.push(ops.closeGate(gate.id));
      } else if (waits.mode === "any" ? waits.taskIds.some(done) : waits.taskIds.every(done)) {
        gates.delete(gate.id);
        list.push(ops.closeGate(gate.id));
        for (const id of waits.taskIds) joined.add(id);
        const { taskIds, mode, note } = waits;
        send({ id: newId("m"), to: gate.owner, from: { kind: "system" }, kind: "results", results: { taskIds, mode, note }, ts: now() });
      } else if (quiet) {
        gates.set(gate.id, waits);
        list.push(ops.openGate(waits));
      }
    }

    for (const held of releasable(state, ended)) {
      const released: Task = { ...held, status: "queued", updatedAt: now() };
      list.push(ops.putTask(released));
      send(taskMail(released));
      changed.push(released);
    }
    for (const notice of notices) send(notice);

    state.commit(list);
    for (const t of changed) this.hub.broadcast(Tasks.update, { task: t });
    for (const item of outgoing) this.deliver(item);
  }
}
