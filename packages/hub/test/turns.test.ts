import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { text, ConversationEvent, RunExt, TurnExt, TurnFailure, RpcError, OriginExt, CONNECTION_CLOSED } from "@xsb/protocol";
import type { Addr, Task } from "@xsb/protocol";
import { Store } from "@xsb/store";
import { Delivery } from "../src/delivery.ts";
import { Elicitations } from "../src/elicitations.ts";
import { Hooks, isVeto } from "../src/hooks.ts";
import { Kernel, USER } from "../src/kernel.ts";
import { Paths } from "../src/paths.ts";
import { LiveSession } from "../src/session.ts";
import { State, ops } from "../src/state.ts";
import type { MailItem } from "../src/state.ts";
import { Workflows } from "../src/workflows.ts";
import { adopt, empty } from "../src/workflow-state.ts";
import { readWorkflowJournal, workflowJournal } from "../src/workflow-journal.ts";
import { deferred } from "../src/util.ts";
import { contextPolicy, contextRef, textTokens } from "../src/context.ts";

/** A hub over a fresh directory, or, given `reopen`, over one a previous hub left (a restart). */
function setup(t: test.TestContext, reopen?: string) {
  const dir = reopen ?? fs.mkdtempSync(path.join(os.tmpdir(), "xsb-turns-"));
  const paths = new Paths(dir), state = new State(new Store(paths.dir));
  state.load();
  const A = { agentId: "a", sessionId: "sa" }, B = { agentId: "b", sessionId: "sb" }, C = { agentId: "c", sessionId: "sc" };
  if (!reopen) for (const to of [A, B, C]) state.commit([
    ops.putAgent({ id: to.agentId, name: to.agentId, description: "", backend: "mock", workspace: dir, createdAt: "" }),
    ops.putSession({ id: to.sessionId, agentId: to.agentId, main: true, createdAt: "", updatedAt: "" }),
  ]);
  const hooks = new Hooks<any, any>({ log() {}, vetoed() {}, deadLetter(_point, _event, error) { throw error; } });
  const effects: string[] = [], prompts: string[] = [];
  const hub: any = {
    state, paths, live: new Map(), stopping: false,
    agentChanged() {}, log() {}, permissions: { cancel() {} }, policy: () => contextPolicy("mock"),
    agent: (id: string) => state.agents.get(id), role: () => ({ grants: ["dispatch", "message"], skills: [] }),
    toolServers: () => [{ from: "role", server: { name: "render" } }],
    rotateBridge() { effects.push("revoke"); }, revokePublications() {}, backends: { stop() { effects.push("stop process"); } },
  };
  const kernel = new Kernel(state, hooks, (to) => hub.delivery.recipient(to));
  hub.kernel = kernel;
  hub.delivery = new Delivery(hub);
  const heldMessageIds = new Set<string>();
  const heldReplies = new Map<string, { session: LiveSession; resolve(id: string): void }>();
  let holdSteered = false;
  for (const to of [A, B, C]) {
    const session = new LiveSession(hub, state.sessions.get(to.sessionId)!);
    hub.live.set(to.sessionId, session);
    let generation = 0;
    const pending = new Set<(error: unknown) => void>();
    const backend = {
      caps: { orderedCancellation: true },
      async prompt(_id: string, blocks: any[], origin?: any) {
        prompts.push(blocks.map((b) => b.text).join("\n"));
        if (heldMessageIds.delete(origin?.messageId) || holdSteered && origin?.steered) return new Promise<string>((resolve, reject) => { pending.add(reject); heldReplies.set(origin.messageId, { session, resolve }); });
        session.onBackendUpdate({ sessionUpdate: "state_update", state: "running" });
        return "receipt";
      },
      cancel() { effects.push("cancel"); for (const reject of pending) reject(RpcError.cancelled()); pending.clear(); }, close(id: string) { effects.push(`close ${id}`); }, stop() { effects.push("close transport"); },
    };
    (session as any).ensureBackend = async () => {
      if (!(session as any).backend) {
        (session as any).backend = backend;
        session.save({ backendSessionId: `backend-${to.agentId}-${++generation}`, renew: undefined, contextEpoch: (session.rec.contextEpoch ?? 0) + 1 });
      }
      return backend;
    };
  }
  const session = hub.live.get(B.sessionId) as LiveSession;
  const give = (from: Addr, to: Addr, title: string, after: string[] = []): Task => {
    const task = kernel.dispatch(from, to, { title, topic: title, instructions: title, after });
    assert.ok(!isVeto(task));
    return task;
  };
  const settle = async () => { for (let i = 0; i < 5; i++) { await hooks.settled(); await Promise.resolve(); } };
  const stop = (task: Task) => {
    const answer = kernel.stop(task, USER, { status: "cancelled", reason: "cancelled", result: "stop" });
    assert.ok(!isVeto(answer));
    return answer;
  };
  const idle = (reason = "end_turn") => {
    session.onBackendUpdate({ sessionUpdate: "state_update", state: "running" });
    session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: reason });
  };
  const holdPrompts = () => { holdSteered = true; };
  const acceptHeld = (id: string) => {
    const reply = heldReplies.get(id); assert.ok(reply, `pending standard prompt ${id}`);
    reply.session.onBackendUpdate({ sessionUpdate: "state_update", state: "running" });
    heldReplies.delete(id); reply.resolve(`receipt:${id}`);
  };
  const unread = (id: string, user = false) => {
    if (!(session as any).sendingBatch) heldMessageIds.add(id);
    const item: MailItem = { id, to: B, from: user ? { kind: "user" } : { kind: "agent", ...C }, kind: "message", content: id, pref: "wake", ts: "" };
    state.commit([ops.enqueue(item)]);
    kernel.mark(id, "submitted");
    return session.steer({ item, origin: { ...item.from, messageId: id }, prompt: [text(id)] })!;
  };
  // Clear bounded stop timers even when an assertion fails before confirmation.
  t.after(async () => {
    await hooks.settled();
    for (const pending of (kernel as any).pendingStops) clearTimeout(pending.timer);
    for (const live of hub.live.values()) live.releaseUserStop(false);
    if (!reopen) fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, paths, state, hooks, kernel, hub, effects, prompts, A, B, C, session, give, settle, stop, idle, unread, holdPrompts, acceptHeld };
}

test("context refusal recovers the same task without publishing a terminal result, and records the attempt", async (t) => {
  const { session, state, hub, A, B, give, settle, effects } = setup(t);
  const task = give(A, B, "too much context"); await settle();
  const prior = session.rec.backendSessionId!;
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "error", error: { code: -32603, message: "Internal error: Prompt is too long", data: { errorKind: "invalid_request" } } });
  await settle();
  assert.equal(session.busy, true);
  assert.notEqual(session.rec.backendSessionId, prior);
  assert.equal(state.tasks.get(task.id)!.status, "running");
  assert.equal(session.rec.contextRecovery?.attempts, 1);
  assert.ok(effects.includes(`close ${prior}`));
  const reloaded = new State(state.store); reloaded.load();
  assert.equal(reloaded.sessions.get(B.sessionId)!.contextRecovery?.attempts, 1);
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
  await settle();
  assert.equal(state.tasks.get(task.id)!.status, "completed");
  assert.equal(session.rec.contextRecovery, undefined);
});

test("a prompt rejection for overflow retires the backend before another turn", async (t) => {
  const { session, A, B, give, settle } = setup(t);
  await (session as any).ensureBackend();
  const backend = (session as any).backend;
  backend.prompt = async () => { throw new RpcError(-32603, "Internal error: Prompt is too long"); };
  give(A, B, "rejected prompt"); await settle();
  assert.equal(session.busy, false);
  assert.equal(session.rec.backendSessionId, undefined);
  assert.equal(session.rec.renew, true);
});

test("reported context windows reserve headroom below the configured token limit", async (t) => {
  const { session, A, B, give, settle, idle } = setup(t);
  give(A, B, "small window"); await settle();
  session.onBackendUpdate({ sessionUpdate: "usage_update", used: 8000, size: 10000 });
  idle(); await settle();
  assert.equal(session.rec.backendSessionId, undefined);
  assert.equal(session.rec.renew, true);
  assert.equal(session.rec.used, undefined);
});

test("unrelated backend failures retain the conversation", async (t) => {
  const { session, A, B, give, settle } = setup(t);
  give(A, B, "rate limited"); await settle();
  const prior = session.rec.backendSessionId;
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "error", error: { code: -32603, message: "Rate limit exceeded" } });
  await settle();
  assert.equal(session.rec.backendSessionId, prior);
  assert.equal(session.rec.renew, undefined);
});

test("observed execution prevents prompt replay and only publishes the terminal failure", async (t) => {
  const { session, state, A, B, give, settle, prompts } = setup(t);
  const task = give(A, B, "external write"); await settle();
  const count = prompts.length;
  session.onBackendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "write", title: "Send request", status: "completed" });
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "error", error: { code: -32603, message: "Internal error: Prompt is too long" } });
  await settle();
  assert.equal(prompts.length, count);
  assert.equal(state.tasks.get(task.id)!.status, "failed");
  assert.equal(session.rec.renew, true);
});

test("a fresh oversized input fails once without sending or silently dropping the original", async (t) => {
  const { session, state, kernel, A, B, give, settle, prompts } = setup(t);
  const task = kernel.dispatch(A, B, { title: "large", topic: "large", instructions: "x".repeat(100000), after: [] });
  assert.ok(!isVeto(task));
  await settle();
  assert.equal(session.busy, false);
  assert.equal(prompts.length, 0);
  assert.equal(state.tasks.get(task.id)!.status, "failed");
  assert.equal(state.tasks.get(task.id)!.instructions.length, 100000);
  assert.equal(session.rec.contextRecovery, undefined);
});

test("a task ended before deferred delivery never opens a turn", async (t) => {
  const { kernel, state, A, B, give, settle, prompts, session } = setup(t);
  const task = give(A, B, "completed before delivery");
  kernel.complete(task, "completed", "already done");
  await settle();
  assert.equal(session.busy, false);
  assert.equal(prompts.length, 0);
  assert.equal(state.tasks.get(task.id)!.status, "completed");
});

