import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ConversationEvent, Question, Workflow, text, conversationEntry } from "@xsb/protocol";
import type { NodeDef, SessionUpdate } from "@xsb/protocol";
import { Hub } from "../src/hub.ts";
import { Paths } from "../src/paths.ts";
import { setProjectLanguage } from "../src/config.ts";
import { pathToFileURL } from "node:url";
import { conversationPrompt, WORKFLOW_MAIN_ABOUT, WORKFLOW_TASK_ABOUT } from "../src/prompts.ts";
import { F, ops } from "../src/state.ts";
import { deferred, newId } from "../src/util.ts";
import type { LiveSession, Turn } from "../src/session.ts";
import { canonical, graphJsonl, validateResult, parseGraph } from "../src/workflow-graph.ts";
import { additional, adopt, claim, control, empty, normalize, settled, view } from "../src/workflow-state.ts";
import { WORKFLOW_REFRESH_TURNS } from "../src/workflows.ts";
import type { Flow } from "../src/workflow-state.ts";

const graph = (...rows: unknown[]) => rows.map((v) => JSON.stringify(v)).join("\n");
const task = (node: string, prompt = node) => ({ node, prompt });
const end = (node = "end") => ({ node, kind: "end" });
const edge = (from: string, to: string, choice?: string) => ({ from, to, case: choice });
const build = (graphJsonl: string) => {
  const f = empty("root");
  adopt(f, { graphJsonl }, false);
  normalize(f);
  return f;
};
const replace = (f: Flow, node: string, prompt: string) => {
  adopt(f, { replaceNode: task(node, prompt) }, false);
  normalize(f);
};
const deliver = (f: Flow, node: string, summary = node) => {
  const w = f.instances[node].work ?? claim(f, node);
  assert.ok(w && w.state === "running", node);
  w.staged = { summary, assets: [], result: { node } };
  w.state = "ended";
  normalize(f);
};
const select = (f: Flow, from: string, cases: string[]) => {
  assert.ok(f.instances[from].invitation);
  f.instances[from].last!.choice = { id: newId("choice"), cases };
  normalize(f);
};

test("completion is independent of model delivery and controls cannot replay a completed graph", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-completed-query-"));
  const hub = new Hub(dir); hub.stopping = true;
  t.after(async () => { await hub.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
  const root = hub.createConversation();
  const f = build(graph(task("A"), end(), edge("A", "end"))); f.owner = root.id;
  deliver(f, "A");
  hub.state.commit([ops.workflow(f)]);
  assert.deepEqual(f.outbox, []);
  assert.equal(hub.workflows.get(root.id).state, "completed");
  assert.deepEqual(hub.workflows.get(root.id).controls, { pause: false, resume: false });
  assert.deepEqual(hub.workflows.list(), [hub.workflows.get(root.id)]);
  hub.workflows.restart();
  assert.equal(hub.workflows.read(root.id).paused, false);
  const delivery = hub.workflows.read(root.id).instances.A.last!.id;
  hub.workflows.control(root.id, "resume");
  hub.workflows.control(root.id, "pause");
  assert.equal(hub.workflows.get(root.id).state, "completed");
  assert.equal(hub.workflows.read(root.id).instances.A.last!.id, delivery);
  assert.equal(hub.workflows.read(root.id).instances.A.work, undefined);
  const unfinished = structuredClone(hub.workflows.read(root.id));
  unfinished.instances.A.extras.push({ text: "more work", predecessors: [] });
  hub.state.commit([ops.workflow(unfinished)]);
  assert.equal(hub.workflows.get(root.id).state, "running");
  hub.workflows.restart();
  assert.equal(hub.workflows.get(root.id).state, "paused");
  assert.deepEqual(hub.workflows.get(root.id).controls, { pause: false, resume: true });
});

test("a delivered predecessor can still pause its unfinished branch", () => {
  const f = build(graph(task("A"), task("B"), end(), edge("A", "B"), edge("B", "end")));
  deliver(f, "A");
  assert.equal(view(f).nodes.find(n => n.name === "A")!.controls!.pause, true);
  control(f, true, ["A"]);
  assert.equal(view(f).nodes.find(n => n.name === "A")!.controls!.resume, true);
  assert.equal(claim(f, "B"), undefined);
});

test("an accepted end and its complete passive result commit together and notify clients exactly once", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-completion-result-"));
  const hub = new Hub(dir); hub.stopping = true;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = hub.createConversation(), other = hub.createConversation();
  setProjectLanguage(hub.paths, "zh-CN");
  const f = build(graph(task("Draft"), task("Review"), end("Publish"), edge("Draft", "Review"), edge("Review", "Publish")));
  f.owner = root.id;
  const large = "原始材料".repeat(15_000);
  deliver(f, "Draft", large);
  const work = claim(f, "Review")!;
  const file = path.join(dir, "audit with spaces.md");
  fs.writeFileSync(file, large);
  hub.state.commit([ops.putAsset({ id: "workflow/Audit @ note", type: "workflow", name: "Audit @ note", version: 2,
    description: "Audit", by: root.agentId, path: file, createdAt: new Date().toISOString() })]);
  work.staged = { summary: "Verified the evidence", assets: [{ name: "Audit @ note", version: "v2" }],
    result: { verified: false, count: 0, missing: [null], html: "<script>sample</script>", text: "A paragraph\n\nwith details", list: [], obj: {} } };
  const worker = hub.createConversation("claude", "Review", {
    owner: root.id, node: "Review", bind: (agentId, sessionId) => {
      Object.assign(f.instances.Review, { agentId, sessionId });
      return ops.workflow(f);
    },
  });
  const turn = turnFor(worker, work.attempt!);
  worker.current = undefined;
  const occupied = turnFor(root, "user-request");
  const updates: SessionUpdate[] = [];
  root.clients.add({ history: true, conn: { notify: (_method: string, body: { update: SessionUpdate }) => updates.push(body.update) } } as any);
  const transcript = Paths.transcript(root.agentId, root.id);
  const events = () => hub.state.store.read(transcript).filter(rec => rec.update?._meta?.[ConversationEvent.key]);
  assert.throws(() => hub.state.atomic(() => {
    hub.workflows.ended(worker, turn, { stopReason: "end_turn" });
    throw Error("rollback");
  }), /rollback/);
  assert.equal(events().length, 0);
  assert.equal(updates.length, 0);
  assert.equal(hub.workflows.read(root.id).instances.Publish.last, undefined);
  hub.workflows.ended(worker, turn, { stopReason: "end_turn" });
  assert.equal(root.current, occupied);
  assert.equal(occupied.inputs.length, 1);
  assert.deepEqual(hub.workflows.read(root.id).outbox, []);
  assert.equal(hub.state.mail.size, 0);
  assert.equal(hub.workflows.get(root.id).state, "completed");
  assert.equal(events().length, 1);
  const [record] = events();
  // The transaction tag links the authoritative end decision to its permanent transcript entry.
  const flowRecord = hub.state.store.read(F.workflows).at(-1)!;
  assert.equal(record._tx.split(":")[0], flowRecord._tx.split(":")[0]);
  assert.deepEqual(JSON.parse(JSON.stringify(updates)), [record.update]);
  const event = conversationEntry(record.update, root.id)!;
  assert.deepEqual(event.source, { kind: "plugin", id: "workflow", label: "工作流" });
  assert.equal(event.id, hub.workflows.read(root.id).instances.Publish.last!.id);
  assert.deepEqual(Object.keys(event).sort(), ["id", "markdown", "schemaVersion", "sessionId", "source"]);
  const body = event.markdown;
  for (const part of ["# 工作流已完成", "plan-1", "Publish", large, "Verified the evidence", "Audit @ note@v2", pathToFileURL(file).href,
    "`node` Draft", "`verified` `false`", "`count` `0`", "`missing`", "1. `null`", "A paragraph", "with details", "&lt;script>sample&lt;/script>", "`[]`", "`{}`"])
    assert.ok(body.includes(part), part.slice(0, 80));
  assert.ok(body.indexOf("## `Draft`") < body.indexOf("## `Review`"));
  assert.ok(!body.includes(hub.workflows.read(root.id).instances.Review.last!.id));
  assert.equal(hub.state.store.read(Paths.transcript(other.agentId, other.id)).length, 0);
  hub.workflows.ended(worker, turn, { stopReason: "end_turn" });
  hub.workflows.restart();
  const restarted = new Hub(dir); restarted.stopping = true;
  restarted.workflows.restart();
  assert.equal(events().length, 1);
  assert.equal(updates.length, 1);
});

