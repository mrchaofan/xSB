/**
 * The kernel: tasks and their graph, the inboxes, the ledger. It knows principals, tasks, messages and events, and
 * nothing of ACP, sessions, backends or clients: it can run, and be tested, without any of them.
 *
 * It decides what happens; what is to be done because of it is for the hooks (hooks.ts) and the effectors
 * registered on them (delivery.ts, jobs.ts). Its own policies are hooks too, registered first (`policies`):
 *
 *   task.pre_create         is the task acceptable                       `after` names known tasks
 *   task.pre_stop           may this principal stop this task            its initiator, the user, or xsb
 *   task.pre_complete       does the task end with this turn's result    complete by default
 *   cascade.pre_propagate   does work held up by others go too           no ("spare")
 *   message.pre_deliver     how a message in an inbox reaches its session  `deliveryPolicy`
 *
 * One communication primitive: everything that passes between principals (a task, a message, a result, a notice)
 * is a message, written to its recipient's inbox, which is where it counts as delivered, and then routed by the one
 * pipeline (`route`). Whether that calls the recipient's backend at all is the route's business.
 *
 * Every task has a beginning (its initiator: the user, or an agent) and an end (`Task.ended`: why, and who ended it).
 * A task ends by default when its executor's turn does (`turnEnded`: the turn's last message is the result), or
 * when its executor reports it, or when it is stopped. All ends go through `finish`, one transaction: the outcome,
 * the notification of the initiator (NotificationHook; not when the initiator ended it itself), the joins it
 * settles, the tasks it releases. Done and stopped differ only in what the end says.
 */
import { isTerminal, textOf } from "@xsb/protocol";
import type { Addr, ExecutionSource, BackendRun, ContentBlock, DeliveryPref, EndReason, LedgerEntry, LedgerState, Origin, Principal, SessionUpdate, StopReason, Task, TaskStatus } from "@xsb/protocol";
import type { Op } from "@xsb/store";
import type { Hooks, Veto } from "./hooks.ts";
import { isVeto } from "./hooks.ts";
import { ledgerHook } from "./ledger.ts";
import { abandonNotice, contractReminder, endNotice } from "./prompts.ts";
import type { Gate, MailItem, State } from "./state.ts";
import { ops } from "./state.ts";
import { Paths } from "./paths.ts";
import { doom, doomMany, releasable } from "./task-graph.ts";
import { newId, now } from "./util.ts";

/**
 * How a message reaches its session. `return`: as what a tool call that waits for it returns. `turn`: as a turn of
 * its own, now or after the running one. `interject`: into the running turn. `inbox`: it stays in the inbox and comes
 * with the session's next turn. `drop`: it cannot be delivered.
 */
export type Route = "return" | "turn" | "interject" | "inbox" | "drop";

/** What the kernel is to know of a session to route to it. The effectors that run sessions answer (delivery.ts). */
export type Recipient = {
  source?: ExecutionSource;
  /** Its agent exists. */
  exists: boolean;
  /** It works on something, or has something waiting to run. */
  busy: boolean;
  /** A tool call of its running turn waits for the end of this task. */
  awaits(taskId: string): boolean;
  turn?: { id: string; protected: boolean; taskIds: string[] };
  protect?(): void;
  prioritize?(taskId: string, turnId: string): void;
};

export type Delivery = { to: Addr; from: Origin; item: MailItem; route?: Route };
/** What a session is to be given for a message: may be rewritten, or vetoed (then it is not delivered). */
export type Submission = { to: Addr; from: Origin; item: MailItem; prompt: ContentBlock[] };
/** A task its executor's turn ended with: `verdict` says whether that ends it, and how. */
export type Completion = { task: Task; result: string; verdict: "complete" | "retry" | "fail"; why?: string };

export type KernelDecide = {
  "task.pre_create": { task: Task };
  "task.pre_stop": { task: Task; stopper: Principal };
  "task.pre_complete": Completion;
  "cascade.pre_propagate": { root: Task; stopper: Principal; cascade: "spare" | "force" };
  "message.pre_deliver": Delivery;
  "message.pre_submit": Submission;
  /** Policy for backend execution with no turn owner; observing it never creates a turn or task. */
  "acp.pre_unowned_run": { agentId: string; sessionId: string; run: BackendRun; action: "show" | "stop" };
};

export type Receipt = { messageId: string; about: Omit<LedgerEntry, "messageId" | "state" | "ts">; inserted: boolean; outcome?: "inserted" | "not_inserted" | "unknown" };

export type KernelObserve = Record<import("./lifecycle.ts").LifecyclePoint, import("./lifecycle.ts").LifecycleEvent> & {
  "task.created": Task;
  /** It reached its executor: the model was given it, or the job's call began. */
  "task.started": Task;
  /** Any change of a task, for whoever shows them. */
  "task.changed": Task;
  /** It is being stopped: a running job is called off, a session that ran only for it is stopped. It ends when that is done. */
  "task.stopping": Task & { turnId?: string };
  "task.ended": { ended: { task: Task; was: TaskStatus }[] };
  "message.routed": { item: MailItem; route: Route };
  /** Taken back out before they reached anyone. */
  "message.withdrawn": MailItem[];
  /** A notification was written to its recipient's inbox and routed: it has been given. */
  "notify.delivered": { item: MailItem; route: Route };
  /** An input reached the model's conversation (`inserted`), or will not (-32800, or stopped before). */
  "message.insertion_receipt": Receipt;
  "message.seen": LedgerEntry;
  "message.discarded": LedgerEntry;
  /** Every change of the ledger. */
  "message.ledger": LedgerEntry;
  "acp.session_update": { agentId: string; sessionId: string; source: ExecutionSource; update: SessionUpdate };
  /** Also emitted when an insertion receipt claims an already-running, unowned execution. */
  "acp.run_started": { agentId: string; sessionId: string; run: BackendRun };
  "acp.run_ended": { agentId: string; sessionId: string; run: BackendRun; stopReason: StopReason; origin?: unknown };
  "acp.turn_changed": { agentId: string; sessionId: string };
  "acp.turn_ended": { agentId: string; sessionId: string; turnId?: string; stopReason: StopReason; failed: boolean };
  /** The backend session was replaced: what it held is gone. */
  "acp.session_renewed": { agentId: string; sessionId: string };
};

export type KernelHooks = Hooks<KernelDecide, KernelObserve>;

export const USER: Principal = { kind: "user" };
export const SYSTEM: Principal = { kind: "system" };
export const agentPrincipal = (agentId: string): Principal => ({ kind: "agent", agentId });
export const same = (a: Principal, b: Principal): boolean => a.kind === b.kind && (a.kind !== "agent" || a.agentId === (b as { agentId: string }).agentId);
/** How an end is told: "a cancelled", "a replaced it", "the user cancelled", "failed". */
const byWhom = (stopper: Principal, reason: EndReason): string =>
  stopper.kind === "agent" ? (reason === "superseded" ? `${stopper.agentId} replaced it with a new task` : `${stopper.agentId} cancelled`) : stopper.kind === "user" ? (reason === "interrupted" ? "the user did not continue" : "the user cancelled") : "failed";

