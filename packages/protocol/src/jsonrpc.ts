/**
 * Newline-delimited JSON-RPC 2.0 over any byte stream pair.
 *
 * This is the one wire layer of the system: ACP towards the outside, ACP
 * towards the backends, and MCP towards the tool bridge all run on it.
 */
import type { Readable, Writable } from "node:stream";

export class RpcError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
  static methodNotFound(method: string): RpcError {
    return new RpcError(-32601, "Method not found", { method });
  }
  static invalidParams(message: string, data?: unknown): RpcError {
    return new RpcError(-32602, message, data);
  }
  static internal(message: string, data?: unknown): RpcError {
    return new RpcError(-32603, message, data);
  }
  /** ACP `resource_not_found`. */
  static notFound(what: string): RpcError {
    return new RpcError(-32002, `Resource not found: ${what}`);
  }
  /** ACP v2: a prompt that was cancelled before it was inserted into the conversation. */
  static cancelled(): RpcError {
    return new RpcError(RpcError.CANCELLED, "Request cancelled");
  }
  static readonly CANCELLED = -32800;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The peer went away. Not -32000: that is ACP's `auth_required`. */
export const CONNECTION_CLOSED = -32099;

export type RequestCtx = { id: string | number; signal: AbortSignal };
type RequestHandler = (params: any, ctx: RequestCtx) => unknown;
type NotificationHandler = (params: any) => void;
type Id = string | number;

export class Connection {
  readonly name: string;
  /** Resolves once the stream is gone, for whatever reason. */
  readonly closed: Promise<void>;
  isClosed = false;
  trace?: (direction: "in" | "out", message: unknown) => void;

  private output: Writable;
  private nextId = 1;
  private pending = new Map<Id, { resolve: (v: any) => void; reject: (e: unknown) => void }>();
  private inflight = new Map<Id, AbortController>();
  private requestHandlers = new Map<string, RequestHandler>();
  private notificationHandlers = new Map<string, NotificationHandler>();
  private fragments: string[] = [];
  private markClosed!: () => void;

  constructor(input: Readable, output: Writable, name = "rpc") {
    this.name = name;
    this.output = output;
    this.closed = new Promise((resolve) => (this.markClosed = resolve));
    input.setEncoding("utf8");
    input.on("data", (chunk: string) => this.onData(chunk));
    input.on("end", () => this.close());
    input.on("close", () => this.close());
    input.on("error", () => this.close());
    output.on("error", () => this.close());
    this.onNotification("$/cancel_request", (p) => this.inflight.get(p?.requestId)?.abort());
    // MCP's name for the same thing.
    this.onNotification("notifications/cancelled", (p) => this.inflight.get(p?.requestId)?.abort());
  }

  onRequest(method: string, handler: RequestHandler): this {
    this.requestHandlers.set(method, handler);
    return this;
  }

  onNotification(method: string, handler: NotificationHandler): this {
    this.notificationHandlers.set(method, handler);
    return this;
  }

  /**
   * Ask the peer. With `cancel`, aborting its signal tells the peer that the answer is no longer wanted, by the
   * notification the protocol spoken has for that (`cancel.notify`). The request stays open: what the peer
   * answers to a cancelled request is still its answer.
   */
  request<T = any>(method: string, params?: unknown, cancel?: { signal: AbortSignal; notify: string }, onId?: (id: number) => void): Promise<T> {
    if (this.isClosed) return Promise.reject(new RpcError(CONNECTION_CLOSED, `${this.name}: connection closed`));
    const id = this.nextId++;
    onId?.(id);
    const answer = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
    if (!cancel) return answer;
    const tell = (): void => this.notify(cancel.notify, { requestId: id });
    if (cancel.signal.aborted) tell();
    else cancel.signal.addEventListener("abort", tell, { once: true });
    const forget = (): void => cancel.signal.removeEventListener("abort", tell);
    answer.then(forget, forget);
    return answer;
  }

  hasPendingRequest(id: string | number): boolean { return this.pending.has(id); }

  notify(method: string, params?: unknown): void {
    if (!this.isClosed) this.send({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    const error = new RpcError(CONNECTION_CLOSED, `${this.name}: connection closed`);
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    for (const c of this.inflight.values()) c.abort();
    this.inflight.clear();
    this.fragments = [];
    this.output.end();
    this.markClosed();
  }

  private send(message: unknown): void {
    this.trace?.("out", message);
    if (!this.output.destroyed && this.output.writable) this.output.write(JSON.stringify(message) + "\n");
  }

  private onData(chunk: string): void {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf("\n", start);
      if (nl < 0) {
        if (start < chunk.length) this.fragments.push(chunk.slice(start));
        return;
      }
      this.fragments.push(chunk.slice(start, nl));
      const line = this.fragments.join("").trim();
      this.fragments = [];
      start = nl + 1;
      if (!line) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        this.send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        continue;
      }
      this.trace?.("in", message);
      this.dispatch(message);
    }
  }

  private dispatch(message: any): void {
    if (typeof message?.method === "string") {
      if (message.id === undefined || message.id === null) {
        // Notifications run synchronously, in arrival order: a `session/update`
        // is always handled before the response that follows it on the wire.
        try {
          this.notificationHandlers.get(message.method)?.(message.params);
        } catch {
          /* a notification has nobody to report to */
        }
        return;
      }
      void this.serve(message.id, message.method, message.params);
      return;
    }
    const waiter = this.pending.get(message?.id);
    if (!waiter) return;
    this.pending.delete(message.id);
    if (message.error) {
      waiter.reject(new RpcError(message.error.code ?? -32603, message.error.message ?? "error", message.error.data));
    } else {
      waiter.resolve(message.result);
    }
  }

  private async serve(id: Id, method: string, params: unknown): Promise<void> {
    const handler = this.requestHandlers.get(method);
    const abort = new AbortController();
    this.inflight.set(id, abort);
    try {
      if (!handler) throw RpcError.methodNotFound(method);
      const result = await handler(params ?? {}, { id, signal: abort.signal });
      this.send({ jsonrpc: "2.0", id, result: result ?? {} });
    } catch (e) {
      const error =
        e instanceof RpcError
          ? { code: e.code, message: e.message, data: e.data }
          : { code: -32603, message: errorMessage(e) };
      this.send({ jsonrpc: "2.0", id, error });
    } finally {
      this.inflight.delete(id);
    }
  }
}