test("restart converts pending legacy completion notices to history without replaying their transport", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-legacy-results-"));
  const before = new Hub(dir); before.stopping = true;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cases = (["unposted", "inboxed", "offered", "inserted"] as const).map(status => {
    const root = before.createConversation(), f = build(graph(task("A"), end(), edge("A", "end")));
    f.owner = root.id;
    deliver(f, "A");
    const body = JSON.stringify({ completed: "end", version: f.active, predecessors: [{ node: "A", ...f.instances.A.last }] });
    const notice = { id: newId("notice"), text: body, delivery: f.instances.end.last!.id };
    const to = { agentId: root.agentId, sessionId: root.id }, from = { kind: "system" as const };
    const posted = status === "unposted" ? undefined : newId("noticeAttempt");
    f.outbox = [{ ...notice, posted }];
    before.state.commit([ops.workflow(f)]);
    if (posted) {
      before.state.commit([ops.enqueue({ id: posted, to, from, kind: "message", workflowNotice: true, ts: "", prompt: [text(body)] })]);
      before.kernel.mark(posted, status === "inserted" ? "inserted" : "inboxed", { ...to, from });
      if (status === "offered") before.kernel.offered([{ messageId: posted, about: { ...to, from } }], "backend", posted);
      if (status === "inserted") root.emit({ sessionUpdate: "user_message_chunk", messageId: posted, content: text(body) });
    }
    return { root, status, posted, endId: notice.delivery };
  });
  const restarted = new Hub(dir); restarted.stopping = true;
  restarted.workflows.restart();
  restarted.kernel.resume();
  restarted.workflows.restart();
  for (const { root, status, posted, endId } of cases) {
    const history = restarted.state.store.read(Paths.transcript(root.agentId, root.id));
    const results = history.flatMap(rec => conversationEntry(rec.update, root.id) ?? []);
    assert.deepEqual(results.map(r => r.id), status === "inserted" ? [] : [endId]);
    assert.equal(restarted.workflows.get(root.id).state, "completed");
    assert.deepEqual(restarted.workflows.read(root.id).outbox, []);
    if (!posted) continue;
    assert.equal(restarted.state.mail.has(posted), false);
    assert.equal(restarted.state.ledger.get(posted)?.state, status === "offered" ? "insertion_uncertain" :
      status === "inserted" ? "inserted" : "discarded_unseen");
    assert.equal(history.filter(rec => rec.update?.sessionUpdate === "user_message_chunk").length, status === "inserted" ? 1 : 0);
    assert.ok(!history.some(rec => rec.update?._meta?.["dev.xsb/discarded"]));
  }
});

test("runtime-only turn changes publish fresh workflow controls for a pending correction", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-flow-controls-"));
  const hub = new Hub(dir); hub.stopping = true;
  t.after(async () => { await hub.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
  const root = hub.createConversation(), f = build(graph(task("A"), end(), edge("A", "end")));
  f.owner = root.id; f.interruptions = [{ id: "correction", target: f.active!, prompt: [text("Change the plan")] }];
  hub.state.commit([ops.workflow(f)]);
  const snapshots: any[] = [];
  hub.broadcast = (method, params: any) => { if (method === Workflow.update) snapshots.push(params.workflow); };
  root.current = { id: "handling" } as Turn;
  hub.kernel.hooks.emit("acp.turn_changed", { agentId: root.agentId, sessionId: root.id });
  await hub.kernel.hooks.settled();
  assert.deepEqual(snapshots.at(-1).controls, { pause: true, resume: false });
  root.current = undefined;
  hub.kernel.hooks.emit("acp.turn_changed", { agentId: root.agentId, sessionId: root.id });
  await hub.kernel.hooks.settled();
  assert.deepEqual(snapshots.at(-1).controls, { pause: false, resume: true });
  assert.equal(hub.workflows.read(root.id).interruptions[0].id, "correction", "query publication does not consume input");
});

test("workflow examples and task/end node names follow the system prompt's conversation language", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-flow-language-"));
  const hub = new Hub(dir); hub.stopping = true;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = hub.createConversation();
  for (const language of ["zh-CN", "en"] as const) {
    const prompt = conversationPrompt(hub.agent(root.agentId), language, "");
    assert.match(prompt, language === "zh-CN" ? /Name every task and end node in Simplified Chinese/ : /Name every task and end node in English/);
    const example = prompt.split("Graph JSONL example:\n")[1].split("\nUse case")[0];
    const parsed = parseGraph(example);
    const expected = language === "zh-CN" ? ["起草", "审阅", "完成"] : ["Draft", "Review", "Done"];
    assert.deepEqual(new Set(parsed.nodes.map(n => n.node)), new Set(expected));
    const f = build(example);
    deliver(f, expected[0]);
    deliver(f, expected[1]);
    assert.ok(settled(f), "localized names survive assignment and delivery matching");
    const taskPrompt = conversationPrompt({ ...hub.agent(root.agentId), workflowOwner: root.id, workflowNode: expected[0] }, language, "");
    assert.ok(taskPrompt.includes(`node "${expected[0]}"`), "task conversations retain the localized node name");
  }
});