/** How a task ends, as `finish` records it. */
type End = { task: Task; status: TaskStatus; result: string; reason: EndReason; stopper: Principal; cause?: string };

/** A stop that waits for sessions to confirm they stopped (`idle(cancelled)`) before its tasks end. */
type PendingStop = { taskIds: string[]; sessions: Map<string, string | undefined>; timer: NodeJS.Timeout };

/** The end a task that is being stopped comes to (`Task.stopping`). `said`: what its executor added. */
const endOf = (task: Task, said = ""): End => {
  const { status, reason, stopper, cause, result } = task.stopping!;
  return { task, status, reason, stopper, ...(cause ? { cause } : {}), result: `${result} ${said}`.trim() };
};
/** Of tasks being stopped, those whose initiators are not to be told. */
const quietOf = (tasks: Task[]): Set<string> => new Set(tasks.filter((t) => t.stopping?.quiet).map((t) => t.id));

/** How long a stop waits for a session to confirm that it stopped. */
const STOP_CONFIRM_MS = 10_000;

/** A task the user initiates with what they said. */
function userTask(to: Addr, prompt: ContentBlock[], topic: string): Task {
  const said = textOf(prompt).trim();
  const title = said.split("\n")[0].slice(0, 80) || "(attachment)";
  return { id: newId("t"), title, topic, instructions: said, initiator: USER, to, after: [], status: "queued", createdAt: now(), updatedAt: now() };
}

function taskMail(task: Task, prompt?: ContentBlock[], id = newId("m")): MailItem {
  const from: Origin = task.from ? { kind: "agent", ...task.from } : { kind: "user" };
  return { id, to: task.to, from, kind: "task", topic: task.topic, taskId: task.id, pref: "wake", ...(prompt ? { prompt } : {}), ts: now() };
}

export class Kernel {
  readonly state: State;
  readonly hooks: KernelHooks;
  private recipient: (to: Addr) => Recipient;
  private pendingStops: PendingStop[] = [];

  constructor(state: State, hooks: KernelHooks, recipient: (to: Addr) => Recipient) {
    this.state = state;
    this.hooks = hooks;
    this.recipient = recipient;
    this.policies();
    ledgerHook(this);
    hooks.on("acp.turn_ended", ({ sessionId, turnId }) => this.confirmed(sessionId, turnId));
  }

  // ---- built-in policies ------------------------------------------------------

  private policies(): void {
    const { hooks } = this;
    hooks.decider("task.pre_create", (p) => {
      const unknown = p.task.after.filter((id) => !this.state.tasks.has(id));
      return unknown.length ? { veto: `"after" names an unknown task: ${unknown.join(", ")}` } : p;
    });
    hooks.decider("task.pre_stop", (p) => {
      const { task, stopper } = p;
      if (stopper.kind === "agent" && !same(stopper, task.initiator)) return { veto: `no task "${task.id}" dispatched by ${stopper.agentId}` };
      return p;
    });
    hooks.decider("message.pre_deliver", (p) => ({ ...p, route: p.route ?? this.deliveryPolicy(p) }));
    hooks.decider("acp.pre_unowned_run", (p) => ({ ...p, action: p.action ?? "show" }));
  }

  /**
   * The one delivery pipeline. In order:
   *   a. a tool call of the recipient waits for it (`sync`): it is what the call returns;
   *   b. the recipient is gone: it cannot be delivered;
   *   c. into the running work of a busy recipient (`interject`): always for the user's word, which makes that turn
   *      the user's (protected); for xsb's word on work the session has open (`steer`); and for what an agent sends
   *      while the running turn is still an agent's (unprotected). A turn the user started or spoke into is the
   *      user's: what an agent sends then waits its turn, or its sender stops that work (`dispatch` with `replace`);
   *   d. `lazy`: it stays in the inbox and comes with the recipient's next turn;
   *   e. otherwise (`wake`) a turn of its own: now if the recipient is idle, after its running turn if not.
   */
  private deliveryPolicy({ to, from, item }: Delivery): Route {
    const r = this.recipient(to);
    if (from.kind === "user") r.protect?.();
    if (item.targetTurnId) return r.exists && r.turn?.id === item.targetTurnId ? "interject" : "drop";
    const results = item.results;
    if (!r.exists) return "drop";
    if (results && (item.workGeneration ?? 0) < this.generation(to.sessionId)) return "inbox";
    if (results && !results.mode && r.awaits(results.taskIds[0])) return "return";
    if (r.busy && (from.kind === "user" || item.steer)) return "interject";
    // An agent's task or message goes into an agent's turn (rechecked where it is put in, LiveSession.steer: the user
    // may have spoken into the turn since). A task's result does not: it is a fact of the work that asked for it, given
    // with its own turn, and kept as one if that work is stopped.
    if (from.kind === "agent" && !results && r.turn && !r.turn.protected && item.pref !== "lazy") return "interject";
    return item.pref === "lazy" ? "inbox" : "turn";
  }

  // ---- queries ------------------------------------------------------------------

  /** The agent tasks a session was handed and has not finished: the context it works in. */
  openTasks(sessionId: string): Task[] {
    return [...this.state.tasks.values()].filter((t) => !t.tool && t.to.sessionId === sessionId && t.status === "running");
  }

  generation(sessionId: string): number {
    return this.state.sessions.get(sessionId)?.workGeneration ?? 0;
  }

  /** Check the committed stop, rather than waiting for its delivery hook to halt the backend. */
  sourceStopped(from: Addr): boolean {
    const turn = this.recipient(from).turn;
    const tasks = turn ? turn.taskIds.map((id) => this.state.tasks.get(id)).filter((t): t is Task => !!t) : this.openTasks(from.sessionId);
    return tasks.length > 0 && tasks.every((t) => !!t.stopping || !!t.cascadeStopped || ["cancelled", "interrupted"].includes(t.status));
  }

  /** The user's task of a session that has not ended: what the user says there belongs to it. */
  userTask(sessionId: string): Task | undefined {
    return [...this.state.tasks.values()].find((t) => t.initiator.kind === "user" && t.to.sessionId === sessionId && !isTerminal(t.status) && !t.stopping);
  }

  /** Mail of a session that waits in its inbox for its next turn. */
  inbox(sessionId: string): MailItem[] {
    return [...this.state.mail.values()].filter((m) => !m.heldBy && m.to.sessionId === sessionId && this.state.ledger.get(m.id)?.state === "inboxed");
  }

  private finished(taskId: string): boolean {
    const task = this.state.tasks.get(taskId);
    return !task || isTerminal(task.status);
  }

  /**
   * Whether something will bring the task's executor back to it: work started for it whose result is to wake it
   * (or a job), a join of its session, or such a result already on its way. Then its turn's end does not end it.
   */
  private awaited(task: Task): boolean {
    const { state } = this;
    const children = [...state.tasks.values()].filter((c) => c.parents?.includes(task.id));
    if (children.some((c) => !isTerminal(c.status) && c.tool)) return true;
    if ([...state.gates.values()].some((g) => g.owner.sessionId === task.to.sessionId)) return true;
    const ids = new Set(children.map((c) => c.id));
    return [...state.mail.values()].some((m) => m.to.sessionId === task.to.sessionId && m.results?.taskIds.some((id) => ids.has(id)) && state.ledger.get(m.id)?.state !== "inboxed");
  }

