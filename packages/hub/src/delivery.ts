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
import { errorMessage, text } from "@xsb/protocol";
import type { Addr, ContentBlock, OriginMeta } from "@xsb/protocol";
import type { Client } from "./acp-server.ts";
import { userSaid } from "./capabilities.ts";
import type { Hub } from "./hub.ts";
import { isVeto } from "./hooks.ts";
import type { Recipient, Route } from "./kernel.ts";
import { USER } from "./kernel.ts";
import { inboxDigest, renderMail } from "./prompts.ts";
import type { Gives, TaskContext } from "./prompts.ts";
import { skillBody } from "./roles.ts";
import type { LiveSession, Turn, TurnEnd } from "./session.ts";
import { lastText } from "./session.ts";
import type { MailItem } from "./state.ts";
import { topicKey } from "./state.ts";
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
  private inserted = new Map<string, { done: Deferred<void>; client: Client }>();

  constructor(hub: Hub) {
    this.hub = hub;
    const { hooks } = hub.kernel;
    hooks.on("message.routed", ({ item, route }) => this.deliver(item, route));
    hooks.on("message.withdrawn", (items) => {
      for (const item of items) this.hub.live.get(item.to.sessionId)?.withdraw((m) => m.id === item.id);
    });
    hooks.on("task.stopping", (task) => {
      if (!task.tool) this.hub.live.get(task.to.sessionId)?.halt();
    });
  }

  /** What the kernel is to know of a session. */
  recipient(to: Addr): Recipient {
    // Asking makes nothing: a session that is not registered is not there to deliver to.
    const session = this.hub.state.agents.has(to.agentId) ? this.hub.live.get(to.sessionId) : undefined;
    return {
      exists: !!session,
      busy: !!session?.busy,
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
    if (route === "drop") return waiting?.reject(new Error(`agent "${item.to.agentId}" no longer exists`));
    if (route === "inbox" || !this.hub.state.mail.has(item.id)) return waiting?.resolve();
    const session = this.hub.live.get(item.to.sessionId);
    if (!session) return waiting?.reject(new Error(`session ${item.to.sessionId} is not registered`));
    const rendered = this.render(item, session);
    const delivered = rendered && user ? { ...rendered, from: user.client } : rendered;
    if (!delivered) return waiting?.reject(new Error("the message was refused"));
    if (route === "return") return this.returned(item, delivered);
    const input = (route === "interject" && session.steer(delivered)) || session.enqueue(delivered, item.from.kind === "user");
    if (waiting) input.inserted.promise.then(waiting.resolve, waiting.reject);
  }

  /** The prompt a mail item becomes (`message.pre_submit` may rewrite it, or veto it: then it is not delivered). */
  private render(item: MailItem, session: LiveSession): Delivered | undefined {
    const { state, kernel } = this.hub;
    const rendered = item.prompt ? { prompt: item.prompt, gives: undefined } : (() => {
      const { text: said, gives } = renderMail(state, item, this.taskContext(item, session), session.given);
      return { prompt: [text(said)], gives };
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
    return { origin, prompt: decided.prompt, item, gives: rendered.gives };
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
  digest(session: LiveSession): Delivered[] {
    const delivered = this.hub.kernel.inbox(session.id).map((item) => this.render(item, session)).filter((d): d is Delivered => !!d);
    if (delivered.length) delivered[0] = { ...delivered[0], prompt: [text(inboxDigest(delivered.length)), ...delivered[0].prompt] };
    return delivered;
  }

  // ---- the user -----------------------------------------------------------------

  /**
   * What the user says in a session. Said where no task of the user's is open, it is a new task the user initiates
   * (its executor works for the user, with what the user's words give it, capabilities.ts); said while one is, it is
   * more of it. Either way it is a message in the session's inbox like any other, from the user, which never waits
   * behind work (kernel.ts, `deliveryPolicy`). Resolves when it is inserted into the conversation.
   */
  async fromUser(session: LiveSession, prompt: ContentBlock[], origin: OriginMeta, client: Client): Promise<{ messageId: string }> {
    const { kernel } = this.hub;
    const messageId = origin.messageId ?? newId("m");
    const to = { agentId: session.agentId, sessionId: session.id };
    const waiting = deferred<void>();
    this.inserted.set(messageId, { done: waiting, client });
    try {
      const open = kernel.userTask(session.id);
      if (open) {
        userSaid(this.hub, open, prompt);
        kernel.post({ id: messageId, to, from: { kind: "user" }, kind: "message", taskId: open.id, prompt, pref: "wake" });
      } else {
        const task = kernel.dispatchUser(to, prompt, messageId, topicKey(session.rec.title ?? "conversation"));
        if (isVeto(task)) throw new Error(task.veto);
      }
      await waiting.promise;
      return { messageId };
    } finally {
      this.inserted.delete(messageId);
    }
  }

  /**
   * The user stopped the session (Esc): its work stops, and so do the tasks it works on, the user being the stopper;
   * what they took along goes too. What the user says next is a task of its own: the user taking over.
   */
  userStop(session: LiveSession): void {
    session.cancel();
    for (const task of this.hub.kernel.openTasks(session.id)) {
      this.hub.kernel.stop(task, USER, { status: "cancelled", reason: "cancelled", result: `The user stopped ${session.agentId}'s work on it.` });
    }
  }

  // ---- turns ----------------------------------------------------------------------

  /** Mail was given to the model, in a turn or into one: the tasks it brings are its executor's now. */
  given(items: MailItem[]): void {
    for (const item of items) if (item.kind === "task") this.hub.kernel.started(item.taskId!);
  }

  /**
   * A turn ended. Its mail leaves the inbox. The kernel is told how it ended, which ends the tasks that ended with it
   * (implicit completion), or fails them. The sender of a message that could not be read is told.
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
    kernel.turnEnded(session.id, end.stopReason, lastText(turn), end.failure ? errorMessage(end.failure) : undefined);
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
}