test("validation returns a counterexample for an ambiguous route", () => {
  const invalid = graph(
    { ...task("R"), multi: true },
    end("x"),
    end("y"),
    edge("R", "x", "x"),
    edge("R", "y", "y"),
  );
  assert.throws(() => parseGraph(invalid), /0 ends:.*"R":\[\]/);
  assert.throws(() => parseGraph(graph(task("a"), task("a"))), /Duplicate/);
  assert.throws(() => parseGraph(graph(task("a"), edge("a", "x"))), /endpoint/);
  assert.throws(() => parseGraph(graph(task("a"), edge("a", "a"))), /cycle/);
  assert.throws(() => parseGraph(graph(task("a"))), /leaf/);
  assert.throws(
    () =>
      validateResult(
        {
          type: "object",
          required: ["issues"],
          properties: { issues: { type: "array", items: { type: "string" } } },
        },
        { issues: [3] },
      ),
    /string/,
  );
});

test("valid branch combinations beyond the former step cap are all checked", () => {
  const nodes = Array.from({ length: 14 }, (_, i) => `branch-${i}`);
  const jsonl = graph(...nodes.map(n => task(n)), end(),
    ...nodes.flatMap(n => [edge(n, "end", "left"), edge(n, "end", "right")]));
  assert.equal(parseGraph(jsonl).nodes.length, 15);
  const f = empty("uncapped");
  assert.equal(adopt(f, { graphJsonl: jsonl }, true), "plan-1");
});

test("adoption invalidates in-flight consumers before redispatch, keeps siblings and unions actual predecessors", () => {
  const f = build(
    graph(
      ...["A", "B", "C", "D", "E"].map((n) => task(n)),
      end(),
      ...["A", "B", "C"].map((n) => edge(n, "D")),
      edge("D", "end"),
      edge("E", "end"),
    ),
  );
  for (const n of ["A", "B", "C"]) deliver(f, n);
  const firstD = claim(f, "D")!,
    music = claim(f, "E")!,
    a = f.instances.A.id;
  const oldVersion = f.active!;
  adopt(
    f,
    {
      graphJsonl: graph(
        ...f.versions[oldVersion].nodes.map((n) => (n.node === "A" ? task("A", "slimmer") : n)),
        ...f.versions[oldVersion].edges,
      ),
    },
    true,
  );
  assert.equal(f.instances.D.work, firstD);
  adopt(f, {}, false);
  normalize(f);
  assert.equal(f.instances.A.id, a);
  assert.equal(f.instances.D.work, undefined);
  assert.equal(f.instances.E.work, music);
  assert.equal(f.versions[oldVersion].nodes.find((n) => n.node === "A")!.prompt, "A");
  deliver(f, "A", "A2");
  const w = claim(f, "D")!;
  assert.deepEqual(
    (w.assignment.predecessors as any[]).map((p) => p.summary),
    ["A2", "B", "C"],
  );
  deliver(f, "D");
  deliver(f, "E");
  assert.ok(f.instances.end.last?.valid);
  const merged = build(
    graph(
      ...["A", "B", "C", "J"].map((n) => task(n)),
      end(),
      edge("A", "B"),
      edge("A", "C"),
      edge("B", "J"),
      edge("C", "J"),
      edge("J", "end"),
    ),
  );
  for (const n of ["A", "B", "C"]) deliver(merged, n);
  const inputs = claim(merged, "J")!.assignment.predecessors as any[];
  assert.deepEqual(
    inputs.map((p) => p.node),
    ["A", "B", "C"],
  );
  assert.deepEqual(
    inputs.map((p) => !!p.result),
    [false, true, true],
  );
});

test("empty multiselect, skipped inputs and retracted decisions keep independent work valid", () => {
  const f = build(
    graph(
      { ...task("R"), multi: true },
      task("X"),
      task("E"),
      task("J"),
      end(),
      edge("R", "X", "draw"),
      edge("X", "J"),
      edge("E", "J"),
      edge("J", "end"),
    ),
  );
  deliver(f, "R");
  select(f, "R", []);
  assert.equal(claim(f, "J"), undefined);
  deliver(f, "E");
  const j = claim(f, "J")!,
    e = f.instances.E.last;
  control(f, true, ["X"]);
  normalize(f);
  replace(f, "X", "new");
  assert.equal(f.instances.J.work, j);
  delete f.instances.R.last!.choice;
  normalize(f);
  assert.equal(f.instances.J.work, undefined);
  assert.equal(f.instances.E.last, e);
  assert.equal(claim(f, "J"), undefined);
});

test("quick end retires running graph work and leaves additional work independent", () => {
  const f = build(
    graph(
      task("R"),
      task("E"),
      task("fix"),
      end("fast"),
      end("slow"),
      edge("R", "fast", "pass"),
      edge("R", "fix", "revise"),
      edge("R", "slow", "revise"),
      edge("fix", "slow"),
      edge("E", "slow"),
    ),
  );
  const old = claim(f, "E")!;
  deliver(f, "R");
  select(f, "R", ["pass"]);
  assert.ok(f.instances.fast.last?.valid);
  assert.equal(f.instances.E.work, undefined);
  additional(f, "E", "more");
  const extra = claim(f, "E")!;
  assert.equal(extra.kind, "extra");
  assert.notEqual(extra.attempt, old.attempt);
  assert.equal(f.instances.E.last, undefined);
});

test("pause sources stack; edits clear only a superseded redirection; extra goals are frozen on submission", () => {
  const f = build(
    graph(task("A", "full body"), task("B"), task("D"), end(), edge("A", "D"), edge("B", "D"), edge("D", "end")),
  );
  additional(f, "A", "again");
  f.instances.A.replan = "redirect";
  control(f, true, ["A", "B"]);
  adopt(f, { graphJsonl: graphJsonl(f.versions[f.active!]) }, false);
  normalize(f);
  assert.ok(f.instances.A.replan);
  replace(f, "A", "half body");
  assert.equal(f.instances.A.replan, undefined);
  assert.equal(claim(f, "A"), undefined);
  control(f, false, ["A"]);
  normalize(f);
  assert.equal(claim(f, "A")!.assignment.target, "half body");
  deliver(f, "A");
  assert.equal(claim(f, "A")!.assignment.target, "full body");
  assert.equal(view(f).nodes.find((n) => n.name === "D")!.status, "paused");
  assert.equal(claim(f, "D"), undefined);
  assert.throws(() => control(f, false, ["B", "missing"]));
  assert.equal(f.instances.B.paused, true);
});

