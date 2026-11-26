import assert from "node:assert/strict";
import test from "node:test";
import { Hooks } from "../src/hooks.ts";
import { Lifecycle } from "../src/lifecycle.ts";
import { skillPrompt } from "../src/prompt-capabilities.ts";
import { airSuggestions } from "../src/air-compat.ts";
import type { KernelHooks } from "../src/kernel.ts";

function hooks(): KernelHooks { return new Hooks({ log() {}, vetoed() {}, deadLetter() {} }); }
test("lifecycle captures immutable causality and dispatch does not await background observers", async () => {
  const h = hooks(), lifecycle = new Lifecycle(h);
  let release!: () => void;
  const pending = new Promise<void>(resolve => release = resolve);
  const source = { agentId: "a", sessionId: "s", turnId: "old" };
  let completed = false, observed: any;
  h.on("turn.ended", async event => { observed = event; await pending; completed = true; });
  lifecycle.emit("turn.ended", source, { status: "completed" });
  source.turnId = "new";
  await h.settled();
  assert.equal(observed.source.turnId, "old");
  assert.equal(completed, false);
  assert.throws(() => { observed.source.turnId = "spoofed"; }, TypeError);
  const barrier = h.completed(); release(); await barrier;
  assert.equal(completed, true);
});
test("steps may complete after their turn and emit one end with the original source", async () => {
  const h = hooks(), lifecycle = new Lifecycle(h), ends: any[] = [];
  h.on("step.ended", event => { ends.push(event); });
  const source = { agentId: "a", sessionId: "s", turnId: "old", contextEpoch: 1 };
  const step = lifecycle.step(source, "job:1");
  lifecycle.emit("turn.ended", source);
  source.turnId = "new"; source.contextEpoch = 2;
  step.end({ status: "completed" }); step.end({ status: "failed" }); await h.settled();
  assert.equal(ends.length, 1);
  assert.equal(ends[0].source.turnId, "old");
  assert.equal(ends[0].source.contextEpoch, 1);
  assert.equal(ends[0].source.stepId, "job:1");
});
test("observers with effects can opt out of automatic retries", async () => {
  const h = hooks(); let calls = 0;
  h.on("turn.started", async () => { calls++; throw new Error("failed effect"); }, { retries: 0 });
  new Lifecycle(h).emit("turn.started", { agentId: "a", sessionId: "s", turnId: "t" });
  await h.completed(); assert.equal(calls, 1);
});
test("native skill references precede context without changing context contents", () => {
  const context = { type: "text", text: "constant context" }, skill = { type: "skill", name: "pdf" };
  assert.deepEqual(skillPrompt([context, skill], { skill: true }), [skill, context]);
  assert.deepEqual(skillPrompt([context, skill], { skill: true, inlineSkill: true }), [context, skill]);
  assert.throws(() => skillPrompt([skill], {}), /does not support/);
  assert.throws(() => skillPrompt([skill, skill], { skill: true }), /only one/);
});
test("AIR-only suggestions normalize into standard prompts and withdrawals stay empty", () => {
  assert.deepEqual(airSuggestions({ sessionUpdate: "session_info_update", _meta: { promptSuggestions: { suggestions: [{ text: "Continue" }] } } }), [{ prompt: [{ type: "text", text: "Continue" }] }]);
  assert.deepEqual(airSuggestions({ sessionUpdate: "session_info_update", _meta: { promptSuggestions: { suggestions: [] } } }), []);
});

test("an asynchronous decision cannot accidentally authorize a state transition", async () => {
  const h = new Hooks<any, any>({ log() {}, vetoed() {}, deadLetter() {} });
  h.decider("create", async (value: unknown) => value);
  assert.match(h.decide("create", { allowed: true }).veto, /must be synchronous/);
  await Promise.resolve();
});
