import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Hub } from "../src/hub.ts";
import { ops } from "../src/state.ts";
import { additional, adopt, chooseMarkdown, claim, control, empty, finishMarkdown, normalize, rollback, view } from "../src/workflow-state.ts";
import type { Flow } from "../src/workflow-state.ts";

const task = (node: string, input?: string) => ({ node, requirements: node, input });
const end = { node: "end", kind: "end" };
const edge = (from: string, to: string, when?: string) => ({ from, to, case: when });
const jsonl = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n");
function build(...rows: unknown[]): Flow {
  const f = empty("test");
  adopt(f, { graphJsonl: jsonl(...rows) }, false);
  return f;
}
function deliver(f: Flow, name: string, body: string, choice?: string) {
  const w = f.instances[name].work ?? claim(f, name);
  assert.ok(w && w.state === "running");
  finishMarkdown(f, name, w, body);
  if (choice) chooseMarkdown(f, name, w, choice);
  w.state = "ended";
  return normalize(f);
}
function detail(f: Flow, node: string) {
  return view(f).nodes.find(n => n.name === node)!.markdown!;
}
const fork = () => build(task("A", "route"), task("B", "preferences"), task("local"), task("cross"), end,
  edge("A", "local", "single city"), edge("A", "cross", "several cities"),
  edge("B", "local"), edge("B", "cross"), edge("local", "end"), edge("cross", "end"));

test("rolling back or editing a skipped path preserves both a staged join and its published end", () => {
  const branches = [task("route"), task("left"), task("right"), task("join"), end,
    edge("route", "left", "one"), edge("route", "right", "two"), edge("left", "join"), edge("join", "end")];
  const f = build(...branches, edge("right", "join"));
  deliver(f, "route", "use the left", "left");
  deliver(f, "left", "left output");
  const join = claim(f, "join")!;
  finishMarkdown(f, "join", join, "published output");
  rollback(f, ["right"]);
  assert.equal(f.instances.join.work, join);
  assert.equal(join.staged?.output, "published output");
  // An extra intermediate step on the skipped path changes the join's static incoming edges.
  adopt(f, { graphJsonl: jsonl(...branches, task("skip too"), edge("right", "skip too"), edge("skip too", "join")) }, false);
  normalize(f);
  assert.equal(f.instances.join.work, join);
  join.state = "ended";
  assert.equal(normalize(f)?.output, "published output");
  const delivered = f.instances.join.last!.id, published = f.instances.end.last!.id;
  const recovered: Flow = JSON.parse(JSON.stringify(f));
  rollback(recovered, ["right"]);
  adopt(recovered, { replaceNode: { node: "right", requirements: "Revised unused branch" } }, false);
  assert.equal(normalize(recovered), undefined);
  assert.equal(recovered.instances.join.last!.id, delivered);
  assert.equal(recovered.instances.end.last!.id, published);
  assert.equal(view(recovered).state, "completed");
  assert.equal(claim(recovered, "join"), undefined);

  // Withdrawing an actual producer retracts the publication, even if its next output has identical text.
  rollback(recovered, ["left"]);
  assert.equal(detail(recovered, "join").output, undefined);
  assert.equal(detail(recovered, "end").output, undefined);
  assert.equal(detail(recovered, "route").choice, "left");
  deliver(recovered, "left", "left output");
  assert.equal(claim(recovered, "join")!.assignment.input, "left output");
});

test("a revised graph invalidates a Markdown join when the order of its effective inputs changes", () => {
  const common = [task("route"), task("A"), task("C"), task("X"), task("Y"), task("join"), end,
    edge("route", "A", "active"), edge("route", "C", "other"), edge("A", "X"), edge("A", "Y"),
    edge("X", "join"), edge("Y", "join"), edge("join", "end")];
  const f = build(...common, edge("C", "Y"));
  deliver(f, "route", "active", "A");
  deliver(f, "A", "input for both");
  deliver(f, "X", "first");
  deliver(f, "Y", "second");
  const sources = [f.instances.X.last!.id, f.instances.Y.last!.id];
  const join = claim(f, "join")!;
  assert.equal(join.assignment.input, "### X\n\nfirst\n\n### Y\n\nsecond");
  adopt(f, { graphJsonl: jsonl(...common, edge("C", "X")) }, false);
  assert.deepEqual([f.instances.X.last!.id, f.instances.Y.last!.id], sources);
  assert.throws(() => finishMarkdown(f, "join", join, "late output"), /expired/);
  assert.equal(claim(f, "join")!.assignment.input, "### Y\n\nsecond\n\n### X\n\nfirst");
});