test("incoming edge change reuses a node, candidate adoption and version names are checked", () => {
  const first = graph(task("A"), task("B"), task("D"), end(), edge("A", "D"), edge("D", "end"), edge("B", "end"));
  const second = graph(task("D"), task("B"), task("A"), end(), edge("B", "D"), edge("D", "end"), edge("A", "end"));
  const f = build(first),
    id = f.instances.D.id;
  assert.equal(f.active, "plan-1");
  assert.throws(() => adopt(f, {}, false), /No candidate/);
  assert.equal(adopt(f, { graphJsonl: second }, true), "plan-2");
  assert.equal(adopt(f, { graphJsonl: second }, true), "plan-2", "the same graph keeps its name");
  assert.equal(adopt(f, { graphJsonl: first }, true), "plan-1");
  assert.throws(() => adopt(f, { replaceNode: task("A") }, true), /single adoption/);
  adopt(f, { graphJsonl: second }, true);
  replace(f, "A", "updated");
  assert.throws(() => adopt(f, {}, false), /stale/);
  adopt(f, { graphJsonl: second }, false);
  normalize(f);
  deliver(f, "A");
  assert.equal(f.instances.D.id, id);
  assert.deepEqual(f.instances.D.goals, ["D"]);
  assert.equal(claim(f, "D"), undefined);
  deliver(f, "B");
  assert.ok(claim(f, "D"));
});

function turnFor(session: LiveSession, id: string) {
  const first = {
    origin: { kind: "system" },
    messageId: id,
    prompt: [],
    content: [],
    in: true,
    inserted: deferred<void>(),
  } as Turn["first"];
  const turn: Turn = {
    id: newId("turn"),
    first,
    protected: false,
    inputs: [first],
    held: [],
    items: [],
    inserted: true,
    started: true,
    done: deferred(),
  };
  session.current = turn;
  return turn;
}

test("a failed workflow journal append fences storage without publishing a fallback conversation entry", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-flow-audit-"));
  const hub = new Hub(dir);
  t.after(async () => { await hub.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
  const session = hub.createConversation();
  const file = Paths.transcript(session.agentId, session.id);
  const before = hub.state.store.read(file);
  fs.mkdirSync(hub.paths.agentDir(session.agentId), { recursive: true });
  fs.writeFileSync(path.join(hub.paths.agentDir(session.agentId), "workflow"), "not a directory");
  assert.throws(() => hub.workflows.record(session, "t", { kind: "tool", tool: "plan", receipt: "call", arguments: "{}", result: "saved" }));
  assert.equal(hub.state.store.healthy, false);
  assert.equal(hub.stopping, true);
  assert.throws(() => hub.state.commit([]), /restart and recover/);
  assert.deepEqual(hub.state.store.read(file), before);
});

test("receipt replay, exact asset grants, pinned base, staged finish, interrupt and restart", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-flow-state-"));
  const hub = new Hub(dir);
  hub.stopping = true;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = hub.createConversation(),
    runtime = hub.workflows;
  turnFor(root, "request");
  const asset = path.join(dir, "input.txt");
  fs.writeFileSync(asset, "original");
  const invoke = (s: LiveSession, tool: string, a: Record<string, any>, id = newId("call")) =>
    runtime.call(s, tool, a, id);
  assert.deepEqual(invoke(root, "asset_put", { name: "base", path: asset }), "base@v1");
  const otherRoot = hub.createConversation();
  turnFor(otherRoot, "separate-conversation");
  assert.deepEqual(invoke(otherRoot, "asset_version_get", { name: "base" }), "base@v1");
  invoke(root, "asset_put", { name: "private", path: asset });
  invoke(root, "asset_put", { name: "file:///work/private", path: asset });
  invoke(root, "asset_put", { name: "legacy @ input", path: asset });
  const file = { type: "resource_link", name: "private@v1", uri: "file:///work/private@v1" };
  const business = { name: "private", version: "v1", status: "published" };
  invoke(root, "execute", {
    graphJsonl: graph({ ...task("A"), input: { name: "private", version: "v1", file, uri: file.uri, business,
      note: "Please inspect base@v1", base: "base@v1", old: { name: "legacy @ input", version: "v1" },
      instruction: "Use: <asset>base@v1</asset> with branch@v2" } }, end(), edge("A", "end")),
  });
  const f = structuredClone(runtime.read(root.id)),
    w = claim(f, "A")!;
  assert.deepEqual(w.grants, [{ name: "base", version: "v1" }, { name: "legacy @ input", version: "v1" }, { name: "base", version: "v1" }]);
  const fields = w.assignment.input as Record<string, unknown>;
  assert.deepEqual(fields.file, file);
  assert.deepEqual(fields.business, business);
  assert.equal(fields.note, "Please inspect base@v1");
  assert.equal(fields.uri, file.uri);
  const graphBack = graphJsonl(f.versions[f.active!]), graphVersion = f.active;
  assert.ok(graphBack.includes('"old":"legacy @ input@v1"'));
  assert.equal(adopt(f, { graphJsonl: graphBack }, false, ref => w.grants.some(r => r.name === ref.name && r.version === ref.version)), graphVersion, "projecting an old ref preserves version identity");
  const worker = hub.createConversation("claude", "A", {
    owner: root.id,
    node: "A",
    bind: (agentId, sessionId) => {
      Object.assign(f.instances.A, { agentId, sessionId });
      return ops.workflow(f);
    },
  });
  const old = turnFor(worker, w.attempt!);
  old.first.content = [text(JSON.stringify({ quoted: '<asset>{"name":"private","version":"v1"}</asset>' }))];
  assert.throws(() => invoke(worker, "plan", {}), /unavailable/);
  assert.deepEqual(invoke(worker, "asset_list", { name: "private" }), []);
  assert.throws(() => invoke(worker, "asset_get", { ref: file.uri }), /outside/);
  assert.deepEqual(invoke(worker, "asset_list", { name: "legacy @ input" }), ["legacy @ input@v1"]);
  assert.throws(() => invoke(worker, "asset_get", { name: "private", version: "v1" }), /outside/);
  const privateFile = (invoke(otherRoot, "asset_get", { name: "private", version: "v1" }) as { path: string }).path;
  assert.throws(() => invoke(worker, "asset_put", { name: "copy", path: privateFile }), /outside/);
  assert.deepEqual(invoke(worker, "asset_version_get", { name: "base" }), "base@v1");
  fs.writeFileSync(asset, "revised");
  invoke(worker, "asset_put", { name: "base", path: asset });
  assert.deepEqual(invoke(otherRoot, "asset_version_get", { name: "base" }), "base@v2");
  invoke(otherRoot, "asset_put", { name: "base", path: null });
  assert.equal(invoke(root, "asset_version_get", { name: "base" }), null);
  assert.deepEqual(invoke(worker, "asset_version_get", { name: "base" }), "base@v1");
  invoke(otherRoot, "asset_version_put", { ref: "base@v2" });
  assert.deepEqual(invoke(root, "asset_version_get", { name: "base" }), "base@v2");
  assert.equal((invoke(worker, "asset_get", { ref: "base@v1" }) as any).content, "original");
  invoke(worker, "finish", { summary: "done", assets: ["base@v2"] });
  assert.throws(() => invoke(worker, "asset_put", { name: "base", path: asset }), /closed/);
  runtime.input(worker, "user-correction", [text("Check the base")]);
  worker.current = undefined;
  runtime.ended(worker, old, { stopReason: "end_turn" });
  assert.equal(runtime.read(root.id).instances.A.work?.state, "ended");
  assert.equal(runtime.read(root.id).instances.end.last, undefined);
  const restarted = new Hub(dir);
  restarted.stopping = true;
  restarted.workflows.restart();
  const restored = restarted.workflows.read(root.id);
  assert.ok(restored.paused);
  assert.equal(restored.instances.A.work?.state, "ended");
  assert.equal(restored.instances.A.work?.selected.base, "v1");
  const live = restarted.session(worker.id),
    answer = turnFor(live, "user-correction");
  restarted.workflows.control(root.id, "resume");
  assert.equal(restarted.workflows.read(root.id).instances.end.last, undefined);
  live.current = undefined;
  restarted.workflows.ended(live, answer, { stopReason: "end_turn" });
  assert.ok(restarted.workflows.read(root.id).instances.end.last?.valid);
  const r = restarted.session(root.id),
    run = turnFor(r, "request2");
  restarted.workflows.context(r, run);
  const more = (id: string) => restarted.workflows.call(r, "prompt", { node: "A", text: "again" }, id);
  assert.deepEqual(more("one"), more("one"));
  more("two");
  assert.equal(restarted.workflows.read(root.id).instances.A.extras.length, 2);
  restarted.workflows.ended(live, old, { stopReason: "end_turn" });
  assert.equal(restarted.workflows.read(root.id).instances.A.extras.length, 2);
});