  // ---- tasks --------------------------------------------------------------------

  /**
   * A task an agent's session (`from`) gives `to`. What it is started for is what the dispatching session has open
   * (task-graph.ts). It is held back while a task in `after` is unfinished.
   */
  dispatch(
    from: Addr,
    to: Addr,
    input: { title: string; topic: string; instructions: string; after: string[]; deliveryPref?: DeliveryPref },
  ): Task | Veto {
    if (this.sourceStopped(from)) return { veto: "This work was stopped; no new work was submitted." };
    const held = input.after.some((id) => !this.finished(id));
    const parents = this.openTasks(from.sessionId).filter((t) => !t.stopping).map((t) => t.id);
    const { deliveryPref, ...rest } = input;
    return this.create(
      {
        id: newId("t"),
        ...rest,
        initiator: agentPrincipal(from.agentId),
        ...(deliveryPref && deliveryPref !== "lazy" ? { deliveryPref } : {}),
        ...(parents.length ? { parents } : {}),
        from,
        workGeneration: this.generation(from.sessionId),
        to,
        status: held ? "blocked" : "queued",
        createdAt: now(),
        updatedAt: now(),
      },
      held,
    );
  }

  /**
   * What the user asks of an agent in one of its sessions: a task the user initiates, given as the user's own message
   * (`messageId`). It is the root of whatever is done for it.
   */
  dispatchUser(to: Addr, prompt: ContentBlock[], messageId: string, topic: string): Task | Veto {
    return this.create(userTask(to, prompt, topic), false, { prompt, id: messageId });
  }

  /**
   * What the user said that is a turn of its own without having been a task: it went into work that ended before
   * the model took it, or a stop kept it from the model (docs/DESIGN.md 3.1, 5 and 8). It is the user's task now,
   * given already.
   */
  adoptUser(to: Addr, prompt: ContentBlock[], topic: string): Task | Veto {
    const task = this.create(userTask(to, prompt, topic), true);
    if (!isVeto(task)) this.started(task.id);
    return task;
  }

  /** Record a task; unless it is held back (or a job, which has nobody to be given to), give it to its executor. */
  private create(draft: Task, withoutMail: boolean, mail?: { prompt: ContentBlock[]; id: string }): Task | Veto {
    const source = draft.from ? structuredClone(this.recipient(draft.from).source ?? {
      ...draft.from, turnId: this.recipient(draft.from).turn?.id ?? null,
    }) : undefined;
    const decided = this.hooks.decide("task.pre_create", { task: { ...draft, ...(source ? { source: structuredClone(source) } : {}) } });
    if (isVeto(decided)) return decided;
    const task = { ...decided.task, ...(source ? { source } : {}) };
    if (source?.turnId && this.recipient(source).turn?.id !== source.turnId) return { veto: "The originating turn ended; no new work was submitted." };
    if (task.from && (this.sourceStopped(task.from) || task.parents?.some((id) => {
      const parent = this.state.tasks.get(id);
      return parent?.stopping || parent?.cascadeStopped || parent?.status === "cancelled" || parent?.status === "interrupted";
    }))) return { veto: "This work was stopped; no new work was submitted." };
    this.write([ops.putTask(task)], { changed: [task], created: [task], mail: withoutMail ? [] : [taskMail(task, mail?.prompt, mail?.id)] });
    return task;
  }

  /** A job: one call of a tool of the dispatcher's, run in the background (jobs.ts). Its result wakes the dispatcher. */
  createJob(from: Addr, input: { title: string; topic: string; tool: NonNullable<Task["tool"]> }): Task | Veto {
    if (this.sourceStopped(from)) return { veto: "This work was stopped; no new work was submitted." };
    const parents = this.openTasks(from.sessionId).filter((t) => !t.stopping).map((t) => t.id);
    return this.create(
      {
        id: newId("t"),
        title: input.title,
        topic: input.topic,
        instructions: "",
        initiator: agentPrincipal(from.agentId),
        from,
        workGeneration: this.generation(from.sessionId),
        to: from,
        after: [],
        ...(parents.length ? { parents } : {}),
        tool: input.tool,
        deliveryPref: "wake",
        status: "queued",
        createdAt: now(),
        updatedAt: now(),
      },
      true,
    );
  }

  /**
   * Explicit replacement: `by`, a task just dispatched, takes the place of the work its dispatcher gave the same
   * session and that runs there. Each is stopped as `superseded`, like a cancel by its dispatcher: what was started
   * for it goes with it (cascade), and the dispatcher, its stopper, is not told. `by` runs once the session stopped.
   * Work the dispatcher's own open work was started for is left alone: replacing it would stop the dispatcher too.
   */
  replace(by: Task, targetTurnId?: string): Task[] {
    const r = this.recipient(by.to);
    const own = new Set(by.parents ?? []);
    const valid = (): boolean => {
      const turn = this.recipient(by.to).turn;
      const task = this.state.tasks.get(by.id);
      return !!targetTurnId && turn?.id === targetTurnId && !turn.protected && task?.status === "queued" && !task.stopping &&
        turn.taskIds.every((id) => {
          const work = this.state.tasks.get(id);
          return !work || isTerminal(work.status) || (!work.stopping && same(work.initiator, by.initiator) && !doom(this.state, work).doomed.some((d) => own.has(d.id)));
        });
    };
    if (!valid() || !r.turn) return [];
    const replaced = this.openTasks(by.to.sessionId).filter(
      (t) => t.id !== by.id && !t.stopping && r.turn!.taskIds.includes(t.id) && same(t.initiator, by.initiator) && !doom(this.state, t).doomed.some((d) => own.has(d.id)),
    );
    if (!replaced.length) return [];
    const stopped = this.stopMany(replaced, by.initiator, { status: "cancelled", reason: "superseded", result: `Replaced by ${by.id} "${by.title}".` }, [], [], [], undefined, () => {
      // Hooks may synchronously accept user input. Recheck after them, immediately before committing.
      if (!valid()) return false;
      r.prioritize?.(by.id, targetTurnId!);
      return true;
    });
    if (isVeto(stopped)) return [];
    return replaced;
  }

  /** The task reached its executor. */
  started(taskId: string): void {
    const task = this.state.tasks.get(taskId);
    if (task?.status !== "queued" || task.stopping) return;
    const running = { ...task, status: "running" as const, updatedAt: now() };
    this.write([ops.putTask(running)], { changed: [running] });
    this.state.afterCommit(() => this.hooks.emit("task.started", running));
  }

  /** The task is as `task` now. */
  update(task: Task): void {
    const saved = { ...task, updatedAt: now() };
    this.write([ops.putTask(saved)], { changed: [saved] });
  }

