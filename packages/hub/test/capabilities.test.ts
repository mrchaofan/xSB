import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Connection, SessionControls } from "@xsb/protocol";
import { Hub } from "../src/hub.ts";
import { Auth } from "../src/auth.ts";

const agent = fileURLToPath(new URL("./capability-agent.ts", import.meta.url));
const project = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-capabilities-"));
const priorHome = process.env.XSB_HOME;
process.env.XSB_HOME = path.join(project, "home"); fs.mkdirSync(process.env.XSB_HOME);
fs.writeFileSync(path.join(process.env.XSB_HOME, "config.json"), JSON.stringify({ version: 1, backends: {
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

test("OAuth URL maps request IDs across both connections and completion retains the opaque UI ID", async () => {
  const { conn, session, completions } = await client();
  let outer: number | undefined, shown: any;
  conn.onRequest("elicitation/create", p => { shown = p; return { action: "accept" }; });
  const methods = await conn.request(Auth.methods, { agentId: session.agentId });
  assert.deepEqual(methods.find((m: any) => m.type === "terminal").env, [{ name: "ACP_TEST", value: "ok" }]);
  const response = await conn.request(Auth.login, { agentId: session.agentId, methodId: "oauth" }, undefined, id => outer = id);
  assert.equal(shown.requestId, outer);
  assert.notEqual(shown.elicitationId, "oauth");
  assert.equal(response.authenticated, true);
  await until(() => completions.length > 0);
  assert.equal(completions[0].elicitationId, shown.elicitationId);
  assert.equal(session.current, undefined);
  conn.close();
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

test("terminal auth uses configured invocation and reconnects without creating a turn or losing session ID", async () => {
  const { conn, session } = await client();
  await conn.request(SessionControls.get, { sessionId: session.id, discover: true });

  const saved = session.rec.backendSessionId;
  let terminal: any;
  conn.onRequest(Auth.terminal, async p => {
    terminal = p;
    const child = spawn(p.command, [...p.args, ...p.method.args], { cwd: p.cwd, env: { ...process.env, ...Object.fromEntries(p.method.env.map((e: any) => [e.name, e.value])) }, stdio: "ignore" });
    return { exitCode: await new Promise(r => child.once("exit", r)) };
  });
  await conn.request(Auth.login, { agentId: session.agentId, methodId: "terminal" });
  assert.equal(terminal.command, process.execPath);
  assert.equal(terminal.cwd, project);
  assert.equal(session.current, undefined);
  assert.equal(session.rec.backendSessionId, saved);
  await session.ensureBackend();
  assert.equal(session.rec.backendSessionId, saved, "new process resumes the saved native ID");
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
