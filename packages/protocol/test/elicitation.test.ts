import assert from "node:assert/strict";
import { test } from "node:test";
import { elicitationForm, elicitationContent, elicitationAnswers } from "../src/elicitation.ts";
import type { ElicitationRequest } from "../src/acp.ts";

test("Claude select/custom fields share one UI question and preserve enum values, multi-select and defaults", () => {
  const request: ElicitationRequest = { mode: "form", sessionId: "s", message: "Questions", requestedSchema: { type: "object", properties: {
    question_0: { type: "string", description: "Where?", oneOf: [{ const: "cn", title: "China", description: "Local" }, { const: "us", title: "US" }], default: "cn" },
    question_0_custom: { type: "string", title: "Other" },
    question_1: { type: "array", description: "Which?", items: { anyOf: [{ const: "desktop", title: "Desktop" }, { const: "web", title: "Web" }] } },
    question_1_custom: { type: "string", title: "Other" },
  } } };
  const form = elicitationForm(request);
  assert.equal(form.questions.length, 2);
  assert.equal(form.questions[0].default, "China");
  assert.equal(form.questions[0].other, true);
  assert.equal(form.questions[1].kind, "multi");
  const content = elicitationContent(form, ["Japan", ["Desktop", "Mobile"]]);
  assert.deepEqual(content, { question_0_custom: "Japan", question_1: ["desktop"], question_1_custom: "Mobile" });
  assert.deepEqual(elicitationAnswers(form, content), ["Japan", ["Desktop", "Mobile"]]);
});

test("required selections and numeric constraints are validated while optional fields may stay empty", () => {
  const form = elicitationForm({ mode: "form", sessionId: "s", message: "Configure", requestedSchema: { type: "object", required: ["count"], properties: {
    count: { type: "integer", minimum: 1, maximum: 5 }, note: { type: "string" }, agree: { type: "boolean" },
  } } });
  assert.deepEqual(elicitationContent(form, ["3", null, "true"]), { count: 3, agree: true });
  assert.throws(() => elicitationContent(form, [null, null, null]), /required/);
  assert.throws(() => elicitationContent(form, ["8", null, null]), /allowed range/);
  assert.throws(() => elicitationContent(form, ["1.5", null, null]), /number/);
});

test("unknown field schemas are rejected instead of being displayed as a supported form", () => {
  assert.throws(() => elicitationForm({ mode: "form", sessionId: "s", message: "", requestedSchema: { type: "object", properties: { custom: { type: "object" } } } }), /Unsupported/);
});
