import assert from "node:assert/strict";
import { test } from "node:test";
import { Ajv } from "ajv";
import { elicitationForm, elicitationContent, elicitationAnswers, elicitationResponseSchema } from "../src/elicitation.ts";
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

test("Claude's single question keeps its full message above the choices", () => {
  const form = elicitationForm({ sessionId: "s", mode: "form", message: "Which database should we ship?", requestedSchema: { type: "object", properties: {
    question_0: { type: "string", title: "Database", oneOf: [{ const: "Local", description: "Offline" }, { const: "Other" }] },
    question_0_custom: { type: "string", title: "Other" },
  } } });
  assert.equal(form.questions[0].question, "Which database should we ship?");
  assert.deepEqual(form.questions[0].options, ["Local", "Other"]);
  assert.deepEqual(elicitationContent(form, ["Other"]), { question_0: "Other" });
  assert.deepEqual(elicitationAnswers(form, { question_0: "Other" }), ["Other"]);
});

for (const air of [true, false]) test(`Codex ${air ? "AIR" : "standard"} form encodes preset, typed, and independent optional answers`, () => {
  const marker = { version: 1, customAnswer: true };
  const request: ElicitationRequest = { mode: "form", sessionId: "s", message: "Codex needs your input to continue.",
    ...(air ? { _meta: { jetbrains: { air: { version: 1, customAnswerFields: ["question_0_note_2"] } } } } : {}),
    requestedSchema: { type: "object", required: ["question_0"], properties: {
      question_0: { type: "string", title: "Which release?", description: "Release", _meta: { codex: { isOther: true, isSecret: false } },
        oneOf: [{ const: "Beta", title: "Beta", description: "Preview" }, ...(air ? [] : [{ const: "None of the above", title: "None of the above" }])] },
      question_0_note_2: { type: "string", title: "Additional answer or note", _meta: {
        codex: { role: "user_note", questionId: "question_0" }, ...(air ? { jetbrains: { air: marker } } : {}),
      } },
      question_0_note: { type: "string", title: "Additional context?", _meta: { codex: { isOther: false } } },
    } },
  };
  const form = elicitationForm(request);
  const ajv = new Ajv({ strict: false });
  const valid = ajv.compile(elicitationResponseSchema(request));
  assert.deepEqual(form.questions.map(q => q.question), ["Which release?", "Additional context?"]);
  assert.deepEqual(form.questions[0].options, ["Beta"]);
  const preset = elicitationContent(form, ["Beta", null]);
  assert.deepEqual(preset, { question_0: "Beta" });
  assert.equal(valid(preset), true);
  const custom = elicitationContent(form, ["Nightly", "Linux"]);
  assert.deepEqual(custom, air ? { question_0: "Nightly", question_0_note: "Linux" }
    : { question_0: "None of the above", question_0_note_2: "Nightly", question_0_note: "Linux" });
  assert.equal(valid(custom), true);
  assert.deepEqual(elicitationAnswers(form, custom), ["Nightly", "Linux"]);
  assert.equal(valid({}), false);
  assert.equal(valid({ question_0: "  " }), false);
  assert.equal(valid({ question_0: "unlisted" }), air);
  const unmarked = { ...request, _meta: {} };
  assert.equal(ajv.compile(elicitationResponseSchema(unmarked))({ question_0: "unlisted" }), false);
  const optional = { ...request, requestedSchema: { ...request.requestedSchema, required: [] } };
  assert.deepEqual(elicitationContent(elicitationForm(optional), [null, "Linux"]), { question_0_note: "Linux" });
});