  /**
   * Subscribe: the owner wants the results of `tasks` to wake it (`wake`), together in one message once all (or any)
   * have ended. Their results that have not reached it yet are taken back into the join. Returns whether it is
   * satisfied already: then nothing is registered, and the caller hands the results over itself.
   */
  subscribe(owner: Addr, tasks: Task[], mode: "all" | "any", note: string | undefined): { satisfied: boolean; finished: number } {
    const ids = tasks.map((t) => t.id);
    const unread = [...this.state.mail.values()].filter(
      (m) => m.to.sessionId === owner.sessionId && m.kind === "results" && !m.results!.mode && ids.includes(m.results!.taskIds[0]) && this.withdrawable(m),
    );
    const finished = tasks.filter((t) => isTerminal(t.status)).length;
    const satisfied = mode === "any" ? finished > 0 : finished === tasks.length;
    // The same wait asked for again is the one already registered: a second gate would deliver the results twice.
    const same = [...this.state.gates.values()].find((g) => g.owner.sessionId === owner.sessionId && g.mode === mode && g.taskIds.length === ids.length && ids.every((id) => g.taskIds.includes(id)));
    const gate: Gate = { id: newId("g"), owner, taskIds: ids, mode, note, createdAt: now(), workGeneration: this.generation(owner.sessionId) };
    const raised = tasks.filter((t) => !isTerminal(t.status) && t.deliveryPref !== "wake" && t.deliveryPref !== "sync").map((t) => ({ ...t, deliveryPref: "wake" as const, updatedAt: now() }));
    this.write([...unread.map((m) => ops.ack(m.id)), ...raised.map(ops.putTask), ...(satisfied || same ? [] : [ops.openGate(gate)])], { withdrawn: unread, changed: raised });
    return { satisfied, finished };
  }

  /** Whether mail has not reached its session's model yet, and can still be taken back. */
  private withdrawable(item: MailItem): boolean {
    const state = this.state.ledger.get(item.id)?.state;
    return state === "queued" || state === "inboxed";
  }

  /** The executor explicitly reported the outcome of this task. */
  complete(task: Task, status: "completed" | "failed", result: string): void {
    this.finish([{ task, status, result, reason: status, stopper: agentPrincipal(task.to.agentId) }]);
  }

  /**
   * A turn of a session ended: what it means for the tasks the session has open (implicit completion). Ended
   * normally, each task that nothing will bring it back to ends with the record of the work on it (`record`) as its
   * result, as `task.pre_complete` judges it. Ended by the model's limits or refusal, they fail with it. Failed,
   * they are errors. Stopped, they were stopped already, by whoever stopped the turn.
   */
  turnEnded(sessionId: string, stopReason: StopReason, record: (task: Task) => string, failure?: string, consumed: string[] = []): void {
    this.state.atomic(() => {
      this.ack(consumed);
      for (const task of this.openTasks(sessionId)) {
        if (failure) {
          this.fail(task, failure);
          continue;
        }
        if (stopReason === "cancelled" || task.stopping) continue;
        const said = record(task);
        if (stopReason !== "end_turn") {
          this.finish([{ task, status: "failed", result: `${said}\n(The turn ended: ${stopReason}.)`.trim(), reason: "failed", stopper: agentPrincipal(task.to.agentId) }]);
          continue;
        }
        if (this.awaited(task)) continue;
        const decided = this.hooks.decide("task.pre_complete", { task, result: said, verdict: "complete" });
        if (isVeto(decided)) continue;
        if (decided.verdict === "retry") {
          this.tell(task.to, task.topic, contractReminder(task, decided.why ?? ""), { steer: true, pref: "wake" });
        } else if (decided.verdict === "fail") {
          this.finish([{ task, status: "failed", result: `${said}\n${decided.why ?? ""}`.trim(), reason: "error", stopper: SYSTEM }]);
        } else {
          this.finish([{ task, status: "completed", result: decided.result, reason: "completed", stopper: agentPrincipal(task.to.agentId) }]);
        }
      }
    });
  }

  /** A job's tool answered. If it was being called off, its end is as the stop said, unless it finished all the same. */
  jobEnded(taskId: string, status: TaskStatus, result: string): void {
    const task = this.state.tasks.get(taskId);
    if (!task || isTerminal(task.status)) return;
    if (task.stopping && status === "cancelled") {
      this.finish([endOf(task, result)], [], [], quietOf([task]));
    } else {
      this.finish([{ task, status, result, reason: status === "completed" ? "completed" : "failed", stopper: SYSTEM }]);
    }
  }

  /**
   * Stop `root` for `stopper`, and with it what nothing else holds up (task-graph.ts, `doom`; `cascade.pre_propagate`
   * may have the rest go too) (docs/TASK-GRAPH.md). `root` ends as `end` says; the rest as `cascaded`, their stopper
   * the root's. What has not reached its executor is taken back at once. A session that was working only for what
   * goes is stopped (`task.stopping`), and the stop is recorded, in one transaction, once every such session said it
   * stopped (or after a while); a job that runs is called off and ends when its tool answers.
   *
   * Told: the initiator of each, unless it is the stopper (NotificationHook); and an executor that goes on with other
   * work, of what of its own went, so that it stops working on that.
   */
  stop(root: Task, stopper: Principal, end: { status: "cancelled" | "failed"; reason: EndReason; result: string }): Veto | { stopping: boolean; with: Task[] } {
    const current = this.state.tasks.get(root.id) ?? root;
    if (current.stopping) {
      const asked = this.hooks.decide("task.pre_stop", { task: current, stopper });
      if (isVeto(asked)) return asked;
      return { stopping: !!current.stopping, with: [] };
    }
    return this.stopMany([current], stopper, end);
  }

  /** User stop is a snapshot of all this session's accepted work, committed before the backend is cancelled. */
  stopSession(to: Addr, inputIds: string[], sentIds: string[] = [], insertedIds: string[] = []): Veto | { stopping: boolean; with: Task[] } {
    return this.stopSessions([{ to, pending: inputIds, sent: sentIds, inserted: insertedIds }]);
  }

