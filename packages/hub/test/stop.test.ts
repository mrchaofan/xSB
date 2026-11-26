import assert from "node:assert/strict";
import { contextPolicy } from "../src/context.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Addr, Task } from "@xsb/protocol";
import { Store } from "@xsb/store";
import { Hooks, isVeto } from "../src/hooks.ts";
import { Kernel, USER } from "../src/kernel.ts";
import { State, ops } from "../src/state.ts";
import type { Input } from "../src/session.ts";

function setup(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-stop-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = new State(new Store(dir));
  state.load();
  const A = { agentId: "a", sessionId: "sa" }, B = { agentId: "b", sessionId: "sb" }, C = { agentId: "c", sessionId: "sc" };
  for (const to of [A, B, C]) state.commit([
    ops.putAgent({ id: to.agentId, name: to.agentId, description: "", backend: "mock", workspace: dir, createdAt: "" }),
    ops.putSession({ id: to.sessionId, agentId: to.agentId, main: true, createdAt: "", updatedAt: "" }),
  ]);
  const hooks = new Hooks<any, any>({ log() {}, vetoed() {}, deadLetter() {} });
  const busy = new Set<string>();
  const kernel = new Kernel(state, hooks, (to) => ({ exists: true, busy: busy.has(to.sessionId), awaits: () => false }));
  const give = (from: Addr, to: Addr, title: string, extra: Partial<Task> = {}) => {
    const task = kernel.dispatch(from, to, { title, topic: title, instructions: title, after: [], ...extra });
    assert.ok(!isVeto(task));
    return task;
  };
  const hand = (task: Task) => { kernel.started(task.id); return state.tasks.get(task.id)!; };
  const stopped = (task: Task) => state.tasks.get(task.id)!.status === "cancelled";
  return { dir, state, hooks, busy, kernel, A, B, C, give, hand, stopped };
}

test("user stop cancels the entire accepted backlog before after can release it", async (t) => {
  const { state, hooks, busy, kernel, A, B, C, give, hand, stopped } = setup(t);
  const running = hand(give(A, B, "running"));
  busy.add(B.sessionId);
  const queued = give(C, B, "queued");
  const blocked = give(A, B, "blocked", { after: [running.id] });
  const message = kernel.post({ to: B, from: { kind: "agent", ...C }, kind: "message", content: "old instructions", pref: "wake" }).item;
  const changed: Task[] = [];
  hooks.on("task.changed", (task) => { changed.push(task); });
  assert.ok(!isVeto(kernel.stopSession(B, [])));
  hooks.emit("acp.turn_ended", { sessionId: B.sessionId, agentId: B.agentId, stopReason: "cancelled", failed: false });
  await hooks.settled();
  assert.ok([running, queued, blocked].every(stopped));
  assert.ok(!changed.some((task) => task.id === blocked.id && task.status === "queued"));
  assert.equal(state.mail.has(message.id), false);
  assert.equal(state.ledger.get(message.id)?.state, "discarded_unseen");
  assert.equal(kernel.generation(B.sessionId), 1);
  const fresh = give(A, B, "fresh");
  assert.equal(state.tasks.get(fresh.id)?.status, "queued");
});

test("an unowned run ending cannot confirm a stop that waits for a logical turn", async (t) => {
  const { state, hooks, busy, kernel, A, B, give, hand } = setup(t);
  const task = hand(give(A, B, "owned work"));
  busy.add(B.sessionId);
  assert.ok(!isVeto(kernel.stop(task, USER, { status: "cancelled", reason: "cancelled", result: "stop" })));
  hooks.emit("acp.run_ended", { ...B, run: { id: "background", turnId: null }, stopReason: "end_turn" });
  await hooks.settled();
  assert.ok(state.tasks.get(task.id)!.stopping);
  assert.equal(state.tasks.get(task.id)!.status, "running");
  hooks.emit("acp.turn_ended", { ...B, stopReason: "cancelled", failed: false });
  await hooks.settled();
  assert.equal(state.tasks.get(task.id)!.status, "cancelled");
});

