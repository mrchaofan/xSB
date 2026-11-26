/** Native ACP questions: a live request bound to one execution, with durable UI records. */
import { Ajv } from "ajv";
import { Question, elicitationAnswers, elicitationForm } from "@xsb/protocol";
import type { ElicitationRequest, ElicitationResponse, QuestionState } from "@xsb/protocol";
import type { Client } from "./acp-server.ts";
import type { Hub } from "./hub.ts";
import type { LiveSession } from "./session.ts";
import { deferred, newId } from "./util.ts";
import { Paths } from "./paths.ts";

const validator = new Ajv({ strict: false, validateFormats: false });
type Pending = {
  session: LiveSession; turnId: string; backendSessionId: string; id: string;
  params: ElicitationRequest; form: ReturnType<typeof elicitationForm>;
  validate: ReturnType<typeof validator.compile>;
  answer: ReturnType<typeof deferred<ElicitationResponse>>;
  clients: Map<Client, AbortController>; unable: Set<Client>; signal: AbortSignal; onAbort: () => void;
};

export class Elicitations {
  private hub: Hub;
  private pending = new Set<Pending>();
  constructor(hub: Hub) { this.hub = hub; }

  waitingOn(agentId: string): boolean {
    return [...this.pending].some((p) => p.session.agentId === agentId && (p.params._meta?.codex as any)?.delivery !== "async");
  }

  request(session: LiveSession, request: ElicitationRequest, signal: AbortSignal): Promise<ElicitationResponse> {
    const form = elicitationForm(request);
    const id = newId("elicitation");
    const pending: Pending = {
      session, id, turnId: session.current!.id, backendSessionId: request.sessionId,
      params: { ...request, sessionId: session.id, _meta: { ...request._meta, [Question.key]: { id, source: "acp" } } },
      form, validate: validator.compile(request.requestedSchema), answer: deferred(), clients: new Map(), unable: new Set(),
      signal, onAbort: () => this.settle(pending, { action: "cancel" }),
    };
    this.pending.add(pending);
    this.record(pending, "open");
    signal.addEventListener("abort", pending.onAbort, { once: true });
    if (signal.aborted) pending.onAbort(); else this.route();
    this.hub.agentChanged(session.agentId);
    return pending.answer.promise;
  }

  route(): void {
    for (const pending of this.pending) {
      const able = (clients: Iterable<Client>) => [...clients].filter((c) => c.forms && !c.conn.isClosed && !pending.unable.has(c));
      const attached = able(pending.session.clients);
      const targets = attached.length ? attached : able(this.hub.clients).filter((c) => c.observer);
      for (const client of targets) {
        if (pending.clients.has(client)) continue;
        const abort = new AbortController();
        pending.clients.set(client, abort);
        client.conn.request<ElicitationResponse>("elicitation/create", pending.params, { signal: abort.signal, notify: "$/cancel_request" }).then(
          (answer) => this.settle(pending, answer),
          () => { if (!this.pending.has(pending)) return; pending.unable.add(client); this.route(); },
        );
      }
      const caller = pending.session.current?.first.from;
      if (!targets.length && caller && !caller.conn.isClosed) this.settle(pending, { action: "decline" });
    }
  }

  cancel(session: LiveSession): void {
    for (const p of [...this.pending]) if (p.session === session) this.settle(p, { action: "cancel" });
  }

  /** A request cannot survive the process that owned its original JSON-RPC id. */
  restart(): void {
    for (const session of this.hub.live.values()) {
      const questions = new Map<string, any>();
      for (const row of this.hub.state.store.read(Paths.transcript(session.agentId, session.id))) {
        const q = row.update?._meta?.[Question.key];
        if (q?.source === "acp") questions.set(q.id, q);
      }
      for (const q of questions.values()) if (q.state === "open") session.emit({ sessionUpdate: "session_info_update", _meta: { [Question.key]: { ...q, state: "cancelled" } } });
    }
  }

  private valid(p: Pending): boolean {
    return p.session.current?.id === p.turnId && p.session.current.started && p.session.acceptsTools &&
      p.session.rec.backendSessionId === p.backendSessionId && !this.hub.stopping;
  }

  private settle(p: Pending, response: ElicitationResponse): void {
    if (!this.pending.has(p)) return;
    let answer: ElicitationResponse = response?.action === "accept" || response?.action === "decline" ? response : { action: "cancel" };
    if (!this.valid(p) || answer.action === "accept" && !p.validate(answer.content ?? {})) answer = { action: "cancel" };
    // A human's answer protects this exact turn before returning control to the backend.
    if (answer.action !== "cancel") p.session.protect();
    this.pending.delete(p);
    p.signal.removeEventListener("abort", p.onAbort);
    for (const abort of p.clients.values()) abort.abort();
    this.record(p, answer.action === "accept" ? "answered" : answer.action === "decline" ? "skipped" : "cancelled", answer);
    p.answer.resolve(answer);
    this.hub.agentChanged(p.session.agentId);
  }

  private record(p: Pending, state: QuestionState, response?: ElicitationResponse): void {
    p.session.emit({ sessionUpdate: "session_info_update", _meta: { [Question.key]: {
      id: p.id, source: "acp", state,
      ...(state === "open" ? { questions: p.form.questions } : {}),
      ...((p.params._meta?.codex as any)?.delivery === "async" ? { delivery: "async" } : {}),
      ...(response?.action === "accept" ? { answers: elicitationAnswers(p.form, response.content ?? {}) } : {}),
    } } });
  }
}