  stopSessions(scopes: { to: Addr; pending: string[]; sent: string[]; inserted: string[] }[], extra: Op[] = []): Veto | { stopping: boolean; with: Task[] } {
    return this.state.atomic(() => {
      const scope = new Map(scopes.map(s => [s.to.sessionId, s]));
      const accepted = [...this.state.tasks.values()].filter((t) => scope.has(t.to.sessionId) && !isTerminal(t.status) && !t.stopping);
      const agentRoots = accepted.filter((t) => !t.tool);
      const covered = new Set(doomMany(this.state, agentRoots).doomed.map((t) => t.id));
      const roots = [...agentRoots, ...accepted.filter((t) => t.tool && !covered.has(t.id))];
      const ids = new Set(scopes.flatMap(s => s.pending));
      const sent = new Set(scopes.flatMap(s => s.sent)), inserted = new Set(scopes.flatMap(s => s.inserted));
      const mail = [...this.state.mail.values()].filter((m) => scope.has(m.to.sessionId) && !inserted.has(m.id) && (this.withdrawable(m) || this.state.ledger.get(m.id)?.state === "submitted" || ids.has(m.id)));
      // Keep facts, but give them a fresh, passive delivery. Withdrawn instructions are never digested again.
      const kept = mail.filter((m) => !sent.has(m.id) && !m.provider && (m.kind === "results" || (m.kind === "message" && m.from.kind === "system" && !m.steer)))
        .map((m) => ({ ...m, id: newId("m"), pref: "lazy" as const, steer: false }));
      const gates = [...this.state.gates.values()].filter((g) => scope.has(g.owner.sessionId));
      // Retire waits belonging to the stopped work. Shared children still return their facts individually, passively.
      const keptIds = new Set(kept.flatMap((m) => m.results?.taskIds ?? []));
      for (const gate of gates) for (const id of gate.taskIds) {
        const task = this.state.tasks.get(id);
        if (!task || !isTerminal(task.status) || keptIds.has(id)) continue;
        keptIds.add(id);
        kept.push({ id: newId("m"), to: gate.owner, from: { kind: "system" }, kind: "results", results: { taskIds: [id] }, pref: "lazy", steer: false, ts: now() });
      }
      const first = [...extra, ...scopes.flatMap(({ to }) => {
        const session = this.state.sessions.get(to.sessionId);
        return session ? [ops.putSession({ ...session, workGeneration: this.generation(to.sessionId) + 1, updatedAt: now() })] : [];
      }), ...mail.map((m) => ops.ack(m.id)), ...gates.map((g) => ops.closeGate(g.id))];
      const end = { status: "cancelled" as const, reason: "cancelled" as const, result: `The user stopped ${scopes.map(s => s.to.agentId).join(", ")}'s current and queued work.` };
      return this.stopMany(roots, USER, end, first, mail.filter((m) => !sent.has(m.id)), kept, [...scope.keys()]);
    });
  }

  private stopMany(roots: Task[], stopper: Principal, end: { status: "cancelled" | "failed"; reason: EndReason; result: string }, first: Op[] = [], taken: MailItem[] = [], kept: MailItem[] = [], stoppedSession?: string | string[], commitGuard?: () => boolean): Veto | { stopping: boolean; with: Task[] } {
    const forced = new Set<string>();
    for (const task of roots) {
      const asked = this.hooks.decide("task.pre_stop", { task, stopper });
      if (isVeto(asked)) return asked;
      const propagate = this.hooks.decide("cascade.pre_propagate", { root: task, stopper, cascade: "spare" });
      if (!isVeto(propagate) && propagate.cascade === "force") forced.add(task.id);
    }
    const { doomed, spared } = doomMany(this.state, roots, forced);
    const retired = roots.filter((t) => isTerminal(t.status)).map((t) => ({ ...t, cascadeStopped: true }));
    const causes = new Map(roots.map((r) => [r.id, r]));
    for (const r of roots) {
      const queue = [r.id];
      const visited = new Set<string>();
      while (queue.length) for (const id of this.state.graph.children.get(queue.pop()!) ?? []) {
        if (visited.has(id)) continue;
        visited.add(id);
        if (!causes.has(id)) causes.set(id, r);
        queue.push(id);
      }
    }
    const going = new Set(doomed.map((t) => t.id));
    const cause = byWhom(stopper, end.reason);
    const handed = (t: Task): boolean => !t.tool && t.status === "running";
    // Sessions whose open work all goes: their running work is stopped, and the stop waits for them.
    const halted = new Map<string, string | undefined>();
    const notices: MailItem[] = [...kept];
    // report_result can end a task while its turn is still running. Stopping that
    // finished root retires its remaining turn too, without changing the recorded result.
    const retiredIds = new Set(retired.map((t) => t.id));
    for (const root of retired) {
      const turn = this.recipient(root.to).turn;
      if (turn?.taskIds.includes(root.id) && turn.taskIds.every((id) => going.has(id) || retiredIds.has(id))) halted.set(root.to.sessionId, turn.id);
    }
    for (const sessionId of new Set(doomed.filter(handed).map((t) => t.to.sessionId))) {
      const own = doomed.filter((t) => handed(t) && t.to.sessionId === sessionId);
      // A session working only for what goes is stopped; it needs no word of it then.
      if (this.openTasks(sessionId).every((t) => going.has(t.id)) && this.recipient(own[0].to).busy) {
        halted.set(sessionId, this.recipient(own[0].to).turn?.id);
        continue;
      }
      if (same(stopper, agentPrincipal(own[0].to.agentId))) continue;
      const root = causes.get(own[0].id)!;
      const text = endNotice(
        own.map((t) => ({ task: t, root: t === root })),
        { root, cause, status: end.status, result: end.result },
        doomed.filter((t) => t.from?.sessionId === sessionId),
        spared.filter((t) => t.from?.sessionId === sessionId),
      );
      notices.push({ id: newId("m"), to: { agentId: own[0].to.agentId, sessionId }, from: { kind: "system" }, kind: "message", topic: own[0].topic, content: text, steer: true, pref: "lazy", ts: now() });
    }
    // A session told just now of what went is not told of each of them again; one whose work all went, of none.
    const told = new Set([...notices.map((n) => n.to.sessionId), ...halted.keys(), ...(typeof stoppedSession === "string" ? [stoppedSession] : stoppedSession ?? [])]);
    const quiet = new Set(doomed.filter((t) => same(stopper, t.initiator) || (t.from && told.has(t.from.sessionId))).map((t) => t.id));
    // The freeze: every task that goes is marked with the end it comes to, in one transaction with taking back its mail.
    const frozen: Task[] = [];
    const freeze: Op[] = [...first, ...retired.map(ops.putTask)];
    const withdrawn: MailItem[] = [...taken];
    const calledOff: Task[] = [];
    for (const task of doomed) {
      if (task.stopping) continue;
      const root = causes.get(task.id)!;
      const isRoot = roots.some((r) => r.id === task.id);
      const why = isRoot ? end.result : `Cancelled with "${root.title}" (${root.id}), which ${cause}.`;
      const status = isRoot ? end.status : "cancelled";
      let result = why;
      if (task.tool && task.status === "running") calledOff.push(task);
      else if (task.tool) result = `${why} It had not started: it waited for its turn in xsb, nothing was submitted, nothing is billed.`;
      else {
        // Its mail leaves the inbox, so that nothing gives it again; what is not in a conversation yet never will be.
        const mail = [...this.state.mail.values()].filter((m) => m.kind === "task" && m.taskId === task.id);
        freeze.push(...mail.map((m) => ops.ack(m.id)));
        withdrawn.push(...mail.filter((m) => this.withdrawable(m)));
        if (status !== "failed") result += handed(task) ? ` ${task.to.agentId} had it, and was stopped.` : " It had not been handed over.";
      }
      const stopping: Task["stopping"] = { status, reason: isRoot ? end.reason : "cascaded", stopper, ...(isRoot ? {} : { cause: root.id }), result, ...(quiet.has(task.id) ? { quiet: true } : {}) };
      frozen.push({ ...task, stopping, updatedAt: now() });
    }
    freeze.push(...frozen.map(ops.putTask));
    const ends = frozen.filter((t) => !calledOff.some((c) => c.id === t.id)).map((t) => endOf(t));
    if (commitGuard && !commitGuard()) return { veto: "The target turn changed or became protected; the new task was queued." };
    if (!halted.size) {
      this.finish(ends, freeze, notices, quiet, withdrawn);
    } else {
      // The stop is recorded now; the tasks end once the sessions confirmed it (or on the next start of xsb).
      this.write(freeze, { changed: frozen, mail: notices, withdrawn });
      this.state.afterCommit(() => {
        const pending: PendingStop = { taskIds: ends.map((e) => e.task.id), sessions: halted, timer: setTimeout(() => this.settleStop(pending), STOP_CONFIRM_MS) };
        this.pendingStops.push(pending);
        for (const task of [...doomed.filter(handed), ...retired].filter((t) => halted.has(t.to.sessionId))) this.hooks.emit("task.stopping", { ...task, turnId: halted.get(task.to.sessionId) });
      });
    }
    this.state.afterCommit(() => { for (const task of calledOff) this.hooks.emit("task.stopping", task); });
    return { stopping: calledOff.some((t) => roots.some((r) => r.id === t.id)) || halted.size > 0, with: doomed.filter((t) => !roots.some((r) => r.id === t.id)) };
  }

