/**
 * The kernel: tasks and their graph, the inboxes, the ledger. It knows principals, tasks, messages and events, and
 * nothing of ACP, sessions, backends or clients: it can run, and be tested, without any of them.
 *
 * It decides what happens; what is to be done because of it is for the hooks (hooks.ts) and the effectors
 * registered on them (delivery.ts, jobs.ts). Its own policies are hooks too, registered first (`policies`):
 *
 *   task.pre_create         is the task acceptable                       `after` names known tasks
 *   task.pre_stop           may this principal stop this task            its initiator, the user, or xsb
 *   task.pre_complete       does the task end with this turn's result    ResultExtraction, QualityGate
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
import type { Addr, Asset, ContentBlock, DeliveryPref, EndReason, LedgerEntry, LedgerState, Origin, Principal, SessionUpdate, StopReason, Task, TaskStatus } from "@xsb/protocol";
import type { Op } from "@xsb/store";
import type { Hooks, Veto } from "./hooks.ts";
import { isVeto } from "./hooks.ts";
import { ledgerHook } from "./ledger.ts";
import { abandonNotice, contractReminder, endNotice } from "./prompts.ts";
import type { Gate, MailItem, State } from "./state.ts";
import { ops } from "./state.ts";
import { doom, releasable } from "./task-graph.ts";
import { newId, now } from "./util.ts";

/**
 * How a message reaches its session. `return`: as what a tool call that waits for it returns. `turn`: as a turn of
 * its own, now or after the running one. `interject`: into the running turn. `inbox`: it stays in the inbox and comes
 * with the session's next turn. `drop`: it cannot be delivered.
 */
export type Route = "return" | "turn" | "interject" | "inbox" | "drop";

/** What the kernel is to know of a session to route to it. The effectors that run sessions answer (delivery.ts). */
export type Recipient = {
  /** Its agent exists. */
  exists: boolean;
  /** It works on something, or has something waiting to run. */
  busy: boolean;
  /** A tool call of its running turn waits for the end of this task. */
  awaits(taskId: string): boolean;
};

export type Delivery = { to: Addr; from: Origin; item: MailItem; route?: Route };
/** What a session is to be given for a message: may be rewritten, or vetoed (then it is not delivered). */
export type Submission = { to: Addr; from: Origin; item: MailItem; prompt: ContentBlock[] };
/** A task its executor's turn ended with: `verdict` says whether that ends it, and how. */
export type Completion = { task: Task; result: string; assets: Asset[]; verdict: "complete" | "retry" | "fail"; why?: string };

export type KernelDecide = {
  "task.pre_create": { task: Task };
  "task.pre_stop": { task: Task; stopper: Principal };
  "task.pre_complete": Completion;
  "cascade.pre_propagate": { root: Task; stopper: Principal; cascade: "spare" | "force" };
  "message.pre_deliver": Delivery;
  "message.pre_submit": Submission;
};

export type Receipt = { messageId: string; about: Omit<LedgerEntry, "messageId" | "state" | "ts">; inserted: boolean };

