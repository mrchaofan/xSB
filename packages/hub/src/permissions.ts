/**
 * Permission requests of backends.
 *
 * Whether a backend asks at all is the backend's own setting. When it does,
 * the hub decides nothing and passes the question to a human: the clients
 * attached to the session, or failing that any observer. A client that cannot
 * answer (it has no handler for the request: a script, a log) says so by
 * failing it, and is passed over.
 *
 * When nobody connected can answer, the request waits for the next client,
 * with one exception: a turn that a client asked for and still waits on (a
 * script's `xsb send`) is not left hanging, and its request is declined.
 */
import type { PermissionRequest, PermissionResponse } from "@xsb/protocol";
import type { Client } from "./acp-server.ts";
import type { Hub } from "./hub.ts";
import type { LiveSession } from "./session.ts";
import type { Deferred } from "./util.ts";
import { deferred } from "./util.ts";

type Pending = {
  session: LiveSession;
  params: PermissionRequest;
  answer: Deferred<PermissionResponse>;
  asked: Set<Client>;
  /** Clients that were asked and could not answer, or left. */
  unable: Set<Client>;
};

export class Permissions {
  private hub: Hub;
  private pending: Pending[] = [];

  constructor(hub: Hub) {
    this.hub = hub;
  }

  /** Whether a request of this agent waits for a human. */
  waitingOn(agentId: string): boolean {
    return this.pending.some((p) => p.session.agentId === agentId);
  }

  request(session: LiveSession, request: PermissionRequest): Promise<PermissionResponse> {
    const pending: Pending = {
      session,
      // The client knows the hub's session id, not the backend's.
      params: { ...request, sessionId: session.id },
      answer: deferred(),
      asked: new Set(),
      unable: new Set(),
    };
    this.pending.push(pending);
    this.route();
    this.hub.agentChanged(session.agentId);
    return pending.answer.promise;
  }

  /** Ask whoever can answer and has not been asked. Called when clients come, attach, or turn out unable to answer. */
  route(): void {
    for (const pending of [...this.pending]) {
      const able = (clients: Iterable<Client>): Client[] => [...clients].filter((c) => !pending.unable.has(c));
      const attached = able(pending.session.clients);
      const targets = attached.length ? attached : able(this.hub.clients).filter((c) => c.observer);
      for (const client of targets) {
        if (pending.asked.has(client)) continue;
        pending.asked.add(client);
        client.conn.request<PermissionResponse>("session/request_permission", pending.params).then(
          (answer) => this.settle(pending, answer),
          () => {
            pending.unable.add(client);
            this.route(); // another one may still answer
          },
        );
      }
      const waiting = pending.session.current?.req.from;
      if (!targets.length && waiting && !waiting.conn.isClosed) this.settle(pending, { outcome: { outcome: "cancelled" } });
    }
  }

  /** The turn that asked is over or interrupted: its questions are void. */
  cancel(session: LiveSession): void {
    for (const pending of this.pending.filter((p) => p.session === session)) {
      this.settle(pending, { outcome: { outcome: "cancelled" } });
    }
  }

  private settle(pending: Pending, answer: PermissionResponse): void {
    const index = this.pending.indexOf(pending);
    if (index < 0) return;
    this.pending.splice(index, 1);
    pending.answer.resolve(answer);
    this.hub.agentChanged(pending.session.agentId);
  }
}
