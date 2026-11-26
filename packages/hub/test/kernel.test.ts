/**
 * The kernel alone: no hub, no sessions, no backend, no ACP. A scratch store, the hooks, and a stand-in for the
 * effectors that says how busy each session is. What is checked here holds for every backend.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Addr, Task } from "@xsb/protocol";
import { Store } from "@xsb/store";
import { Hooks, isVeto } from "../src/hooks.ts";
import type { HookReports } from "../src/hooks.ts";
import { Kernel, USER, agentPrincipal } from "../src/kernel.ts";
import type { KernelHooks, Route } from "../src/kernel.ts";
import type { MailItem } from "../src/state.ts";
import { State, ops } from "../src/state.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-kernel-"));
const state = new State(new Store(dir));
state.load();
for (const id of ["a", "b", "c"]) state.commit([ops.putAgent({ id, name: id, description: "", backend: "mock", workspace: dir, createdAt: "" })]);

const vetoes: string[] = [];
const dead: string[] = [];
const reports: HookReports = { log: () => {}, vetoed: (point, _p, veto) => vetoes.push(`${point}: ${veto.veto}`), deadLetter: (point) => dead.push(point) };
const hooks: KernelHooks = new Hooks(reports);
/** Sessions that are busy, and task ids a tool call waits for. */
const busy = new Set<string>();
const awaited = new Set<string>();
/** Sessions whose running turn is the user's: started or spoken into by the user. */
const protectedTurns = new Set<string>();
const kernel = new Kernel(state, hooks, (to) => ({ exists: state.agents.has(to.agentId), busy: busy.has(to.sessionId), awaits: (id) => awaited.has(id), ...(busy.has(to.sessionId) ? { turn: { id: `turn-${to.sessionId}`, protected: protectedTurns.has(to.sessionId), taskIds: [...state.tasks.values()].filter((t) => t.to.sessionId === to.sessionId && t.status === "running").map((t) => t.id) } } : {}) }));
// What the effectors would do: a task given is a task its executor has (in a session, `started`).
const routed: { item: MailItem; route: Route }[] = [];
hooks.on("message.routed", (r) => void routed.push(r));
const delivered: string[] = [];
hooks.on("notify.delivered", ({ item }) => void delivered.push(item.id));

const A: Addr = { agentId: "a", sessionId: "sa" };
const B: Addr = { agentId: "b", sessionId: "sb" };
const C: Addr = { agentId: "c", sessionId: "sc" };
const give = (from: Addr, to: Addr, title: string, extra: Partial<Task> = {}): Task => {
  const task = kernel.dispatch(from, to, { title, topic: title, instructions: "", after: [], ...extra });
  assert.ok(!isVeto(task));
  return task;
};
/** The executor was given it. */
const handed = (task: Task): Task => {
  kernel.started(task.id);
  return state.tasks.get(task.id)!;
};
const results = (to: Addr, id: string) => [...state.mail.values()].filter((m) => m.to.sessionId === to.sessionId && m.results?.taskIds.includes(id));
const settle = () => hooks.settled();

// Unowned backend execution is a policy hook; its default does not touch business state.
{
  const p = { ...B, run: { id: "background", turnId: null }, action: "show" as const };
  const before = state.tasks.size;
  assert.deepEqual(hooks.decide("acp.pre_unowned_run", p), p);
  const customHooks: KernelHooks = new Hooks(reports);
  new Kernel(state, customHooks, () => ({ exists: true, busy: false, awaits: () => false }));
  customHooks.decider("acp.pre_unowned_run", p => ({ ...p, action: "stop" }));
  assert.equal((customHooks.decide("acp.pre_unowned_run", p) as typeof p).action, "stop");
  customHooks.decider("acp.pre_unowned_run", () => { throw new Error("policy failed"); });
  assert.ok(isVeto(customHooks.decide("acp.pre_unowned_run", p)));
  assert.equal(state.tasks.size, before);
}

