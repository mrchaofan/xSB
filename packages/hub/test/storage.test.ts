import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "@xsb/store";
import { Hub } from "../src/hub.ts";
import { State, ops, F } from "../src/state.ts";
import { empty, adopt, normalize } from "../src/workflow-state.ts";
import { turnsSinceCleared } from "../src/transcript.ts";

function scratch(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-storage-"));
  const prior = process.env.XSB_HOME;
  process.env.XSB_HOME = path.join(dir, "global");
  t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); if (prior === undefined) delete process.env.XSB_HOME; else process.env.XSB_HOME = prior; });
  return dir;
}
function hub(t: test.TestContext) {
  const h = new Hub(path.join(scratch(t), "project")); h.stopping = true;
  t.after(async () => { await h.kernel.hooks.settled(); await h.backends.close(); });
  return h;
}

test("failed clear restores the session and replays its durable boundary on restart", t => {
  const h = hub(t), s = h.createConversation();
  s.save({ backendSessionId: "before", conversed: true });
  s.emit({ sessionUpdate: "user_message_chunk", messageId: "m", content: { type: "text", text: "old" } });
  const original = s.rec;
  h.state.store.failpoint = point => { if (point === "after-op-0") throw Error("interrupted clear"); };
  assert.throws(() => s.clear(), /interrupted clear/);
  assert.equal(s.rec, original);
  const restored = new Hub(h.paths.project); restored.stopping = true;
  assert.equal(restored.session(s.id).rec.backendSessionId, undefined);
  assert.deepEqual(turnsSinceCleared(restored.state.store, s.agentId, s.id), []);
});

test("turn settlement recovers both consumed mail and its task outcome", async t => {
  const h = hub(t), s = h.createConversation();
  const task = h.kernel.dispatchUser({ agentId: s.agentId, sessionId: s.id }, [{ type: "text", text: "request" }], "m", "request");
  assert.ok(!("veto" in task)); h.kernel.started(task.id); await h.kernel.hooks.settled();
  h.state.store.failpoint = point => { if (point === "after-op-0") throw Error("interrupted settlement"); };
  assert.throws(() => h.kernel.turnEnded(s.id, "end_turn", () => "done", undefined, ["m"]), /interrupted settlement/);
  assert.ok(h.state.mail.has("m")); assert.equal(h.state.tasks.get(task.id)?.status, "running");
  const restored = new Hub(h.paths.project); restored.stopping = true;
  assert.equal(restored.state.mail.has("m"), false); assert.equal(restored.state.tasks.get(task.id)?.status, "completed");
});

test("workflow stop atomically pauses the graph and cancels its user backlog", async t => {
  const h = hub(t), s = h.createConversation(), flow = empty(s.id);
  adopt(flow, { graphJsonl: [{ node: "A", prompt: "A" }, { node: "E", kind: "end" }, { from: "A", to: "E" }].map(v => JSON.stringify(v)).join("\n") }, false); normalize(flow);
  h.state.commit([ops.workflow(flow)]);
  const task = h.kernel.dispatchUser({ agentId: s.agentId, sessionId: s.id }, [{ type: "text", text: "request" }], "m", "request");
  assert.ok(!("veto" in task)); await h.kernel.hooks.settled();
  h.state.store.failpoint = point => { if (point === "after-op-0") throw Error("interrupted stop"); };
  assert.throws(() => h.workflows.userStop(s), /interrupted stop/);
  assert.equal(h.state.workflows.get(s.id)?.paused, false);
  const restored = new Hub(h.paths.project); restored.stopping = true;
  assert.equal(restored.state.workflows.get(s.id)?.paused, true);
  assert.equal(restored.state.sessions.get(s.id)?.workGeneration, 1);
  assert.equal(restored.state.mail.has("m"), false);
  assert.equal(restored.state.tasks.get(task.id)?.status, "cancelled");
});

test("compaction preserves graph, deduplication, topic counts, workflow deltas and transcript offsets", t => {
  const h = hub(t), s = h.createConversation(), flow = empty(s.id);
  h.state.commit([ops.workflow(flow)]);
  const changed = structuredClone(flow); changed.receipts.r = { ok: true }; changed.paused = true;
  h.state.commit([ops.workflow(changed)]);
  assert.equal(h.state.store.read(F.workflows).at(-1)?.op, "patch");
  s.emit({ sessionUpdate: "user_message_chunk", messageId: "m", content: { type: "text", text: "history" } });
  const file = `agents/${s.agentId}/sessions/${s.id}.jsonl`, transcript = h.state.store.read(file);
  h.state.commit([ops.enqueue({ id: "mail", to: { agentId: s.agentId, sessionId: s.id }, from: { kind: "agent", agentId: "peer", sessionId: "peer-session" }, kind: "message", topic: "topic", content: "one", ts: "now" }), ops.mark({ messageId: "consumed", agentId: s.agentId, sessionId: s.id, from: { kind: "user" }, state: "seen", ts: "now" })]);
  h.state.compact();
  assert.equal(h.state.store.deltaBytes(F.agents), 0);
  assert.equal(h.state.store.deltaBytes(F.workflows), 0);
  h.state.commit([ops.enqueue({ id: "later", to: { agentId: s.agentId, sessionId: s.id }, from: { kind: "agent", agentId: "peer", sessionId: "peer-session" }, kind: "message", topic: "topic", content: "two", ts: "later" })]);
  const after = new Hub(h.paths.project); after.stopping = true;
  assert.equal(after.state.store.deltaBytes(F.agents), 0);
  assert.ok(after.state.store.deltaBytes(F.mailbox) > 0);
  assert.deepEqual(after.state.store.read(file), transcript);
  assert.equal(after.state.ledger.get("consumed")?.state, "seen");
  assert.equal(after.state.topics.get(s.agentId)?.get("topic")?.peers.get("peer")?.count, 2);
  assert.deepEqual(after.state.workflows.get(s.id), changed);
});