test("a Markdown join pulls active direct outputs at dispatch and a selective rollback changes branches", () => {
  const f = fork();
  deliver(f, "B", "# preferences\n\nWalk.");
  assert.equal(detail(f, "local").input, undefined);
  assert.equal(claim(f, "cross"), undefined);
  const source = claim(f, "A")!;
  assert.equal(source.assignment.input, "route");
  deliver(f, "A", "Coordinates", "cross");
  const cross = claim(f, "cross")!;
  const b = f.instances.B.last!;
  assert.deepEqual(cross.assignment.sources, [{ node: "A", delivery: f.instances.A.last!.id }, { node: "B", delivery: b.id }]);
  assert.equal(cross.assignment.input, "### A\n\nCoordinates\n\n### B\n\n# preferences\n\nWalk.");
  assert.equal(claim(f, "local"), undefined);
  const oldEnd = deliver(f, "cross", "First itinerary");
  assert.equal(oldEnd?.output, "First itinerary");
  assert.equal(detail(f, "cross").input, cross.assignment.input);
  rollback(f, ["A"]);
  assert.equal(view(f).state, "running");
  assert.equal(f.instances.B.last!.id, b.id);
  for (const name of ["A", "local", "cross", "end"]) {
    assert.equal(detail(f, name).output, undefined);
    assert.equal(detail(f, name).input, undefined);
    assert.equal(detail(f, name).choice, undefined);
  }
  assert.equal(f.history![0].nodes.find(n => n.name === "A")!.markdown?.choice, "cross");
  assert.throws(() => finishMarkdown(f, "A", source, "late"), /expired/);
  assert.throws(() => chooseMarkdown(f, "A", source, "cross"), /expired/);
  const next = claim(f, "A")!;
  assert.notEqual(next.id, source.id);
  deliver(f, "A", "Coordinates", "local");
  assert.equal(claim(f, "local")!.assignment.input, cross.assignment.input);
  assert.equal(claim(f, "cross"), undefined);
  const newEnd = deliver(f, "local", "New itinerary");
  assert.equal(newEnd?.output, "New itinerary");
  assert.notEqual(oldEnd?.id, newEnd?.id);
  assert.equal(normalize(f), undefined, "the same end publishes once");
  rollback(f);
  assert.equal(detail(f, "B").output, undefined);
  assert.equal(detail(f, "B").entryInput, "preferences");
});

test("a missing choice resumes on its producer while a normal edge uses the accepted output", () => {
  const f = build(task("A", "raw"), task("ordinary"), task("left"), task("right"), end, edge("A", "ordinary"),
    edge("A", "left", "one"), edge("A", "right", "two"), edge("ordinary", "end"), edge("left", "end"), edge("right", "end"));
  const a = claim(f, "A")!;
  assert.throws(() => chooseMarkdown(f, "A", a, "right"), /after submitting/);
  assert.deepEqual(finishMarkdown(f, "A", a, "original"), { staged: true, candidates: [{node:"left", case:"one"},{node:"right", case:"two"}] });
  control(f, true);
  normalize(f);
  assert.equal(detail(f, "A").output, "original");
  assert.equal(claim(f, "ordinary"), undefined);
  const recovered: Flow = JSON.parse(JSON.stringify(f));
  control(recovered, false);
  const resumed = claim(recovered, "A")!;
  assert.equal(resumed.id, a.id);
  assert.equal(resumed.staged?.output, "original");
  resumed.state = "ended";
  normalize(recovered);
  assert.equal(claim(recovered, "ordinary")!.assignment.input, "original");
  assert.equal(claim(recovered, "right"), undefined);
  assert.equal(recovered.outbox.length, 0);
  const route = claim(recovered, "A")!;
  assert.equal(route.routing, recovered.instances.A.last!.id);
  assert.equal(route.assignment.output, "original");
  assert.throws(() => finishMarkdown(recovered, "A", route, "replacement"), /already been accepted/);
  assert.throws(() => chooseMarkdown(recovered, "A", route, "ordinary"), /Invalid branch/);
  chooseMarkdown(recovered, "A", route, "right");
  chooseMarkdown(recovered, "A", route, "right");
  assert.throws(() => chooseMarkdown(recovered, "A", route, "left"), /already been chosen/);
  control(recovered, true);
  normalize(recovered);
  control(recovered, false);
  assert.equal(claim(recovered, "A"), undefined, "an accepted saved choice is never replayed");
  assert.equal(detail(recovered, "A").choice, "right");
  assert.equal(claim(recovered, "right")!.assignment.input, "original");
});