// Done and stopped share one pipeline: the end says why and who; every party but the one who ended it is notified.
{
  const t = handed(give(A, B, "done"));
  kernel.complete(t, "completed", "DONE", []);
  assert.deepEqual(state.tasks.get(t.id)!.ended, { reason: "completed", stopper: agentPrincipal("b") });
  assert.equal(results(A, t.id).length, 1, "the dispatcher is notified");
  const u = handed(give(A, B, "stopped"));
  const stopped = kernel.stop(u, agentPrincipal("a"), { status: "cancelled", reason: "cancelled", result: "no" });
  assert.ok(!isVeto(stopped));
  assert.equal(results(A, u.id).length, 0, "stopper == initiator: not notified");
  assert.ok([...state.mail.values()].some((m) => m.to.sessionId === "sb" && m.pref === "lazy" && m.content?.includes(`a cancelled the task "stopped"`)), "an idle executor finds a word of it in its inbox");
  const v = handed(give(A, B, "by the user"));
  kernel.stop(v, USER, { status: "cancelled", reason: "cancelled", result: "Cancelled by the user." });
  assert.equal(results(A, v.id).length, 1, "the user stopped it: the dispatcher is notified");
  console.log("ok 1 one end for done and stopped");
}

// task.pre_stop: only the dispatcher, the user or xsb may stop a task; a veto is reported for the audit.
{
  const t = give(A, B, "not yours");
  const refused = kernel.stop(t, agentPrincipal("c"), { status: "cancelled", reason: "cancelled", result: "" });
  assert.ok(isVeto(refused));
  assert.equal(state.tasks.get(t.id)!.status, "queued");
  assert.match(vetoes.at(-1)!, /^task.pre_stop: no task/);
  // A decider that throws vetoes (fail-closed).
  hooks.decider("task.pre_create", (p) => {
    if (p.task.title === "boom") throw new Error("quota");
    return p;
  });
  assert.deepEqual(kernel.dispatch(A, B, { title: "boom", topic: "x", instructions: "", after: [] }), { veto: "task.pre_create: quota" });
  console.log("ok 2 deciders veto, fail-closed");
}

// Cascade: what the stopped task alone held up goes, its stopper the root cause; cascade.pre_propagate can take the rest.
{
  const P = handed(give(A, B, "P"));
  const onlyP = give(B, C, "onlyP"); // started while b had P alone
  const Q = handed(give(C, B, "Q"));
  const both = handed(give(B, C, "both")); // started while b had P and Q
  assert.deepEqual([...both.parents!].sort(), [P.id, Q.id].sort());
  const r = kernel.stop(P, agentPrincipal("a"), { status: "cancelled", reason: "cancelled", result: "" });
  assert.ok(!isVeto(r));
  assert.deepEqual(r.with.map((t) => t.title), ["onlyP"]);
  assert.deepEqual(state.tasks.get(onlyP.id)!.ended, { reason: "cascaded", stopper: agentPrincipal("a"), cause: P.id });
  assert.equal(state.tasks.get(both.id)!.status, "running", "spared: Q still holds it");
  // A policy that has everything go.
  const R = handed(give(A, B, "R"));
  const S = handed(give(C, B, "S"));
  const shared = give(B, C, "shared");
  assert.deepEqual([...shared.parents!].sort(), [Q.id, R.id, S.id].sort());
  hooks.decider("cascade.pre_propagate", (p) => p.root.id === R.id ? { ...p, cascade: "force" } : p);
  const forced = kernel.stop(R, agentPrincipal("a"), { status: "cancelled", reason: "cancelled", result: "" });
  assert.ok(!isVeto(forced) && forced.with.some((t) => t.id === shared.id));
  for (const t of [Q, S]) kernel.complete(state.tasks.get(t.id)!, "completed", "", []);
  console.log("ok 3 cascade and its policy");
}

