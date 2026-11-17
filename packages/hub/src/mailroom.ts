/**
 * Mail and tasks: everything one agent's session sends to another's.
 *
 * A task is either an agent's work or a job: one tool call the hub makes for
 * the dispatcher. An agent's task is one turn, unless that turn ends waiting
 * for a join (`await_tasks`): then the task stays open, and ends with the turn
 * that receives the joined results. A message, a task and the results of tasks (one task's own, or a joined
 * set) are all mail items. An item is first recorded in the mailbox log, then handed to the
 * recipient's session as a turn (or steered into its running turn), and
 * acknowledged when that turn ends. Delivery is therefore at least once: an
 * item that was not acknowledged when the hub stopped is delivered again.
 *
 * Changes that touch several logs (a task ends: its status, the ack of its
 * mail, the gate it closes, the result it sends, the tasks it releases) are
 * one store transaction.
 */
import { Tasks, errorMessage, isTerminal, text, textOf } from "@xsb/protocol";
import type { Addr, McpServer, OriginMeta, StopReason, Task, TaskStatus } from "@xsb/protocol";
import { loadProjectConfig } from "./config.ts";
import type { Paths } from "./paths.ts";
import type { Op } from "@xsb/store";
import type { Hub } from "./hub.ts";
import { mcpRequest } from "./mcp-client.ts";
import { renderMail } from "./prompts.ts";
import type { TaskContext } from "./prompts.ts";
import { skillBody } from "./roles.ts";
import type { LiveSession, Turn } from "./session.ts";
import type { Gate, MailItem } from "./state.ts";
import { ops } from "./state.ts";
import { newId, now } from "./util.ts";

/** A job as it waits for its place, with what is needed to run it then. */
type Job = { task: Task; server: McpServer; cwd: string };

/** How many calls of one tool run at a time, unless the project says otherwise (`limits.jobsAtOnce`). */
const JOBS_AT_ONCE = 2;
const jobsAtOnce = (paths: Paths): number => loadProjectConfig(paths).limits?.jobsAtOnce ?? JOBS_AT_ONCE;

/** How long a cancelled job's tool has to call off what it started and say so, before its server is stopped. */
const JOB_CANCEL_GRACE_MS = 15_000;