test("union cancellation removes a child shared only by stopped roots, and preserves another holder", (t) => {
  const { state, kernel, A, B, C, give, hand, stopped } = setup(t);
  const one = hand(give(A, B, "one"));
  const two = hand(give(C, B, "two"));
  const both = give(B, C, "both");
  assert.deepEqual(both.parents, [one.id, two.id]);
  const independent = hand(give(A, C, "independent"));
  const shared = give(B, A, "shared");
  kernel.update({ ...shared, parents: [...shared.parents!, independent.id] });
  // update does not change graph edges; the original roots already index this child.
  kernel.stopSession(B, []);
  assert.ok([one, two, both].every(stopped));
  assert.equal(state.tasks.get(shared.id)?.status, "queued");
  assert.equal(state.tasks.get(independent.id)?.status, "running");
});

test("pending results survive as passive facts, but cancelled instructions do not reach the next digest", (t) => {
  const { state, kernel, A, B, give, hand } = setup(t);
  const work = hand(give(B, A, "finished", { deliveryPref: "wake" }));
  kernel.complete(work, "completed", "FACT", []);
  const oldResult = [...state.mail.values()].find((m) => m.results?.taskIds.includes(work.id))!;
  const message = kernel.post({ to: B, from: { kind: "agent", ...A }, kind: "message", content: "do old work" }).item;
  kernel.stopSession(B, []);
  assert.equal(state.mail.has(oldResult.id), false);
  assert.equal(state.mail.has(message.id), false);
  const result = kernel.inbox(B.sessionId).find((m) => m.results?.taskIds.includes(work.id));
  assert.ok(result);
  assert.equal(result.pref, "lazy");
  assert.equal(state.tasks.get(work.id)?.result, "FACT");
});

test("late results and retired subscriptions cannot revive stopped work, including after restart", (t) => {
  const { dir, state, hooks, kernel, A, B, C, give, hand } = setup(t);
  const work = hand(give(B, A, "late", { deliveryPref: "wake" }));
  const other = hand(give(B, C, "still running"));
  kernel.subscribe(B, [work, other], "all", "old wait");
  kernel.stopSession(B, []);
  assert.ok(![...state.gates.values()].some((g) => g.owner.sessionId === B.sessionId));
  const restored = new State(new Store(dir));
  restored.load();
  const resumed = new Kernel(restored, hooks, () => ({ exists: true, busy: false, awaits: () => false }));
  assert.equal(resumed.generation(B.sessionId), 1);
  resumed.complete(restored.tasks.get(work.id)!, "completed", "LATE FACT", []);
  const result = resumed.inbox(B.sessionId).find((m) => m.results?.taskIds.includes(work.id));
  assert.ok(result, "late result stays inboxed after recovery");
  assert.equal(restored.ledger.get(result.id)?.state, "inboxed");
  const fresh = resumed.dispatch(B, A, { title: "fresh", topic: "fresh", instructions: "fresh", after: [], deliveryPref: "wake" });
  assert.ok(!isVeto(fresh));
  resumed.started(fresh.id);
  resumed.complete(restored.tasks.get(fresh.id)!, "completed", "NEW", []);
  const newResult = [...restored.mail.values()].find((m) => m.results?.taskIds.includes(fresh.id))!;
  assert.equal(restored.ledger.get(newResult.id)?.state, "submitted", "new work retains wake delivery");
});

test("ordinary task cancellation preserves unrelated queued work", (t) => {
  const { state, kernel, A, B, C, give, hand, stopped } = setup(t);
  const running = hand(give(A, B, "cancel only this"));
  const queued = give(C, B, "keep this");
  const message = kernel.post({ to: B, from: { kind: "agent", ...C }, kind: "message", content: "keep message" }).item;
  kernel.stop(running, USER, { status: "cancelled", reason: "cancelled", result: "cancel one" });
  assert.ok(stopped(running));
  assert.equal(state.tasks.get(queued.id)?.status, "queued");
  assert.ok(state.mail.has(message.id));
  assert.equal(kernel.generation(B.sessionId), 0);
});