  /** A session's turn ended: the stops that waited for it to stop may be recorded. */
  private confirmed(sessionId: string, turnId?: string): void {
    for (const pending of [...this.pendingStops]) {
      if (!pending.sessions.has(sessionId) || (pending.sessions.get(sessionId) && pending.sessions.get(sessionId) !== turnId)) continue;
      pending.sessions.delete(sessionId);
      if (!pending.sessions.size) this.settleStop(pending);
    }
  }

  private settleStop(pending: PendingStop): void {
    const at = this.pendingStops.indexOf(pending);
    if (at < 0) return;
    this.pendingStops.splice(at, 1);
    clearTimeout(pending.timer);
    this.endStopped(pending.taskIds);
  }

  /** Tasks being stopped end as their stop said. */
  private endStopped(taskIds: string[]): void {
    const tasks = taskIds.map((id) => this.state.tasks.get(id)).filter((t): t is Task => !!t?.stopping && !isTerminal(t.status));
    if (tasks.length) this.finish(tasks.map((t) => endOf(t)), [], [], quietOf(tasks));
  }

  /**
   * Tasks reached their end. In one transaction: record each end; notify the initiator of each (NotificationHook),
   * as it asked to be (`deliveryPref`) or, once the join that waits for it is satisfied, with the others; release the
   * tasks held back until these ended (task-graph.ts, `releasable`); and post `notices`. The user's tasks have no
   * mail to send: the user sees their end in the session and the task list. A `quiet` task's initiator is notified of
   * nothing: the join that waits for it waits for the rest only.
   */
  private finish(ends: End[], first: Op[] = [], notices: MailItem[] = [], quiet = new Set<string>(), withdrawn: MailItem[] = []): void {
    const { state } = this;
    const ended = new Set(ends.map((e) => e.task.id));
    const done = (id: string): boolean => ended.has(id) || this.finished(id);
    const list: Op[] = [...first];
    const mail: MailItem[] = [];
    const changed: Task[] = [];
    const gates = new Map(state.gates);
    const joined = new Set<string>();
    for (const { task, status, result, reason, stopper, cause } of ends) {
      const { stopping: _, ...rest } = task;
      const finished: Task = { ...rest, status, result, ended: { reason, stopper, ...(cause ? { cause } : {}) }, updatedAt: now() };
      list.push(ops.putTask(finished));
      changed.push(finished);
      if (!task.from || joined.has(task.id)) continue;
      // Whoever ended it knows: an initiator that stopped its own task is not told of it.
      const silent = quiet.has(task.id) || same(stopper, task.initiator);
      const gate = [...gates.values()].find((g) => g.owner.sessionId === task.from!.sessionId && g.taskIds.includes(task.id));
      if (!gate) {
        const from: MailItem["from"] = task.tool ? { kind: "system" } : { kind: "agent", ...task.to };
        if (!silent && task.tool) mail.push({ id: newId("m"), to: task.from, from, kind: "results", topic: task.topic, results: { taskIds: [task.id] }, workGeneration: task.workGeneration ?? 0, pref: task.deliveryPref ?? "lazy", ts: now() });
        continue;
      }
      const waits = silent ? { ...gate, taskIds: gate.taskIds.filter((id) => id !== task.id) } : gate;
      if (!waits.taskIds.length) {
        gates.delete(gate.id);
        list.push(ops.closeGate(gate.id));
      } else if (waits.mode === "any" ? waits.taskIds.some(done) : waits.taskIds.every(done)) {
        gates.delete(gate.id);
        list.push(ops.closeGate(gate.id));
        for (const id of waits.taskIds) joined.add(id);
        const { taskIds, mode, note } = waits;
        mail.push({ id: newId("m"), to: gate.owner, from: { kind: "system" }, kind: "results", results: { taskIds, mode, note }, workGeneration: gate.workGeneration ?? 0, pref: "wake", ts: now() });
      } else if (silent) {
        gates.set(gate.id, waits);
        list.push(ops.openGate(waits));
      }
    }
    for (const held of releasable(state, ended).filter((t) => !t.stopping && !ended.has(t.id))) {
      const released: Task = { ...held, status: "queued", updatedAt: now() };
      list.push(ops.putTask(released));
      mail.push(taskMail(released));
      changed.push(released);
    }
    const was = new Map(ends.map((e) => [e.task.id, state.tasks.get(e.task.id)?.status ?? e.task.status]));
    this.write(list, { changed, mail: [...mail, ...notices], withdrawn, ended: changed.filter((t) => ended.has(t.id)).map((task) => ({ task, was: was.get(task.id)! })) });
  }

  // ---- mail ---------------------------------------------------------------------

  /** Post a message to an inbox. Returns it and how it goes. */
  post(item: Omit<MailItem, "id" | "ts"> & { id?: string }): { item: MailItem; route: Route } {
    const full: MailItem = { ...item, id: item.id ?? newId("m"), ts: now() };
    return { item: full, route: this.write([], { mail: [full] })[0] };
  }

  /**
   * A word from xsb to a session. `steer`: it is about work the session has open, and goes into its running turn.
   * `pref`: how it is to reach the session when it does not (default: `wake`).
   */
  tell(to: Addr, topic: string | undefined, content: string, how: { steer?: boolean; pref?: DeliveryPref } = {}): Route {
    return this.post({ to, from: { kind: "system" }, kind: "message", topic, content, ...(how.steer ? { steer: true } : {}), pref: how.pref ?? "wake" }).route;
  }

  /** Mail that a turn has read, or a tool call returned: it leaves the inbox. */
  ack(ids: string[]): void {
    const open = ids.filter((id) => this.state.mail.has(id));
    if (open.length) this.state.commit(open.map(ops.ack));
  }

  /** Mail of the inbox, delivered again as `pref` now says (a lazy result its owner subscribed to after all). */
  reroute(item: MailItem, pref: DeliveryPref): void {
    const changed = { ...item, pref };
    this.state.commit([ops.enqueue(changed)]);
    this.route(changed);
  }