test("stale choices and a removed instance's old callbacks cannot act on their replacements", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-flow-choice-"));
  const hub = new Hub(dir);
  hub.stopping = true;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = hub.createConversation(),
    runtime = hub.workflows;
  const first = turnFor(root, "plan");
  const change = (args: object) => runtime.call(root, "execute", args, newId("call"));
  const graphJsonl = graph(task("R"), end("fast"), end("slow"), edge("R", "fast", "yes"), edge("R", "slow", "no"));
  change({ graphJsonl });
  const state = () => structuredClone(runtime.read(root.id));
  let f = state(),
    w = claim(f, "R")!;
  const worker = hub.createConversation("claude", "R", {
    owner: root.id,
    node: "R",
    bind: (agentId, sessionId) => {
      Object.assign(f.instances.R, { agentId, sessionId });
      return ops.workflow(f);
    },
  });
  const old = turnFor(worker, w.attempt!);
  runtime.call(worker, "finish", { summary: "original", assets: [] }, "first-finish");
  worker.current = undefined;
  runtime.ended(worker, old, { stopReason: "end_turn" });
  runtime.context(root, first);
  const invitation = state().instances.R.invitation;
  change({ replaceNode: task("R", "review again") });
  f = state();
  w = claim(f, "R")!;
  hub.state.commit([ops.workflow(f)]);
  const current = turnFor(worker, w.attempt!);
  runtime.call(worker, "finish", { summary: "same conclusion", assets: [] }, "second-finish");
  worker.current = undefined;
  runtime.ended(worker, current, { stopReason: "end_turn" });
  assert.notEqual(state().instances.R.invitation, invitation);
  assert.throws(() => runtime.call(root, "choose", { from: "R", cases: ["yes"] }, "stale"), /expired/);
  runtime.context(root, turnFor(root, "new-invitation"));
  runtime.call(root, "choose", { from: "R", cases: ["yes"] }, "fresh");
  assert.ok(state().instances.fast.last?.valid);
  change({ graphJsonl: graph(end()) });
  change({ graphJsonl });
  assert.equal(state().instances.R.sessionId, undefined);
  assert.throws(() => runtime.accessible(worker), /no longer active/);
  runtime.ended(worker, current, { stopReason: "end_turn" });
  assert.equal(state().instances.R.last, undefined);
});

test("user stop clears the selected scope's held inputs, keeping independent conversations intact", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-flow-stop-"));
  const hub = new Hub(dir);
  hub.stopping = true;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = hub.createConversation(),
    other = hub.createConversation();
  const f = build(graph(task("A"), task("B"), end(), edge("A", "end"), edge("B", "end")));
  f.owner = root.id;
  const workers = ["A", "B"].map((node) =>
    hub.createConversation("claude", node, {
      owner: root.id,
      node,
      bind(agentId, sessionId) {
        Object.assign(f.instances[node], { agentId, sessionId });
        return ops.workflow(f);
      },
    }),
  );
  const hold = (s: LiveSession) => {
    const id = newId("held");
    const from = { kind: "user" } as const,
      to = { agentId: s.agentId, sessionId: s.id };
    hub.state.commit([
      ops.enqueue({ id, from, to, kind: "message", ts: "", prompt: [text("old input")], workflowHeld: true }),
    ]);
    hub.kernel.mark(id, "queued", { from, ...to });
    return id;
  };
  const [a, b, c] = [...workers, other].map(hold);
  hub.workflows.userStop(workers[0]);
  assert.deepEqual(
    [a, b, c].map((id) => hub.state.mail.has(id)),
    [false, true, true],
  );
  const next = hold(workers[0]);
  hub.workflows.userStop(root);
  assert.deepEqual(
    [next, b, c].map((id) => hub.state.mail.has(id)),
    [false, false, true],
  );
});

test("an adopted version keeps the one it replaced; a dropped node's conversation stays readable, not writable", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-history-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hub = new Hub(dir);
  const root = hub.createConversation("claude", "root");
  const f = build(graph(task("draft"), task("A"), end(), edge("draft", "A"), edge("A", "end")));
  f.owner = root.id;
  const node = hub.createConversation("claude", "draft", {
    owner: root.id, node: "draft",
    bind: (agentId, sessionId) => ops.workflow({ ...f, instances: { ...f.instances, draft: { ...f.instances.draft, agentId, sessionId } } }),
  });
  assert.doesNotThrow(() => hub.workflows.accessible(node));
  assert.equal(hub.workflows.retired(node.agentId), false);

  const next = structuredClone(hub.workflows.read(root.id));
  const first = next.active;
  adopt(next, { graphJsonl: graph(task("A"), end(), edge("A", "end")) }, false);
  normalize(next);
  hub.state.commit([ops.workflow(next)]);
  const shown = view(hub.workflows.read(root.id));
  assert.equal(shown.history!.length, 1);
  assert.equal(shown.history![0].version, first);
  assert.deepEqual(shown.history![0].nodes.map((n) => n.name), ["draft", "A", "end"]);
  assert.equal(shown.history![0].nodes[0].agentId, node.agentId, "who did the dropped node's work is kept");
  assert.ok(!shown.nodes.some((n) => n.name === "draft"));

  assert.equal(hub.workflows.retired(node.agentId), true);
  assert.throws(() => hub.workflows.accessible(node), /no longer active/, "cannot be talked to");
  assert.doesNotThrow(() => hub.workflows.readable(node), "its conversation can be read");
  assert.equal(hub.agentInfo(hub.agent(node.agentId)).retired, true);

  const again = structuredClone(hub.workflows.read(root.id));
  adopt(again, { graphJsonl: graphJsonl(again.versions[again.active!]) }, false);
  assert.equal(again.history!.length, 1, "adopting the active version again records nothing");
});

