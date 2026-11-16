/**
 * The one wrapper: serves ACP v1 on a byte stream pair and maps it onto an
 * `AgentAdapter`.
 *
 * The result is indistinguishable, to the hub, from an agent with an official
 * ACP entry point. Capabilities the adapter lacks are simply not advertised,
 * and the hub makes up for them as it does for any backend.
 */
import { Connection, PROTOCOL_VERSION, RpcError, Steering, textOf } from "@xsb/protocol";
import type { InitializeResponse, SteeringOutcome } from "@xsb/protocol";
import type { Readable, Writable } from "node:stream";
import type { AdapterSession, AgentAdapter } from "./adapter.ts";

export function serveAdapter(adapter: AgentAdapter, input: Readable = process.stdin, output: Writable = process.stdout): Connection {
  const conn = new Connection(input, output, adapter.info.name);
  const caps = adapter.capabilities;
  /** Sessions with a turn in flight. */
  const running = new Set<string>();

  const sessionOf = (p: any): AdapterSession => ({
    cwd: p.cwd,
    mcpServers: Array.isArray(p.mcpServers) ? p.mcpServers : [],
    ...(caps.systemPrompt && p.systemPrompt ? { systemPrompt: textOf(p.systemPrompt.content ?? []) } : {}),
  });

  conn.onRequest(
    "initialize",
    (): InitializeResponse => ({
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: adapter.info,
      agentCapabilities: {
        sessionCapabilities: {
          ...(caps.resume ? { resume: {} } : {}),
          ...(caps.systemPrompt ? { systemPrompt: {} } : {}),
        },
      },
      authMethods: [],
      ...(caps.steering ? { _meta: { [Steering.metaKey]: { supported: true } } } : {}),
    }),
  );

  conn.onRequest("session/new", async (p) => ({ sessionId: await adapter.newSession(sessionOf(p)) }));

  if (caps.resume) {
    conn.onRequest("session/resume", async (p) => {
      await adapter.resume!(p.sessionId, sessionOf(p));
      return {};
    });
  }

  conn.onRequest("session/prompt", async (p) => {
    if (running.has(p.sessionId)) throw RpcError.invalidParams("a turn is already running in this session");
    running.add(p.sessionId);
    try {
      const emit = (update: unknown): void => conn.notify("session/update", { sessionId: p.sessionId, update });
      return { stopReason: await adapter.prompt(p.sessionId, p.prompt, emit) };
    } finally {
      running.delete(p.sessionId);
    }
  });

  conn.onNotification("session/cancel", (p) => {
    if (running.has(p?.sessionId)) adapter.cancel(p.sessionId);
  });

  if (caps.steering) {
    conn.onRequest(Steering.method, async (p): Promise<SteeringOutcome> => {
      const injected = running.has(p.sessionId) && (await adapter.steer!(p.sessionId, p.prompt));
      return injected ? { outcome: "injected" } : { outcome: "promptRequired", reason: "noRunningTurn" };
    });
  }

  return conn;
}