test("a queued task completed by its executor is discarded at dequeue instead of run again", async (t) => {
  const { kernel, state, A, B, give, settle, idle, prompts, session, unread, acceptHeld } = setup(t);
  give(A, B, "current"); await settle();
  // The user spoke into it: the turn is the user's, and an agent's task waits its turn.
  unread("the user", true);
  const task = give(A, B, "queued but already completed"); await settle();
  kernel.complete(task, "completed", "done in the current work");
  idle(); await settle();
  // A deferred standard prompt is still owned by its original turn until insertion is confirmed.
  acceptHeld("the user"); await settle();
  idle(); await settle();
  assert.equal(session.busy, false);
  assert.ok(!prompts.some(p => p.includes('title="queued but already completed"')));
  assert.equal(state.tasks.get(task.id)!.status, "completed");
});

test("inbox admission retains over-budget results without acknowledging them", async (t) => {
  const { hub, state, kernel, session, B, C } = setup(t);
  const item: MailItem = { id: "lazy-large", to: B, from: { kind: "agent", ...C }, kind: "message", content: "x".repeat(30000), pref: "lazy", ts: "" };
  state.commit([ops.enqueue(item)]);
  kernel.mark(item.id, "inboxed", { agentId: B.agentId, sessionId: B.sessionId, from: item.from });
  assert.deepEqual(hub.delivery.digest(session, 100), []);
  assert.ok(state.mail.has(item.id));
  const admitted = hub.delivery.digest(session, 10000);
  assert.equal(admitted.length, 1);
  assert.match(admitted[0].prompt[1].text, /context_ref/);
  assert.ok(state.mail.has(item.id));
});

test("user cancellation during binding recovery cannot resume the old task", async (t) => {
  const { session, kernel, state, A, B, give, settle, hub } = setup(t);
  const task = give(A, B, "cancel recovery"); await settle();
  let finish!: () => void;
  (session as any).ensureBackend = () => new Promise<void>((resolve) => { finish = resolve; });
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "error", error: { code: -32603, message: "Internal error: Prompt is too long" } });
  assert.equal(session.current!.recovering, true);
  hub.delivery.userStop(session);
  await settle();
  finish(); await settle();
  assert.equal(state.tasks.get(task.id)!.status, "cancelled");
  assert.equal(session.busy, false);
});

test("user input during context recovery protects and joins that turn before backend insertion", async (t) => {
  const { session, kernel, A, B, give, settle, prompts } = setup(t);
  const task = give(A, B, "recovering work"); await settle();
  const bind = (session as any).ensureBackend;
  let finish!: () => void;
  (session as any).ensureBackend = async () => { await new Promise<void>(resolve => { finish = resolve; }); return bind(); };
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "error", error: { code: -32603, message: "Internal error: Prompt is too long" } });
  assert.equal(session.current!.recovering, true);
  kernel.post({ to: B, from: { kind: "user" }, kind: "message", prompt: [text("new user constraint")], pref: "wake" });
  assert.equal(session.current!.protected, true, "protection is synchronous even while tools are disabled");
  const replacement = give(A, B, "must queue");
  assert.deepEqual(kernel.replace(replacement, session.current!.id), []);
  await settle();
  assert.ok(session.current!.inputs.some(i => i.prompt.some(b => b.type === "text" && b.text === "new user constraint")));
  finish(); await settle();
  assert.equal(session.current!.first.item!.taskId, task.id);
  assert.equal(session.current!.protected, true);
  assert.match(prompts.at(-1)!, /new user constraint/, "accepted corrections are in the first recovered model request");
});

test("handoff content yields budget to the new instructions without losing its retrieval reference", async (t) => {
  const { session, hub, kernel, A, B, settle, prompts } = setup(t);
  const body = "historical decision\n".repeat(2000);
  const ref = contextRef(hub.paths, session.agentId, body).ref;
  session.save({ contextCheckpoint: ref });
  (session as any).handoffPreface = body;
  session.preface(body);
  const task = kernel.dispatch(A, B, { title: "budgeted", topic: "budgeted", instructions: "x".repeat(20000), after: [] });
  assert.ok(!isVeto(task)); await settle();
  assert.equal(session.current?.inserted, true);
  assert.match(prompts[0], new RegExp(ref));
  assert.ok(textTokens(prompts[0]) + 8192 <= 32000);
  assert.ok(prompts[0].includes(task.instructions), "new instructions are intact");
});

test("a late receipt from the refused binding cannot land the replacement's input", async (t) => {
  const { session, A, B, give, settle } = setup(t);
  await (session as any).ensureBackend();
  const replies: (() => void)[] = [];
  (session as any).backend.prompt = () => {
    session.onBackendUpdate({ sessionUpdate: "state_update", state: "running" });
    return new Promise<void>((resolve) => replies.push(resolve));
  };
  give(A, B, "late receipt"); await settle();
  session.onBackendUpdate({ sessionUpdate: "user_message", messageId: "first", content: [text("late receipt")], _meta: { [OriginExt.key]: { messageId: session.current!.first.messageId } } });
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "error", error: { code: -32603, message: "Internal error: Prompt is too long" } });
  await settle();
  assert.equal(replies.length, 2);
  replies[0](); await settle();
  assert.equal(session.current!.inserted, false);
  replies[1](); await settle();
  assert.equal(session.current!.inserted, true);
});

test("execution evidence survives restart and prevents an interrupted input being replayed", async (t) => {
  const { session, state, hub, A, B, give, settle, prompts } = setup(t);
  const task = give(A, B, "observed write"); await settle();
  session.onBackendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "write", title: "External write", status: "completed" });
  const item = [...state.mail.values()].find(m => m.taskId === task.id)!;
  const reloaded = new State(state.store); reloaded.load();
  assert.equal(reloaded.sessions.get(B.sessionId)!.contextExecution!.messageId, item.id);
  const restarted = new LiveSession(hub, reloaded.sessions.get(B.sessionId)!);
  (restarted as any).ensureBackend = () => { throw new Error("must not replay"); };
  hub.live.set(B.sessionId, restarted);
  const count = prompts.length;
  restarted.enqueue({ item, origin: { ...item.from, messageId: item.id, taskId: task.id, role: "task" }, prompt: [text(task.instructions)] });
  await settle();
  assert.equal(prompts.length, count);
  assert.equal(state.tasks.get(task.id)!.status, "failed");
  assert.match(state.tasks.get(task.id)!.result!, /did not replay/);
});

test("user acceptance protects the turn before deferred delivery, even before insertion", async (t) => {
  const { kernel, state, A, B, session, give, settle, effects } = setup(t);
  const old = give(A, B, "old"); await settle();
  const target = session.current!.id;
  kernel.post({ to: B, from: { kind: "user" }, kind: "message", prompt: [text("user")], pref: "wake" });
  const replacement = give(A, B, "replacement");
  assert.equal(session.current!.protected, true);
  assert.deepEqual(kernel.replace(replacement, target), []);
  await settle();
  assert.equal(state.tasks.get(old.id)!.status, "running");
  assert.equal(session.current!.cancelledBy, undefined);
  assert.ok(!effects.includes("cancel"));
});

test("missing and stale preemption targets queue; matching targets never stop a later turn", async (t) => {
  const { kernel, state, A, B, session, give, settle, idle } = setup(t);
  give(A, B, "first"); await settle();
  const stale = session.current!.id;
  idle(); await settle();
  const second = give(A, B, "second"); await settle();
  const replacement = give(A, B, "replacement");
  assert.deepEqual(kernel.replace(replacement), []);
  assert.deepEqual(kernel.replace(replacement, stale), []);
  session.halt(stale);
  assert.equal(state.tasks.get(second.id)!.status, "running");
  assert.equal(session.current!.cancelledBy, undefined);
});

test("a blocked replacement does not stop work before its dependencies finish", async (t) => {
  const { kernel, A, B, session, give, settle } = setup(t);
  const old = give(A, B, "old"); await settle();
  const blocked = give(A, B, "blocked", [old.id]);
  assert.deepEqual(kernel.replace(blocked, session.current!.id), []);
  assert.equal(session.current!.cancelledBy, undefined);
});

test("replacement of a mixed-owner turn queues without partially cancelling its work", async (t) => {
  const { kernel, state, A, B, C, session, give, settle, idle } = setup(t);
  const foreign = give(C, B, "foreign work"); await settle();
  const child = kernel.dispatch(B, C, { title: "foreign child", topic: "foreign", instructions: "wait", after: [], deliveryPref: "wake" });
  assert.ok(!isVeto(child));
  kernel.subscribe(B, [child], "all", "explicit dependency"); await settle();
  idle(); await settle();
  assert.equal(state.tasks.get(foreign.id)!.status, "running");
  const own = give(A, B, "own work"); await settle();
  assert.ok(session.taskIds().includes(foreign.id));
  const replacement = give(A, B, "replacement");
  assert.deepEqual(kernel.replace(replacement, session.current!.id), []);
  await settle();
  assert.equal(state.tasks.get(own.id)!.status, "running");
  assert.equal(state.tasks.get(foreign.id)!.status, "running");
  // An agent's turn takes a peer's task in (interjection); nothing of the mixed work was cancelled.
  assert.equal(state.tasks.get(replacement.id)!.status, "running");
  assert.ok(session.taskIds().includes(replacement.id));
  assert.equal(session.current!.cancelledBy, undefined);
});

test("replacement runs first, then unread prompts retain FIFO order ahead of the old queue", async (t) => {
  const { kernel, A, B, C, session, give, settle, idle, unread, prompts, effects } = setup(t);
  give(A, B, "old"); await settle();
  const backendId = session.rec.backendSessionId;
  const queued = give(C, B, "already queued");
  unread("one"); unread("two");
  const replacement = give(A, B, "replacement");
  assert.equal(kernel.replace(replacement, session.current!.id).length, 1);
  await settle(); idle("cancelled"); await settle();
  assert.equal(session.current!.first.item!.taskId, replacement.id);
  assert.equal(session.rec.backendSessionId, backendId);
  assert.deepEqual(effects, ["cancel"]);
  idle(); await settle(); assert.equal(session.current!.first.messageId, "one");
  idle(); await settle(); assert.equal(session.current!.first.messageId, "two");
  idle(); await settle(); assert.equal(session.current!.first.item!.taskId, queued.id);
  assert.ok(prompts.findIndex((p) => p.includes('title="replacement"')) < prompts.findLastIndex((p) => p === "one"));
});