test("snapshot publication restores an entire generation at every interruption point", t => {
  const dir = scratch(t);
  for (const point of ["after-snapshot-file-0", "before-snapshot-publish", "after-snapshot-publish"]) {
    const root = path.join(dir, point), store = new Store(root);
    store.tx([{ file: "a.jsonl", rec: { value: 1 } }, { file: "b.jsonl", rec: { value: 1 } }]);
    store.failpoint = at => { if (at === point) throw Error("crash"); };
    assert.throws(() => store.compact({ "a.jsonl": [{ value: 2 }], "b.jsonl": [{ value: 2 }] }));
    const after = new Store(root); after.recover();
    const expected = point === "after-snapshot-publish" ? 2 : 1;
    assert.equal(after.read("a.jsonl").at(-1)?.value, expected); assert.equal(after.read("b.jsonl").at(-1)?.value, expected);
  }
});

test("project relocation keeps identity and resolves managed paths while preserving external paths", async t => {
  const dir = scratch(t), first = path.join(dir, "old"), second = path.join(dir, "new"), h = new Hub(first); h.stopping = true;
  const s = h.createConversation(); s.save({ backendSessionId: "old-binding", conversed: true });
  const asset = path.join(h.paths.assets, "test.txt"), external = path.join(dir, "external.txt");
  fs.mkdirSync(h.paths.assets, { recursive: true }); fs.writeFileSync(asset, "value");
  h.state.commit([ops.putAsset({ id: "workflow/a", name: "a", version: 1, type: "workflow", path: asset, by: s.agentId, description: "a", createdAt: "" }), ops.putAsset({ id: "workflow/b", name: "b", version: 1, type: "workflow", path: external, by: s.agentId, description: "b", createdAt: "" })]);
  await h.kernel.hooks.settled(); fs.renameSync(first, second);
  const after = new Hub(second); after.stopping = true;
  assert.equal(after.paths.projectId, h.paths.projectId);
  assert.equal(after.agent(s.agentId).workspace, second);
  assert.equal(after.state.assets.get("workflow/a")?.[0].path, path.join(second, ".xsb2", "assets", "test.txt"));
  assert.equal(after.state.assets.get("workflow/b")?.[0].path, external);
  assert.equal(after.session(s.id).rec.renew, "project_moved");
  assert.equal(after.session(s.id).rec.backendSessionId, undefined);
});

test("a cleanup interrupted before snapshot publication resumes on restart", async t => {
  const h = hub(t), s = h.createConversation();
  await h.deleteConversation(s.agentId);
  h.state.store.failpoint = point => { if (point === "before-snapshot-publish") throw Error("interrupted cleanup"); };
  assert.throws(() => h.purgeDeleted(), /interrupted cleanup/);
  const restored = new Hub(h.paths.project); restored.stopping = true;
  assert.equal(restored.state.agents.has(s.agentId), false);
  assert.equal(restored.state.sessions.has(s.id), false);
  assert.equal(fs.existsSync(h.paths.agentDir(s.agentId)), false);
  assert.deepEqual(restored.purgeDeleted(), { conversations: 0, bytes: 0 });
});

test("workflow deltas omit unchanged version definitions and retain durable receipt replay", t => {
  const h = hub(t), s = h.createConversation(), flow = empty(s.id);
  flow.versions.large = { nodes: [{ node: "A", kind: "task", prompt: "x".repeat(20000), input: {}, multi: false }], edges: [] };
  h.state.commit([ops.workflow(flow)]);
  for (let i = 0; i < 10; i++) {
    const next = structuredClone(h.state.workflows.get(s.id)!); next.receipts[`receipt-${i}`] = { ok: i };
    h.state.commit([ops.workflow(next)]);
  }
  const last = h.state.store.read(F.workflows).at(-1)!;
  assert.ok(JSON.stringify(last).length < 1000);
  const restored = new Hub(h.paths.project); restored.stopping = true;
  assert.deepEqual(restored.state.workflows.get(s.id)?.receipts["receipt-9"], { ok: 9 });
  assert.equal(restored.state.workflows.get(s.id)?.versions.large.nodes[0].prompt, "x".repeat(20000));
});