  /**
   * The ledger moves one way: a message that reached a state does not go back to an earlier one, and one that was
   * seen or discarded stays so.
   */
  mark(messageId: string, state: LedgerState, about?: Receipt["about"], discardReason?: import("@xsb/protocol").DiscardReason): void {
    const base = this.ledgerEntry(messageId, state, about);
    const entry = base && { ...base, ...(discardReason ? { discardReason } : {}) };
    if (!entry) return;
    this.state.commit([ops.mark(entry)]);
    this.state.afterCommit(() => this.ledgerChanged(entry));
  }

  /** Durable intent before a backend write; restart cannot mistake an unanswered submission for unsent mail. */
  offered(inputs: { messageId: string; about: Receipt["about"] }[], backendSessionId: string, key: string): void {
    const entries: LedgerEntry[] = inputs.flatMap(({ messageId, about }) => {
      const prior = this.state.ledger.get(messageId);
      if (prior && (TAKEN_IN.has(prior.state) || prior.state === "discarded_unseen" || prior.state === "insertion_uncertain")) return [];
      return [{ ...(prior ?? about), messageId, state: "submitted", ts: now(), offered: { backendSessionId, key } }];
    });
    if (!entries.length) return;
    this.state.commit(entries.map(ops.mark));
    this.state.afterCommit(() => { for (const entry of entries) this.ledgerChanged(entry); });
  }

  /** The backend answered that it did not take them: a restart no longer has their insertion in doubt. */
  declined(messageIds: string[]): void {
    const entries = messageIds.flatMap((id) => {
      const prior = this.state.ledger.get(id);
      return prior?.offered ? [{ ...prior, offered: undefined }] : [];
    });
    if (entries.length) this.state.commit(entries.map(ops.mark));
  }

  private ledgerEntry(messageId: string, state: LedgerState, about?: Receipt["about"]): LedgerEntry | undefined {
    const prior = this.state.ledger.get(messageId);
    if (prior && RANK[state] <= RANK[prior.state]) return;
    // What got into the conversation is not said afterwards never to have: only a renewed session drops it unprocessed.
    if (state === "discarded_unseen" && prior?.state === "inserted") return;
    if (!prior && !about) return;
    return { ...(prior ?? about!), messageId, state, ts: now(), ...(state !== "insertion_uncertain" ? { offered: undefined } : {}) };
  }

  private ledgerChanged(entry: LedgerEntry): void {
    this.hooks.emit("message.ledger", entry);
    if (entry.state === "seen") this.hooks.emit("message.seen", entry);
    if (entry.state === "discarded_unseen" || entry.state === "insertion_uncertain") this.hooks.emit("message.discarded", entry);
  }

  /**
   * Commit `list` with the mail it posts, then route the mail and tell the observers. Mail goes out only once all of
   * it is committed. Returns the route of each item of `out.mail`.
   */
  private write(
    list: Op[],
    out: { changed?: Task[]; created?: Task[]; mail?: MailItem[]; withdrawn?: MailItem[]; ended?: { task: Task; was: TaskStatus }[] },
  ): Route[] {
    const mail = out.mail ?? [];
    const routes: Route[] = [];
    const receipts = new Map<string, LedgerEntry>();
    for (const item of out.withdrawn ?? []) {
      const entry = this.ledgerEntry(item.id, "discarded_unseen");
      if (entry) receipts.set(item.id, entry);
    }
    this.state.commit([...list, ...mail.map(ops.enqueue), ...[...receipts.values()].map(ops.mark)]);
    this.state.afterCommit(() => {
      for (const entry of receipts.values()) this.ledgerChanged(entry);
      for (const task of out.created ?? []) this.hooks.emit("task.created", task);
      for (const task of out.changed ?? []) this.hooks.emit("task.changed", task);
      if (out.withdrawn?.length) {
        this.hooks.emit("message.withdrawn", out.withdrawn);
      }
      if (out.ended?.length) this.hooks.emit("task.ended", { ended: out.ended });
      routes.push(...mail.map((item) => this.route(item)));
    });
    return routes;
  }

  /** Terminal input/task state is authoritative at routing, deferred delivery and dequeue, not just on restart. */
  settleTerminalInput(item: MailItem): boolean {
    const task = item.kind === "task" ? this.state.tasks.get(item.taskId!) : undefined;
    const discarded = ["discarded_unseen", "insertion_uncertain"].includes(this.state.ledger.get(item.id)?.state ?? "");
    if (discarded || (task && isTerminal(task.status))) {
      // A durable terminal receipt/task cannot become executable again after restart or a deferred route.
      const remove = [ops.ack(item.id)];
      if (discarded && task && !isTerminal(task.status) && !task.stopping) {
        this.finish([{ task, status: "failed", result: this.state.ledger.get(item.id)?.state === "insertion_uncertain" ? "Insertion could not be confirmed after interruption. Verify the outcome; this input was not replayed." : "The input was discarded; it was not replayed.", reason: "error", stopper: SYSTEM }], remove);
      } else this.state.commit(remove);
      return true;
    }
    return false;
  }

  /** The pipeline: decide how mail reaches its session (`message.pre_deliver`), and say so; the effectors act on it. */
  route(item: MailItem): Route {
    if (this.settleTerminalInput(item)) return "drop";
    const decided = this.hooks.decide("message.pre_deliver", { to: item.to, from: item.from, item });
    const route: Route = isVeto(decided) ? "drop" : (decided.route ?? "turn");
    const about = { agentId: item.to.agentId, sessionId: item.to.sessionId, from: item.from, ...(item.taskId ? { taskId: item.taskId } : {}) };
    if (route === "drop") {
      this.drop(item, isVeto(decided) ? decided.veto : `agent "${item.to.agentId}" no longer exists`, about);
      return route;
    }
    this.mark(item.id, route === "inbox" ? "inboxed" : route === "turn" && this.recipient(item.to).busy ? "queued" : "submitted", about);
    this.hooks.emit("message.routed", { item, route });
    if (item.kind === "results" || item.from.kind === "system") this.hooks.emit("notify.delivered", { item, route });
    return route;
  }

  /** Mail that cannot be delivered leaves the inbox unseen; a task that cannot be is an error. */
  reject(item: MailItem, why: string): void {
    this.drop(item, why, { agentId: item.to.agentId, sessionId: item.to.sessionId, from: item.from, ...(item.taskId ? { taskId: item.taskId } : {}) });
  }

  private drop(item: MailItem, why: string, about: Receipt["about"]): void {
    this.state.atomic(() => {
      this.mark(item.id, "discarded_unseen", about);
      const task = item.kind === "task" ? this.state.tasks.get(item.taskId!) : undefined;
      this.ack([item.id]);
      if (task && !isTerminal(task.status)) this.stop(task, SYSTEM, { status: "failed", reason: "error", result: `It could not be delivered: ${why}.` });
    });
  }

