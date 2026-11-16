/**
 * Mail and tasks: everything one agent's session sends to another's.
 *
 * A task is either an agent's turn or a job: one tool call the hub makes for
 * the dispatcher. A message, a task and the results of tasks (one task's own, or a joined
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
import type { OriginMeta, StopReason, Task, TaskStatus } from "@xsb/protocol";
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
    const server = this.hub.role(agent)?.mcpServers.find((s) => s.name === input.server);
    if (!server) throw new Error(`your role has no MCP server "${input.server}"`);
    const self = { agentId: from.agentId, sessionId: from.id };
    const task: Task = {
      id: newId("t"),
      title: input.title,
      topic: input.topic,
      instructions: "",
      from: self,
      to: self,
      after: [],
      tool: { server: input.server, name: input.tool, arguments: input.arguments },
      status: "running",
      createdAt: now(),
      updatedAt: now(),
    };
    this.saveTask(task);
    const abort = new AbortController();
    this.jobs.set(task.id, abort);
    mcpRequest(server, "tools/call", { name: input.tool, arguments: input.arguments }, agent.workspace, abort.signal)
      .then(
        (r): [TaskStatus, string] => [r.isError ? "failed" : "completed", textOf(r.content ?? [])],
        (e): [TaskStatus, string] => (abort.signal.aborted ? ["cancelled", "Cancelled by the dispatcher."] : ["failed", errorMessage(e)]),
      )
      .then(([status, result]) => {
        this.jobs.delete(task.id);
        if (!this.hub.stopping) this.finishTask(this.hub.state.tasks.get(task.id)!, status, result);
      });
    return task;
  }

  /**
   * Join: the owner wants the results of `tasks` in one message. Results that
   * arrived but were not read yet are taken back into the join. Returns whether
   * it was already satisfied: then nothing is registered and the caller hands
   * the results over itself.
   */
  join(owner: LiveSession, tasks: Task[], mode: "all" | "any", note: string | undefined): { satisfied: boolean; finished: number } {
    const ids = tasks.map((t) => t.id);
    const gate: Gate = {
      id: newId("g"),
      owner: { agentId: owner.agentId, sessionId: owner.id },
      taskIds: ids,
      mode,
      note,
      createdAt: now(),
    };
    const unread = owner.withdraw((m) => m.kind === "results" && !m.results!.mode && ids.includes(m.results!.taskIds[0]));
    const acks = unread.map((m) => ops.ack(m.id));
    const finished = tasks.filter((t) => isTerminal(t.status)).length;
    const satisfied = mode === "any" ? finished > 0 : finished === tasks.length;
    this.hub.state.commit(satisfied ? acks : [...acks, ops.openGate(gate)]);
    return { satisfied, finished };
  }

  /**
   * Cancel a task on behalf of its dispatcher. Returns whether it had to be
   * stopped mid-run. Either way it ends like any task: the dispatcher receives
   * its result, with status "cancelled".
   */
  cancel(task: Task): "stopping" | "cancelled" {
    if (task.tool) {
      this.jobs.get(task.id)?.abort();
      return "stopping";
    }
    const target = this.hub.live.get(task.to.sessionId);
    if (target?.current?.req.item?.taskId === task.id) {
      target.cancel(); // ends as "cancelled" through `turnEnded`
      return "stopping";
    }
    const queued = target?.withdraw((m) => m.kind === "task" && m.taskId === task.id) ?? [];
    this.finishTask(task, "cancelled", "Cancelled by the dispatcher before it ran.", queued.map((m) => ops.ack(m.id)));
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
    const result = "xsb was quit while this was unfinished, and the user chose not to have it continued. It is cancelled; dispatch it again if it is still needed.";
    const list: Op[] = [
      ...mail.map((item) => ops.ack(item.id)),
      ...open.map((task) => ops.putTask({ ...task, status: "cancelled", result, updatedAt: now() })),
      ...[...state.gates.values()].map((gate) => ops.closeGate(gate.id)),
    ];
    if (list.length) state.commit(list);
    return { mail: mail.length, tasks: open.length };
  }

  /** Pick up what the last stop left unfinished: mail is delivered again, jobs are not run again. */
  resume(): void {
    for (const task of [...this.hub.state.tasks.values()]) {
      if (task.tool && !isTerminal(task.status)) {
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
      taskId: item.taskId ?? (item.results?.mode ? undefined : item.results?.taskIds[0]),
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

  // ---- outcomes -------------------------------------------------------------

  /** A session began the turn for a mail item. */
  turnStarted(turn: Turn): void {
    const item = turn.req.item;
    const task = item?.kind === "task" ? this.hub.state.tasks.get(item.taskId!) : undefined;
    if (task) this.saveTask({ ...task, status: "running" });
  }

  /** A turn ended: acknowledge its mail and, for a task, route the result. */
  turnEnded(session: LiveSession, turn: Turn, stopReason: StopReason, failure: unknown): void {
    const item = turn.req.item;
    if (!item) return;
    if (item.kind === "task") {
      const task = this.hub.state.tasks.get(item.taskId!)!;
      const status = failure ? "failed" : stopReason === "cancelled" ? "cancelled" : "completed";
      const result = failure
        ? `The agent could not run the task: ${errorMessage(failure)}`
        : turn.lastText.trim() || `(the turn ended with "${stopReason}" and no text)`;
      this.finishTask(task, status, result, [ops.ack(item.id)]);
      return;
    }
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
    if (!gate) {
      const from: MailItem["from"] = task.tool ? { kind: "system" } : { kind: "agent", ...task.to };
      send({ id: newId("m"), to: task.from, from, kind: "results", topic: task.topic, results: { taskIds: [task.id] }, ts: now() });
    } else if (gate.mode === "any" || gate.taskIds.every((id) => this.finished(id, done))) {
      const { taskIds, mode, note } = gate;
      list.push(ops.closeGate(gate.id));
      send({ id: newId("m"), to: gate.owner, from: { kind: "system" }, kind: "results", results: { taskIds, mode, note }, ts: now() });
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
  }
}