test("explicit stop recovers mixed unread prompts in order, including when the queue was empty", async (t) => {
  const { A, B, session, give, settle, stop, idle, unread } = setup(t);
  const old = give(A, B, "old"); await settle();
  // Agents interject while the turn is an agent's; once the user spoke into it, an agent's word waits its turn.
  unread("agent one"); unread("agent two"); unread("user", true);
  assert.equal(session.steer({ item: undefined as any, origin: { kind: "agent", ...A, messageId: "late" }, prompt: [text("late")] }), undefined);
  stop(old); await settle(); idle("cancelled"); await settle();
  assert.equal(session.current!.first.messageId, "agent one");
  idle(); await settle(); assert.equal(session.current!.first.messageId, "agent two");
  idle(); await settle(); assert.equal(session.current!.first.messageId, "user");
  assert.equal(session.current!.protected, true);
});

test("committed stops reject jobs and dispatch before the halt observer runs", async (t) => {
  const { state, kernel, hub, A, B, C, session, give, settle, stop } = setup(t);
  const old = give(A, B, "old"); await settle();
  stop(old);
  assert.equal(session.current!.cancelledBy, undefined, "halt has not run yet");
  assert.equal(session.acceptsTools, false);
  assert.ok(isVeto(kernel.createJob(B, { title: "late", topic: "late", tool: { server: "render", name: "render", arguments: {} } })));
  assert.ok(isVeto(kernel.dispatch(B, C, { title: "late", topic: "late", instructions: "late", after: [] })));
  assert.throws(() => new Workflows(hub).call(session,"execute",{},"late"),/No active turn/);
  assert.ok(![...state.tasks.values()].some((task) => task.title === "late"));
});

test("confirmed stop preserves the backend while rejecting old turn-tagged updates", async (t) => {
  const { state, A, B, session, give, settle, stop, idle, effects } = setup(t);
  const old = give(A, B, "old"); await settle();
  const oldTurn = session.current!.id, oldBackend = session.rec.backendSessionId!;
  give(A, B, "new"); stop(old); await settle(); idle("cancelled"); await settle();
  const current = session.current!;
  assert.equal(session.rec.backendSessionId, oldBackend);
  assert.deepEqual(effects, ["cancel"]);
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "cancelled", _meta: { [TurnExt.key]: { id: oldTurn } } });
  const before = state.store.read(Paths.transcript(B.agentId, B.sessionId)).length;
  session.onBackendUpdate({ sessionUpdate: "agent_message_chunk", content: text("old output"), _meta: { [TurnExt.key]: { id: oldTurn } } }, oldBackend);
  assert.equal(session.current, current);
  assert.equal(state.store.read(Paths.transcript(B.agentId, B.sessionId)).length, before);
});

test("stopping a backend without a tool-ordering guarantee revokes the old bridge before new work", async (t) => {
  const { session, give, settle, stop, idle, effects, A, B } = setup(t);
  const task = give(A, B, "unisolated work"); await settle();
  (session as any).backend.caps.orderedCancellation = false;
  const originalId = session.rec.backendSessionId;
  stop(task); await settle(); idle("cancelled"); await settle();
  assert.ok(effects.includes("revoke"));
  assert.ok(effects.includes("stop process"));
  assert.equal((session as any).backend, undefined);
  assert.equal(session.rec.backendSessionId, originalId, "the backend can restore its saved conversation");
});

test("an old turn's confirmation cannot settle a newer pending stop", async (t) => {
  const { state, hooks, A, B, session, give, settle, stop, idle } = setup(t);
  const old = give(A, B, "old"); await settle();
  const target = session.current!.id;
  stop(old);
  hooks.emit("acp.turn_ended", { sessionId: B.sessionId, turnId: "older", agentId: B.agentId, stopReason: "cancelled", failed: false });
  await settle();
  assert.ok(state.tasks.get(old.id)!.stopping);
  assert.equal(session.current!.id, target);
  idle("cancelled"); await settle();
  assert.equal(state.tasks.get(old.id)!.status, "cancelled");
});

test("stopping an ended root traverses ended intermediates and withdraws queued descendants without rewriting outcomes", async (t) => {
  const { state, kernel, A, B, C, give, settle, stop } = setup(t);
  const root = give(A, B, "root"); await settle();
  const middle = give(B, C, "middle"); await settle();
  const child = give(C, A, "child"); await settle();
  const queued = give(C, A, "queued");
  kernel.complete(state.tasks.get(middle.id)!, "completed", "middle done");
  kernel.complete(state.tasks.get(root.id)!, "completed", "root done");
  const answer = stop(root);
  assert.deepEqual(new Set(answer.with.map((t) => t.id)), new Set([child.id, queued.id]));
  assert.equal(state.tasks.get(root.id)!.status, "completed");
  assert.equal(state.tasks.get(root.id)!.result, "root done");
  assert.equal(state.tasks.get(middle.id)!.status, "completed");
  assert.ok(state.tasks.get(root.id)!.cascadeStopped);
  assert.ok(![...state.mail.values()].some((m) => m.taskId === queued.id));
  assert.ok(isVeto(kernel.dispatch(B, C, { title: "after stop", topic: "after stop", instructions: "", after: [] })));
});

test("explicit append inserts only into its target and fails after a turn switch", async (t) => {
  const { hub, state, A, B, session, give, settle, idle } = setup(t);
  give(A, B, "old"); await settle();
  const target = session.current!.id;
  const append = hub.delivery.append(session, target, A, "append"); await settle();
  const input = session.current!.inputs.find((i) => i.item?.content === "append")!;
  assert.ok(input);
  assert.equal(input.item!.targetTurnId, target);
  (session as any).landed([input]); await append;
  idle(); await settle(); give(A, B, "new"); await settle();
  await assert.rejects(hub.delivery.append(session, target, A, "expired"), /ended or changed/);
  assert.ok(![...state.mail.values()].some((m) => m.content === "expired"));
});

test("append accepted just before target expiry is discarded instead of queued", async (t) => {
  const { hub, A, B, session, give, settle, idle } = setup(t);
  give(A, B, "old"); await settle();
  const append = hub.delivery.append(session, session.current!.id, A, "too late");
  idle();
  await assert.rejects(append, /ended or changed/);
  await settle();
  assert.equal(session.busy, false);
});

test("a task stop that never receives idle expires and retires the old tools before queueing new work", async (t) => {
  const { effects, state, A, B, session, give, settle, stop } = setup(t);
  const old = give(A, B, "old"); await settle();
  const oldBackend = session.rec.backendSessionId!;
  t.mock.timers.enable({ apis: ["setTimeout"] });
  stop(old); await settle();
  assert.equal(session.acceptsTools, false);
  t.mock.timers.tick(10_000); await settle();
  assert.equal(session.current, undefined);
  assert.ok(effects.includes("revoke"));
  assert.ok(effects.includes("close transport"));
  assert.equal(session.rec.renew, "stopped");
  give(A, B, "new"); await settle();
  assert.notEqual(session.rec.backendSessionId, oldBackend);
  const current = session.current;
  const before = state.store.read(Paths.transcript(B.agentId, B.sessionId)).length;
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle" }, oldBackend);
  session.onBackendUpdate({ sessionUpdate: "agent_message_chunk", content: text("old output") }, oldBackend);
  assert.equal(session.current, current);
  assert.equal(state.store.read(Paths.transcript(B.agentId, B.sessionId)).length, before);
});

test("user input accepted by a stop hook protects the turn before replacement commits", async (t) => {
  const { kernel, state, hooks, A, B, session, give, settle } = setup(t);
  const old = give(A, B, "old"); await settle();
  hooks.decider("task.pre_stop", (p: any) => {
    kernel.post({ to: B, from: { kind: "user" }, kind: "message", prompt: [text("user")], pref: "wake" });
    return p;
  });
  const replacement = give(A, B, "replacement");
  assert.deepEqual(kernel.replace(replacement, session.current!.id), []);
  assert.equal(state.tasks.get(old.id)!.stopping, undefined);
  assert.equal(session.current!.protected, true);
});

test("user input after replacement commit joins and protects the replacement turn", async (t) => {
  const { kernel, A, B, session, give, settle, idle } = setup(t);
  give(A, B, "old"); await settle();
  const replacement = give(A, B, "replacement");
  kernel.replace(replacement, session.current!.id);
  kernel.post({ to: B, from: { kind: "user" }, kind: "message", prompt: [text("after replacement")], pref: "wake" });
  await settle(); idle("cancelled"); await settle();
  assert.equal(session.current!.first.item!.taskId, replacement.id);
  assert.equal(session.current!.protected, true);
  assert.ok(session.current!.inputs.some((i) => i.prompt.some((b) => b.type === "text" && b.text === "after replacement")));
});

test("an unread append expires on normal completion instead of becoming another turn", async (t) => {
  const { hub, state, A, B, session, give, settle, idle, effects, holdPrompts } = setup(t);
  const old = give(A, B, "old"); await settle();
  holdPrompts();
  const append = hub.delivery.append(session, session.current!.id, A, "unread append");
  await settle();
  assert.ok(session.current!.inputs.some((i) => i.item?.targetTurnId && !i.in));
  idle(); await assert.rejects(append, /ended or changed/); await settle();
  assert.equal(session.busy, false);
  assert.equal(state.tasks.get(old.id)!.status, "completed");
  assert.ok(![...state.mail.values()].some((m) => m.targetTurnId));
  assert.ok(effects.includes("revoke"), "unconfirmed append expiry keeps its isolation path");
});

test("confirmed stop discards an unread targeted append while preserving the conversation", async (t) => {
  const { hub, state, A, B, session, give, settle, stop, idle, effects, holdPrompts } = setup(t);
  const old = give(A, B, "old"); await settle();
  holdPrompts();
  const backendId = session.rec.backendSessionId;
  const append = hub.delivery.append(session, session.current!.id, A, "unread append");
  const rejected = assert.rejects(append, /ended or changed/);
  await settle(); stop(old); await settle(); idle("cancelled");
  await rejected; await settle();
  assert.equal(session.busy, false);
  assert.equal(session.rec.backendSessionId, backendId);
  assert.deepEqual(effects, ["cancel"]);
  assert.ok(![...state.mail.values()].some((m) => m.targetTurnId));
});