/** The task a turn works on: the one its mail delivers, or one it takes up again after the user stopped it. */
export const taskOfTurn = (turn: Turn): string | undefined => turn.req.item?.taskId ?? turn.resumes;

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

  constructor(hub: Hub) {
    this.hub = hub;
  }

  // ---- sending --------------------------------------------------------------

  /** A message from one agent's session to another agent's main session. */
  send(from: LiveSession, to: string, content: string, topic: string | undefined, steer: boolean): MailItem {
    const item: MailItem = {
      id: newId("m"),
      to: { agentId: to, sessionId: this.hub.mainSession(to).id },
      from: { kind: "agent", agentId: from.agentId, sessionId: from.id },
      kind: "message",
      topic,
      content,
      steer,
      ts: now(),
    };
    this.hub.state.commit([ops.enqueue(item)]);
    this.deliver(item);
    return item;
  }

  /** Hand a task to another agent. It is held back while a task in `after` is unfinished. */
  dispatch(
    from: LiveSession,
    to: string,
    input: { title: string; topic: string; instructions: string; after: string[]; produces?: string; inputs?: string[] },
  ): Task {
    const held = input.after.some((id) => !this.finished(id));
    const task: Task = {
      id: newId("t"),
      ...input,
      from: { agentId: from.agentId, sessionId: from.id },
      to: { agentId: to, sessionId: this.hub.mainSession(to).id },
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
      tool: { server: input.server, name: input.tool, arguments: input.arguments },
      partOf: this.openTask(from.current)?.id,
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
          return abort.signal.aborted && r.isError ? ["cancelled", `Cancelled by the dispatcher. ${said}`] : [r.isError ? "failed" : "completed", said];
        },
        (e): [TaskStatus, string] =>
          abort.signal.aborted ? ["cancelled", "Cancelled by the dispatcher. The tool did not say what became of the call."] : ["failed", errorMessage(e)],
      )
      .then(([status, result]) => {
        this.jobs.delete(task.id);
        if (this.hub.stopping) return;
        this.finishTask(this.hub.state.tasks.get(task.id)!, status, result);
        const next = this.waiting.get(kind)?.shift();
        if (next) this.runJob(next);
      });
  }

  /**
   * Join: the owner wants the results of `tasks` in one message. Results that
   * arrived but were not read yet are taken back into the join. Returns whether
   * it was already satisfied: then nothing is registered and the caller hands
   * the results over itself. Otherwise `keeps` is the task the owner is working
   * on, which the join keeps open until its results are in.
   */
  join(owner: LiveSession, tasks: Task[], mode: "all" | "any", note: string | undefined): { satisfied: boolean; finished: number; keeps?: Task } {
    const ids = tasks.map((t) => t.id);
    const keeps = this.openTask(owner.current);
    const gate: Gate = {
      id: newId("g"),
      owner: { agentId: owner.agentId, sessionId: owner.id },
      taskIds: ids,
      mode,
      note,
      taskId: keeps?.id,
      createdAt: now(),
    };
    const unread = owner.withdraw((m) => m.kind === "results" && !m.results!.mode && ids.includes(m.results!.taskIds[0]));
    const acks = unread.map((m) => ops.ack(m.id));
    const finished = tasks.filter((t) => isTerminal(t.status)).length;
    const satisfied = mode === "any" ? finished > 0 : finished === tasks.length;
    // The same wait asked for again is the one already registered: a second gate would deliver the results twice.
    const same = [...this.hub.state.gates.values()].find((g) => g.owner.sessionId === owner.id && g.mode === mode && g.taskIds.length === ids.length && ids.every((id) => g.taskIds.includes(id)));
    if (same && !satisfied) {
      this.hub.state.commit(acks);
      return { satisfied, finished, keeps };
    }
    this.hub.state.commit(satisfied ? acks : [...acks, ops.openGate(gate)]);
    return { satisfied, finished, keeps: satisfied ? undefined : keeps };
  }

  /**
   * Cancel a task on behalf of its dispatcher. Returns whether it had to be
   * stopped mid-run. Either way it ends like any task: the dispatcher receives
   * its result, with status "cancelled".
   */
  cancel(task: Task): "stopping" | "cancelled" {
    if (task.tool) {
      const kind = `${task.tool.server}/${task.tool.name}`;
      const waiting = this.waiting.get(kind) ?? [];
      if (waiting.some((job) => job.task.id === task.id)) {
        this.waiting.set(kind, waiting.filter((job) => job.task.id !== task.id));
        this.finishTask(task, "cancelled", "Cancelled by the dispatcher before it started: it waited for its turn in xsb, nothing was submitted, nothing is billed.");
        return "cancelled";
      }
      this.jobs.get(task.id)?.abort();
      return "stopping";
    }
    const target = this.hub.live.get(task.to.sessionId);
    if (target?.current && taskOfTurn(target.current) === task.id) {
      target.cancel("dispatcher"); // ends as "cancelled" through `turnEnded`
      return "stopping";
    }
    // No turn is working on it: it has not run yet, it waits for a join, or the user stopped the turn it ran in.
    if (target?.resumes === task.id) target.resumes = undefined;
    const queued = target?.withdraw((m) => m.taskId === task.id) ?? [];
    const result = task.status === "running" ? "Cancelled by the dispatcher while it waited for results." : "Cancelled by the dispatcher before it ran.";
    this.finishTask(task, "cancelled", result, queued.map((m) => ops.ack(m.id)));
    return "cancelled";
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
  }

  /** What the hub adds to a task for its assignee: the assets it works from, the skill for what it produces. */
  private taskContext(item: MailItem): TaskContext | undefined {
    const task = item.kind === "task" ? this.hub.state.tasks.get(item.taskId!) : undefined;
    const agent = this.hub.state.agents.get(item.to.agentId);
    if (!task || !agent) return undefined;
    const inputs = (task.inputs ?? [])
      .map((ref) => this.hub.assets.get(ref))
      .filter((a) => a !== undefined)
      .map((asset) => ({ asset, text: this.hub.assets.text(asset) }));
    const skill = this.hub.role(agent)?.skills.find((s) => task.produces && s.produces === task.produces);
    return { inputs, skill: skill && { ...skill, body: skillBody(skill) } };
  }

  /** Hand a mail item, already recorded in the mailbox, to its recipient's session. */
  private deliver(item: MailItem): void {
    const { state } = this.hub;
    if (!state.agents.has(item.to.agentId)) {
      const task = item.kind === "task" ? state.tasks.get(item.taskId!) : undefined;
      if (task) this.finishTask(task, "failed", `Agent "${item.to.agentId}" no longer exists.`, [ops.ack(item.id)]);
      else state.commit([ops.ack(item.id)]);
      return;
    }
    const session = this.hub.live.get(item.to.sessionId) ?? this.hub.mainSession(item.to.agentId);
    const prompt = [text(renderMail(state, item, this.taskContext(item)))];
    const origin: OriginMeta = {
      ...item.from,
      messageId: item.id,
      taskId: item.results ? (item.results.mode ? undefined : item.results.taskIds[0]) : item.taskId,
      role: item.kind === "results" ? "task_result" : item.kind,
    };
    const queue = (): void => void session.enqueue({ origin, prompt, item });
    if (!item.steer || !session.current) return queue();
    session.steer(prompt, origin, "promptRequired").then(
      (answer) => {
        if (answer.outcome === "injected") state.commit([ops.ack(item.id)]);
        else queue();
      },
      (e) => {
        // The message must not be lost with the interjection: it becomes the next turn.
        this.hub.log(`steer into ${session.id} failed (${errorMessage(e)}), queued instead`);
        queue();
      },
    );
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

  /** A word from xsb to a session, as a message of its own. */
  tell(to: Addr, topic: string | undefined, content: string): void {
    const item: MailItem = { id: newId("m"), to, from: { kind: "system" }, kind: "message", topic, content, ts: now() };
    this.hub.state.commit([ops.enqueue(item)]);
    this.deliver(item);
  }

  // ---- outcomes -------------------------------------------------------------

  /** A session began the turn for a mail item. */
  turnStarted(turn: Turn): void {
    const item = turn.req.item;
    const task = item?.kind === "task" ? this.hub.state.tasks.get(item.taskId!) : undefined;
    if (task) this.saveTask({ ...task, status: "running" });
  }

  /** The task a turn works on, while that task has not ended. */
  private openTask(turn: Turn | undefined): Task | undefined {
    const id = turn && taskOfTurn(turn);
    const task = id ? this.hub.state.tasks.get(id) : undefined;
    return task && !isTerminal(task.status) ? task : undefined;
  }

  /** A turn ended: acknowledge its mail and, when it worked on a task, route the result. */
  turnEnded(session: LiveSession, turn: Turn, stopReason: StopReason, failure: unknown): void {
    const item = turn.req.item;
    const acks = item ? [ops.ack(item.id)] : [];
    const task = this.openTask(turn);
    if (task) {
      // The user stopped the turn, not the work: the task stays open for the session's next turn (session.ts).
      if (!failure && stopReason === "cancelled" && turn.cancelledBy === "user") {
        session.resumes = task.id;
        this.hub.state.commit(acks);
        return this.tell(task.from, task.topic, `The user stopped ${session.agentId}'s turn on your task "${task.title}" (${task.id}). The task stays open, and ${session.agentId} finishes it in its next turn, with what the user says. Nothing for you to do, unless you no longer need it: then cancel it.`);
      }
      const status = failure ? "failed" : stopReason === "cancelled" ? "cancelled" : "completed";
      const gates = [...this.hub.state.gates.values()];
      // Jobs the task started that nobody awaits keep it open as a join of their own would: a result is not
      // complete while what it is made of is still being generated.
      const running = [...this.hub.state.tasks.values()].filter((t) => t.partOf === task.id && !isTerminal(t.status) && !gates.some((g) => g.taskIds.includes(t.id)));
      if (status === "completed" && running.length) {
        const note = "xsb kept your task open: jobs you started for it were still running when your turn ended. Check what they made, then finish the task.";
        const gate: Gate = { id: newId("g"), owner: { agentId: session.agentId, sessionId: session.id }, taskIds: running.map((t) => t.id), mode: "all", note, taskId: task.id, createdAt: now() };
        return this.hub.state.commit([...acks, ops.openGate(gate)]);
      }
      // A join the turn left behind keeps the task open: the turn that receives the joined results ends it.
      const waits = status === "completed" && gates.some((g) => g.taskId === task.id);
      if (waits) return this.hub.state.commit(acks);
      const result = failure
        ? `The agent could not run the task: ${errorMessage(failure)}`
        : turn.lastText.trim() || `(the turn ended with "${stopReason}" and no text)`;
      this.finishTask(task, status, result, acks);
      return;
    }
    if (!item) return;
    const list = [ops.ack(item.id)];
    let notice: MailItem | undefined;
    if (failure && item.from.kind === "agent") {
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
    this.hub.state.commit(list);
    if (notice) this.deliver(notice);
  }

  private saveTask(task: Task): void {
    const saved = { ...task, updatedAt: now() };
    this.hub.state.commit([ops.putTask(saved)]);
    this.hub.broadcast(Tasks.update, { task: saved });
  }

  private finished(taskId: string, just?: Task): boolean {
    const task = taskId === just?.id ? just : this.hub.state.tasks.get(taskId);
    return !task || isTerminal(task.status);
  }

  /**
   * A task reached its end. In one transaction: record the outcome, send the
   * result to whoever dispatched it (on its own, or with the others once the
   * join that waits for it is satisfied), and release the tasks that were held
   * back until this one finished.
   *
   * A task that ends takes what it waited for with it: nobody wants those
   * results any more, so its joins swallow them, and what still runs of them
   * is cancelled, for it would only cost.
   */
  private finishTask(task: Task, status: TaskStatus, result: string, acks: Op[] = []): void {
    const { state } = this.hub;
    const done: Task = { ...task, status, result, updatedAt: now() };
    const list = [ops.putTask(done), ...acks];
    const outgoing: MailItem[] = [];
    const changed: Task[] = [done];
    const send = (item: MailItem): void => {
      list.push(ops.enqueue(item));
      outgoing.push(item);
    };

    const gate = [...state.gates.values()].find(
      (g) => g.owner.sessionId === task.from.sessionId && g.taskIds.includes(task.id),
    );
    const unwanted = gate?.taskId !== undefined && this.finished(gate.taskId);
    if (!gate) {
      const from: MailItem["from"] = task.tool ? { kind: "system" } : { kind: "agent", ...task.to };
      send({ id: newId("m"), to: task.from, from, kind: "results", topic: task.topic, results: { taskIds: [task.id] }, ts: now() });
    } else if (unwanted) {
      if (gate.taskIds.every((id) => this.finished(id, done))) list.push(ops.closeGate(gate.id));
    } else if (gate.mode === "any" || gate.taskIds.every((id) => this.finished(id, done))) {
      const { taskIds, mode, note, taskId } = gate;
      list.push(ops.closeGate(gate.id));
      send({ id: newId("m"), to: gate.owner, from: { kind: "system" }, kind: "results", results: { taskIds, mode, note }, taskId, ts: now() });
    }

    for (const held of state.tasks.values()) {
      if (held.status !== "blocked" || !held.after.includes(task.id)) continue;
      if (!held.after.every((id) => this.finished(id, done))) continue;
      const released: Task = { ...held, status: "queued", updatedAt: now() };
      list.push(ops.putTask(released));
      send(taskMail(released));
      changed.push(released);
    }

    state.commit(list);
    for (const t of changed) this.hub.broadcast(Tasks.update, { task: t });
    for (const item of outgoing) this.deliver(item);

    const awaited = [...state.gates.values()].filter((g) => g.taskId === task.id).flatMap((g) => g.taskIds);
    for (const id of new Set(awaited)) if (!this.finished(id)) this.cancel(state.tasks.get(id)!);
  }
}