test("on restart only the workflow's own input is held; what got into a conversation is the kernel's to settle", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-flow-restart-"));
  const hub = new Hub(dir);
  hub.stopping = true;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = hub.createConversation();
  turnFor(root, "request");
  hub.workflows.call(root, "execute", { graphJsonl: graph(task("A"), end(), edge("A", "end")) }, newId("call"));
  hub.workflows.input(root, "interrupt", [text("about the graph")], "workflow");
  assert.equal(hub.workflows.read(root.id).interruptions.length, 1);
  const to = { agentId: root.agentId, sessionId: root.id };
  const mail = (id: string) => ({ id, to, from: { kind: "user" as const }, kind: "message" as const, ts: "", prompt: [text(id)], pref: "wake" as const });
  hub.state.commit([ops.enqueue(mail("interrupt")), ops.enqueue(mail("unrelated")), ops.enqueue(mail("in-already"))]);
  hub.kernel.mark("in-already", "inserted", { ...to, from: { kind: "user" } });
  const restarted = new Hub(dir);
  restarted.stopping = true;
  restarted.workflows.restart();
  const { mail: inbox } = restarted.state;
  assert.equal(inbox.get("interrupt")?.workflowHeld, true, "the workflow's interruption waits for it to resume");
  assert.ok(!inbox.get("unrelated")?.workflowHeld, "the main conversation's other mail is not the workflow's");
  assert.ok(inbox.has("in-already") && !inbox.get("in-already")?.workflowHeld, "left to kernel.resume, which notes its outcome is unknown");
});

test("an interruption that never got to the model holds nothing", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-flow-discard-"));
  const hub = new Hub(dir);
  hub.stopping = true;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = hub.createConversation();
  turnFor(root, "request");
  hub.workflows.call(root, "execute", { graphJsonl: graph(task("A"), end(), edge("A", "end")) }, newId("call"));
  hub.workflows.input(root, "lost", [text("about the graph")], "workflow");
  assert.equal(view(hub.workflows.read(root.id)).interrupted, true);
  hub.workflows.discarded(root, "lost");
  assert.equal(hub.workflows.read(root.id).interruptions.length, 0);
  assert.equal(view(hub.workflows.read(root.id)).interrupted, false);
});

test("agents are told what their built-in workflow tools are, and a task agent sorts what the user asks it", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-flow-prompt-"));
  const hub = new Hub(dir);
  hub.stopping = true;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = hub.createConversation();
  turnFor(root, "request");
  const main = hub.systemPromptFor(hub.agent(root.agentId));
  assert.match(main, /MCP server named "workflow"/, "where the tools come from");
  assert.match(main, /mcp__workflow__/, "and how an agent program shows them");
  assert.match(main, /workflow 技能/, "what a user calls them");
  assert.match(main, /escalate/, "and what a task agent's escalation is");
  assert.doesNotMatch(main, /mcp__xsb__ask|xsb\.ask/, "only native question tools are advertised");
  assert.doesNotMatch(WORKFLOW_MAIN_ABOUT + WORKFLOW_TASK_ABOUT, /\bask\b/, "and no workflow tool list names it");
  hub.workflows.call(root, "execute", { graphJsonl: graph(task("A"), end(), edge("A", "end")) }, newId("call"));
  const f = structuredClone(hub.workflows.read(root.id)), w = claim(f, "A")!;
  const worker = hub.createConversation("claude", "A", { owner: root.id, node: "A", bind: (agentId, sessionId) => {
    Object.assign(f.instances.A, { agentId, sessionId });
    return ops.workflow(f);
  } });
  const prompt = hub.systemPromptFor(hub.agent(worker.agentId));
  for (const part of [/own assignment/, /overall task/, /escalate\(\{message\}\)/, /escalate\(\{message, pauseSelf: true\}\)/, /answer it directly/]) assert.match(prompt, part);
  assert.doesNotMatch(prompt, /replan|coordinate/, "one tool, not two");
  // The user asks the task agent about the whole task: it goes to the main conversation, with the user's words.
  const turn = turnFor(worker, w.attempt!);
  const asked = { ...turn.first, origin: { kind: "user" }, messageId: "q", content: [text("Should the ending change too?")], in: true } as Turn["first"];
  turn.inputs.push(asked);
  assert.deepEqual(hub.workflows.call(worker, "escalate", { message: "The user asks whether the ending should change." }, newId("call")), { forwarded: "main conversation" });
  const notice = JSON.parse(hub.workflows.read(root.id).outbox.at(-1)!.text);
  assert.deepEqual(notice, { escalate: "A", message: "The user asks whether the ending should change.", userSaid: "Should the ending change too?", paused: false });
  assert.equal(hub.workflows.read(root.id).instances.A.replan, undefined, "without pauseSelf the node's work goes on");
  assert.throws(() => hub.workflows.call(worker, "escalate", { message: "x", invalidateSelf: true }, newId("call")), /needs pauseSelf/);
  assert.throws(() => hub.workflows.call(root, "escalate", { message: "x" }, newId("call")), /Unavailable|unavailable/);
  // Its own assignment must change (here its own work finds so): it stops and waits for the main agent, which is told so.
  turnFor(worker, w.attempt!);
  hub.workflows.call(worker, "escalate", { message: "Use the night version of the base.", pauseSelf: true }, newId("call"));
  assert.equal(hub.workflows.read(root.id).instances.A.replan, "Use the night version of the base.");
  assert.equal(view(hub.workflows.read(root.id)).nodes.find((n) => n.name === "A")!.paused, true);
  assert.equal(JSON.parse(hub.workflows.read(root.id).outbox.at(-1)!.text).paused, true);
});