test("a resumed turn retains its open task context and cannot detach jobs from a committed stop", async (t) => {
  const { state, kernel, A, B, C, session, give, settle, idle, stop } = setup(t);
  const root = give(A, B, "root"); await settle();
  const child = kernel.dispatch(B, C, { title: "child", topic: "child", instructions: "child", after: [], deliveryPref: "wake" });
  assert.ok(!isVeto(child));
  kernel.subscribe(B, [child], "all", "explicit dependency"); await settle();
  idle(); await settle();
  assert.equal(state.tasks.get(root.id)!.status, "running");
  kernel.tell(B, "root", "resume"); await settle();
  assert.equal(session.current!.first.item!.kind, "message");
  assert.ok(session.taskIds().includes(root.id));
  stop(root);
  assert.equal(session.acceptsTools, false);
  assert.ok(isVeto(kernel.createJob(B, { title: "late", topic: "late", tool: { server: "render", name: "render", arguments: {} } })));
});

test("a stop inside task creation is rechecked before committing the new child", async (t) => {
  const { state, hooks, kernel, A, B, C, give, settle, stop } = setup(t);
  const root = give(A, B, "root"); await settle();
  hooks.decider("task.pre_create", (p: any) => {
    if (p.task.title === "late child") stop(root);
    return p;
  });
  const child = kernel.dispatch(B, C, { title: "late child", topic: "late child", instructions: "late child", after: [] });
  assert.ok(isVeto(child));
  assert.ok(![...state.tasks.values()].some((t) => t.title === "late child"));
});

test("idle before the deferred halt still cancels the stopped turn and preserves its backend", async (t) => {
  const { effects, A, B, session, give, settle, stop, idle } = setup(t);
  const old = give(A, B, "old"); await settle();
  const oldTurn = session.current!, oldBackend = session.rec.backendSessionId!;
  const next = give(A, B, "next");
  stop(old);
  idle();
  await settle();
  assert.equal((await oldTurn.done.promise).stopReason, "cancelled");
  assert.ok(!effects.some((e) => e.startsWith("close") || e === "revoke"));
  assert.equal(session.current!.first.item!.taskId, next.id);
  assert.equal(session.rec.backendSessionId, oldBackend);
});

test("a peer's work goes into an agent's turn; once the user spoke into it, the turn is the user's and peers wait", async (t) => {
  const { state, A, B, C, session, give, settle, idle, unread, acceptHeld } = setup(t);
  const current = give(A, B, "current"); await settle();
  const turn = session.current!;
  assert.equal(turn.protected, false);
  const peer = give(C, B, "from a peer"); await settle();
  assert.equal(session.current, turn, "no new turn: it went into the running one");
  assert.ok(session.taskIds().includes(peer.id));
  assert.equal(state.tasks.get(peer.id)!.status, "running");
  unread("the user", true);
  assert.equal(turn.protected, true, "the user's word makes the turn the user's at once");
  const later = give(C, B, "after the user"); await settle();
  assert.equal(session.current, turn);
  assert.ok(!session.taskIds().includes(later.id));
  assert.equal(state.tasks.get(later.id)!.status, "queued");
  idle(); await settle();
  assert.equal(state.tasks.get(current.id)!.status, "running", "a held standard prompt awaits its receipt");
  acceptHeld("the user"); await settle(); idle(); await settle();
  assert.equal(state.tasks.get(current.id)!.status, "completed");
  assert.equal(state.tasks.get(peer.id)!.status, "completed");
});

test("a workflow journals the context and scope actually inserted, keeping original user input in conversation history", async (t) => {
  const { state, session, hub, settle } = setup(t);
  hub.workflows = new Workflows(hub);
  const flow = empty(session.id);
  adopt(flow, { graphJsonl: [{ node: "A", prompt: "Review" }, { node: "end", kind: "end" }, { from: "A", to: "end" }].map(row => JSON.stringify(row)).join("\n") }, false);
  const messageId = "interruption";
  const raw = '<asset>{"name":"Report","version":"v1"}</asset>';
  const blocks = [text(raw), { type: "resource_link" as const, name: raw, uri: "file:///some-file.md" }];
  flow.interruptions.push({ id: messageId, target: flow.active!, prompt: blocks });
  state.commit([ops.workflow(flow)]);

  const backend = await (session as any).ensureBackend();
  const insertion = deferred<string>();
  let offered: typeof blocks = [];
  backend.prompt = (_: string, content: typeof blocks) => { offered = content; return insertion.promise; };
  const input = session.enqueue({ origin: { kind: "user", messageId }, prompt: blocks });
  await settle();
  const turnId = session.current!.id;
  const scope = "[xSB] The user is addressing the current workflow.";
  assert.deepEqual(offered.slice(-3), [text(scope), ...blocks]);
  const context = offered.find(block => block.text?.startsWith("[xSB workflow]"))?.text;
  assert.ok(context);
  assert.deepEqual(state.store.read(workflowJournal(session)), [], "offering a prompt is not its insertion");

  insertion.resolve("backend-message");
  await input.inserted.promise;
  const journal = state.store.read(workflowJournal(session));
  assert.deepEqual(journal.map(row => row.kind), ["context", "scope"]);
  assert.equal(journal[0].context, context);
  assert.equal(journal[1].scope, scope);
  for (const row of journal) {
    assert.equal(row.source, "workflow"); assert.equal(row.schemaVersion, 1);
    assert.equal(row.agentId, session.agentId); assert.equal(row.sessionId, session.id); assert.equal(row.turnId, turnId);
  }
  const file = Paths.transcript(session.agentId, session.id);
  const transcript = state.store.read(file);
  const visible = transcript.filter(row => row.update?.sessionUpdate === "user_message_chunk");
  assert.deepEqual(visible.map(row => row.update.content), blocks);
  assert.deepEqual(visible[0].update._meta["dev.xsb/delivered"], { scope: true });
  assert.equal(visible[0]._tx.split(":")[0], journal[0]._tx.split(":")[0], "the journal and the user's insertion commit together");
  assert.ok(!JSON.stringify(transcript).includes("dev.xsb/workflow-log"));
  assert.ok(!JSON.stringify(transcript).includes(scope));

  const legacy = { turnId: "old", tool: "plan", arguments: "{}", receipt: "old-call", result: "old output" };
  state.store.append(file, { ts: "2025-01-01T00:00:00Z", update: { sessionUpdate: "session_info_update", _meta: { "dev.xsb/workflow-log": legacy } } });
  state.store.append(workflowJournal(session), { schemaVersion: 2, source: "workflow", kind: "future" });
  const read = [...readWorkflowJournal(state.store, session)];
  assert.deepEqual(read.map(record => record.kind), ["scope", "context", "tool"]);
  assert.deepEqual(read[2], { ...legacy, kind: "tool", ts: "2025-01-01T00:00:00Z", schemaVersion: 1, source: "workflow", agentId: session.agentId, sessionId: session.id });
});

test("a workflow node's turn that ends normally keeps its backend process: no restart, its prompt cache with it", async (t) => {
  const { state, session, give, settle, idle, effects, A, B } = setup(t);
  const spec = state.agents.get(B.agentId)!;
  state.commit([ops.putAgent({ ...spec, workflowOwner: A.sessionId, workflowNode: "n" })]);
  give(A, B, "node work"); await settle();
  const backendId = session.rec.backendSessionId;
  (session as any).backend.caps.orderedCancellation = false;
  idle(); await settle();
  assert.ok(!effects.includes("stop process"), "ended normally: nothing late to fence off");
  assert.ok(!effects.includes("revoke"));
  assert.ok((session as any).backend, "the same process serves the next turn");
  assert.equal(session.rec.backendSessionId, backendId, "and the same backend session");
});

test("after a restart, what the backend had already taken in is not given again; the conversation says its turn was cut short", async (t) => {
  const first = setup(t);
  const task = first.give(first.A, first.B, "do the task"); await first.settle();
  // The user speaks into the running turn; the backend takes it in, works on it, and xsb is killed before the turn ends.
  const spoken = first.kernel.post({ to: first.B, from: { kind: "user" }, kind: "message", prompt: [text("also delete old files")], pref: "wake" }).item;
  await first.settle();
  first.session.onBackendUpdate({ sessionUpdate: "user_message", messageId: "echo", content: [text("also delete old files")], _meta: { [OriginExt.key]: { messageId: spoken.id } } });
  first.session.onBackendUpdate({ sessionUpdate: "agent_message_chunk", content: text("deleting…") });
  await first.settle();
  assert.equal(first.state.ledger.get(spoken.id)?.state, "inserted");
  const before = first.prompts.length;

  const second = setup(t, first.dir);
  const taken = second.kernel.resume();
  for (const [sessionId, items] of taken) second.hub.live.get(sessionId)?.interrupted(items.length);
  await second.settle();
  assert.deepEqual(first.prompts.slice(before).concat(second.prompts), [], "nothing is given to the model again");
  assert.ok(!second.state.mail.has(spoken.id), "settled where it stands");
  assert.equal(second.state.tasks.get(task.id)!.status, "failed", "its task's outcome is unknown, not replayed");
  const records = second.state.store.read(Paths.transcript(second.B.agentId, second.B.sessionId)).map((r: any) => r.update);
  const said = records.filter((u: any) => u.sessionUpdate === "user_message_chunk").map((u: any) => u.content.text);
  assert.equal(said.filter((x: string) => x === "also delete old files").length, 1, "shown once");
  assert.ok(records.some((u: any) => u._meta?.[TurnFailure.key]?.data?.errorKind === "execution_uncertain"), "the user is told");
});

