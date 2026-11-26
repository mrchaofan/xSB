import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Connection, SessionControls, TurnFailure } from "@xsb/protocol";
import { Hub } from "../src/hub.ts";

const agent = fileURLToPath(new URL("./capability-agent.ts", import.meta.url));
const project = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-capabilities-"));
const priorHome = process.env.XSB_HOME;
process.env.XSB_HOME = path.join(project, "home"); fs.mkdirSync(process.env.XSB_HOME);
fs.writeFileSync(path.join(process.env.XSB_HOME, "config.json"), JSON.stringify({ version: 1, backends: {
  rejected: { command: process.execPath, args: [agent, "--setup-error"] },
  startup: { command: process.execPath, args: [agent, "--startup-url"] },
  codex: { command: process.execPath, args: [agent] }, capabilities: { command: process.execPath, args: [agent] },
} }));
const hub = new Hub(project);
await hub.start();
test.after(async () => { await hub.shutdown(); if (priorHome === undefined) delete process.env.XSB_HOME; else process.env.XSB_HOME = priorHome; fs.rmSync(project, { recursive: true, force: true }); });
async function client(backend = "capabilities") {
  const socket = net.connect(hub.paths.socket("acp")); await new Promise(r => socket.once("connect", r));
  const conn = new Connection(socket, socket, "test");
  const updates: any[] = [], completions: any[] = [];
  conn.onNotification("session/update", p => updates.push(p.update));
  conn.onNotification("elicitation/complete", p => completions.push(p));
  await conn.request("initialize", { protocolVersion: 2, info: { name: "test", version: "1" }, capabilities: { auth: { terminal: {} }, elicitation: { url: {}, form: {} } } });
  const created = await conn.request("session/new", { _meta: { "dev.xsb/backend": backend } });
  const session = hub.session(created.sessionId);
  assert.equal(hub.agent(session.agentId).backend, backend);
  return { conn, session, updates, completions };
}
async function until(predicate: () => boolean) { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); } assert.fail("condition did not arrive"); }

test("agent sign-in extensions are unavailable even when an agent offers auth methods", async () => {
  const { conn, session } = await client();
  await conn.request(SessionControls.get, { sessionId: session.id, discover: true });
  for (const method of ["_dev.xsb/auth/methods", "_dev.xsb/auth/login"]) {
    await assert.rejects(conn.request(method, { agentId: session.agentId, methodId: "terminal" }), { code: -32601 });
  }
  assert.equal(session.current, undefined);
  conn.close();
});

test("ACP setup rejection preserves the provider's code, message and data", async () => {
  const { conn, session } = await client("rejected");
  await assert.rejects(conn.request(SessionControls.get, { sessionId: session.id, discover: true }), {
    code: -32000, message: "Provider rejected credentials", data: { reason: "auth_required", provider: "custom" },
  });
  assert.equal(session.current, undefined);
  conn.close();
});

test("ACP prompt and run failures keep the provider error without sign-in advice", async () => {
  for (const text of ["reject-prompt", "fail-run"]) {
    const { conn, session, updates } = await client();
    await conn.request("session/prompt", { sessionId: session.id, prompt: [{ type: "text", text }] }).catch(error => {
      assert.equal(error.code, -32000);
      assert.equal(error.message, "Provider rejected credentials");
    });
    await until(() => !session.current && updates.some(u => u._meta?.[TurnFailure.key]));
    const failed = updates.find(u => u._meta?.[TurnFailure.key])._meta[TurnFailure.key];
    assert.equal(failed.message, "Provider rejected credentials");
    assert.deepEqual(failed.data, { reason: "auth_required", provider: "custom" });
    conn.close();
  }
});

test("session URL survives foreground idle and standard suggestions override AIR without changing prefix order", async () => {
  const { conn, session, updates, completions } = await client("codex");
  let resolve!: (r: any) => void, shown: any;
  conn.onRequest("elicitation/create", p => { shown = p; return new Promise(r => resolve = r); });
  await conn.request("session/prompt", { sessionId: session.id, prompt: [{ type: "skill", name: "pdf" }, { type: "text", text: "session-url" }] });
  await until(() => !session.current && !!shown);
  assert.equal(shown.sessionId, session.id);
  assert.equal(shown.mode, "url");
  await until(() => session.composerState().suggestions.length > 0);
  assert.equal(session.composerState().suggestions[0].prompt[0].text, "Standard suggestion");
  const payload = JSON.parse(updates.find(u => u.sessionUpdate === "agent_message_chunk").content.text);
  assert.equal(payload.blocks[0].type, "skill");
  assert.equal(typeof payload.idempotencyKey, "string", "standard prompt uses a stable Hub message identity");
  assert.equal(payload.capabilities.elicitation.form, undefined, "Codex questions keep xSB ask");
  assert.deepEqual(payload.capabilities.elicitation.url, {});
  assert.deepEqual(payload.capabilities._meta.jetbrains.air.capabilities, []);
  resolve({ action: "accept" }); await until(() => completions.length > 0);
  assert.equal(session.current, undefined, "URL completion never revives the turn");
  conn.close();
});

test("request-scoped authorization during session setup maps to the discovering client request", async () => {
  const { conn, session } = await client("startup");
  let shown: any, outer: number | undefined;
  conn.onRequest("elicitation/create", p => { shown = p; return { action: "accept" }; });
  await conn.request(SessionControls.get, { sessionId: session.id, discover: true }, undefined, id => outer = id);
  assert.equal(shown.requestId, outer);
  assert.equal(session.current, undefined);
  assert.ok(session.rec.backendSessionId);
  conn.close();
});

test("Claude-style forms return answers on the original request", async () => {
  const { conn, session } = await client();
  let shown: any;
  conn.onRequest("elicitation/create", p => { shown = p; return { action: "accept", content: { choice: "B" } }; });
  await conn.request("session/prompt", { sessionId: session.id, prompt: [{ type: "text", text: "native-form" }] });
  await until(() => !session.current && !!shown);
  assert.equal(shown.mode, "form");
  assert.equal(session.current, undefined);
  conn.close();
});
