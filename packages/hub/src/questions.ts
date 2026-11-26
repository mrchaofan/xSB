/**
 * Questions agents ask the user: the `ask` tool.
 *
 * The MCP call stays pending until the user submits or explicitly skips. Answers return through that call in
 * the same turn, without another prompt. There is no deadline or default answer. Stops, turn/backend changes,
 * transport cancellation and restarts invalidate the request; a new user message supersedes it.
 * One question is open per conversation, with durable Question records for the UI.
 */
import { Ajv } from "ajv";
import { Question, RpcError } from "@xsb/protocol";
import type { Answer, QuestionAnswer, QuestionItem, QuestionState, SessionUpdate } from "@xsb/protocol";
import type { Hub } from "./hub.ts";
import type { LiveSession } from "./session.ts";
import { deferred, newId } from "./util.ts";

export const ASK_LIMITS = { questions: 4, options: 8, chars: 500 };

/** The `ask` tool: xSB's own, served apart from the workflow tools (mcp.ts, `XSB_SERVER`). Any agent may use it. */
export const ASK_TOOL = {
  name: "ask",
  description: "Request user input on decisions that materially affect the outcome. Follow the effective decision consultation preference and existing instructions; review available context first, explain the tradeoff and offer a recommendation when useful. Group 1 to 4 concise questions. kind single: one choice; multi: multiple choices; text: a written answer. Provide 2 to 8 distinct options for choice questions; other:true allows an alternative response. Waits until the user submits or explicitly skips, then returns their answers in this same turn. No automatic timeout or default answer. Never assume an answer or treat silence as consent. If optional questions are skipped, proceed with reasonable defaults and state them; required information or authorization must still be obtained.",
  inputSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: ASK_LIMITS.questions,
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            kind: { enum: ["single", "multi", "text"] },
            options: { type: "array", items: { type: "string" }, maxItems: ASK_LIMITS.options },
            other: { type: "boolean" },
          },
          required: ["question", "kind"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
};
const validator = new Ajv();
const checkAsk = validator.compile(ASK_TOOL.inputSchema);

/** How the model is told what the user's message is, in front of it. */
const SCOPES: Record<Exclude<QuestionState, "open">, string> = {
  answered: "[xSB] The user's answers to the questions you asked (ask).",
  skipped: "[xSB] The user skipped the questions you asked (ask). Go on with sensible choices of your own and say which you made.",
  superseded: "[xSB] The user did not answer the questions you asked (ask) and wrote this instead.",
  cancelled: "[xSB] The question was cancelled.",
};

function checkQuestions(questions: QuestionItem[]): QuestionItem[] {
  if (!Array.isArray(questions) || !questions.length || questions.length > ASK_LIMITS.questions)
    throw Error(`ask takes 1 to ${ASK_LIMITS.questions} questions`);
  return questions.map((q, n) => {
    const where = `question ${n + 1}`;
    if (typeof q.question !== "string" || !q.question.trim() || q.question.length > ASK_LIMITS.chars)
      throw Error(`${where}: question is 1 to ${ASK_LIMITS.chars} characters`);
    if (q.kind === "text") {
      if (q.options?.length) throw Error(`${where}: a text question has no options`);
      return { question: q.question.trim(), kind: "text" };
    }
    if (q.kind !== "single" && q.kind !== "multi") throw Error(`${where}: kind is single, multi or text`);
    const options = (q.options ?? []).map((o) => (typeof o === "string" ? o.trim() : ""));
    if (options.length < 2 || options.length > ASK_LIMITS.options || options.some((o) => !o || o.length > ASK_LIMITS.chars))
      throw Error(`${where}: a ${q.kind} question has 2 to ${ASK_LIMITS.options} non-empty options`);
    if (new Set(options).size !== options.length) throw Error(`${where}: options differ from each other`);
    return { question: q.question.trim(), kind: q.kind, options, ...(q.other ? { other: true } : {}) };
  });
}

export class Questions {
  private hub: Hub;
  private pending = new Map<LiveSession, {
    id: string; turnId: string; backendSessionId?: string; questions: QuestionItem[];
    result: ReturnType<typeof deferred<string>>; signal?: AbortSignal; onAbort: () => void;
  }>();
  /** What the model is told of a reply, by its message id, until the message is in the conversation. */
  private scopes = new Map<string, string>();

  constructor(hub: Hub) {
    this.hub = hub;
  }