test("a prompt whose connection closes before its receipt is uncertain: kept, said so, never given again", async (t) => {
  const { state, session, give, settle, prompts, A, B } = setup(t);
  const backend = await (session as any).ensureBackend();
  backend.prompt = async (_id: string, blocks: any[]) => { prompts.push(blocks.map((b) => b.text).join("\n")); throw new RpcError(CONNECTION_CLOSED, "backend: connection closed"); };
  const task = give(A, B, "maybe taken"); await settle();
  const entry = [...state.ledger.values()].find((e) => e.taskId === task.id)!;
  assert.equal(entry.state, "insertion_uncertain", "neither inserted nor known to be unseen");
  assert.ok(!state.mail.has(entry.messageId), "it does not wait to be given again");
  assert.equal(state.tasks.get(task.id)!.status, "failed");
  assert.equal(prompts.length, 1, "one copy only was ever offered");
  assert.equal(session.busy, false);
});

test("after a restart, neither an unanswered nor a declined pre-restart input is replayed", async (t) => {
  const first = setup(t);
  const backend = await (first.session as any).ensureBackend();
  backend.prompt = (_id: string, blocks: any[]) => { first.prompts.push(blocks.map((b: any) => b.text).join("\n")); return new Promise<string>(() => {}); };
  const task = first.give(first.A, first.B, "power lost"); await first.settle();
  const offered = [...first.state.ledger.values()].find((e) => e.taskId === task.id)!;
  assert.equal(offered.state, "submitted");
  assert.equal(offered.offered?.backendSessionId, first.session.rec.backendSessionId, "the offer is durable before the write");

  const second = setup(t, first.dir);
  second.kernel.resume(); await second.settle();
  assert.deepEqual(second.prompts, [], "nothing is given to the backend again");
  assert.equal(second.state.ledger.get(offered.messageId)?.state, "insertion_uncertain");
  assert.ok(!second.state.mail.has(offered.messageId));
  assert.equal(second.state.tasks.get(task.id)!.status, "failed");
  assert.match(second.state.tasks.get(task.id)!.result ?? "", /interrupted by restart/);

  // The backend's own -32800 is an answer: that input was not inserted, so a restart gives it again.
  const third = setup(t);
  const item: MailItem = { id: "declined", to: third.B, from: { kind: "agent", ...third.C }, kind: "message", content: "declined once", pref: "wake", ts: "" };
  const about = { agentId: third.B.agentId, sessionId: third.B.sessionId, from: item.from };
  third.state.commit([ops.enqueue(item)]);
  third.kernel.offered([{ messageId: item.id, about }], "backend-b-1", item.id);
  third.kernel.declined([item.id]);
  assert.equal(third.state.ledger.get(item.id)?.offered, undefined, "the refusal cleared the offer");
  const fourth = setup(t, third.dir);
  fourth.kernel.resume(); await fourth.settle();
  assert.equal(fourth.state.ledger.get(item.id)?.state, "discarded_unseen");
  assert.deepEqual(fourth.prompts, []);
  assert.ok(!fourth.state.mail.has(item.id), "old declined input is settled, not queued");
});

test("while the hub stops, no turn starts: what waits runs on the next start", async (t) => {
  const { hub, session, give, settle, prompts, A, B, state } = setup(t);
  give(A, B, "one"); await settle();
  const second = give(A, B, "two"); await settle();
  const sent = prompts.length;
  hub.stopping = true;
  session.onBackendGone((session as any).backend, "exited (SIGTERM)");
  await settle();
  assert.equal(prompts.length, sent, "the queued task is not given to the model");
  assert.equal(session.current, undefined, "no turn runs");
  assert.ok([...state.mail.values()].some((m) => m.taskId === second.id), "it stays in the inbox for the next start");
});

test("a first prompt the backend refuses for another reason than a stop keeps its handoff for the next prompt", async (t) => {
  const { session, give, settle, prompts, A, B } = setup(t);
  (session as any).prefaces = ["[handoff] what came before"];
  const backend = await (session as any).ensureBackend();
  const realPrompt = backend.prompt;
  let refuse = true;
  backend.prompt = async (id: string, blocks: any[]) => {
    if (refuse) { refuse = false; prompts.push(blocks.map((b: any) => b.text).join("\n")); throw new RpcError(-32603, "rate limited"); }
    return realPrompt(id, blocks);
  };
  give(A, B, "first"); await settle();
  give(A, B, "second"); await settle();
  assert.match(prompts[0], /\[handoff\]/, "the refused prompt carried it");
  assert.match(prompts.at(-1)!, /\[handoff\] what came before/, "and the next one carries it again");
});

test("the backend's own compaction leaves a boundary in the transcript: what is above, the model has only as its summary", async (t) => {
  const { session, state, give, settle, A, B } = setup(t);
  give(A, B, "work"); await settle();
  session.onBackendUpdate({ sessionUpdate: "compaction_update", compactionId: "c1", status: "in_progress" } as any);
  session.onBackendUpdate({ sessionUpdate: "compaction_update", compactionId: "c1", status: "completed" } as any);
  const marks = state.store.read(Paths.transcript(B.agentId, B.sessionId)).map((r: any) => r.update?._meta?.["dev.xsb/boundary"]).filter(Boolean);
  assert.deepEqual(marks.map((m: any) => [m.kind, m.handoff]), [["compacted", false]], "one boundary, once it completed");
});

test("a turn that fails with input given and unanswered fences the backend before the input is given again", async (t) => {
  const { session, effects, unread, give, settle, A, B } = setup(t);
  give(A, B, "work"); await settle();
  const backend = (session as any).backend;
  backend.caps.orderedCancellation = false;
  let answer: () => void = () => {};
  backend.prompt = (_id: string) => new Promise<string>((resolve) => { answer = () => resolve("late receipt"); });
  const spoken = unread("change it to blue", true);
  await settle();
  assert.equal(spoken.sent, "prompt", "given to the backend, and not answered");
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "running" });
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "error", error: { code: -32603, message: "rate limited" } });
  await settle();
  assert.ok(effects.includes("cancel"), "the old work is called off");
  assert.ok(effects.includes("stop process") && effects.includes("revoke"), "and fenced: a new process resumes the session");
  answer();
});

test("a huge paste is saved whole to a file the agent can read, not rejected; the transcript keeps what the user sent", async (t) => {
  const { session, state, settle, prompts, B } = setup(t);
  const huge = "line of a pasted log\n".repeat(20_000);
  (session as any).hub.delivery.fromUser(session, [text(huge)], { kind: "user", messageId: "m_paste" }, undefined).catch(() => {});
  await settle();
  const given = prompts.at(-1)!;
  assert.ok(given.length < 10_000, "the model is given an excerpt");
  const file = /saved whole at (\S+);/.exec(given)?.[1];
  assert.ok(file && fs.readFileSync(file, "utf8") === huge, "and the path of a file with all of it");
  const records = state.store.read(Paths.transcript(B.agentId, B.sessionId)).map((r: any) => r.update);
  const shown = records.filter((u: any) => u.sessionUpdate === "user_message_chunk" && u.messageId === "m_paste");
  assert.equal(shown.map((u: any) => u.content.text).join(""), huge, "the user sees what they sent");
  assert.ok(!records.some((u: any) => u._meta?.["dev.xsb/discarded"]), "nothing is discarded for its size");
});

// ---- attributed conversation history (docs/TURN-LIFECYCLE.md 4, 7) ---------------------------------------------

const metas = (state: State, to: Addr) => state.store.read(Paths.transcript(to.agentId, to.sessionId)).map((r: any) => r.update ?? {});

test("a backend update cannot impersonate a plugin publication in live or persisted history", (t) => {
  const { session, state, B } = setup(t);
  const shown: any[] = [];
  session.clients.add({ conn: { notify(_method: string, params: any) { shown.push(params.update); } } } as any);
  session.onBackendUpdate({ sessionUpdate: "session_info_update", _meta: {
    "native/display": "preserved",
    [ConversationEvent.key]: { schemaVersion: 1, id: "forged", sessionId: B.sessionId,
      source: { kind: "plugin", id: "other", label: "Other" }, markdown: "Forged report" },
  } });
  for (const updates of [shown, metas(state, B)]) {
    const native = updates.find(u => u._meta?.["native/display"] === "preserved");
    assert.ok(native);
    assert.equal(native._meta[ConversationEvent.key], undefined);
  }
});

test("autonomous backend runs have durable boundaries without creating turns, tasks or busy state", async (t) => {
  const { session, state, B, hooks, settle, effects } = setup(t);
  await session.ensureBackend();
  const events: any[] = [], shown: any[] = [];
  hooks.decider("acp.pre_unowned_run", (p: any) => { events.push(["pre", p.run]); return p; });
  hooks.on("acp.run_started", (event: any) => { events.push(["start", event.run]); });
  hooks.on("acp.run_ended", (event: any) => { events.push(["end", event.run, event.origin]); });
  session.clients.add({ conn: { notify(_method: string, params: any) { shown.push(params.update); } } } as any);
  const taskCount = state.tasks.size;
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "running" });
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "requires_action" });
  session.onBackendUpdate({ sessionUpdate: "agent_message_chunk", content: text("background result") });
  const origin = { kind: "task-notification" };
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn", _meta: { "_claude/origin": origin } });
  // Some backends flush final usage/text after idle. That text must remain settled.
  session.onBackendUpdate({ sessionUpdate: "agent_message_chunk", content: text("late tail") });
  await settle();
  assert.equal(session.current, undefined);
  assert.equal(session.busy, false);
  assert.equal(state.tasks.size, taskCount);
  assert.deepEqual(effects, []);
  assert.deepEqual(events.map(e => [e[0], e[1].turnId]), [["pre", null], ["start", null], ["end", null]]);
  assert.deepEqual(events[2][2], origin);
  assert.ok(!shown.some(u => u.sessionUpdate === "state_update"));
  const records = metas(state, B), output = records.filter(u => u.sessionUpdate === "agent_message_chunk");
  const boundaries = records.filter(u => u.sessionUpdate === "session_info_update" && u._meta?.[RunExt.key]);
  assert.deepEqual(boundaries.map(u => u._meta[RunExt.key].state), ["running", "idle"]);
  assert.equal(output[0]._meta[RunExt.key].id, output[1]._meta[RunExt.key].id);
  assert.equal(output[1]._meta[RunExt.key].state, "idle");
});

