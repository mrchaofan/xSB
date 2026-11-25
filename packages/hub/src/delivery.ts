/**
 * Delivery: the effector between the kernel and the sessions. The kernel decides how a message in an inbox reaches
 * its session (`message.routed`); this does it, in ACP v2 terms, and reports back what the sessions did:
 *
 *   return     as what the tool call that waits for it returns (`awaitResult`): no turn
 *   turn       a turn of its own (LiveSession.enqueue)
 *   interject  into the running work (LiveSession.steer): the backend takes it at once, or holds it
 *   inbox      nothing now: it comes in front of the session's next turn (`digest`)
 *
 * It also turns what the user says into the user's tasks (`fromUser`), stops the work of the user's stop, answers
 * the kernel's questions about sessions (`recipient`), takes back what the kernel withdrew, stops the turns that
 * only served work that was stopped, and tells the kernel how turns ended.
 */
import { errorMessage, text, RpcError } from "@xsb/protocol";
import type { Addr, ContentBlock, DiscardReason, OriginMeta } from "@xsb/protocol";
import type { Client } from "./acp-server.ts";
import type { Hub } from "./hub.ts";
import { isVeto } from "./hooks.ts";
import { TAKEN_IN } from "./kernel.ts";
import type { Recipient, Route } from "./kernel.ts";
import { inboxDigest, renderMail } from "./prompts.ts";
import type { Gives, TaskContext } from "./prompts.ts";
import { boundedText, contentTokens } from "./context.ts";
import type { LiveSession, Turn, TurnEnd } from "./session.ts";
import type { MailItem } from "./state.ts";
import { topicKey } from "./state.ts";
import { taskRecord } from "./transcript.ts";
import { deferred, newId } from "./util.ts";
import type { Deferred } from "./util.ts";

/** A mail item as a session is given it. */
export type Delivered = { origin: OriginMeta; prompt: ContentBlock[]; item: MailItem; gives?: Gives; from?: Client };

/** A tool call that waits for the end of a task (`sync`). */
type Waiter = { session: LiveSession; turn: Turn; resolve: (text: string) => void; timer: NodeJS.Timeout };

export class Delivery {
  private hub: Hub;
  /** Task id -> the tool call that waits for its result. */
  private waiters = new Map<string, Waiter>();
  /** Message id -> the user's `session/prompt` that waits for its insertion, and the client that sent it. */
  private inserted = new Map<string, { done: Deferred<void>; client?: Client }>();

  constructor(hub: Hub) {
    this.hub = hub;
    const { hooks } = hub.kernel;
    hooks.on("message.routed", ({ item, route }) => this.deliver(item, route));
    // The user's message that ended without the session recording it (dropped, refused, abandoned at quit, or settled on a
    // restart) is recorded as discarded: what the user sees of it is what became of it.
    hooks.on("message.discarded", (entry) => {
      if (entry.from.kind === "user") this.hub.live.get(entry.sessionId)?.unaccepted(entry.messageId, this.hub.stopping ? "abandoned" : "refused");
    });
    hooks.on("message.withdrawn", (items) => {
      for (const item of items) this.hub.live.get(item.to.sessionId)?.withdraw((m) => m.id === item.id);
    });
    hooks.on("task.stopping", (task) => {
      const currentTask = this.hub.state.tasks.get(task.id);
      if (task.tool || (!currentTask?.stopping && !currentTask?.cascadeStopped)) return;
      const session = this.hub.live.get(task.to.sessionId);
      // Stop observations may outlive their turn. Never cancel a newly accepted task with an old event.
      const first = session?.current?.first.item;
      const firstTask = first?.kind === "task" ? this.hub.state.tasks.get(first.taskId!) : undefined;
      if (firstTask && !firstTask.stopping && !firstTask.cascadeStopped) return;
      if (this.hub.kernel.openTasks(task.to.sessionId).some((t) => !t.stopping)) return;
      if (task.turnId) session?.halt(task.turnId);
    });
  }

  /** What the kernel is to know of a session. */
  recipient(to: Addr): Recipient {
    // Asking makes nothing: a session that is not registered is not there to deliver to.
    const known = this.hub.state.agents.has(to.agentId) ? this.hub.live.get(to.sessionId) : undefined;
    const session = known && this.hub.workflows?.available(known) !== false ? known : undefined;
    return {
      exists: !!session,
      busy: !!session?.busy,
      ...(session?.current && !session.current.cancelledBy ? {
        turn: { id: session.current.id, protected: session.current.protected, taskIds: session.taskIds() },
      } : {}),
      protect: () => session?.protect(),
      prioritize: (taskId, turnId) => session?.prioritize(taskId, turnId),
      awaits: (taskId) => {
        const waiter = this.waiters.get(taskId);
        return !!waiter && waiter.session === session && waiter.session.current === waiter.turn;
      },
    };
  }