// One pipeline, `message.pre_deliver`: a message in the inbox is delivered whether or not it calls a backend; how it
// reaches the model is decided apart, by the recipient's preference and state.
{
  routed.length = 0;
  const lazy = handed(give(A, B, "lazy"));
  kernel.complete(lazy, "completed", "", []);
  const sync = handed(give(A, B, "sync", { deliveryPref: "sync" }));
  awaited.add(sync.id);
  kernel.complete(sync, "completed", "", []);
  awaited.clear();
  const wake = handed(give(A, B, "wake", { deliveryPref: "wake" }));
  kernel.complete(wake, "completed", "", []);
  await settle();
  const routeOf = (id: string) => routed.find((r) => r.item.results?.taskIds[0] === id)?.route;
  assert.deepEqual([routeOf(lazy.id), routeOf(sync.id), routeOf(wake.id)], ["inbox", "return", "turn"]);
  assert.equal(state.ledger.get(results(A, lazy.id)[0].id)!.state, "inboxed");
  assert.ok(kernel.inbox("sa").some((m) => m.results?.taskIds[0] === lazy.id));
  assert.ok(!kernel.inbox("sa").some((m) => m.results?.taskIds[0] === wake.id));
  for (const id of [lazy.id, sync.id, wake.id]) assert.ok(delivered.includes(results(A, id)[0].id), "notified, whatever the route");
  console.log("ok 4 notified is not woken");
}

// §7.1 on the same pipeline: the user's word never waits. A peer's goes into a turn that is an agent's, and waits
// its turn when the running turn is the user's (started or spoken into by the user).
{
  const t = handed(give(A, B, "work"));
  busy.add("sb");
  const say = (from: MailItem["from"], content: string, pref: "wake" | "lazy" = "wake") => kernel.post({ to: B, from, kind: "message", content, pref });
  assert.equal(say({ kind: "agent", ...A }, "into the agent's turn").route, "interject");
  assert.equal(say({ kind: "agent", ...C }, "from someone else, too").route, "interject");
  assert.equal(say({ kind: "agent", ...C }, "not urgent", "lazy").route, "inbox");
  protectedTurns.add("sb");
  assert.equal(say({ kind: "user" }, "from the user").route, "interject");
  const dispatcher = say({ kind: "agent", ...A }, "from the dispatcher");
  assert.equal(dispatcher.route, "turn");
  assert.equal(state.ledger.get(dispatcher.item.id)!.state, "queued");
  const other = say({ kind: "agent", ...C }, "from someone else");
  assert.equal(other.route, "turn");
  assert.equal(state.ledger.get(other.item.id)!.state, "queued");
  protectedTurns.clear();
  busy.clear();
  assert.equal(say({ kind: "user" }, "now idle").route, "turn");
  kernel.complete(state.tasks.get(t.id)!, "completed", "", []);
  console.log("ok 5 arbitration");
}

// Explicit replacement: a new task of the dispatcher takes the place of its work the session runs. That work ends as
// superseded, what was started for it goes with it, and the dispatcher, who stopped it, is told nothing.
{
  const theirs = handed(give(C, B, "someone else's"));
  const first = handed(give(A, B, "first"));
  const child = handed(give(B, C, "child of first"));
  busy.add("sb");
  busy.add("sc");
  const second = give(A, B, "second");
  assert.equal(state.ledger.get([...state.mail.values()].find((m) => m.taskId === second.id)!.id)!.state, "submitted", "an agent's task goes into a turn that is an agent's");
  assert.deepEqual(kernel.replace(second, "turn-sb"), [], "mixed work queues without partially cancelling the turn");
  assert.equal(state.tasks.get(first.id)!.status, "running");
  assert.equal(state.tasks.get(theirs.id)!.status, "running");
  assert.equal(state.tasks.get(child.id)!.status, "running");
  const removed = kernel.stop(theirs, agentPrincipal("c"), { status: "cancelled", reason: "cancelled", result: "C withdrew its work" });
  assert.ok(!isVeto(removed));
  assert.equal(state.tasks.get(child.id)!.status, "running", "A still supports the shared child");
  const replaced = kernel.replace(second, "turn-sb");
  assert.deepEqual(replaced.map((t) => t.id), [first.id], "only the dispatcher's own work");
  busy.clear();
  hooks.emit("acp.turn_ended", { agentId: "b", sessionId: "sb", turnId: "turn-sb", stopReason: "cancelled", failed: false });
  hooks.emit("acp.turn_ended", { agentId: "c", sessionId: "sc", turnId: "turn-sc", stopReason: "cancelled", failed: false });
  await settle();
  assert.deepEqual(state.tasks.get(first.id)!.ended, { reason: "superseded", stopper: agentPrincipal("a") });
  assert.deepEqual(state.tasks.get(child.id)!.ended, { reason: "cascaded", stopper: agentPrincipal("a"), cause: first.id });
  assert.equal(state.tasks.get(theirs.id)!.ended?.stopper.kind, "agent");
  assert.deepEqual(state.tasks.get(theirs.id)!.ended?.stopper, agentPrincipal("c"), "replacement did not cancel another initiator's work");
  assert.equal(results(A, first.id).length, 0, "its dispatcher stopped it, and is not told");
  assert.equal(state.tasks.get(second.id)!.status, "queued");
  kernel.complete(handed(state.tasks.get(second.id)!), "completed", "", []);
  console.log("ok 5b explicit replacement");
}