for (const afterAnswer of [false, true]) test(afterAnswer
  ? "a native async reply racing a submitted prompt cannot claim its turn without insertion"
  : "an unowned run ending while a new prompt waits cannot finish or execute that turn", async (t) => {
  const { session, state, hub, B, settle } = setup(t);
  const backend = await session.ensureBackend();
  if (afterAnswer) session.expectAsyncReplyRun("earlier-turn");
  else session.onBackendUpdate({ sessionUpdate: "state_update", state: "running" });
  let receipt!: () => void;
  (backend as any).prompt = () => new Promise<void>(resolve => { receipt = resolve; });
  const sent = hub.delivery.fromUser(session, [text("new work")], { kind: "user", messageId: "pending-run" });
  await settle();
  if (afterAnswer) session.onBackendUpdate({ sessionUpdate: "state_update", state: "running" });
  const turn = session.current!;
  assert.equal(session.acceptsTools, false, "an unowned run has no right to use the pending turn's tools");
  session.onBackendUpdate({ sessionUpdate: "agent_message_chunk", content: text("earlier background work") });
  session.onBackendUpdate({ sessionUpdate: "agent_message_chunk", content: text("Internal error: Prompt is too long") });
  assert.equal(turn.executed, undefined);
  assert.equal(turn.refusalChunks, undefined, "unowned errors are displayed instead of affecting prompt recovery");
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
  session.onBackendUpdate({ sessionUpdate: "agent_message_chunk", content: text("old late tail") });
  assert.equal(turn.executed, undefined);
  assert.equal(session.acceptsTools, false, "late idle work cannot acquire the pending turn's tools");
  assert.equal((await session.onBackendPermission({ sessionId: session.rec.backendSessionId!, title: "late permission", options: [] } as any)).outcome.outcome, "cancelled");
  await settle();
  assert.equal(session.current, turn);
  assert.equal(turn.inserted, false);
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "running" });
  receipt(); await sent; await settle();
  session.onBackendUpdate({ sessionUpdate: "agent_message_chunk", content: text("new answer") });
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
  await settle();
  assert.equal(session.busy, false);
  const output = metas(state, B).filter(u => u.sessionUpdate === "agent_message_chunk");
  assert.equal(output[0]._meta[RunExt.key].turnId, null);
  assert.equal(output.at(-1)._meta[RunExt.key].turnId, turn.id);
  assert.notEqual(output[0]._meta[RunExt.key].id, output.at(-1)._meta[RunExt.key].id);
});

test("only the original live main conversation accepts an async answer between normal idle and its insertion receipt", async t => {
  for (const scope of ["main", "node", "stopping"]) {
    const { session, state, hub, A, B, give, settle } = setup(t);
    if (scope === "node") state.commit([ops.putAgent({ ...state.agents.get(B.agentId)!, workflowOwner: A.sessionId, workflowNode: "n" })]);
    hub.elicitations = new Elicitations(hub);
    const answer = deferred<{ action: "accept"; content: { choice: string } }>();
    session.clients.add({ forms: true, conn: { notify() {}, request: () => answer.promise } } as any);
    const backend = await session.ensureBackend(), receipt = deferred<string>();
    backend.prompt = () => {
      session.onBackendUpdate({ sessionUpdate: "state_update", state: "running" });
      return receipt.promise;
    };
    give(A, B, "work"); await settle();
    const turn = session.current!;
    const response = session.onBackendElicitation({ mode: "form", sessionId: session.rec.backendSessionId!,
      message: "Choose", requestedSchema: { type: "object", properties: { choice: { type: "string" } }, required: ["choice"] },
      _meta: { codex: { delivery: "async" } } }, new AbortController().signal);
    session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
    assert.equal(session.current, turn);
    assert.equal(session.acceptsTools, false);
    assert.equal(session.canAnswerForm("other-turn", true), false);
    assert.equal(session.canAnswerForm(turn.id, false), false);
    if (scope === "stopping") session.beginUserStop();
    const choice = { action: "accept" as const, content: { choice: "continue" } };
    answer.resolve(choice);
    assert.deepEqual(await response, scope === "main" ? choice : { action: "cancel" }, scope);
    assert.equal(turn.protected, scope === "main");
    if (scope === "stopping") session.cancelUserWork();
    receipt.resolve("native-input"); await settle();
    assert.equal(session.current, undefined);
  }
});

test("completed standalone async follow-ups do not hold the next prompt open when its receipt follows idle", async t => {
  const { session, state, A, B, give, idle, settle } = setup(t);
  give(A, B, "ask two questions"); await settle();
  const origin = session.current!.id;
  session.expectAsyncReplyRun(origin);
  session.expectAsyncReplyRun(origin);
  idle(); await settle();
  idle(); idle(); // Both follow-ups ran with no submitted Hub input.
  const backend = await session.ensureBackend();
  (backend as any).prompt = async () => {
    session.onBackendUpdate({ sessionUpdate: "state_update", state: "running" });
    assert.equal(session.acceptsTools, true);
    session.onBackendUpdate({ sessionUpdate: "agent_message_chunk", content: text("finished new task") });
    session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
    return "new-receipt";
  };
  const task = give(A, B, "new task"); await settle();
  assert.equal(session.busy, false);
  assert.equal(state.tasks.get(task.id)?.status, "completed");
  const output = metas(state, B).find(u => u.content?.text === "finished new task");
  assert.ok(output._meta[RunExt.key].turnId);
});

test("each async answer can start a separate follow-up, including while the next Hub prompt awaits insertion", async t => {
  const { session, hub, idle, settle } = setup(t);
  const backend = await session.ensureBackend();
  session.expectAsyncReplyRun("prior-turn");
  session.expectAsyncReplyRun("prior-turn");
  idle();
  let receipt!: (id: string) => void;
  (backend as any).prompt = () => new Promise<string>(resolve => receipt = resolve);
  const input = hub.delivery.fromUser(session, [text("new input")], { kind: "user", messageId: "waiting-input" });
  await settle();
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "running" });
  assert.equal(session.acceptsTools, false);
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
  receipt("new-native-input"); await input; await settle();
  assert.ok(session.current, "an earlier idle cannot complete an uncorrelated prompt");
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "running" });
  assert.equal(session.acceptsTools, true);
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
  await settle();
  assert.equal(session.busy, false);
});

test("an exact native echo preceding running keeps that execution's end until its response, even across another run", async t => {
  const { session, hub, state, B, settle } = setup(t);
  const backend = await session.ensureBackend();
  session.expectAsyncReplyRun("prior-turn");
  let receipt!: (id: string) => void;
  (backend as any).prompt = () => new Promise<string>(resolve => receipt = resolve);
  const input = hub.delivery.fromUser(session, [text("new input")], { kind: "user", messageId: "echo-before-running" });
  await settle();
  session.onBackendUpdate({ sessionUpdate: "user_message", messageId: "new-native-input", content: [text("new input")] });
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "running" });
  assert.equal(session.acceptsTools, false, "a native ID alone cannot authorize the Hub input");
  session.onBackendUpdate({ sessionUpdate: "agent_message_chunk", content: text("before correlation") });
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "running" });
  assert.equal(session.acceptsTools, false);
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "error", error: { code: -32603, message: "unrelated failure" } });
  assert.ok(session.current);
  receipt("new-native-input"); await input; await settle();
  assert.equal(session.busy, false);
  const task = [...state.tasks.values()].find(task => task.to.sessionId === B.sessionId)!;
  assert.equal(task.status, "completed", "the matched window supplies its own end");
  const output = metas(state, B).find(u => u.content?.text === "before correlation");
  assert.equal(output._meta[RunExt.key].turnId, null);
  assert.equal(state.ledger.get("echo-before-running")?.state, "inserted");
});

test("an insertion receipt claims an unowned run from that point, preserving earlier output attribution", async (t) => {
  const { session, state, hub, B, settle, hooks } = setup(t);
  const backend = await session.ensureBackend();
  const owners: (string | null)[] = [];
  hooks.on("acp.run_started", ({ run }: any) => { owners.push(run.turnId); });
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "running" });
  session.onBackendUpdate({ sessionUpdate: "agent_message_chunk", content: text("before insertion") });
  let receipt!: () => void;
  (backend as any).prompt = () => new Promise<void>(resolve => { receipt = resolve; });
  const sent = hub.delivery.fromUser(session, [text("join this execution")], { kind: "user", messageId: "claim-run" });
  await settle();
  const turn = session.current!;
  session.onBackendUpdate({ sessionUpdate: "user_message_chunk", messageId: "echo-claim", content: text("join ") });
  assert.equal(turn.inserted, false);
  session.onBackendUpdate({ sessionUpdate: "user_message_chunk", messageId: "echo-claim", content: text("this execution"), _meta: { [OriginExt.key]: { messageId: "claim-run" } } });
  assert.equal(turn.inserted, true);
  assert.equal(session.acceptsTools, true);
  session.onBackendUpdate({ sessionUpdate: "agent_message_chunk", content: text("after insertion") });
  receipt(); await sent;
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
  await settle();
  const output = metas(state, B).filter(u => u.sessionUpdate === "agent_message_chunk");
  assert.deepEqual(owners, [null, turn.id]);
  assert.equal(output[0]._meta[RunExt.key].id, output[1]._meta[RunExt.key].id);
  assert.deepEqual(output.map(u => u._meta[RunExt.key].turnId), [null, turn.id]);
  assert.equal(session.busy, false);
  const task = [...state.tasks.values()].find(task => task.to.sessionId === B.sessionId)!;
  assert.doesNotMatch(task.result!, /before insertion/);
  assert.match(task.result!, /after insertion/);
});

test("owned execution can end before its prompt receipt without losing the turn end", async (t) => {
  const { session, hub, settle } = setup(t);
  const backend = await session.ensureBackend();
  (backend as any).prompt = async () => {
    session.onBackendUpdate({ sessionUpdate: "state_update", state: "running" });
    session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
  };
  await hub.delivery.fromUser(session, [text("quick work")], { kind: "user", messageId: "quick-run" });
  await settle();
  assert.equal(session.busy, false);
});