test("branch edits fence staged work and additional output never routes the graph", () => {
  const f = fork();
  const source = claim(f, "A")!;
  finishMarkdown(f, "A", source, "part");
  chooseMarkdown(f, "A", source, "local");
  deliver(f, "B", "preferences");
  const before = f.instances.B.last!.id;
  adopt(f, { replaceNode: { node: "A", requirements: "A", input: "changed" } }, false);
  assert.equal(detail(f, "A").output, undefined);
  assert.throws(() => chooseMarkdown(f, "A", source, "local"), /expired/);
  deliver(f, "A", "updated", "cross");
  const previous = claim(f, "cross")!;
  const changed = jsonl(task("A", "changed"), task("B", "preferences"), task("cross"), task("local"), end,
    edge("A","cross","international travel"),edge("A","local","local travel"),edge("B","local"),edge("B","cross"),edge("cross","end"),edge("local","end"));
  adopt(f, { graphJsonl: changed }, false);
  assert.equal(detail(f, "A").output, undefined);
  assert.equal(detail(f, "A").choice, undefined);
  assert.throws(() => finishMarkdown(f, "cross", previous, "superseded"), /expired/);
  assert.equal(f.instances.B.last!.id, before);
  additional(f, "B", "write a note");
  const extra = claim(f, "B")!;
  assert.equal(extra.kind, "extra");
  assert.equal(extra.assignment.input, "preferences");
  finishMarkdown(f, "B", extra, "independent\n\n[files](notes.txt)");
  assert.throws(() => chooseMarkdown(f, "B", extra, "cross"), /formal/);
  extra.state = "ended";
  normalize(f);
  assert.equal(f.instances.B.additionalResults![0].output, "independent\n\n[files](notes.txt)");
  assert.equal(f.instances.B.last!.id, before);
});

test("two producers can select the same target independently and a shared destination waits for both", () => {
  const graph = jsonl(task("X", "one"), task("Y", "two"), task("shared"), task("other"), end,
    edge("X", "shared", "send"), edge("X", "other", "hold"),
    edge("Y", "shared", "send"), edge("Y", "other", "hold"), edge("shared", "end"), edge("other", "end"));
  const f = empty("test");
  adopt(f, { graphJsonl: graph }, false);
  const x = claim(f, "X")!, y = claim(f, "Y")!;
  finishMarkdown(f, "X", x, "identical");
  finishMarkdown(f, "Y", y, "identical");
  chooseMarkdown(f, "Y", y, "shared");
  y.state = "ended";
  normalize(f);
  assert.equal(claim(f, "shared"), undefined);
  assert.equal(detail(f, "X").choice, undefined);
  assert.equal(detail(f, "Y").choice, "shared");
  assert.throws(() => chooseMarkdown(f, "X", y, "shared"), /expired/);
  chooseMarkdown(f, "X", x, "shared");
  control(f, true, ["X"]);
  normalize(f);
  const restored: Flow = JSON.parse(JSON.stringify(f));
  assert.equal(detail(restored, "X").choice, "shared");
  control(restored, false, ["X"]);
  const resumed = claim(restored, "X")!;
  assert.equal(resumed.staged?.selected, "shared");
  resumed.state = "ended";
  normalize(restored);
  const shared = claim(restored, "shared")!;
  assert.equal(shared.assignment.input, "### X\n\nidentical\n\n### Y\n\nidentical");
  assert.equal(claim(restored, "other"), undefined);
});

