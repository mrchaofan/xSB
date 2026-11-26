import assert from "node:assert/strict";
import { test } from "node:test";
import { backendPresentation } from "../renderer/backend-state.js";
import { TEXT } from "../renderer/text.js";

const installed = { name: "codex", cli: "codex", installed: true };

test("setup always offers the next useful action, based on executable readiness", () => {
  assert.equal(backendPresentation({ ...installed, installed: false }).primary, "install");
  assert.equal(backendPresentation(installed).primary, "check");
  const ready = backendPresentation(installed, { state: "ready" });
  assert.equal(ready.state, "ready");
  assert.equal(ready.emphasized, false);
  assert.equal(ready.label, "recheck");
  assert.equal(backendPresentation(installed, { state: "broken" }).tone, "error");
  assert.equal(backendPresentation({ ...installed, installed: false }, { state: "ready" }).state, "missing");
});

test("failure recovery retries the failed operation and progress locks the primary action", () => {
  for (const action of ["install", "check", "locate"]) {
    const failure = backendPresentation(installed, { state: "ready" }, { action });
    assert.equal(failure.primary, action);
    assert.equal(failure.label, `retry.${action}`);
    assert.equal(failure.tone, "error");
    const pending = backendPresentation(installed, { state: "ready" }, { action }, "installing");
    assert.equal(pending.primary, null);
    assert.equal(pending.tone, "progress");
  }
  assert.equal(backendPresentation({ name: "custom", installed: false, missing: "my-tool" }).primary, "locate");
  assert.equal(backendPresentation({ name: "custom", installed: true }).primary, null);
});

test("all readiness states and recovery actions have complete translations", () => {
  for (const language of ["zh-CN", "en"] as const) {
    for (const state of ["missing", "found", "ready", "broken", "installing", "checking", "locating"]) {
      assert.ok(TEXT[language][`backend.status.${state}`]);
      assert.ok(TEXT[language][`backend.detail.${state}`]);
    }
    for (const action of ["install", "check", "locate", "recheck", "installing", "checking", "locating", "retry.install", "retry.check", "retry.locate"]) assert.ok(TEXT[language][`backend.action.${action}`]);
  }
});