test("a turn waits for pending prompt receipts and can own several backend executions", async (t) => {
  const { session, hub, settle, hooks } = setup(t);
  const backend = await session.ensureBackend();
  await hub.delivery.fromUser(session, [text("first")], { kind: "user", messageId: "multi-first" });
  await settle();
  const turn = session.current!, runs: any[] = [];
  hooks.on("acp.run_started", (event: any) => { runs.push(event.run); });
  let receipt!: () => void;
  (backend as any).prompt = () => new Promise<void>(resolve => { receipt = resolve; });
  const later = hub.delivery.fromUser(session, [text("later")], { kind: "user", messageId: "multi-later" });
  await settle();
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
  assert.equal(session.current, turn, "pending receipt keeps the logical turn open");
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "running" });
  // This execution also ends before its prompt receipt. Its end belongs to this same turn.
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
  assert.equal(session.current, turn);
  receipt(); await later; await settle();
  assert.deepEqual(runs.map(run => run.turnId), [turn.id]);
  assert.equal(session.busy, false);
});

test("running never associates a later queued prompt with the first prompt's execution", async (t) => {
  const { session, hub, settle } = setup(t);
  const backend = await session.ensureBackend();
  (backend as any).prompt = async () => {};
  await hub.delivery.fromUser(session, [text("first")], { kind: "user", messageId: "early-first" });
  await settle();
  const turn = session.current!;
  let receipt!: () => void;
  (backend as any).prompt = () => new Promise<void>(resolve => { receipt = resolve; });
  const later = hub.delivery.fromUser(session, [text("later")], { kind: "user", messageId: "early-later" });
  await settle();
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "running" });
  assert.equal(turn.inputs.find(i => i.messageId === "early-later")!.runId, undefined);
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
  receipt(); await later; await settle();
  assert.equal(session.current, turn);
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "running" });
  assert.equal(session.acceptsTools, true);
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
  await settle();
  assert.equal(session.busy, false);
});

test("user corrections still join and protect a pending turn while backend execution is unowned", async (t) => {
  const { session, hub, settle } = setup(t);
  const backend = await session.ensureBackend();
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "running" });
  let receipt!: () => void;
  (backend as any).prompt = () => new Promise<void>(resolve => { receipt = resolve; });
  const first = hub.delivery.fromUser(session, [text("first")], { kind: "user", messageId: "pending-first" });
  await settle();
  const turn = session.current!;
  const correction = hub.delivery.fromUser(session, [text("correction")], { kind: "user", messageId: "pending-correction" });
  await settle();
  assert.equal(session.current, turn);
  assert.equal(turn.protected, true);
  assert.ok(turn.inputs.some(i => i.messageId === "pending-correction"));
  assert.equal(session.acceptsTools, false);
  receipt(); await first; await settle();
  session.onBackendUpdate({ sessionUpdate: "user_message_chunk", messageId: "echo-correction", content: text("correction"), _meta: { [OriginExt.key]: { messageId: "pending-correction" } } });
  await correction;
  assert.equal(session.current, turn);
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
  await settle();
  assert.equal(session.busy, false);
});

for (const policy of ["stop", "veto", "throw"]) test(`unowned execution policy ${policy} cancels the backend without creating work`, async (t) => {
  const { session, state, effects, hooks, settle } = setup(t);
  await session.ensureBackend();
  hooks.decider("acp.pre_unowned_run", (p: any) => {
    if (policy === "throw") throw new Error("policy unavailable");
    return policy === "veto" ? { veto: "no autonomous work" } : { ...p, action: "stop" };
  });
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "running" });
  assert.deepEqual(effects, ["cancel"]);
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "cancelled" });
  await settle();
  assert.equal(session.busy, false);
  assert.equal(state.tasks.size, 0);
});

test("autonomous execution cannot ask for a pending turn's permissions", async (t) => {
  const { session } = setup(t);
  await session.ensureBackend();
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "running" });
  const result = await session.onBackendPermission({ sessionId: session.rec.backendSessionId!, title: "background write", options: [] } as any);
  assert.equal(result.outcome.outcome, "cancelled");
});

test("failed user input stays in history but is not automatically added to the next prompt", async (t) => {
  const { session, state, hub, settle, prompts, idle, B } = setup(t);
  const backend = await (session as any).ensureBackend();
  const real = backend.prompt;
  let refuse = true;
  backend.prompt = async (id: string, blocks: any[]) => {
    if (refuse) { refuse = false; throw new RpcError(-32603, "rate limited"); }
    return real(id, blocks);
  };
  const client: any = { echo: true };
  await assert.rejects(hub.delivery.fromUser(session, [text("FIRST")], { kind: "user", messageId: "u1" }, client), /rate limited/);
  await settle();
  assert.equal(session.rec.owed, undefined);
  assert.ok(metas(state, B).some(u => u._meta?.["dev.xsb/discarded"]?.messageId === "u1"));
  await hub.delivery.fromUser(session, [text("SECOND")], { kind: "user", messageId: "u2" }, client);
  await settle();
  assert.doesNotMatch(prompts.at(-1)!, /(?:^|\n)FIRST(?:\n|$)|did not reach you/);
  idle(); await settle();
  await hub.delivery.fromUser(session, [text("FIRST")], { kind: "user", messageId: "u3", resendOf: "u1" }, client);
  assert.match(prompts.at(-1)!, /FIRST/);
});

test("sending the same message again (its answer was lost) reaches the model once, and xsb says what became of it", async (t) => {
  const { session, state, hub, settle, prompts, idle, B } = setup(t);
  const client: any = { echo: true };
  const first = hub.delivery.fromUser(session, [text("ONCE")], { kind: "user", messageId: "d1" }, client);
  const again = hub.delivery.fromUser(session, [text("ONCE")], { kind: "user", messageId: "d1" }, client);
  await settle();
  assert.deepEqual(await Promise.all([first, again]), [{ messageId: "d1" }, { messageId: "d1" }]);
  idle(); await settle();
  assert.deepEqual(await hub.delivery.fromUser(session, [text("ONCE")], { kind: "user", messageId: "d1" }, client), { messageId: "d1" });
  assert.equal(prompts.filter((p) => p.includes("ONCE")).length, 1);
  const status = hub.delivery.status(["d1", "never-sent"]);
  assert.equal(status["never-sent"], "unknown");
  assert.ok(["inserted", "seen"].includes(status.d1));
  // Recorded as waiting first, then as in the conversation, under the same id: a reader sees it waiting until it is in.
  const updates = metas(state, B);
  const accepted = updates.findIndex((u) => u._meta?.["dev.xsb/accepted"]?.messageId === "d1");
  const inserted = updates.findIndex((u) => u.sessionUpdate === "user_message_chunk" && u.messageId === "d1");
  assert.ok(accepted >= 0 && inserted > accepted);
  assert.equal(updates.filter((u) => u._meta?.["dev.xsb/accepted"]?.messageId === "d1").length, 1);
});

test("a user stop records what it took from the model: queued user mail is shown as not seen, not dropped silently", async (t) => {
  const { session, state, hub, settle, B, give, A, idle, holdPrompts } = setup(t);
  give(A, B, "work"); await settle();
  holdPrompts();
  const client: any = { echo: true };
  const waiting = hub.delivery.fromUser(session, [text("LATER")], { kind: "user", messageId: "s1" }, client);
  await settle();
  hub.delivery.userStop(session);
  idle("cancelled");
  await settle();
  await assert.rejects(waiting);
  const records = metas(state, B).map((u) => u._meta?.["dev.xsb/discarded"]).filter((d: any) => d?.messageId === "s1");
  assert.equal(records.length, 1, "one record of it");
  assert.equal(records[0].reason, "stopped");
  assert.ok(!records[0].owed, "a stop is the user's choice: not given later");
});

test("while the hub stops, a turn that could not start keeps its input in the inbox for the next start", async (t) => {
  const { session, state, hub, settle, B } = setup(t);
  (session as any).ensureBackend = async () => { hub.stopping = true; throw new Error("the agent program is gone"); };
  const client: any = { echo: true };
  void hub.delivery.fromUser(session, [text("KEEP")], { kind: "user", messageId: "k1" }, client).catch(() => {});
  await settle();
  assert.ok(state.mail.has("k1"), "still in the inbox");
  assert.notEqual(state.ledger.get("k1")?.state, "discarded_unseen", "not recorded as never to be seen");
  assert.ok(!metas(state, B).some((u) => u._meta?.["dev.xsb/discarded"]?.messageId === "k1"));
});

test("a backend session named after xsb's own words does not rename the conversation", (t) => {
  const { session } = setup(t) as any;
  const title = (value: string) => { session.onBackendUpdate({ sessionUpdate: "session_info_update", title: value }); return session.rec.title; };
  assert.equal(title("做一支短片"), "做一支短片");
  for (const own of ["[xsb] This conversation had grown long, and goes on", "[xSB task conversation] {}", '<xsb-task from="director"', '{"excerpt":"[xsb] This session takes over']) {
    assert.equal(title(own), "做一支短片");
  }
  assert.equal(title("短片的分镜"), "短片的分镜");
});

test("native background steps finish under their original turn while a later turn executes", async (t) => {
  const { session, A, B, give, settle, hooks } = setup(t);
  const ended: any[] = [];
  hooks.on("step.ended", event => { ended.push(event); });
  give(A, B, "first"); await settle();
  const old = session.current!.id;
  session.onBackendUpdate({ sessionUpdate: "tool_call", toolCallId: "bg", title: "Background", status: "in_progress" });
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn", background: [{ type: "tool_call", toolCallId: "bg" }] });
  await settle();
  assert.equal(session.current, undefined, "background work does not extend a turn");
  assert.equal(ended.length, 0, "background step remains observable after foreground idle");
  give(A, B, "second"); await settle();
  const next = session.current!.id;
  session.onBackendUpdate({ sessionUpdate: "tool_call_update", toolCallId: "bg", status: "completed", _meta: { [TurnExt.key]: { id: old } } });
  await settle();
  assert.equal(session.current!.id, next);
  assert.equal(session.current!.executed, undefined, "old tool update is not execution evidence for the new turn");
  assert.equal(ended.length, 1);
  assert.equal(ended[0].source.turnId, old);
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn", background: [] });
  await settle();
});

