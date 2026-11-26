/** ACP forms projected onto the same questions used by xSB's own ask UI. */
import type { FormElicitationRequest } from "./acp.ts";
import type { QuestionAnswer, QuestionItem } from "./ext.ts";
import { RpcError } from "./jsonrpc.ts";

type Field = { key: string; schema: any; choices: { label: string; value: unknown }[]; custom?: string; otherValue?: unknown };
export type ElicitationForm = { questions: QuestionItem[]; fields: Field[] };
const fail = (message: string): never => { throw RpcError.invalidParams(message); };

export function elicitationForm(request: FormElicitationRequest): ElicitationForm {
  const schema = request.requestedSchema;
  if (request.mode !== "form" || schema?.type !== "object" || !schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties))
    return fail("Unsupported elicitation form");
  const props = schema.properties;
  const companions = new Map<string, string>();
  for (const [key, prop] of Object.entries(props)) {
    const codex = prop?._meta?.codex;
    const custom = prop?._meta?.jetbrains?.air?.customAnswer ?? prop?._meta?._askUserQuestionCustomAnswer;
    const target = custom?.isCustomAnswer === true ? custom.questionId : codex?.role === "user_note" ? codex.questionId
      : /^question_\d+_custom$/.test(key) && prop?.title === "Other" ? key.slice(0, -7) : undefined;
    if (prop?.type === "string" && typeof target === "string" && props[target]) companions.set(target, key);
  }
  const fields: Field[] = [], questions: QuestionItem[] = [];
  for (const [key, prop] of Object.entries(props)) {
    if ([...companions.values()].includes(key)) continue;
    if (!prop || !["string", "array", "number", "integer", "boolean"].includes(prop.type)) return fail(`Unsupported form field: ${key}`);
    const choicesSchema = prop.type === "array" ? prop.items : prop;
    const enumOptions = choicesSchema?.oneOf ?? choicesSchema?.anyOf ?? choicesSchema?.enum?.map((value: unknown) => ({ const: value }));
    if (prop.type === "array" && !Array.isArray(enumOptions)) return fail(`Unsupported array field: ${key}`);
    const choices = (prop.type === "boolean" ? [{ const: true, title: "true" }, { const: false, title: "false" }] : enumOptions ?? []).map((o: any) => {
      if (!o || !Object.hasOwn(o, "const")) return fail(`Invalid form option: ${key}`);
      return { label: String(o.title ?? o.const), value: o.const, description: String(o.description ?? "") };
    });
    if (new Set(choices.map((o: any) => o.label)).size !== choices.length) return fail(`Ambiguous form options: ${key}`);
    const field: Field = { key, schema: prop, choices, custom: companions.get(key) };
    if (field.custom) {
      const other = choices.findIndex((o: any) => o.value === "Other");
      if (other >= 0) field.otherValue = choices.splice(other, 1)[0].value;
    }
    const kind = prop.type === "array" ? "multi" : choices.length ? "single" : "text";
    const question: QuestionItem = {
      question: prop.description && /^question_\d+$/.test(key) ? prop.description : prop.title || request.message || key,
      kind,
      optional: !schema.required?.includes(key),
      ...(choices.length ? { options: choices.map((o: any) => o.label), optionDescriptions: choices.map((o: any) => o.description) } : {}),
      ...(field.custom ? { other: true } : {}),
    };
    const value = prop.default;
    if (value !== undefined) question.default = kind === "multi" && Array.isArray(value)
      ? value.flatMap((v) => choices.filter((o: any) => o.value === v).map((o: any) => o.label))
      : choices.find((o: any) => o.value === value)?.label ?? (kind === "text" ? String(value) : undefined);
    fields.push(field); questions.push(question);
  }
  if (!questions.length) return fail("Empty elicitation form");
  return { questions, fields };
}

export function elicitationContent(form: ElicitationForm, answers: QuestionAnswer[]): Record<string, unknown> {
  if (!Array.isArray(answers) || answers.length !== form.fields.length) return fail("Expected one answer per form field");
  const content: Record<string, unknown> = {};
  form.fields.forEach((field, index) => {
    const answer = answers[index], question = form.questions[index];
    if (answer == null || answer === "") {
      if (!question.optional) return fail(`Answer required: ${question.question}`);
      return;
    }
    if (question.kind === "multi") {
      if (!Array.isArray(answer) || !answer.every((v) => typeof v === "string")) return fail("Invalid multiple-choice answer");
      const custom = answer.filter((label) => !field.choices.some((o) => o.label === label));
      if (custom.length && !field.custom) return fail("Unknown form option");
      content[field.key] = answer.flatMap((label) => field.choices.filter((o) => o.label === label).map((o) => o.value));
      if (custom.length) content[field.custom!] = custom.join("、");
    } else {
      if (typeof answer !== "string") return fail("Invalid form answer");
      const picked = field.choices.find((o) => o.label === answer);
      if (picked) content[field.key] = picked.value;
      else if (field.custom) {
        content[field.custom] = answer;
        if (field.otherValue !== undefined) content[field.key] = field.otherValue;
      } else if (field.choices.length) return fail("Unknown form option");
      else if (field.schema.type === "number" || field.schema.type === "integer") {
        const value = Number(answer);
        if (!answer.trim() || !Number.isFinite(value) || field.schema.type === "integer" && !Number.isInteger(value)) return fail("Expected a number");
        content[field.key] = value;
      } else content[field.key] = answer;
    }
    const value = content[field.key], schema = field.schema;
    if (typeof value === "string" && (schema.minLength != null && value.length < schema.minLength || schema.maxLength != null && value.length > schema.maxLength)) return fail("Answer length is outside the allowed range");
    if (typeof value === "number" && (schema.minimum != null && value < schema.minimum || schema.maximum != null && value > schema.maximum)) return fail("Number is outside the allowed range");
    if (Array.isArray(value) && (schema.minItems != null && value.length < schema.minItems || schema.maxItems != null && value.length > schema.maxItems)) return fail("Selection count is outside the allowed range");
  });
  return content;
}

export function elicitationAnswers(form: ElicitationForm, content: Record<string, unknown>): QuestionAnswer[] {
  return form.fields.map((field, n) => {
    const raw = content[field.key];
    const chosen = [raw].flat().flatMap((value) => field.choices.filter((o) => o.value === value).map((o) => o.label));
    const custom = field.custom && content[field.custom];
    const values = [...chosen.filter((s) => s !== "Other"), ...(typeof custom === "string" && custom ? [custom] : [])];
    if (form.questions[n].kind === "multi") return values;
    return values.length ? values.join("、") : raw == null ? null : String(raw);
  });
}