  // ---- routes ---------------------------------------------------------------------

  private deliver(item: MailItem, route: Route): void {
    const user = this.inserted.get(item.id);
    const waiting = user?.done;
    if (route === "drop") return waiting?.reject(new Error(item.targetTurnId ? "Target turn has ended or changed." : `agent "${item.to.agentId}" no longer exists`));
    if (!this.hub.state.mail.has(item.id) || !this.recipient(item.to).exists) return waiting?.reject(RpcError.cancelled());
    if (this.hub.kernel.settleTerminalInput(item)) return waiting?.reject(RpcError.cancelled());
    if (route === "inbox") return waiting?.resolve();
    // A route observation can arrive after a user stop changed the result's receiving generation.
    if (item.results && (item.workGeneration ?? 0) < this.hub.kernel.generation(item.to.sessionId)) {
      this.hub.kernel.reroute(item, "lazy");
      return;
    }
    const session = this.hub.live.get(item.to.sessionId);
    if (!session) return waiting?.reject(new Error(`session ${item.to.sessionId} is not registered`));
    const rendered = this.render(item, session);
    const delivered = rendered && user?.client ? { ...rendered, from: user.client } : rendered;
    if (!delivered) return waiting?.reject(new Error("the message was refused"));
    if (route === "return") return this.returned(item, delivered);
    const steered = route === "interject" && session.steer(delivered, item.targetTurnId);
    if (item.targetTurnId && !steered) {
      this.hub.kernel.mark(item.id, "discarded_unseen");
      this.hub.kernel.ack([item.id]);
      waiting?.reject(new Error("Target turn has ended or changed."));
      return;
    }
    const input = steered || session.enqueue(delivered, item.from.kind === "user");
    if (waiting) input.inserted.promise.then(waiting.resolve, waiting.reject);
  }

  /** The prompt a mail item becomes (`message.pre_submit` may rewrite it, or veto it: then it is not delivered). */
  render(item: MailItem, session: LiveSession): Delivered | undefined {
    const { state, kernel } = this.hub;
    const rendered = item.prompt ? { prompt: item.prompt, gives: undefined } : (() => {
      const { text: said, gives } = renderMail(state, item, this.taskContext(item, session), session.given);
      const history = item.results && (item.workGeneration ?? 0) < kernel.generation(session.id)
        ? "These results belong to work accepted before the user's stop. They are historical context; do not resume that work unless the user asks.\n"
        : "";
      return { prompt: [text(history + said)], gives };
    })();
    const decided = kernel.hooks.decide("message.pre_submit", { to: item.to, from: item.from, item, prompt: rendered.prompt });
    if (isVeto(decided)) {
      kernel.mark(item.id, "discarded_unseen");
      kernel.ack([item.id]);
      return undefined;
    }
    const origin: OriginMeta = {
      ...item.from,
      messageId: item.id,
      taskId: item.results ? (item.results.mode ? undefined : item.results.taskIds[0]) : item.taskId,
      role: item.kind === "results" ? "task_result" : item.kind,
    };
    // User/task instructions remain intact. Results/notices may be excerpts, always with retrievable originals.
    const prompt = item.from.kind !== "user" && item.kind !== "task"
      ? decided.prompt.map((b) => b.type === "text" ? text(boundedText(this.hub.paths, session.agentId, b.text ?? "", this.hub.policy(session.agentId).outputTokens)) : b)
      : decided.prompt;
    const excerpted = prompt.some((b, i) => b.type === "text" && decided.prompt[i]?.type === "text" && b.text !== decided.prompt[i].text);
    return { origin, prompt, item, gives: excerpted ? undefined : rendered.gives };
  }

  /** A result handed to the tool call that waits for it: it is in the model's conversation once the call returns. */
  private returned(item: MailItem, delivered: Delivered): void {
    const taskId = item.results!.taskIds[0];
    const waiter = this.waiters.get(taskId);
    if (!waiter) return;
    this.waiters.delete(taskId);
    clearTimeout(waiter.timer);
    waiter.resolve(delivered.prompt.map((b) => (b.type === "text" ? b.text : "")).join("\n"));
    this.hub.kernel.ack([item.id]);
    const about = { agentId: item.to.agentId, sessionId: item.to.sessionId, from: item.from, taskId };
    this.hub.kernel.hooks.emit("message.insertion_receipt", { messageId: item.id, about, inserted: true });
  }