// Implicit completion: a turn's end ends the session's tasks with its last words, unless something started for one is
// to come back; one without the asset it has to produce is asked again (QualityGate), then fails.
{
  const waiting = handed(give(A, B, "waits for a child"));
  const child = give(B, C, "child", { deliveryPref: "wake" });
  assert.ok(child.parents!.includes(waiting.id));
  const plain = handed(give(A, B, "implicit"));
  kernel.turnEnded("sb", "end_turn", () => "THE ANSWER");
  assert.deepEqual([state.tasks.get(plain.id)!.status, state.tasks.get(plain.id)!.result], ["completed", "THE ANSWER"]);
  assert.equal(state.tasks.get(waiting.id)!.status, "running", "its child is to wake it");
  kernel.complete(handed(state.tasks.get(child.id)!), "completed", "", []);
  kernel.turnEnded("sb", "end_turn", () => "still waiting");
  assert.equal(state.tasks.get(waiting.id)!.status, "running", "the child's result is on its way");
  // The turn that brings it reads it (the effectors acknowledge it), and ends.
  kernel.ack(results(B, child.id).map((m) => m.id));
  kernel.turnEnded("sb", "end_turn", () => "NOW DONE");
  assert.equal(state.tasks.get(waiting.id)!.result, "NOW DONE");

  const contract = handed(give(A, B, "must make a frame", { produces: "frame" }));
  kernel.turnEnded("sb", "end_turn", () => "nothing");
  kernel.turnEnded("sb", "end_turn", () => "nothing");
  assert.equal(state.tasks.get(contract.id)!.status, "running", "asked again, twice");
  assert.equal([...state.mail.values()].filter((m) => m.to.sessionId === "sb" && m.content?.includes("is not done")).length, 2);
  kernel.turnEnded("sb", "end_turn", () => "nothing");
  assert.deepEqual([state.tasks.get(contract.id)!.status, state.tasks.get(contract.id)!.ended!.reason], ["failed", "error"]);
  console.log("ok 6 implicit completion and its quality gate");
}

// The ledger only moves forward, from the receipts and what follows them; the stop of a turn decides the rest.
{
  const about = { agentId: "b", sessionId: "sx", from: { kind: "user" } as const };
  const receipt = (messageId: string, inserted = true) => hooks.emit("message.insertion_receipt", { messageId, about, inserted });
  receipt("m1");
  receipt("m2", false);
  hooks.emit("acp.turn_ended", { agentId: "b", sessionId: "sx", turnId: "turn-sx", stopReason: "cancelled", failed: false });
  await settle();
  assert.equal(state.ledger.get("m1")!.state, "inserted_unprocessed");
  assert.equal(state.ledger.get("m2")!.state, "discarded_unseen", "-32800: it never got in");
  hooks.emit("acp.session_update", { agentId: "b", sessionId: "sx", source: { agentId: "b", sessionId: "sx", turnId: null }, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "on" } } as any });
  await settle();
  assert.equal(state.ledger.get("m1")!.state, "seen", "seen when the session goes on");
  kernel.mark("m1", "queued");
  assert.equal(state.ledger.get("m1")!.state, "seen", "never back");
  receipt("m3");
  hooks.emit("acp.turn_ended", { agentId: "b", sessionId: "sx", turnId: "turn-sx", stopReason: "cancelled", failed: false });
  hooks.emit("acp.session_renewed", { agentId: "b", sessionId: "sx" });
  await settle();
  assert.equal(state.ledger.get("m3")!.state, "discarded_unseen", "its session is gone");
  console.log("ok 7 ledger");
}

