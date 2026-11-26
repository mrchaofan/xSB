/** URL consent and authentication have request/session lifetimes, never model turn lifetimes. */
import { RpcError } from "@xsb/protocol";
import type { ElicitationResponse, UrlElicitationRequest } from "@xsb/protocol";
import type { Backend } from "./backend.ts";
import type { Client } from "./acp-server.ts";
import type { Hub } from "./hub.ts";
import { deferred, newId } from "./util.ts";

export const Auth = { methods: "_dev.xsb/auth/methods", login: "_dev.xsb/auth/login", terminal: "_dev.xsb/auth/terminal" };
type Scope = { client: Client; requestId: string | number; signal: AbortSignal };
type Url = { backend: Backend; originalId: string; id: string; clients: Map<Client, AbortController>; settled: boolean;
  answer: ReturnType<typeof deferred<ElicitationResponse>>; abort: () => void; signal: AbortSignal; scope?: Scope };
export class Authentication {
  private hub: Hub;
  private urls = new Set<Url>();
  private scopes = new Map<string, Set<Scope>>();
  private loggingIn = new Set<string>();
  constructor(hub: Hub) { this.hub = hub; }
  busy(agentId: string): boolean { return this.loggingIn.has(agentId); }

  async forward<T>(agentId: string, client: Client, requestId: string | number, signal: AbortSignal, call: () => Promise<T>): Promise<T> {
    const scope = { client, requestId, signal };
    const active = this.scopes.get(agentId) ?? new Set<Scope>();
    this.scopes.set(agentId, active); active.add(scope);
    try { return await call(); } finally {
      active.delete(scope); if (!active.size) this.scopes.delete(agentId);
      for (const p of [...this.urls]) if (p.scope === scope) this.retire(p);
    }
  }

  async methods(agentId: string) { return (await this.hub.backends.for(this.hub.agent(agentId))).authMethods; }
  async login(agentId: string, methodId: string, client: Client, signal: AbortSignal): Promise<unknown> {
    const session = this.hub.mainSession(agentId);
    if (!session.configurationIdle || this.loggingIn.has(agentId)) throw RpcError.invalidParams("Wait for the agent to become idle before signing in");
    this.loggingIn.add(agentId);
    try {
      const agent = this.hub.agent(agentId);
      const backend = await this.hub.backends.for(agent);
      const method = backend.authMethods.find(m => m.methodId === methodId);
      if (!method) throw RpcError.invalidParams("Unknown authentication method");
      if (signal.aborted) throw RpcError.cancelled();
      if (method.type === "terminal") {
        if (!client.terminalAuth) throw RpcError.invalidParams("This client cannot run terminal authentication");
        await this.hub.backends.stopAndWait(agentId);
        if (signal.aborted) throw RpcError.cancelled();
        const spec = this.hub.backends.spec(agent);
        const result = await client.conn.request<{ exitCode: number | null }>(Auth.terminal, {
          agentId, method, command: spec.command, args: spec.args ?? [], cwd: agent.workspace,
        }, { signal, notify: "$/cancel_request" });
        if (result.exitCode !== 0) throw RpcError.invalidParams("Terminal authentication did not succeed");
        await this.hub.backends.for(agent); // New initialize; saved backend session ID is retained for the next bind.
        return { authenticated: true };
      }
      return await backend.conn.request("auth/login", { methodId }, { signal, notify: "$/cancel_request" });
    } finally {
      this.loggingIn.delete(agentId);
      session.resumeAfterAuth();
    }
  }

  request(backend: Backend, request: UrlElicitationRequest, signal: AbortSignal): Promise<ElicitationResponse> {
    if (signal.aborted || this.hub.stopping) return Promise.resolve({ action: "cancel" });
    // Session IDs are scoped to a backend connection. Never associate a URL with a later binding.
    const session = "sessionId" in request ? backend.session(request.sessionId) : undefined;
    const scope = "requestId" in request && backend.conn.hasPendingRequest(request.requestId)
      ? [...(this.scopes.get(backend.agentId) ?? [])].find(s => !s.signal.aborted && !s.client.conn.isClosed) : undefined;
    if (!session && !scope) return Promise.resolve({ action: "decline" });
    const candidates = scope ? [scope.client] : [...new Set([...session!.clients, ...[...this.hub.clients].filter(c => c.observer)])];
    const clients = candidates.filter(c => c.urls && !c.conn.isClosed);
    if (!clients.length) return Promise.resolve({ action: "decline" });
    const id = newId("url");
    const p: Url = { backend, originalId: request.elicitationId, id, clients: new Map(), settled: false,
      answer: deferred(), signal, scope, abort: () => this.retire(p) };
    this.urls.add(p);
    const { sessionId: ignoredSession, requestId: ignoredRequest, ...body } = request as UrlElicitationRequest & { sessionId?: string; requestId?: string | number };
    const params = { ...body, elicitationId: id, ...(session ? { sessionId: session.id } : { requestId: scope!.requestId }) };
    signal.addEventListener("abort", p.abort, { once: true });
    scope?.signal.addEventListener("abort", p.abort, { once: true });
    void backend.conn.closed.then(() => this.retire(p));
    for (const client of clients) {
      const abort = new AbortController(); p.clients.set(client, abort);
      client.conn.request<ElicitationResponse>("elicitation/create", params, { signal: abort.signal, notify: "$/cancel_request" }).then(response => {
        if (p.settled || !this.urls.has(p)) return;
        p.settled = true;
        const action = response?.action === "accept" || response?.action === "decline" ? response.action : "cancel";
        p.answer.resolve({ action });
        for (const [other, controller] of p.clients) if (other !== client) controller.abort();
        if (action !== "accept") this.retire(p);
      }, () => {
        p.clients.delete(client);
        if (!p.clients.size && !p.settled) this.retire(p);
      });
    }
    if (signal.aborted) this.retire(p);
    return p.answer.promise;
  }

  complete(backend: Backend, originalId: string): void {
    for (const p of this.urls) if (p.backend === backend && p.originalId === originalId) {
      for (const client of p.clients.keys()) client.conn.notify("elicitation/complete", { elicitationId: p.id });
      this.retire(p);
    }
  }
  private retire(p: Url): void {
    if (!this.urls.delete(p)) return;
    p.settled = true; p.answer.resolve({ action: "cancel" });
    p.signal.removeEventListener("abort", p.abort);
    p.scope?.signal.removeEventListener("abort", p.abort);
    for (const abort of p.clients.values()) abort.abort();
  }
  close(): void { for (const p of [...this.urls]) this.retire(p); }
}