  /**
   * Wait in a tool call of `session`'s running turn for the end of `taskId`, at most `ms`: the result is what the call
   * returns. Past that, or once the turn has ended, it is delivered as `wake`.
   */
  awaitResult(session: LiveSession, taskId: string, ms: number, late: string): Promise<string> {
    const turn = session.current;
    if (!turn) return Promise.resolve(late);
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.unwait(taskId, late), ms);
      this.waiters.set(taskId, { session, turn, resolve, timer });
    });
  }

  /** A wait that is over without the result: it is delivered when it comes, waking the session. */
  private unwait(taskId: string, late: string): void {
    const waiter = this.waiters.get(taskId);
    if (!waiter) return;
    this.waiters.delete(taskId);
    clearTimeout(waiter.timer);
    waiter.resolve(late);
    const task = this.hub.state.tasks.get(taskId);
    if (task?.deliveryPref === "sync") this.hub.kernel.update({ ...task, deliveryPref: "wake" });
  }

  /** The inbox of a session, as it comes in front of its next turn. */
  digest(session: LiveSession, tokens = this.hub.policy(session.agentId).promptTokens / 2): Delivered[] {
    const delivered: Delivered[] = [];
    let left = Math.max(0, tokens - 100);
    for (const item of this.hub.kernel.inbox(session.id)) {
      const next = this.render(item, session);
      if (!next) continue;
      const cost = contentTokens(next.prompt);
      if (cost > left) break; // Retain unselected mail in original order; no receipt and no ack.
      delivered.push(next);
      left -= cost;
    }
    if (delivered.length) delivered[0] = { ...delivered[0], prompt: [text(inboxDigest(delivered.length)), ...delivered[0].prompt] };
    return delivered;
  }

  // ---- the user -----------------------------------------------------------------

  /** Explicit agent append: its delivery cannot fall back to a different turn or the queue. */
  async append(session: LiveSession, targetTurnId: string, from: Addr, content: string, topic?: string): Promise<string> {
    if (session.current?.id !== targetTurnId || session.current.cancelledBy) throw new Error("Target turn has ended or changed.");
    const id = newId("m"), done = deferred<void>();
    this.inserted.set(id, { done });
    try {
      this.hub.kernel.post({ id, to: { agentId: session.agentId, sessionId: session.id }, from: { kind: "agent", ...from }, kind: "message", content, topic, targetTurnId, pref: "wake" });
      await done.promise;
      return id;
    } finally {
      this.inserted.delete(id);
    }
  }

  /**
   * What the user says in a session (docs/DESIGN.md 3.1, 1-2). Said while a task of the user's is open there, it is
   * more of it. Said while the session works on tasks, it goes into that work: no task of its own. Otherwise it is a new task the user initiates (into the
   * work under way, if there is any). Either way it is a message in the session's inbox like any other, from the user, which never waits
   * behind work (kernel.ts, `deliveryPolicy`). Resolves when it is inserted into the conversation.
   */
  async fromUser(session: LiveSession, prompt: ContentBlock[], origin: OriginMeta, client: Client): Promise<{ messageId: string }> {
    const { kernel } = this.hub;
    const messageId = origin.messageId ?? newId("m");
    if (this.known(messageId)) return this.again(session, messageId);
    // Sent again by the user: it is a message of its own, and the one it repeats is no longer owed (never both).
    if (origin.resendOf) session.resend(origin.resendOf, messageId);
    session.protect();
    const to = { agentId: session.agentId, sessionId: session.id };
    const waiting = deferred<void>();
    this.inserted.set(messageId, { done: waiting, client });
    session.accept(messageId, { ...origin, messageId }, prompt, client);
    try {
      const open = kernel.userTask(session.id);
      if (open) {
        kernel.post({ id: messageId, to, from: { kind: "user" }, kind: "message", taskId: open.id, prompt, pref: "wake" });
      } else if (session.busy && kernel.openTasks(session.id).some((t) => !t.stopping)) {
        kernel.post({ id: messageId, to, from: { kind: "user" }, kind: "message", prompt, pref: "wake" });
      } else {
        const task = kernel.dispatchUser(to, prompt, messageId, topicKey(session.rec.title ?? "conversation"));
        if (isVeto(task)) throw new Error(task.veto);
      }
      await waiting.promise;
      return { messageId };
    } catch (e) {
      session.unaccepted(messageId, reasonOf(e), errorMessage(e));
      throw e;
    } finally {
      this.inserted.delete(messageId);
    }
  }

  /** Whether xsb has accepted a message of this id: a client sending it again (it lost the answer) gets no second copy. */
  known(messageId: string): boolean {
    return this.inserted.has(messageId) || this.hub.state.mail.has(messageId) || this.hub.state.ledger.has(messageId);
  }

  /** The answer to a message sent again: what became of the one accepted, once it is known. */
  private async again(session: LiveSession, messageId: string): Promise<{ messageId: string }> {
    const state = this.hub.state.ledger.get(messageId)?.state;
    if (state && TAKEN_IN.has(state)) return { messageId };
    if (state === "discarded_unseen") throw new RpcError(-32602, "This message did not get into the model's conversation; it is recorded so.", { errorKind: "discarded" });
    const pending = this.inserted.get(messageId)?.done.promise ?? session.insertionOf(messageId);
    if (pending) { await pending; return { messageId }; }
    // In the inbox, or routed after a restart and not yet in a session: wait for its routing to settle it.
    const waiting = deferred<void>();
    this.inserted.set(messageId, { done: waiting });
    try { await waiting.promise; return { messageId }; } finally { this.inserted.delete(messageId); }
  }

  /** What the states of messages are, by id (`Ledger.status`): "unknown" for one xsb never accepted. */
  status(messageIds: string[]): Record<string, string> {
    const { ledger, mail } = this.hub.state;
    return Object.fromEntries(messageIds.map((id) => [id, ledger.get(id)?.state ?? (mail.has(id) || this.inserted.has(id) ? "inboxed" : "unknown")]));
  }

  /**
   * The user stopped the session (Esc): its work stops, and so do the tasks it works on, the user being the stopper;
   * what they took along goes too. What the user says next is a task of its own: the user taking over.
   */
  userStop(session: LiveSession): void {
    const inputs = session.beginUserStop();
    if (!inputs) return;
    const stopped = this.hub.kernel.stopSession({ agentId: session.agentId, sessionId: session.id }, inputs.pending, inputs.sent, inputs.inserted);
    if (isVeto(stopped)) {
      session.releaseUserStop();
      this.hub.log(`user stop refused: ${stopped.veto}`);
      return;
    }
    session.rec = this.hub.state.sessions.get(session.id) ?? session.rec;
    session.cancelUserWork();
  }

  // ---- turns ----------------------------------------------------------------------

  /**
   * A turn begins with what the user said without it being a task (`LiveSession.resume`, `pump`): unless a task of
   * the user's is open there, it is a new one, given already. Returns its id.
   */
  userTurn(session: LiveSession, input: { prompt: ContentBlock[] }): string | undefined {
    if (this.hub.kernel.userTask(session.id)) return undefined;
    const task = this.hub.kernel.adoptUser({ agentId: session.agentId, sessionId: session.id }, input.prompt, topicKey(session.rec.title ?? "conversation"));
    return isVeto(task) ? undefined : task.id;
  }

  /** Mail was given to the backend: the tasks it brings are its executor's now. */
  given(items: MailItem[]): void {
    for (const item of items) if (item.kind === "task") this.hub.kernel.started(item.taskId!);
  }

  /**
   * A turn ended. Its mail leaves the inbox. The kernel is told how it ended, which ends the tasks that ended with it
   * (implicit completion: the result is the record of the work on the task, transcript.ts), or fails them. The sender
   * of a message that could not be read is told.
   */
  turnEnded(session: LiveSession, turn: Turn, end: TurnEnd): void {
    const { kernel } = this.hub;
    for (const [taskId, waiter] of this.waiters) if (waiter.turn === turn) this.unwait(taskId, "");
    kernel.ack(turn.items.map((m) => m.id));
    if (end.failure) {
      for (const item of turn.items) {
        if (item.kind !== "task" && item.from.kind === "agent") {
          // The sender believes the message arrived; tell it otherwise.
          kernel.tell({ agentId: item.from.agentId, sessionId: item.from.sessionId }, item.topic, `Your message ${item.id} to "${session.agentId}" was not processed: ${errorMessage(end.failure)}`);
        }
      }
      // The tasks the turn brought fail even when they had not reached the model: nothing else will run them.
      for (const item of turn.items) {
        const task = item.kind === "task" ? this.hub.state.tasks.get(item.taskId!) : undefined;
        if (task?.status === "queued") kernel.started(task.id);
      }
    }
    const record = (task: { id: string }): string => taskRecord(this.hub.state.store, session.agentId, session.id, task.id);
    kernel.turnEnded(session.id, end.stopReason, record, end.failure ? errorMessage(end.failure) : undefined);
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
        const body = this.hub.assets.text(asset);
        const budget = Math.min(1500, this.hub.policy(session.agentId).outputTokens, this.hub.policy(session.agentId).promptTokens / Math.max(4, (task.inputs?.length ?? 1) * 4));
        // Overlarge materials remain available via get_asset/read_context; never mark an excerpt as fully seen.
        return { asset, text: body !== undefined && contentTokens([text(body)]) <= budget ? body : undefined,
          ...(earlier ? { before: { version: earlier.version, text: this.hub.assets.text(earlier) } } : {}) };
      });
    return { inputs };
  }
}

/** Why the user's message did not get to the session: its rejection, worded as a `DiscardReason`. */
function reasonOf(e: unknown): DiscardReason {
  const message = errorMessage(e);
  if (e instanceof RpcError && e.code === RpcError.CANCELLED) return "stopped";
  if (/Target turn has ended or changed|no longer exists|not registered|no longer active|expired/.test(message)) return "expired";
  return "refused";
}