// Observers: isolated, tried again, then a dead letter.
{
  let tries = 0;
  let others = 0;
  hooks.on("task.created", () => {
    tries++;
    throw new Error("broken");
  });
  hooks.on("task.created", () => void others++);
  give(A, B, "observed");
  await settle();
  assert.deepEqual([tries, others, dead], [3, 1, ["task.created"]]);
  console.log("ok 8 observers");
}

// A stop that waits for its session is recorded when it is decided: xsb restarting meanwhile ends the task as the stop
// said, never as done by a turn that happened to end. What got into the conversation is not said never to have.
{
  busy.add("sb");
  const t = handed(give(A, B, "stopped across a restart"));
  const mail = [...state.mail.values()].find((m) => m.taskId === t.id)!;
  kernel.mark(mail.id, "inserted");
  const stopped = kernel.stop(t, agentPrincipal("a"), { status: "cancelled", reason: "cancelled", result: "no" });
  assert.ok(!isVeto(stopped) && stopped.stopping);
  const twice = kernel.stop(state.tasks.get(t.id)!, USER, { status: "cancelled", reason: "cancelled", result: "" });
  assert.ok(!isVeto(twice) && twice.stopping && !twice.with.length, "stopped once");
  assert.equal(state.ledger.get(mail.id)!.state, "inserted", "the ledger keeps what happened");
  kernel.turnEnded("sb", "end_turn", () => "unrelated words");
  assert.equal(state.tasks.get(t.id)!.status, "running", "a turn's end does not complete a task being stopped");
  // Another hub, from what is on disk.
  const again = new State(new Store(dir));
  again.load();
  assert.equal(again.tasks.get(t.id)!.stopping?.reason, "cancelled");
  new Kernel(again, new Hooks(reports), () => ({ exists: true, busy: false, awaits: () => false })).resume();
  assert.deepEqual([again.tasks.get(t.id)!.status, again.tasks.get(t.id)!.ended], ["cancelled", { reason: "cancelled", stopper: agentPrincipal("a") }]);
  assert.equal(again.tasks.get(t.id)!.stopping, undefined);
  // This hub: the session confirms.
  busy.delete("sb");
  hooks.emit("acp.turn_ended", { agentId: "b", sessionId: "sb", turnId: "turn-sb", stopReason: "cancelled", failed: false });
  await settle();
  assert.equal(state.tasks.get(t.id)!.status, "cancelled");
  console.log("ok 7b a stop survives a restart; the ledger is not rewritten");
}

// Abandon: everything open ends as interrupted by the user; who has to know is notified to its inbox, waking nobody.
{
  const { tasks } = kernel.abandon();
  assert.ok(tasks > 0);
  assert.ok([...state.tasks.values()].every((t) => t.status !== "running" && t.status !== "queued"));
  assert.ok([...state.mail.values()].every((m) => m.pref === "lazy" && state.ledger.get(m.id)!.state === "inboxed"));
  assert.ok([...state.tasks.values()].filter((t) => t.status === "interrupted").every((t) => t.ended!.stopper.kind === "user"));
  console.log("ok 9 abandon");
}

// Durable terminal prompts/tasks cannot be routed into new work when the hub resumes.
{
  const message = kernel.post({ to: B, from: { kind: "user" }, kind: "message", prompt: [{ type: "text", text: "discarded" }], pref: "wake" }).item;
  kernel.mark(message.id, "discarded_unseen");
  const task = handed(give(A, B, "finished before mail acknowledgement"));
  const taskMail = [...state.mail.values()].find(m => m.taskId === task.id)!;
  kernel.complete(task, "completed", "done", []);
  await settle(); // Drain the original, valid routing events before measuring resume events.
  routed.length = 0;
  kernel.resume(); await settle();
  assert.ok(!routed.some(r => r.item.id === message.id || r.item.id === taskMail.id));
  assert.ok(!state.mail.has(message.id) && !state.mail.has(taskMail.id));
  assert.equal(state.tasks.get(task.id)!.status, "completed");
  console.log("ok 10 terminal input is not replayed on resume");
}
fs.rmSync(dir, { recursive: true, force: true });
console.log("kernel: ok");