  /** The `ask` tool. */
  ask(s: LiveSession, args: unknown, signal?: AbortSignal): Promise<string> {
    if (!checkAsk(args)) throw Error(validator.errorsText(checkAsk.errors));
    const checked = checkQuestions((args as { questions: QuestionItem[] }).questions);
    if (!s.current?.started || !s.acceptsTools) throw Error("No active turn");
    if (signal?.aborted) throw RpcError.cancelled();
    if (s.rec.question) this.close(s, "cancelled");
    const id = newId("question");
    const p = { id, turnId: s.current.id, backendSessionId: s.rec.backendSessionId, questions: checked,
      result: deferred<string>(), signal, onAbort: () => { if (this.pending.get(s)?.id === id) this.cancel(s); } };
    this.pending.set(s, p);
    signal?.addEventListener("abort", p.onAbort, { once: true });
    this.hub.state.atomic(() => {
      s.save({ question: id });
      this.record(s, { id, state: "open", questions: checked });
      this.hub.workflows.asking(s, id);
      this.hub.state.afterCommit(() => this.hub.agentChanged(s.agentId));
    });
    return p.result.promise;
  }

  /** A targeted user response is never routed as a new prompt or workflow interruption. */
  answer(s: LiveSession, answer: Answer): void {
    const p = this.pending.get(s);
    if (!p || answer?.questionId !== p.id) throw RpcError.notFound("This question has expired");
    if (s.current?.id !== p.turnId || !s.current.started || !s.acceptsTools ||
        s.rec.backendSessionId !== p.backendSessionId || this.hub.stopping) {
      this.cancel(s);
      throw RpcError.notFound("This question has expired");
    }
    if (answer.skipped !== undefined && typeof answer.skipped !== "boolean") throw RpcError.invalidParams("skipped must be a boolean");
    const answers = answer.skipped ? undefined : this.checkAnswers(p.questions, answer.answers);
    s.protect();
    this.close(s, answer.skipped ? "skipped" : "answered", answers);
  }

  waitingOn(agentId: string): boolean {
    return [...this.pending.keys()].some(s => s.agentId === agentId);
  }

  cancel(s: LiveSession): void {
    if (s.rec.question) this.close(s, "cancelled");
  }

  restart(): void {
    for (const s of this.hub.live.values()) this.cancel(s);
  }

  private checkAnswers(questions: QuestionItem[], answers?: QuestionAnswer[]): QuestionAnswer[] {
    if (!Array.isArray(answers) || answers.length !== questions.length) throw RpcError.invalidParams("One answer is required per question");
    return questions.map((q, n) => {
      const a = answers[n];
      const valid = (v: unknown): v is string => typeof v === "string" && !!v.trim() &&
        (q.kind === "text" || !!q.other || !!q.options?.includes(v));
      if (q.kind === "multi" ? !Array.isArray(a) || !a.length || !a.every(valid) || new Set(a).size !== a.length : !valid(a))
        throw RpcError.invalidParams(`Invalid answer to question ${n + 1}`);
      return a;
    });
  }

  /** The user's message to an agent: if it has a question open, the message replies to it. */
  reply(s: LiveSession, messageId: string): void {
    if (!s.rec.question) return;
    const state = "superseded";
    this.scopes.set(messageId, SCOPES[state]);
    this.close(s, state, undefined, messageId);
  }

  /** What the model is told in front of the message, if it replies to a question. Once given, forgotten. */
  scope(messageId: string): string | undefined {
    return this.scopes.get(messageId);
  }
  given(messageId: string): void {
    this.scopes.delete(messageId);
  }

  private close(s: LiveSession, state: Exclude<QuestionState, "open">, answers?: QuestionAnswer[], reply?: string): void {
    const id = s.rec.question!;
    const p = this.pending.get(s);
    const shown = Array.isArray(answers) ? answers.filter((a) => typeof a === "string" || (Array.isArray(a) && a.every((x) => typeof x === "string"))) : undefined;
    this.hub.state.atomic(() => {
      s.save({ question: undefined });
      this.record(s, { id, state, ...(shown?.length ? { answers: shown } : {}), ...(reply ? { reply } : {}) });
      this.hub.state.afterCommit(() => {
        if (p?.id === id) {
          if (this.pending.get(s) === p) this.pending.delete(s);
          p.signal?.removeEventListener("abort", p.onAbort);
          if (state === "cancelled") p.result.reject(RpcError.cancelled());
          else p.result.resolve(SCOPES[state] + "\n" + JSON.stringify({ questionId: id, status: state,
            questions: p.questions, ...(shown ? { answers: shown } : {}) }));
        }
        this.hub.agentChanged(s.agentId);
      });
    });
  }

  private record(s: LiveSession, question: Question): void {
    s.emit({ sessionUpdate: "session_info_update", _meta: { [Question.key]: question } } as SessionUpdate);
  }
}