test("versions are xSB's: the model plans and executes by graph, and a fresh context is shown the graphs whole", async (t) => {
  const g = parseGraph(graph({ ...task("R"), input: { a: 1 }, model: "m", schema: { type: "object" } }, end("x"), end("y"), edge("R", "x", "go"), edge("R", "y", "stop")));
  assert.equal(canonical(parseGraph(graphJsonl(g))), canonical(g), "the JSONL a context shows parses back to its graph");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-flow-context-"));
  const hub = new Hub(dir);
  hub.stopping = true;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = hub.createConversation(),
    runtime = hub.workflows;
  const shown = async (id: string) => {
    const turn = turnFor(root, id);
    const context = runtime.context(root, turn);
    turn.first.inserted.resolve();
    await new Promise((r) => setImmediate(r));
    return context && JSON.parse(context.slice(context.indexOf("\n") + 1));
  };
  const call = (name: string, args: object) => runtime.call(root, name, args, newId("call"));
  const jsonl = graph(task("A"), end(), edge("A", "end"));

  assert.equal(await shown("t1"), undefined);
  assert.throws(() => call("plan", { version: "mine", graphJsonl: jsonl }), /additional/, "a model cannot name a version");
  assert.throws(() => call("execute", {}), /No candidate/);
  assert.deepEqual(call("plan", { graphJsonl: jsonl }), { version: "plan-1" });

  const second = await shown("t2");
  assert.equal(second.candidate.version, "plan-1");
  assert.equal(second.candidate.graphJsonl, graphJsonl(parseGraph(jsonl)));
  assert.deepEqual(call("execute", {}), { version: "plan-1" }, "execute adopts the candidate this turn was shown");

  // The model adopted it itself: the next turns are not told again, until WORKFLOW_REFRESH_TURNS have passed.
  for (let n = 1; n < WORKFLOW_REFRESH_TURNS; n++) assert.equal(await shown(`quiet-${n}`), undefined, `turn ${n} after being told`);
  const refreshed = await shown("refresh");
  assert.equal(refreshed.version, "plan-1");
  assert.equal(refreshed.graphJsonl, undefined, "a context that has the graph gets what changed");
  assert.ok(refreshed.graphRef);
  assert.equal(await shown("after-refresh"), undefined);

  // What it cannot learn otherwise is told at once: here, the user paused the workflow.
  runtime.control(root.id, "pause");
  assert.equal((await shown("paused")).paused, true);
  assert.equal(await shown("still-paused"), undefined);
  runtime.control(root.id, "resume");
  assert.equal((await shown("resumed")).paused, false);

  // The backend compacted the conversation: the graph is shown whole again; so is it to a renewed context.
  root.onBackendUpdate({ sessionUpdate: "compaction_update", status: "completed" } as never);
  assert.equal((await shown("compacted")).graphJsonl, graphJsonl(parseGraph(jsonl)), "a compacted context is shown the graph whole");
  assert.equal(await shown("after-compaction"), undefined);
  root.rec.contextEpoch = (root.rec.contextEpoch ?? 0) + 1;
  const renewed = await shown("renewed");
  assert.equal(renewed.graphJsonl, graphJsonl(parseGraph(jsonl)), "a renewed context is shown the graph whole");

  // Once it has settled, the model keeps it in mind itself: no refresh, and the main conversation's messages are its own,
  // not interruptions of the workflow. A compaction still brings it back whole.
  const done = structuredClone(runtime.read(root.id));
  deliver(done, "A");
  hub.state.commit([ops.workflow(done)]);
  assert.ok(settled(runtime.read(root.id)));
  for (let n = 0; n < WORKFLOW_REFRESH_TURNS * 2; n++) assert.equal(await shown(`settled-${n}`), undefined, `settled turn ${n}`);
  const message = newId("m");
  runtime.input(root, message, [text("plan a road trip")], "workflow");
  assert.equal(runtime.interruptionContext(root, message), undefined, "a message after the workflow is not an interruption of it");
  root.onBackendUpdate({ sessionUpdate: "compaction_update", status: "completed" } as never);
  assert.equal((await shown("settled-compacted")).graphJsonl, graphJsonl(parseGraph(jsonl)));
});

test("a settled workflow reached an end and has nothing left to do", () => {
  const f = build(graph(task("A"), task("B"), end(), edge("A", "B"), edge("B", "end")));
  assert.equal(settled(f), false);
  deliver(f, "A");
  assert.equal(settled(f), false, "B still has to run");
  deliver(f, "B");
  assert.equal(settled(f), true);
  additional(f, "B", "one more pass");
  assert.equal(settled(f), false, "queued additional work is still to happen");
});

test("upgrade closes a saved MCP question once and preserves its transcript", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-legacy-question-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const before = new Hub(dir);
  const original = before.createConversation();
  const id = "question_saved";
  const open = { id, state: "open", questions: [{ question: "Which?", kind: "text" }] };
  before.state.atomic(() => {
    original.save({ question: id });
    original.emit({ sessionUpdate: "session_info_update", _meta: { [Question.key]: open } });
  });
  await before.shutdown();

  for (let restart = 0; restart < 2; restart++) {
    const hub = new Hub(dir);
    try {
      await hub.start();
      const session = hub.session(original.id);
      assert.equal(session.rec.question, undefined);
      const records = hub.state.store.read(Paths.transcript(session.agentId, session.id))
        .map(row => row.update?._meta?.[Question.key]).filter(q => q?.id === id);
      assert.deepEqual(records, [open, { id, state: "cancelled" }]);
    } finally {
      await hub.shutdown();
    }
  }
});