test("cancelled idle waits for an in-flight prompt's real insertion receipt", async (t) => {
  const { LiveSession } = await import("../src/session.ts");
  const { deferred } = await import("../src/util.ts");
  const { state, hooks, kernel, B, dir } = setup(t);
  const hub = {
    state, kernel, paths: { dir }, stopping: false,
    agentChanged() {}, log() {}, permissions: { cancel() {} }, policy: () => contextPolicy("mock"),
    delivery: { turnEnded() {} }, rotateBridge() {},
  };
  const session = new LiveSession(hub as any, state.sessions.get(B.sessionId)!);
  const input = (id: string, inserted: boolean): Input => ({
    messageId: id, origin: { kind: "user" as const, messageId: id },
    prompt: [{ type: "text" as const, text: id }], content: [{ type: "text" as const, text: id }],
    inserted: deferred<void>(), sent: "prompt" as const, in: inserted,
  });
  const first = input("first", true), pending = input("pending", false);
  pending.batch = [pending];
  const turn = { id: "old", protected: true, first, inputs: [first, pending], held: [], items: [], inserted: true, started: true, done: deferred<any>() };
  session.current = turn;
  Object.assign(session, { backend: { cancel() {}, caps: { steering: false, orderedCancellation: true } } });
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "running" });
  session.beginUserStop();
  session.cancelUserWork();
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "cancelled" });
  assert.equal(session.current, turn, "idle alone does not mislabel pending input as unseen");
  (session as any).landed([pending]);
  assert.equal(session.current, undefined);
  await hooks.settled();
  assert.equal(state.ledger.get("pending")?.state, "inserted_unprocessed");
});

test("stop timeout revokes the old tools and closes the backend before unfreezing", async (t) => {
  const { LiveSession } = await import("../src/session.ts");
  const { deferred } = await import("../src/util.ts");
  const { state, kernel, B, dir } = setup(t);
  const effects: string[] = [];
  const hub = {
    state, kernel, paths: { dir }, stopping: false,
    agentChanged() {}, log() {}, permissions: { cancel() {} }, policy: () => contextPolicy("mock"),
    delivery: { turnEnded() {} }, rotateBridge() { effects.push("revoke"); },
    backends: { stop() { effects.push("remove process"); } },
  };
  const session = new LiveSession(hub as any, state.sessions.get(B.sessionId)!);
  const first = {
    messageId: "timeout", origin: { kind: "user" as const, messageId: "timeout" },
    prompt: [], content: [], in: true, inserted: deferred<void>(),
  };
  session.current = { id: "old", protected: true, first, inputs: [first], held: [], items: [], inserted: true, started: true, done: deferred<any>() };
  Object.assign(session, { backend: { cancel() { effects.push("cancel"); }, stop() { effects.push("close transport"); } } });
  session.onBackendUpdate({ sessionUpdate: "state_update", state: "running" });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  session.beginUserStop();
  session.cancelUserWork();
  assert.equal(session.acceptsTools, false);
  t.mock.timers.tick(10_000);
  assert.deepEqual(effects, ["cancel", "revoke", "remove process", "close transport"]);
  assert.equal(session.current, undefined);
  assert.equal(session.acceptsTools, true);
});

test("an already attached MCP connection is rejected after its bridge is revoked", async (t) => {
  const { serveMcp, BRIDGE_ATTACH } = await import("../src/mcp.ts");
  const handlers = new Map<string, (params: any) => any>();
  const session = { current: { started: true }, acceptsTools: true };
  let valid = true;
  serveMcp({ agent:() => ({}) } as any, { onRequest(name: string, handler: (params: any) => any) { handlers.set(name, handler); } } as any, (token) => valid && token === "old" ? session as any : undefined);
  handlers.get(BRIDGE_ATTACH)!({ token: "old" });
  valid = false;
  await assert.rejects(handlers.get("tools/call")!({ name: "dispatch_task", arguments: {} }), /bridge revoked/);
});

test("an attached but idle/stopped MCP caller cannot detach new work from a stopped turn", async () => {
  const { serveMcp, BRIDGE_ATTACH } = await import("../src/mcp.ts");
  const handlers = new Map<string, (params: any) => any>();
  const session: any = { current: undefined, acceptsTools: true };
  serveMcp({ agent:() => ({}) } as any, { onRequest(name: string, handler: (params: any) => any) { handlers.set(name, handler); } } as any, () => session);
  handlers.get(BRIDGE_ATTACH)!({ token: "connected" });
  assert.ok(handlers.get("tools/list")!({}).tools.some((t: any) => t.name === "execute"), "schema discovery remains available before a turn");
  await assert.rejects(handlers.get("tools/call")!({ name: "start_job", arguments: {} }), /No active turn/);
  session.current = { started: false };
  await assert.rejects(handlers.get("tools/call")!({ name: "dispatch_task", arguments: {} }), /No active turn/);
  session.current.started = true;
  session.acceptsTools = false;
  await assert.rejects(handlers.get("tools/call")!({ name: "dispatch_task", arguments: {} }), /No active turn/);
});
