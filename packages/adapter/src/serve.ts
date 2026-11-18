/**
 * The one wrapper: serves ACP v2 on a byte stream pair and maps it onto an `AgentAdapter`.
 *
 * The result is indistinguishable, to the hub, from an agent with an official ACP entry point. ACP v2's lifecycle is
 * kept here once for every adapter: a prompt is answered with its message id when it is inserted; work is reported
 * with `state_update`; a prompt that comes while the agent works is steered in (`steer`, when the adapter can) or
 * held until the work is done, and answered with -32800 when a cancel comes first. Capabilities the adapter lacks are
 * simply not advertised.
 */
import { Connection, PROTOCOL_VERSION, RpcError, textOf } from "@xsb/protocol";
import type { ContentBlock, InitializeResponse } from "@xsb/protocol";
import type { Readable, Writable } from "node:stream";
import type { AdapterSession, AgentAdapter } from "./adapter.ts";

type Held = { prompt: ContentBlock[]; resolve: (r: { messageId: string }) => void; reject: (e: unknown) => void };

export function serveAdapter(adapter: AgentAdapter, input: Readable = process.stdin, output: Writable = process.stdout): Connection {
  const conn = new Connection(input, output, adapter.info.name);
  const caps = adapter.capabilities;
  /** Sessions with work in flight, and the prompts each holds meanwhile. */
  const running = new Map<string, Held[]>();
  let counter = 0;

  const sessionOf = (p: any): AdapterSession => ({
    cwd: p.cwd,
    mcpServers: Array.isArray(p.mcpServers) ? p.mcpServers : [],
    ...(caps.systemPrompt && p.systemPrompt ? { systemPrompt: textOf(p.systemPrompt.content ?? []) } : {}),
  });
  const emit = (sessionId: string, update: unknown): void => conn.notify("session/update", { sessionId, update });

  /** Insert a prompt: it is echoed and answered with its id. */
  const insert = (sessionId: string, prompt: ContentBlock[], answer: (r: { messageId: string }) => void): void => {
    const messageId = `${adapter.info.name}_${++counter}`;
    emit(sessionId, { sessionUpdate: "user_message", messageId, content: prompt });
    answer({ messageId });
  };

  /** Run the adapter's turn for a prompt, then what was held meanwhile, each as work of its own. */
  const work = async (sessionId: string, prompt: ContentBlock[]): Promise<void> => {
    const held = running.get(sessionId) ?? [];
    running.set(sessionId, held);
    emit(sessionId, { sessionUpdate: "state_update", state: "running" });
    let stopReason = "end_turn";
    let error: { code: number; message: string } | undefined;
    try {
      stopReason = await adapter.prompt(sessionId, prompt, (update) => emit(sessionId, update));
    } catch (e) {
      stopReason = "error";
      error = { code: e instanceof RpcError ? e.code : -32603, message: e instanceof Error ? e.message : String(e) };
    }
    emit(sessionId, { sessionUpdate: "state_update", state: "idle", stopReason, ...(error ? { error } : {}) });
    const next = held.shift();
    if (!next) return void running.delete(sessionId);
    insert(sessionId, next.prompt, next.resolve);
    void work(sessionId, next.prompt);
  };

  conn.onRequest(
    "initialize",
    (): InitializeResponse => ({
      protocolVersion: PROTOCOL_VERSION,
      info: adapter.info,
      capabilities: { session: { ...(caps.systemPrompt ? { systemPrompt: {} } : {}) } },
      authMethods: [],
    }),
  );

  conn.onRequest("session/new", async (p) => ({ sessionId: await adapter.newSession(sessionOf(p)) }));

  conn.onRequest("session/resume", async (p) => {
    if (!caps.resume) throw RpcError.notFound(`session ${p.sessionId}`);
    await adapter.resume!(p.sessionId, sessionOf(p));
    emit(p.sessionId, { sessionUpdate: "state_update", state: running.has(p.sessionId) ? "running" : "idle" });
    return {};
  });

  conn.onRequest("session/prompt", (p) => {
    if (!Array.isArray(p.prompt) || !p.prompt.length) throw RpcError.invalidParams("prompt must not be empty");
    return new Promise((resolve, reject) => {
      const held = running.get(p.sessionId);
      if (!held) {
        insert(p.sessionId, p.prompt, resolve);
        void work(p.sessionId, p.prompt);
        return;
      }
      const hold = (): void => void held.push({ prompt: p.prompt, resolve, reject });
      if (!caps.steering) return hold();
      adapter.steer!(p.sessionId, p.prompt).then(
        (steered) => (steered ? insert(p.sessionId, p.prompt, resolve) : hold()),
        () => hold(),
      );
    });
  });

  conn.onNotification("session/cancel", (p) => {
    const held = running.get(p?.sessionId);
    if (!held) return;
    for (const h of held.splice(0)) h.reject(RpcError.cancelled());
    adapter.cancel(p.sessionId);
  });

  return conn;
}
