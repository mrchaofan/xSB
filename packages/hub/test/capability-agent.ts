/** Scripted ACP peer for capability negotiation and cross-connection correlation tests. */
import { Connection } from "@xsb/protocol";
import { randomUUID } from "node:crypto";
if (process.argv.includes("--terminal-login")) process.exit(0);
const conn = new Connection(process.stdin, process.stdout, "capability-agent");
let capabilities: any;
const setup = { availableCommands: [{ type: "skill", name: "pdf", description: "Read PDF" }], configOptions: [] };
conn.onRequest("initialize", p => {
  capabilities = p.capabilities;
  return { protocolVersion: 2, info: { name: "capability-agent", version: "1" }, capabilities: { session: { systemPrompt: {}, prompt: { skill: {} } } },
    authMethods: [{ type: "agent", methodId: "oauth", name: "OAuth" }, { type: "terminal", methodId: "terminal", name: "Terminal", args: ["--terminal-login"], env: [{ name: "ACP_TEST", value: "ok" }] }] };
});
conn.onRequest("auth/login", async (_p, ctx) => {
  const response = await conn.request("elicitation/create", { mode: "url", requestId: ctx.id, elicitationId: "oauth", message: "Sign in", url: "https://example.com/oauth" });
  conn.notify("elicitation/complete", { elicitationId: "oauth" });
  return { authenticated: response.action === "accept" };
});
conn.onRequest("session/new", async (_p, ctx) => {
  if (process.argv.includes("--startup-url")) await conn.request("elicitation/create", { mode: "url", requestId: ctx.id, elicitationId: "startup", message: "Authorize during setup", url: "https://example.com/setup" });
  return { sessionId: randomUUID(), ...setup };
});
conn.onRequest("session/resume", () => setup);
conn.onRequest("session/prompt", (p) => {
  const update = (u: object) => conn.notify("session/update", { sessionId: p.sessionId, update: u });
  queueMicrotask(async () => {
    update({ sessionUpdate: "state_update", state: "running" });
    update({ sessionUpdate: "user_message_chunk", messageId: "received", content: { type: "text", text: "received" } });
    const blocks = p.prompt;
    const text = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    if (text.includes("session-url")) {
      void conn.request("elicitation/create", { mode: "url", sessionId: p.sessionId, elicitationId: "session-url", message: "Authorize a plugin", url: "https://example.com/plugin" }).then(() => conn.notify("elicitation/complete", { elicitationId: "session-url" }));
    }
    if (text.includes("native-form")) await conn.request("elicitation/create", { mode: "form", sessionId: p.sessionId, message: "Choose", requestedSchema: { type: "object", properties: { choice: { type: "string", enum: ["A", "B"] } } } });
    update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify({ blocks, capabilities, idempotencyKey: p.idempotencyKey }) } });
    update({ sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" });
    update({ sessionUpdate: "prompt_suggestions_update", suggestions: [{ prompt: [{ type: "text", text: "Standard suggestion" }] }] });
    update({ sessionUpdate: "session_info_update", _meta: { promptSuggestions: { suggestions: [{ text: "Legacy suggestion" }] } } });
  });
  return { messageId: "received" };
});
conn.onNotification("session/cancel", () => {});
