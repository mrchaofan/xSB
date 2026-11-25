import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { text } from "@xsb/protocol";
import type { NodeDef } from "@xsb/protocol";
import { Hub } from "../src/hub.ts";
import { ops } from "../src/state.ts";
import { deferred, newId } from "../src/util.ts";
import type { LiveSession, Turn } from "../src/session.ts";
import { validateResult, parseGraph } from "../src/workflow-graph.ts";
import { additional, adopt, claim, control, empty, normalize, view } from "../src/workflow-state.ts";
import type { Flow } from "../src/workflow-state.ts";

const graph = (...rows: unknown[]) => rows.map((v) => JSON.stringify(v)).join("\n");
const task = (node: string, prompt = node) => ({ node, prompt });
const end = (node = "end") => ({ node, kind: "end" });
const edge = (from: string, to: string, choice?: string) => ({ from, to, case: choice });
const build = (graphJsonl: string) => {
  const f = empty("root");
  adopt(f, { graphJsonl }, 100000, false);
  normalize(f);
  return f;
};
const replace = (f: Flow, node: string, prompt: string) => {
  adopt(f, { replaceNode: task(node, prompt) }, 100000, false);
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

test("validation exhausts a single budget and returns a counterexample for an ambiguous route", () => {
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
  assert.throws(() => parseGraph(graph(task("a"), end(), edge("a", "end")), 3), /分支组合过多/);
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
      version: "second",
      graphJsonl: graph(
        ...f.versions[oldVersion].nodes.map((n) => (n.node === "A" ? task("A", "slimmer") : n)),
        ...f.versions[oldVersion].edges,
      ),
    },
    100000,
    true,
  );
  assert.equal(f.instances.D.work, firstD);
  adopt(f, { version: "second" }, 100000, false);
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
  adopt(f, { version: f.active }, 100000, false);
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
  adopt(f, { version: "preview", graphJsonl: second }, 100000, true);
  replace(f, "A", "updated");
  assert.throws(() => adopt(f, { version: "preview" }, 100000, false), /stale/);
  assert.throws(() => adopt(f, { version: "preview", graphJsonl: first }, 100000, true), /bound/);
  adopt(f, { graphJsonl: second }, 100000, false);
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
  assert.deepEqual(invoke(root, "asset_put", { name: "base", path: asset }), { name: "base", version: "v1" });
  const otherRoot = hub.createConversation();
  turnFor(otherRoot, "separate-conversation");
  assert.deepEqual(invoke(otherRoot, "asset_version_get", { name: "base" }), { name: "base", version: "v1" });
  invoke(root, "asset_put", { name: "private", path: asset });
  invoke(root, "execute", {
    graphJsonl: graph({ ...task("A"), input: { base: { name: "base", version: "v1" } } }, end(), edge("A", "end")),
  });
  const f = structuredClone(runtime.read(root.id)),
    w = claim(f, "A")!;
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
  assert.throws(() => invoke(worker, "asset_get", { name: "private", version: "v1" }), /outside/);
  const privateFile = (invoke(otherRoot, "asset_get", { name: "private", version: "v1" }) as { path: string }).path;
  assert.throws(() => invoke(worker, "asset_put", { name: "copy", path: privateFile }), /outside/);
  assert.deepEqual(invoke(worker, "asset_version_get", { name: "base" }), { name: "base", version: "v1" });
  fs.writeFileSync(asset, "revised");
  invoke(worker, "asset_put", { name: "base", path: asset });
  assert.deepEqual(invoke(otherRoot, "asset_version_get", { name: "base" }), { name: "base", version: "v2" });
  invoke(otherRoot, "asset_put", { name: "base", path: null });
  assert.equal(invoke(root, "asset_version_get", { name: "base" }), null);
  assert.deepEqual(invoke(worker, "asset_version_get", { name: "base" }), { name: "base", version: "v1" });
  invoke(otherRoot, "asset_version_put", { name: "base", version: "v2" });
  assert.deepEqual(invoke(root, "asset_version_get", { name: "base" }), { name: "base", version: "v2" });
  assert.equal((invoke(worker, "asset_get", { name: "base", version: "v1" }) as any).content, "original");
  invoke(worker, "finish", { summary: "done", assets: [{ name: "base", version: "v2" }] });
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
  restarted.workflows.clientControl(root.id, false);
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
  adopt(next, { graphJsonl: graph(task("A"), end(), edge("A", "end")) }, 100000, false);
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
  adopt(again, { version: again.active }, 100000, false);
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