test("job provenance is durable before delayed dispatch and hooks cannot retarget its turn", async (t) => {
  const { session, A, B, give, settle, kernel, state, dir, hooks } = setup(t);
  give(A, B, "create work"); await settle();
  const old = session.current!.id;
  hooks.decider("task.pre_create", ({ task }) => ({ task: { ...task, source: { ...task.source, turnId: "spoof" } } }));
  const job = kernel.createJob(B, { title: "job", topic: "topic", tool: { server: "render", name: "render", arguments: {} } });
  assert.ok(!isVeto(job));
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
  await settle();
  assert.equal(state.tasks.get(job.id)!.source?.turnId, old);
  const restored = new State(new Store(new Paths(dir).dir)); restored.load();
  assert.equal(restored.tasks.get(job.id)!.source?.turnId, old);
});

test("user prompts wait for each real insertion receipt, without waiting for turn completion", async (t) => {
  const { session, hub, settle, state } = setup(t);
  const backend = await session.ensureBackend();
  const replies: ((id: string) => void)[] = [];
  const offered: string[] = [];
  (backend as any).prompt = (_id: string, _blocks: any[], origin: any) => {
    offered.push(origin.messageId);
    return new Promise<string>(resolve => replies.push(resolve));
  };
  const first = hub.delivery.fromUser(session, [text("first")], { kind: "user", messageId: "serial-first" }); await settle();
  const second = hub.delivery.fromUser(session, [text("second")], { kind: "user", messageId: "serial-second" });
  const third = hub.delivery.fromUser(session, [text("third")], { kind: "user", messageId: "serial-third" }); await settle();
  assert.deepEqual(offered, ["serial-first"]);
  assert.equal(session.current!.protected, true);
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "running" });
  session.onBackendUpdate({ sessionUpdate: "agent_message_chunk", content: text("old output") });
  assert.deepEqual(offered, ["serial-first"], "output cannot release the input slot");
  replies[0]("native-first"); await first; await settle();
  assert.deepEqual(offered, ["serial-first", "serial-second"]);
  replies[1]("native-second"); await second; await settle();
  assert.deepEqual(offered, ["serial-first", "serial-second", "serial-third"]);
  replies[2]("native-third"); await third; await settle();
  assert.equal(state.ledger.get("serial-third")?.state, "inserted");
});

test("a targeted standard prompt inserted before idle may acknowledge after idle without losing completion", async (t) => {
  const { session, hub, give, A, B, settle, effects } = setup(t);
  give(A, B, "first"); await settle();
  const backend = await session.ensureBackend();
  let receipt!: (id: string) => void;
  (backend as any).prompt = () => new Promise<string>(resolve => receipt = resolve);
  const appended = hub.delivery.append(session, session.current!.id, A, "apply before finishing");
  await settle();
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
  receipt("late append response"); await appended; await settle();
  assert.equal(session.busy, false);
  assert.ok(!effects.includes("revoke"), "an inserted append does not need expiry isolation");
});

test("an exact prompt receipt settles an unowned execution that already ended without replay or retroactive ownership", async (t) => {
  const { session, hub, state, B, settle } = setup(t);
  const backend = await session.ensureBackend();
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "running" });
  let receipt!: (id: string) => void;
  (backend as any).prompt = () => new Promise<string>(resolve => receipt = resolve);
  const input = hub.delivery.fromUser(session, [text("input")], { kind: "user", messageId: "late-owned-input" });
  await settle();
  session.onBackendUpdate({ sessionUpdate: "user_message_chunk", messageId: "native-input", content: text("input") });
  session.onBackendUpdate({ sessionUpdate: "agent_message_chunk", content: text("before the response") });
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
  assert.ok(session.current, "wait for exact insertion correlation");
  receipt("native-input"); await input; await settle();
  assert.equal(session.busy, false);
  const output = metas(state, B).find(u => u.sessionUpdate === "agent_message_chunk" && u.content.text === "before the response");
  assert.equal(output._meta[RunExt.key].turnId, null, "already displayed output keeps its original attribution");
  assert.equal(state.ledger.get("late-owned-input")?.state, "inserted", "completion does not add a model-read claim");
});

test("only the queue head can be sent now and its in-flight receipt blocks the next head", async t => {
  const { hub, session, state, hooks, A, B, give, settle, holdPrompts, acceptHeld } = setup(t);
  await hub.delivery.fromUser(session, [text("user work")], { kind: "user", messageId: "owner" });
  await settle();
  const one = give(A, B, "first queued"), two = give(A, B, "second queued"), three = give(A, B, "third queued");
  await settle();
  const idOf = (task: Task) => [...state.mail.values()].find(m => m.taskId === task.id)!.id;
  const firstId = idOf(one), secondId = idOf(two), thirdId = idOf(three);
  const view = (id: string) => metas(state, B).filter(u => u._meta?.["dev.xsb/input_delivery"]?.messageId === id).at(-1)!._meta!["dev.xsb/input_delivery"];
  assert.equal(view(firstId).canSendNow, true);
  assert.equal(view(secondId).isHead, false);
  assert.throws(() => session.sendQueued(secondId, session.current!.id), /queue head/);
  assert.throws(() => session.sendQueued(firstId, "stale-turn"), /queue head/);
  holdPrompts();
  const turn = session.current!;
  session.sendQueued(firstId, turn.id);
  assert.equal(view(firstId).state, "sending");
  assert.equal(view(secondId).isHead, false, "the unsettled first item reserves the head");
  assert.throws(() => session.sendQueued(secondId, turn.id), /queue head/);
  assert.throws(() => session.cancelQueued(firstId), /no longer queued/);
  session.cancelQueued(thirdId);
  await settle();
  assert.equal(state.tasks.get(three.id)?.status, "cancelled");
  acceptHeld(firstId); await settle();
  assert.equal(session.current, turn);
  assert.equal(turn.protected, true);
  assert.equal(state.ledger.get(firstId)?.state, "inserted");
  assert.equal(view(secondId).canSendNow, true);
  void hub.delivery.fromUser(session, [text("another user correction")], { kind: "user", messageId: "serial-extra" }).catch(() => {});
  await settle();
  assert.equal(view(secondId).canSendNow, false, "a user prompt reserves the same transport slot");
  acceptHeld("serial-extra"); await settle();
  assert.equal(view(secondId).canSendNow, true);
  hooks.decider("task.pre_stop", p => {
    assert.throws(() => session.sendQueued(secondId, turn.id), /queue head/, "a cancellation cannot be raced by a reentrant send-now");
    return p;
  });
  session.cancelQueued(secondId); await settle();
  assert.equal(state.tasks.get(two.id)?.status, "cancelled");
  assert.ok(!state.mail.has(thirdId));
});

test("a durable insertion cannot survive without its history when storage fails between transaction records", async t => {
  const { hub, session, state, settle, dir, B } = setup(t);
  const backend = await session.ensureBackend();
  (backend as any).prompt = () => new Promise(() => {});
  void hub.delivery.fromUser(session, [text("durable original")], { kind: "user", messageId: "atomic-input" }).catch(() => {});
  await settle();
  const input = session.current!.first;
  state.store.failpoint = at => { if (at === "after-op-0") throw new Error("power lost"); };
  assert.throws(() => (session as any).receipt(input, true), /power lost/);
  const restored = new State(new Store(new Paths(dir).dir)); restored.load();
  assert.equal(restored.ledger.get("atomic-input")?.state, "inserted");
  assert.ok(metas(restored, B).some(u => u.sessionUpdate === "user_message_chunk" && u.messageId === "atomic-input"));
});

test("acceptance is durable with the mailbox before any backend submission", async t => {
  const { hub, session, state, prompts, dir, B } = setup(t);
  state.store.failpoint = at => { if (at === "after-op-0") throw new Error("power lost during acceptance"); };
  await assert.rejects(hub.delivery.fromUser(session, [text("original before send")], { kind: "user", messageId: "atomic-accept" }), /power lost/);
  assert.deepEqual(prompts, []);
  const restored = new State(new Store(new Paths(dir).dir)); restored.load();
  assert.ok(restored.mail.has("atomic-accept"));
  assert.ok(metas(restored, B).some(u => u._meta?.["dev.xsb/accepted"]?.messageId === "atomic-accept"));
});

test("restart withdraws unsent, in-flight and blocked old work without releasing a successor", async t => {
  const first = setup(t);
  const backend = await first.session.ensureBackend();
  (backend as any).prompt = () => new Promise(() => {});
  void first.hub.delivery.fromUser(first.session, [text("old user input")], { kind: "user", messageId: "restart-first" }).catch(() => {});
  await first.settle();
  void first.hub.delivery.fromUser(first.session, [text("old queued correction")], { kind: "user", messageId: "restart-second" }).catch(() => {});
  await first.settle();
  const root = first.kernel.userTask(first.B.sessionId)!;
  const blocked = first.give(first.A, first.B, "old blocked", [root.id]);
  const second = setup(t, first.dir);
  second.kernel.resume(); await second.settle();
  assert.deepEqual(second.prompts, []);
  assert.equal(second.state.tasks.get(blocked.id)?.status, "failed");
  for (const id of ["restart-first", "restart-second"]) {
    assert.ok(!second.state.mail.has(id));
    assert.ok(metas(second.state, second.B).some(u => u._meta?.["dev.xsb/discarded"]?.messageId === id && u._meta["dev.xsb/discarded"].reason === "interrupted"));
  }
});

test("disconnect during user stop remains unconfirmed instead of claiming the model never received it", async t => {
  const { hub, session, state, settle, B } = setup(t);
  const backend = await session.ensureBackend();
  (backend as any).prompt = () => new Promise(() => {});
  const waiting = hub.delivery.fromUser(session, [text("possibly inserted")], { kind: "user", messageId: "stop-uncertain" }).catch(() => {});
  await settle();
  hub.delivery.userStop(session);
  session.onBackendGone(backend, "disconnected during stop");
  await settle(); await waiting;
  assert.equal(state.ledger.get("stop-uncertain")?.state, "insertion_uncertain");
  assert.ok(metas(state, B).some(u => u._meta?.["dev.xsb/discarded"]?.messageId === "stop-uncertain" && u._meta["dev.xsb/discarded"].reason === "uncertain"));
});