test("an ACP form in a task resumes the same attempt without a workflow interruption", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-ask-task-"));
  const hub = new Hub(dir);
  hub.stopping = true;
  t.after(async () => { await hub.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
  const root = hub.createConversation(), runtime = hub.workflows;
  turnFor(root, "request");
  runtime.call(root, "execute", { graphJsonl: graph(task("A"), end(), edge("A", "end")) }, newId("call"));
  const f = structuredClone(runtime.read(root.id)), w = claim(f, "A")!;
  const worker = hub.createConversation("claude", "A", { owner: root.id, node: "A", bind: (agentId, sessionId) => {
    Object.assign(f.instances.A, { agentId, sessionId });
    return ops.workflow(f);
  } });
  const turn = turnFor(worker, w.attempt!);
  hub.stopping = false;
  worker.save({ backendSessionId: "backend-worker" });
  worker.onBackendUpdate({ sessionUpdate: "state_update", state: "running" }, "backend-worker");
  const response = deferred<{ action: "accept"; content: { orientation: string } }>();
  worker.clients.add({ forms: true, conn: { notify() {}, request: () => response.promise } } as any);
  const answer = worker.onBackendElicitation({ mode: "form", sessionId: "backend-worker", message: "横版还是竖版？",
    requestedSchema: { type: "object", properties: { orientation: { type: "string", enum: ["横版", "竖版"] } }, required: ["orientation"] },
  }, new AbortController().signal);
  assert.ok(hub.agentInfo(hub.agent(worker.agentId)).asking);
  response.resolve({ action: "accept", content: { orientation: "竖版" } });
  assert.deepEqual(await answer, { action: "accept", content: { orientation: "竖版" } });
  assert.equal(turn.protected, true);
  worker.clients.clear();
  const continued = runtime.read(root.id).instances.A;
  assert.equal(continued.work!.attempt, w.attempt);
  assert.equal(continued.interruptions.length, 0);
  assert.equal(worker.current, turn);
  runtime.call(worker, "finish", { summary: "竖版海报", assets: [] }, newId("call"));
  worker.onBackendUpdate({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" }, "backend-worker");
  hub.stopping = true;
  assert.equal(runtime.read(root.id).instances.A.last?.summary, "竖版海报");
});

test("node agent settings round-trip and reused nodes inherit but cannot alter the role or skills", () => {
  const agent = { systemPrompt: "Review evidence carefully.", skills: [{ name: "review", description: "Check a delivery", content: "Inspect the files, then report concrete checks." }] };
  const f = build(graph({ ...task("A"), agent }, end(), edge("A", "end")));
  assert.deepEqual(parseGraph(graphJsonl(f.versions[f.active!])), f.versions[f.active!]);
  const id = f.instances.A.id;
  adopt(f, { replaceNode: { ...task("A", "new goal"), agent: { systemPrompt: agent.systemPrompt } } }, false);
  assert.deepEqual(f.versions[f.active!].nodes[0].agent, agent);
  assert.equal(f.instances.A.id, id);
  for (const plan of [true, false]) for (const changed of [{ systemPrompt: "A different role" }, { skills: [] }, { skills: [{ ...agent.skills[0], content: "Changed steps" }] }]) {
    const before = canonical(f);
    assert.throws(() => adopt(f, { graphJsonl: graph({ ...task("A"), agent: changed }, end(), edge("A", "end")) }, plan), /immutable/);
    assert.equal(canonical(f), before, "rejection does not change candidates, versions, or live instances");
  }
  const legacy = build(graph(task("A"), end(), edge("A", "end")));
  assert.throws(() => adopt(legacy, { replaceNode: { ...task("A"), agent } }, false), /immutable/, "an existing default role is also pinned");
  adopt(f, { graphJsonl: graph({ ...task("B"), agent: { systemPrompt: "New role" } }, end(), edge("B", "end")) }, false);
  assert.notEqual(f.instances.B.id, id, "a different agent gets a new instance");
});

test("generated roles and skill catalogs have explicit context limits and reject invalid definitions", () => {
  const invalid = [null, { unexpected: true }, { systemPrompt: "" }, { systemPrompt: "a".repeat(4097) },
    { skills: [{ name: "s", description: "d", content: "x".repeat(16385) }] },
    { skills: [{ name: "s", description: "d", content: "c" }, { name: "s", description: "d", content: "c" }] },
    { skills: [{ name: "s", description: "d".repeat(2049), content: "c" }] },
    { skills: Array.from({ length: 9 }, (_, i) => ({ name: String(i), description: "d", content: "c" })) }];
  for (const agent of invalid) assert.throws(() => parseGraph(graph({ ...task("A"), agent }, end(), edge("A", "end"))));
  assert.throws(() => parseGraph(graph({ ...end(), agent: {} })), /Only task/);
});

test("task prefixes share common instructions and freeze role, catalog and preferences across reuse and restart", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-frozen-prefix-"));
  const hub = new Hub(dir); hub.stopping = true;
  t.after(async () => { await hub.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); });
  const root = hub.createConversation();
  const agent = { systemPrompt: "Stable specialist role", skills: [{ name: "review", description: "Evidence checks", content: "SKILL BODY MUST BE LOADED" }] };
  const f = build(graph({ ...task("A"), agent }, end(), edge("A", "end"))); f.owner = root.id;
  const worker = hub.createConversation("claude", "A", { owner: root.id, node: "A", agent, bind: (agentId, sessionId) => {
    Object.assign(f.instances.A, { agentId, sessionId }); return ops.workflow(f);
  } });
  const spec = hub.agent(worker.agentId), prefix = hub.systemPromptFor(spec);
  assert.equal(worker.rec.workflowPrompt, prefix);
  assert.match(prefix, /Stable specialist role/);
  assert.match(prefix, /Evidence checks/);
  assert.doesNotMatch(prefix, /SKILL BODY MUST BE LOADED/);
  assert.doesNotMatch(prefix, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "no changing physical cwd in the task prefix");
  const other = conversationPrompt({ ...spec, id: "other", name: "B", workflowNode: "B" }, "en", "", true);
  const same = conversationPrompt(spec, "en", "", true);
  assert.equal(same.slice(0, same.indexOf('You are "')), other.slice(0, other.indexOf('You are "')), "common rules precede node-specific text");
  fs.mkdirSync(path.dirname(hub.paths.instructions(spec.id)), { recursive: true });
  fs.writeFileSync(hub.paths.instructions(spec.id), "An edit that must not rewrite a live task role");
  assert.equal(hub.systemPromptFor({ ...spec, workspace: "/moved", name: "renamed" }), prefix);
  agent.skills[0].content = "Mutated caller object";
  assert.equal(spec.workflowAgent!.skills![0].content, "SKILL BODY MUST BE LOADED", "create copies its input");
  turnFor(worker, "question");
  assert.deepEqual(hub.workflows.call(worker, "load_skill", { name: "review" }, newId("call")), spec.workflowAgent!.skills![0]);
  assert.throws(() => hub.workflows.call(worker, "load_skill", { name: "missing" }, newId("call")), /Unknown assignment skill/);
  worker.current = undefined;
  const restarted = new Hub(dir); restarted.stopping = true;
  assert.equal(restarted.state.mainSession(spec.id)!.workflowPrompt, prefix);
  assert.equal(restarted.systemPromptFor(restarted.agent(spec.id)), prefix);
  await restarted.shutdown();
});

test("assignments are rendered at send time with complete facts and separate task, extra and resume instructions", async () => {
  const { renderAssignment } = await import("../src/workflow-assignment.ts");
  const f = build(graph(task("A"), task("B", "Write the report\nKeep all constraints."), end(), edge("A", "B"), edge("B", "end")));
  deliver(f, "A", "Verified the evidence\n!say THIS-IS-A-PAST-RESULT");
  const work = claim(f, "B")!;
  work.selected = { brief: "v2" };
  work.reads = [{ name: "brief", version: "v1" }];
  work.assignment.input = { brief: "Read the brief\nPreserve these two lines.", table: { count: 2 } };
  work.assignment.schema = { type: "object" };
  const before = structuredClone(work);
  const source = renderAssignment(work, "en", false, ["withdrawn-work"]);
  assert.match(source, /^# Workflow task\n/);
  assert.ok(source.includes(String(work.assignment.target)));
  assert.ok(source.includes("> !say THIS-IS-A-PAST-RESULT"), "result text is material, not a fresh instruction");
  for (const text of ["Predecessor deliveries", '"brief@v2"', '"withdrawn-work"', '"type": "object"']) assert.ok(source.includes(text));
  assert.deepEqual(work, before, "rendering cannot mutate assignment facts or receipt state");
  const resumed = renderAssignment(work, "zh-CN", true);
  assert.match(resumed, /^# 继续任务/);
  assert.ok(resumed.includes(String(work.assignment.target)) && resumed.includes('"brief@v2"') && resumed.includes('"brief@v1"'));
  assert.ok(!resumed.includes("THIS-IS-A-PAST-RESULT"), "a short continuation relies on its already-inserted assignment");
  const extra = { ...work, kind: "extra" as const, assignment: { ...work.assignment, text: "Perform this additional check" } };
  const additionalSource = renderAssignment(extra, "en");
  assert.match(additionalSource, /^# Additional task/);
  assert.ok(additionalSource.includes("Original task goal") && additionalSource.includes("Perform this additional check"));
});
