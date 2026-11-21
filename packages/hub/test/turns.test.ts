import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { text, TurnExt, RpcError } from "@xsb/protocol";
import type { Addr, Task } from "@xsb/protocol";
import { Store } from "@xsb/store";
import { Delivery } from "../src/delivery.ts";
import { Hooks, isVeto } from "../src/hooks.ts";
import { Kernel, USER } from "../src/kernel.ts";
import { Paths } from "../src/paths.ts";
import { LiveSession } from "../src/session.ts";
import { State, ops } from "../src/state.ts";
import type { MailItem } from "../src/state.ts";
import { callTool } from "../src/tools.ts";
import { contextRef, textTokens } from "../src/context.ts";

function setup(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-turns-"));
  const paths = new Paths(dir), state = new State(new Store(paths.dir));
  state.load();
  const A = { agentId: "a", sessionId: "sa" }, B = { agentId: "b", sessionId: "sb" }, C = { agentId: "c", sessionId: "sc" };
  for (const to of [A, B, C]) state.commit([
    ops.putAgent({ id: to.agentId, name: to.agentId, description: "", backend: "mock", workspace: dir, createdAt: "" }),
    ops.putSession({ id: to.sessionId, agentId: to.agentId, main: true, createdAt: "", updatedAt: "" }),
  ]);
  const hooks = new Hooks<any, any>({ log() {}, vetoed() {}, deadLetter(_point, _event, error) { throw error; } });
  const effects: string[] = [], prompts: string[] = [];
  const hub: any = {
    state, paths, live: new Map(), stopping: false,
    agentChanged() {}, log() {}, permissions: { cancel() {} },
    agent: (id: string) => state.agents.get(id), role: () => ({ grants: ["dispatch", "message"], skills: [] }),
    toolServers: () => [{ from: "role", server: { name: "render" } }],
    rotateBridge() { effects.push("revoke"); }, backends: { stop() { effects.push("stop process"); } },
  };
  const kernel = new Kernel(state, hooks, (to) => hub.delivery.recipient(to));
  hub.kernel = kernel;
  hub.delivery = new Delivery(hub);
  for (const to of [A, B, C]) {
    const session = new LiveSession(hub, state.sessions.get(to.sessionId)!);
    hub.live.set(to.sessionId, session);
    let generation = 0;
    const backend = {
      caps: { steering: true, orderedCancellation: true },
      async prompt(_id: string, blocks: any[]) {
        prompts.push(blocks.map((b) => b.text).join("\n"));
        session.onBackendUpdate({ sessionUpdate: "state_update", state: "running" });
        return "receipt";
      },
      async steer() { return "injected"; },
      cancel() { effects.push("cancel"); }, close(id: string) { effects.push(`close ${id}`); }, stop() { effects.push("close transport"); },
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
  const unread = (id: string, user = false) => {
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
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, paths, state, hooks, kernel, hub, effects, prompts, A, B, C, session, give, settle, stop, idle, unread };
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
  kernel.complete(task, "completed", "already done", []);
  await settle();
  assert.equal(session.busy, false);
  assert.equal(prompts.length, 0);
  assert.equal(state.tasks.get(task.id)!.status, "completed");
});

test("a queued task completed by its executor is discarded at dequeue instead of run again", async (t) => {
  const { kernel, state, A, B, give, settle, idle, prompts, session } = setup(t);
  give(A, B, "current"); await settle();
  const task = give(A, B, "queued but already completed"); await settle();
  kernel.complete(task, "completed", "done in the current work", []);
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
  session.onBackendUpdate({ sessionUpdate: "user_message", messageId: "first", content: [text("late receipt")] });
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
  assert.ok(!isVeto(child)); await settle();
  idle(); await settle();
  assert.equal(state.tasks.get(foreign.id)!.status, "running");
  const own = give(A, B, "own work"); await settle();
  assert.ok(session.taskIds().includes(foreign.id));
  const replacement = give(A, B, "replacement");
  assert.deepEqual(kernel.replace(replacement, session.current!.id), []);
  await settle();
  assert.equal(state.tasks.get(own.id)!.status, "running");
  assert.equal(state.tasks.get(foreign.id)!.status, "running");
  assert.equal(state.tasks.get(replacement.id)!.status, "queued");
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
  assert.ok(prompts.findIndex((p) => p.includes('title="replacement"')) < prompts.findIndex((p) => p === "one"));
});

test("explicit stop recovers mixed unread prompts in order, including when the queue was empty", async (t) => {
  const { A, B, session, give, settle, stop, idle, unread } = setup(t);
  const old = give(A, B, "old"); await settle();
  unread("agent one"); unread("user", true); unread("agent two");
  stop(old); await settle(); idle("cancelled"); await settle();
  assert.equal(session.current!.first.messageId, "agent one");
  idle(); await settle(); assert.equal(session.current!.first.messageId, "user");
  assert.equal(session.current!.protected, true);
  idle(); await settle(); assert.equal(session.current!.first.messageId, "agent two");
});

test("committed stops reject jobs and dispatch before the halt observer runs", async (t) => {
  const { state, kernel, hub, A, B, C, session, give, settle, stop } = setup(t);
  const old = give(A, B, "old"); await settle();
  stop(old);
  assert.equal(session.current!.cancelledBy, undefined, "halt has not run yet");
  assert.equal(session.acceptsTools, false);
  assert.ok(isVeto(kernel.createJob(B, { title: "late", topic: "late", tool: { server: "render", name: "render", arguments: {} } })));
  assert.ok(isVeto(kernel.dispatch(B, C, { title: "late", topic: "late", instructions: "late", after: [] })));
  const result = await callTool(hub, session, "start_job", { server: "render", tool: "render", title: "late" });
  assert.equal(result.isError, true);
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
  kernel.complete(state.tasks.get(middle.id)!, "completed", "middle done", []);
  kernel.complete(state.tasks.get(root.id)!, "completed", "root done", []);
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
  const { hub, state, A, B, session, give, settle, idle, effects } = setup(t);
  const old = give(A, B, "old"); await settle();
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
  const { hub, state, A, B, session, give, settle, stop, idle, effects } = setup(t);
  const old = give(A, B, "old"); await settle();
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
  assert.ok(!isVeto(child)); await settle();
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