export type KernelObserve = {
  "task.created": Task;
  /** It reached its executor: the model was given it, or the job's call began. */
  "task.started": Task;
  /** Any change of a task, for whoever shows them. */
  "task.changed": Task;
  /** It is being stopped: a running job is called off, a session that ran only for it is stopped. It ends when that is done. */
  "task.stopping": Task;
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
  "acp.session_update": { agentId: string; sessionId: string; update: SessionUpdate };
  "acp.turn_ended": { agentId: string; sessionId: string; stopReason: StopReason; failed: boolean };
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
type PendingStop = { taskIds: string[]; sessions: Set<string>; timer: NodeJS.Timeout };

/** The end a task that is being stopped comes to (`Task.stopping`). `said`: what its executor added. */
const endOf = (task: Task, said = ""): End => {
  const { status, reason, stopper, cause, result } = task.stopping!;
  return { task, status, reason, stopper, ...(cause ? { cause } : {}), result: `${result} ${said}`.trim() };
};
/** Of tasks being stopped, those whose initiators are not to be told. */
const quietOf = (tasks: Task[]): Set<string> => new Set(tasks.filter((t) => t.stopping?.quiet).map((t) => t.id));

/** How often a turn that ended without what its task has to deliver is asked again, before the task fails. */
const QUALITY_RETRIES = 2;
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
  /** Task id -> how often its turn ended without what it has to deliver. */
  private qualityTries = new Map<string, number>();

  constructor(state: State, hooks: KernelHooks, recipient: (to: Addr) => Recipient) {
    this.state = state;
    this.hooks = hooks;
    this.recipient = recipient;
    this.policies();
    ledgerHook(this);
    hooks.on("acp.turn_ended", ({ sessionId }) => this.confirmed(sessionId));
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
    // ResultExtractionHook: what the task delivered is what its executor registered of the type it has to produce.
    hooks.decider("task.pre_complete", (p) => {
      if (!p.task.produces || p.assets.length) return p;
      const assets = [...this.state.assets.values()]
        .map((versions) => versions.at(-1)!)
        .filter((a) => a.by === p.task.to.agentId && a.type === p.task.produces && a.createdAt >= p.task.createdAt);
      return { ...p, assets };
    });
    // QualityGateHook: a task without what it has to deliver is asked for it again, a few times, then fails.
    hooks.decider("task.pre_complete", (p) => {
      if (!p.task.produces || p.assets.length || p.verdict !== "complete") return p;
      const tries = (this.qualityTries.get(p.task.id) ?? 0) + 1;
      this.qualityTries.set(p.task.id, tries);
      const why = `It did not register a "${p.task.produces}" asset, which it had to produce.`;
      return { ...p, verdict: tries > QUALITY_RETRIES ? "fail" : "retry", why };
    });
    hooks.decider("message.pre_deliver", (p) => ({ ...p, route: p.route ?? this.deliveryPolicy(p) }));
  }

  /**
   * The one delivery pipeline. In order:
   *   a. a tool call of the recipient waits for it (`sync`): it is what the call returns;
   *   b. the recipient is gone: it cannot be delivered;
   *   c. into the running work of a busy recipient, when it is the user's word, or xsb's word on work the session
   *      has open (`steer`). Nothing an agent sends goes into another's running work: it waits its turn, or its
   *      sender stops that work and gives it anew (`dispatch` with `replace`);
   *   d. `lazy`: it stays in the inbox and comes with the recipient's next turn;
   *   e. otherwise (`wake`) a turn of its own: now if the recipient is idle, after its running turn if not.
   */
  private deliveryPolicy({ to, from, item }: Delivery): Route {
    const r = this.recipient(to);
    const results = item.results;
    if (results && !results.mode && r.awaits(results.taskIds[0])) return "return";
    if (!r.exists) return "drop";
    if (r.busy && (from.kind === "user" || item.steer)) return "interject";
    return item.pref === "lazy" ? "inbox" : "turn";
  }

  // ---- queries ------------------------------------------------------------------

  /** The agent tasks a session was handed and has not finished: the context it works in. */
  openTasks(sessionId: string): Task[] {
    return [...this.state.tasks.values()].filter((t) => !t.tool && t.to.sessionId === sessionId && t.status === "running");
  }

  /** The user's task of a session that has not ended: what the user says there belongs to it. */
  userTask(sessionId: string): Task | undefined {
    return [...this.state.tasks.values()].find((t) => t.initiator.kind === "user" && t.to.sessionId === sessionId && !isTerminal(t.status));
  }

  /** Mail of a session that waits in its inbox for its next turn. */
  inbox(sessionId: string): MailItem[] {
    return [...this.state.mail.values()].filter((m) => m.to.sessionId === sessionId && this.state.ledger.get(m.id)?.state === "inboxed");
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
    if (children.some((c) => !isTerminal(c.status) && (c.tool || c.deliveryPref === "wake" || c.deliveryPref === "sync"))) return true;
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
    input: { title: string; topic: string; instructions: string; after: string[]; produces?: string; inputs?: string[]; deliveryPref?: DeliveryPref },
  ): Task | Veto {
    const held = input.after.some((id) => !this.finished(id));
    const parents = this.openTasks(from.sessionId).map((t) => t.id);
    const { deliveryPref, ...rest } = input;
    return this.create(
      {
        id: newId("t"),
        ...rest,
        initiator: agentPrincipal(from.agentId),
        ...(deliveryPref && deliveryPref !== "lazy" ? { deliveryPref } : {}),
        ...(parents.length ? { parents } : {}),
        from,
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
    const decided = this.hooks.decide("task.pre_create", { task: draft });
    if (isVeto(decided)) return decided;
    const { task } = decided;
    this.write([ops.putTask(task)], { changed: [task], created: [task], mail: withoutMail ? [] : [taskMail(task, mail?.prompt, mail?.id)] });
    return task;
  }

  /** A job: one call of a tool of the dispatcher's, run in the background (jobs.ts). Its result wakes the dispatcher. */
  createJob(from: Addr, input: { title: string; topic: string; tool: NonNullable<Task["tool"]> }): Task | Veto {
    const parents = this.openTasks(from.sessionId).map((t) => t.id);
    return this.create(
      {
        id: newId("t"),
        title: input.title,
        topic: input.topic,
        instructions: "",
        initiator: agentPrincipal(from.agentId),
        from,
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
  replace(by: Task): Task[] {
    const own = new Set(by.parents ?? []);
    const replaced = this.openTasks(by.to.sessionId).filter(
      (t) => t.id !== by.id && same(t.initiator, by.initiator) && !doom(this.state, t).doomed.some((d) => own.has(d.id)),
    );
    for (const task of replaced) {
      this.stop(task, by.initiator, { status: "cancelled", reason: "superseded", result: `Replaced by ${by.id} "${by.title}".` });
    }
    return replaced;
  }

  /** The task reached its executor. */
  started(taskId: string): void {
    const task = this.state.tasks.get(taskId);
    if (task?.status !== "queued") return;
    const running = { ...task, status: "running" as const, updatedAt: now() };
    this.write([ops.putTask(running)], { changed: [running] });
    this.hooks.emit("task.started", running);
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
    const gate: Gate = { id: newId("g"), owner, taskIds: ids, mode, note, createdAt: now() };
    const raised = tasks.filter((t) => !isTerminal(t.status) && t.deliveryPref !== "wake" && t.deliveryPref !== "sync").map((t) => ({ ...t, deliveryPref: "wake" as const, updatedAt: now() }));
    this.write([...unread.map((m) => ops.ack(m.id)), ...raised.map(ops.putTask), ...(satisfied || same ? [] : [ops.openGate(gate)])], { withdrawn: unread, changed: raised });
    return { satisfied, finished };
  }

  /** Whether mail has not reached its session's model yet, and can still be taken back. */
  private withdrawable(item: MailItem): boolean {
    const state = this.state.ledger.get(item.id)?.state;
    return state === "queued" || state === "inboxed";
  }

  /** The executor reported a task: `completed`, or `failed` by its own word. `assets`: what it named as delivered. */
  complete(task: Task, status: "completed" | "failed", result: string, assets: Asset[]): void {
    const done = { ...task, ...(assets.length ? { assets: assets.map((a) => `${a.id}@${a.version}`) } : {}) };
    this.qualityTries.delete(task.id);
    this.finish([{ task: done, status, result, reason: status, stopper: agentPrincipal(task.to.agentId) }]);
  }

  /**
   * A turn of a session ended: what it means for the tasks the session has open (implicit completion). Ended
   * normally, each task that nothing will bring it back to ends with the record of the work on it (`record`) as its
   * result, as `task.pre_complete` judges it. Ended by the model's limits or refusal, they fail with it. Failed,
   * they are errors. Stopped, they were stopped already, by whoever stopped the turn.
   */
  turnEnded(sessionId: string, stopReason: StopReason, record: (task: Task) => string, failure?: string): void {
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
      const decided = this.hooks.decide("task.pre_complete", { task, result: said, assets: [], verdict: "complete" });
      if (isVeto(decided)) continue;
      if (decided.verdict === "retry") {
        this.tell(task.to, task.topic, contractReminder(task, decided.why ?? ""), { steer: true, pref: "wake" });
      } else if (decided.verdict === "fail") {
        this.finish([{ task, status: "failed", result: `${said}\n${decided.why ?? ""}`.trim(), reason: "error", stopper: SYSTEM }]);
      } else {
        this.qualityTries.delete(task.id);
        const assets = decided.assets.map((a) => `${a.id}@${a.version}`);
        this.finish([{ task: { ...task, ...(assets.length ? { assets } : {}) }, status: "completed", result: decided.result, reason: "completed", stopper: agentPrincipal(task.to.agentId) }]);
      }
    }
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
    // A task ends once: a stop decided already is the one it ends by.
    if (root.stopping) return { stopping: true, with: [] };
    const asked = this.hooks.decide("task.pre_stop", { task: root, stopper });
    if (isVeto(asked)) return asked;
    const propagate = this.hooks.decide("cascade.pre_propagate", { root, stopper, cascade: "spare" });
    const { doomed, spared } = doom(this.state, root, !isVeto(propagate) && propagate.cascade === "force");
    const going = new Set(doomed.map((t) => t.id));
    const cause = byWhom(stopper, end.reason);
    const handed = (t: Task): boolean => !t.tool && t.status === "running";
    // Sessions whose open work all goes: their running work is stopped, and the stop waits for them.
    const halted = new Set<string>();
    const notices: MailItem[] = [];
    for (const sessionId of new Set(doomed.filter(handed).map((t) => t.to.sessionId))) {
      const own = doomed.filter((t) => handed(t) && t.to.sessionId === sessionId);
      // A session working only for what goes is stopped; it needs no word of it then.
      if (this.openTasks(sessionId).every((t) => going.has(t.id)) && this.recipient(own[0].to).busy) {
        halted.add(sessionId);
        continue;
      }
      if (same(stopper, agentPrincipal(own[0].to.agentId))) continue;
      const text = endNotice(
        own.map((t) => ({ task: t, root: t === root })),
        { root, cause, status: end.status, result: end.result },
        doomed.filter((t) => t.from?.sessionId === sessionId),
        spared.filter((t) => t.from?.sessionId === sessionId),
      );
      notices.push({ id: newId("m"), to: { agentId: own[0].to.agentId, sessionId }, from: { kind: "system" }, kind: "message", topic: own[0].topic, content: text, steer: true, pref: "lazy", ts: now() });
    }
    // A session told just now of what went is not told of each of them again; one whose work all went, of none.
    const told = new Set([...notices.map((n) => n.to.sessionId), ...halted]);
    const quiet = new Set(doomed.filter((t) => same(stopper, t.initiator) || (t.from && told.has(t.from.sessionId))).map((t) => t.id));
    // The freeze: every task that goes is marked with the end it comes to, in one transaction with taking back its mail.
    const frozen: Task[] = [];
    const freeze: Op[] = [];
    const withdrawn: MailItem[] = [];
    const calledOff: Task[] = [];
    for (const task of doomed) {
      const isRoot = task === root;
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
    if (!halted.size) {
      this.finish(ends, freeze, notices, quiet, withdrawn);
    } else {
      // The stop is recorded now; the tasks end once the sessions confirmed it (or on the next start of xsb).
      this.write(freeze, { changed: frozen, mail: notices, withdrawn });
      const pending: PendingStop = { taskIds: ends.map((e) => e.task.id), sessions: halted, timer: setTimeout(() => this.settleStop(pending), STOP_CONFIRM_MS) };
      this.pendingStops.push(pending);
      for (const task of doomed.filter((t) => handed(t) && halted.has(t.to.sessionId))) this.hooks.emit("task.stopping", task);
    }
    for (const task of calledOff) this.hooks.emit("task.stopping", task);
    return { stopping: calledOff.includes(root) || halted.size > 0, with: doomed.slice(1) };
  }

  /** A session's turn ended: the stops that waited for it to stop may be recorded. */
  private confirmed(sessionId: string): void {
    for (const pending of [...this.pendingStops]) {
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
        if (!silent) mail.push({ id: newId("m"), to: task.from, from, kind: "results", topic: task.topic, results: { taskIds: [task.id] }, pref: task.deliveryPref ?? "lazy", ts: now() });
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
        mail.push({ id: newId("m"), to: gate.owner, from: { kind: "system" }, kind: "results", results: { taskIds, mode, note }, pref: "wake", ts: now() });
      } else if (silent) {
        gates.set(gate.id, waits);
        list.push(ops.openGate(waits));
      }
    }
    for (const held of releasable(state, ended).filter((t) => !t.stopping)) {
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
  mark(messageId: string, state: LedgerState, about?: Receipt["about"]): void {
    const prior = this.state.ledger.get(messageId);
    if (prior && RANK[state] <= RANK[prior.state]) return;
    // What got into the conversation is not said afterwards never to have: only a renewed session drops it unprocessed.
    if (state === "discarded_unseen" && prior?.state === "inserted") return;
    if (!prior && !about) return;
    const entry: LedgerEntry = { ...(prior ?? about!), messageId, state, ts: now() };
    this.state.commit([ops.mark(entry)]);
    this.hooks.emit("message.ledger", entry);
    if (state === "seen") this.hooks.emit("message.seen", entry);
    if (state === "discarded_unseen") this.hooks.emit("message.discarded", entry);
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
    this.state.commit([...list, ...mail.map(ops.enqueue)]);
    for (const task of out.created ?? []) this.hooks.emit("task.created", task);
    for (const task of out.changed ?? []) this.hooks.emit("task.changed", task);
    if (out.withdrawn?.length) {
      for (const item of out.withdrawn) this.mark(item.id, "discarded_unseen");
      this.hooks.emit("message.withdrawn", out.withdrawn);
    }
    if (out.ended?.length) this.hooks.emit("task.ended", { ended: out.ended });
    return mail.map((item) => this.route(item));
  }

  /** The pipeline: decide how mail reaches its session (`message.pre_deliver`), and say so; the effectors act on it. */
  private route(item: MailItem): Route {
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
  private drop(item: MailItem, why: string, about: Receipt["about"]): void {
    this.mark(item.id, "discarded_unseen", about);
    const task = item.kind === "task" ? this.state.tasks.get(item.taskId!) : undefined;
    this.ack([item.id]);
    if (task && !isTerminal(task.status)) this.stop(task, SYSTEM, { status: "failed", reason: "error", result: `It could not be delivered: ${why}.` });
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
   * with xsb); mail is routed again; jobs are not run again (they may have cost money).
   */
  resume(): void {
    this.endStopped([...this.state.tasks.values()].filter((t) => t.stopping).map((t) => t.id));
    for (const task of [...this.state.tasks.values()]) {
      if (!task.tool || isTerminal(task.status)) continue;
      const result =
        task.status === "queued"
          ? "xsb stopped while this job waited for its turn. It had not started, so nothing was billed; start it again if it is still needed."
          : "xsb stopped while this job ran, so its outcome is unknown. It was not run again; start it again if it is still needed.";
      this.finish([{ task, status: "failed", result, reason: "error", stopper: SYSTEM }]);
    }
    for (const item of [...this.state.mail.values()]) this.route(item);
  }
}

const RANK: Record<LedgerState, number> = { inboxed: 0, queued: 0, submitted: 1, inserted: 2, inserted_unprocessed: 3, seen: 4, discarded_unseen: 4 };