  /** The executor's turn that had a task could not run: the task is an error, and what it held up goes with it. */
  fail(task: Task, why: string): void {
    if (!isTerminal(task.status)) this.stop(task, SYSTEM, { status: "failed", reason: "error", result: `The agent could not run the task: ${why}` });
  }

  // ---- start -------------------------------------------------------------------

  /**
   * Give up what the last stop left unfinished, instead of picking it up: the user quit in the middle of it and does
   * not want it to go on by itself. One transaction: all mail leaves the inboxes, every open task ends as
   * `interrupted` (stopped by the user), every join closes. Who has to know is told in its inbox (`lazy`): it reads
   * it on its next turn, for a turn now would set to work what the user chose to stop.
   */
  abandon(): { mail: number; tasks: number } {
    const { state } = this;
    const mail = [...state.mail.values()];
    const open = [...state.tasks.values()].filter((task) => !isTerminal(task.status));
    const result = "xsb was quit while this was unfinished, and the user chose not to have it continued. It is interrupted; dispatch it again if it is still needed.";
    const lines = new Map<string, { to: Addr; lines: string[] }>();
    const add = (to: Addr, line: string): void => {
      const entry = lines.get(to.sessionId) ?? { to, lines: [] };
      entry.lines.push(line);
      lines.set(to.sessionId, entry);
    };
    for (const task of open) {
      if (task.from) add(task.from, `- the task "${task.title}" (${task.id})${task.tool ? "" : ` to ${task.to.agentId}`}: interrupted`);
      if (!task.tool && task.status === "running") add(task.to, `- the task "${task.title}" (${task.id}) from ${task.from?.agentId ?? "the user"}: interrupted`);
    }
    for (const item of mail) {
      if (item.from.kind === "agent" && item.kind !== "results") add(item.from, `- your ${item.kind} to ${item.to.agentId}${item.topic ? ` on "${item.topic}"` : ""}: not delivered`);
    }
    const ended = open.map((task) => ({ ...task, status: "interrupted" as const, result, ended: { reason: "interrupted" as const, stopper: USER }, updatedAt: now() }));
    const notices: MailItem[] = [...lines.values()].map(({ to, lines }) => ({ id: newId("m"), to, from: { kind: "system" }, kind: "message", content: abandonNotice(lines), pref: "lazy", ts: now() }));
    for (const item of mail) this.mark(item.id, "discarded_unseen");
    this.write([...mail.map((item) => ops.ack(item.id)), ...ended.map(ops.putTask), ...[...state.gates.values()].map((gate) => ops.closeGate(gate.id))], {
      changed: ended,
      mail: notices,
      ended: ended.map((task) => ({ task, was: open.find((t) => t.id === task.id)!.status })),
    });
    return { mail: mail.length, tasks: open.length };
  }

  /**
   * Pick up what the last stop left unfinished: a stop that was decided ends its tasks (the turns it waited for died
   * with xsb); mail is routed again, except what was already in a conversation; jobs are not run again (they may have
   * cost money).
   *
   * Mail the backend had taken in (inserted, seen, or inserted and left unprocessed) is in the backend session the
   * conversation resumes: sending it again would have the model read, and maybe act on, it twice. It is settled where
   * it stands, and a task it carried ends as one whose outcome is unknown, as a replay is never made. Returns it, by
   * session, for the conversations to say that their work was cut short.
   */
  resume(): Map<string, MailItem[]> {
    this.endStopped([...this.state.tasks.values()].filter((t) => t.stopping).map((t) => t.id));
    for (const task of [...this.state.tasks.values()]) {
      if (!task.tool || isTerminal(task.status)) continue;
      const result =
        task.status === "queued"
          ? "xsb stopped while this job waited for its turn. It had not started, so nothing was billed; start it again if it is still needed."
          : "xsb stopped while this job ran, so its outcome is unknown. It was not run again; start it again if it is still needed.";
      this.finish([{ task, status: "failed", result, reason: "error", stopper: SYSTEM }]);
    }
    const taken = new Map<string, MailItem[]>();
    const uncertain = "xsb stopped while this was in the conversation, so how far it got is unknown. It was not given again; verify its results before going on.";
    for (const item of [...this.state.mail.values()]) {
      const entry = this.state.ledger.get(item.id);
      if (!TAKEN_IN.has(entry?.state ?? "inboxed") && !["discarded_unseen", "insertion_uncertain"].includes(entry?.state ?? "")) {
        // Never replay pre-restart instructions. Only retained system facts may wait passively in the inbox.
        if (item.results && item.from.kind === "system") { this.reroute(item, "lazy"); continue; }
        this.state.atomic(() => {
          this.mark(item.id, entry?.offered ? "insertion_uncertain" : "discarded_unseen", undefined, "interrupted");
          const task = item.taskId ? this.state.tasks.get(item.taskId) : undefined;
          const origin = { ...item.from, messageId: item.id, ...(item.taskId ? { taskId: item.taskId } : {}) };
          const content = item.prompt ?? [{ type: "text", text: item.content ?? task?.instructions ?? "" }];
          this.state.commit([{ file: Paths.transcript(item.to.agentId, item.to.sessionId), rec: { ts: now(), update: {
            sessionUpdate: "session_info_update", _meta: { "dev.xsb/discarded": { messageId: item.id, origin, content, reason: "interrupted" } },
          } } }]);
          this.ack([item.id]);
          if (task && item.kind === "task" && !isTerminal(task.status)) this.fail(task, "Sending was interrupted by restart. This input was not sent again.");
        });
        continue;
      }
      if (this.settleTerminalInput(item)) continue;
      (taken.get(item.to.sessionId) ?? taken.set(item.to.sessionId, []).get(item.to.sessionId)!).push(item);
      const task = item.taskId ? this.state.tasks.get(item.taskId) : undefined;
      this.state.atomic(() => {
        this.ack([item.id]);
        if (task && item.kind === "task") this.fail(task, uncertain);
      });
    }
    // Blocked tasks have no mailbox entry yet. Settle them too, before deferred route observers can run.
    const unfinished = [...this.state.tasks.values()].filter(task => !task.tool && !isTerminal(task.status));
    if (unfinished.length) this.finish(unfinished.map(task => ({ task, status: "failed" as const,
      result: "Sending was interrupted by restart. This work was not resumed automatically.", reason: "error" as const, stopper: SYSTEM })));
    for (const item of [...this.state.mail.values()]) {
      if (this.settleTerminalInput(item)) continue;
      if (item.results && item.from.kind === "system") this.reroute(item, "lazy");
      else if (!TAKEN_IN.has(this.state.ledger.get(item.id)?.state ?? "inboxed")) {
        this.state.atomic(() => { this.mark(item.id, "discarded_unseen", undefined, "interrupted"); this.ack([item.id]); });
      }
    }
    return taken;
  }
}

/** Ledger states of mail a backend had taken into its conversation. */
export const TAKEN_IN = new Set<LedgerState>(["inserted", "seen", "inserted_unprocessed"]);

const RANK: Record<LedgerState, number> = { inboxed: 0, queued: 0, submitted: 1, inserted: 2, inserted_unprocessed: 3, seen: 4, discarded_unseen: 4, insertion_uncertain: 1.5 };
