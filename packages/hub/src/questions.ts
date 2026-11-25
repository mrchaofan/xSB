/**
 * Questions agents ask the user: the `ask` tool.
 *
 * The tool shows the questions and returns at once; the agent ends its turn. The user's reply is their next message
 * to it: the answers, a skip, or a message of their own instead. A tool call that waited for a person would outlive
 * agent programs' tool timeouts, and a question would not outlive a restart of the hub; a message does both.
 *
 * One question is open per conversation (`SessionRec.question`): a new one replaces it. What became of it is
 * recorded in the transcript (`Question` in @xsb/protocol), and the model is told how the message it gets replies.
 * A task agent's work waits for the reply instead of ending unfinished (workflows.ts, `asking`).
 */
import { Question } from "@xsb/protocol";
import type { Answer, QuestionAnswer, QuestionItem, QuestionState, SessionUpdate } from "@xsb/protocol";
import type { Hub } from "./hub.ts";
import type { LiveSession } from "./session.ts";
import { newId } from "./util.ts";

export const ASK_LIMITS = { questions: 4, options: 8, chars: 500 };

/** How the model is told what the user's message is, in front of it. */
const SCOPES: Record<Exclude<QuestionState, "open">, string> = {
  answered: "[xSB] The user's answers to the questions you asked (ask).",
  skipped: "[xSB] The user skipped the questions you asked (ask). Go on with sensible choices of your own and say which you made.",
  superseded: "[xSB] The user did not answer the questions you asked (ask) and wrote this instead.",
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
  /** What the model is told of a reply, by its message id, until the message is in the conversation. */
  private scopes = new Map<string, string>();

  constructor(hub: Hub) {
    this.hub = hub;
  }

  /** The `ask` tool. */
  ask(s: LiveSession, questions: QuestionItem[]): string {
    const checked = checkQuestions(questions);
    if (s.rec.question) this.close(s, "superseded");
    const id = newId("question");
    s.save({ question: id });
    this.record(s, { id, state: "open", questions: checked });
    this.hub.workflows.asking(s, id);
    this.hub.agentChanged(s.agentId);
    return "Shown to the user. End your turn now, without assuming their answers: their reply comes as their next message, "
      + "with the answers, a skip, or a message of their own instead.";
  }

  /** The user's message to an agent: if it has a question open, the message replies to it. */
  reply(s: LiveSession, messageId: string, answer?: Answer): void {
    if (!s.rec.question) return;
    const state = answer?.questionId !== s.rec.question ? "superseded" : answer.skipped ? "skipped" : "answered";
    this.scopes.set(messageId, SCOPES[state]);
    this.close(s, state, state === "answered" ? answer?.answers : undefined, messageId);
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
    s.save({ question: undefined });
    const shown = Array.isArray(answers) ? answers.filter((a) => typeof a === "string" || (Array.isArray(a) && a.every((x) => typeof x === "string"))) : undefined;
    this.record(s, { id, state, ...(shown?.length ? { answers: shown } : {}), ...(reply ? { reply } : {}) });
    this.hub.agentChanged(s.agentId);
  }

  private record(s: LiveSession, question: Question): void {
    s.emit({ sessionUpdate: "session_info_update", _meta: { [Question.key]: question } } as SessionUpdate);
  }
}