test("Hub recovery preserves partial and already accepted Markdown work across a real store restart", async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "xsb-flow-md-restart-"));
  const hubs: Hub[] = [];
  function open() {
    const h = new Hub(dir);
    h.stopping = true;
    hubs.push(h);
    return h;
  }
  t.after(async () => {
    for (const h of hubs) {
      await h.kernel.hooks.settled();
      await h.backends.close();
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const before = open();
  const owners = ["working", "staged", "chosen", "accepted"].map(phase => {
    const root = before.createConversation();
    const f = fork();
    f.owner = root.id;
    const w = claim(f, "A")!;
    if (phase !== "working") finishMarkdown(f, "A", w, "saved material");
    if (phase === "chosen") chooseMarkdown(f, "A", w, "cross");
    if (phase === "accepted") {
      w.state = "ended";
      normalize(f);
      assert.equal(claim(f, "A")!.routing, f.instances.A.last!.id);
    }
    before.state.commit([ops.workflow(f)]);
    return { owner: root.id, phase, previous: f.instances.A.work!.attempt! };
  });
  const restored = open();
  restored.workflows.restart();
  for (const { owner, phase, previous } of owners) {
    assert.equal(restored.workflows.get(owner).paused, true);
    const held = restored.workflows.read(owner);
    assert.equal(held.instances.A.work?.state, "suspended");
    assert.equal(held.instances.A.work?.attempt, undefined);
    restored.workflows.control(owner, "resume");
    const f = structuredClone(restored.workflows.read(owner));
    const w = claim(f, "A")!;
    assert.notEqual(w.attempt, previous);
    assert.equal(w.staged?.output, ["staged", "chosen"].includes(phase) ? "saved material" : undefined);
    assert.equal(w.staged?.selected, phase === "chosen" ? "cross" : undefined);
    if (phase === "accepted") {
      assert.equal(w.routing, f.instances.A.last!.id);
      assert.equal(w.assignment.output, "saved material");
    }
    if (phase === "working") finishMarkdown(f, "A", w, "saved material");
    if (phase !== "chosen") chooseMarkdown(f, "A", w, "cross");
    w.state = "ended";
    normalize(f);
    assert.equal(detail(f, "A").choice, "cross");
    assert.equal(detail(f, "A").output, "saved material");
    assert.equal(f.outbox.length, 0);
  }
});

test("changing the graph tool protocol retires the old bound conversation even with matching node names", () => {
  const f = empty("test");
  const structured = jsonl({node:"A",prompt:"write",agent:{systemPrompt:"legacy role"}}, end, edge("A","end"));
  adopt(f, { graphJsonl: structured }, false);
  const oldWork = claim(f, "A")!;
  const original = f.instances.A;
  original.sessionId = "legacy session";
  original.agentId = "legacy agent";
  adopt(f, { graphJsonl: jsonl({node:"A",requirements:"write",agent:{systemPrompt:"new role"}}, end, edge("A","end")) }, false);
  assert.notEqual(f.instances.A.id, original.id);
  assert.equal(f.instances.A.sessionId, undefined);
  assert.equal(f.instances.A.work, undefined);
  assert.equal(f.history![0].nodes.find(n => n.name === "A")!.sessionId, original.sessionId);
  assert.throws(() => finishMarkdown(f, "A", oldWork, "late"), /expired/);
  const current = f.instances.A;
  current.sessionId = "Markdown session";
  const currentWork = claim(f, "A")!;
  adopt(f, { graphJsonl: structured }, false);
  assert.equal(f.instances.A.sessionId, undefined);
  assert.notEqual(f.instances.A.id, current.id);
  assert.throws(() => finishMarkdown(f, "A", currentWork, "late"), /expired/);
  assert.equal(f.history![0].nodes.find(n => n.name === "A")!.sessionId, current.sessionId);
});

test("a routing choice that reaches an end waits for its normal turn settlement without withdrawing the caller", () => {
  const f = build(task("A", "text"), {node:"first",kind:"end"}, {node:"second",kind:"end"},
    edge("A","first","publish"),edge("A","second","archive"));
  deliver(f, "A", "published");
  const w = claim(f, "A")!;
  chooseMarkdown(f, "A", w, "first");
  assert.equal(normalize(f)?.output, "published");
  assert.equal(f.instances.A.work, w);
  assert.equal(f.instances.A.work?.attempt, w.attempt);
  w.state = "ended";
  assert.equal(normalize(f), undefined);
  assert.equal(f.instances.A.work, undefined);
  assert.equal(view(f).state, "completed");
});
