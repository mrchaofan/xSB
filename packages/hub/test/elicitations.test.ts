import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agents, Connection, Question, Workflow } from "@xsb/protocol";
import type { ElicitationResponse } from "@xsb/protocol";
import { Hub } from "../src/hub.ts";

const form = { message: "Choose storage", requestedSchema: {
  type: "object", properties: { question_0: { type: "string", oneOf: [{ const: "sqlite", title: "SQLite" }, { const: "pg", title: "Postgres" }] } }, required: ["question_0"],
} };
async function until(check: () => unknown) {
  for (let n = 0; n < 500; n++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); }
  throw Error("Timed out");
}
async function setup(t: any, backend = "claude") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-native-ask-"));
  const previous = process.env.XSB_HOME;
  process.env.XSB_HOME = path.join(dir, "home"); fs.mkdirSync(process.env.XSB_HOME);
  const spec = { command: process.execPath, args: [fileURLToPath(new URL("./mock-agent.ts", import.meta.url))] };
  fs.writeFileSync(path.join(process.env.XSB_HOME, "config.json"), JSON.stringify({ version: 1, backends: { claude: spec, codex: spec } }));
  const hub = new Hub(dir); await hub.start();
  const socket = net.connect(hub.paths.socket("acp")); await new Promise(r => socket.once("connect", r));
  const client = new Connection(socket, socket);
  const updates: any[] = [];
  client.onNotification("session/update", p => updates.push(p.update));
  await client.request("initialize", { protocolVersion: 2, info: { name: "forms", version: "0" }, capabilities: { elicitation: { form: {} }, _meta: { [Agents.capability]: {} } } });
  const { sessionId } = await client.request("session/new", { cwd: dir, mcpServers: [], _meta: { [Workflow.backend]: backend } });
  t.after(async () => { await hub.shutdown(); client.close(); socket.destroy(); fs.rmSync(dir, { recursive: true, force: true }); if (previous === undefined) delete process.env.XSB_HOME; else process.env.XSB_HOME = previous; });
  const session = hub.session(sessionId);
  return { hub, client, session, updates, send: (prompt: string) => client.request("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] }) };
}

test("native form traverses real ACP transports and resumes the same protected turn; self ask remains available", async t => {
  const { hub, client, session, updates, send } = await setup(t);
  let asked: any, resolve!: (r: ElicitationResponse) => void;
  client.onRequest("elicitation/create", (p) => { asked = p; return new Promise(r => resolve = r); });
  await send("!elicit " + JSON.stringify(form));
  await until(() => asked);
  const turn = session.current!.id;
  assert.equal(asked.sessionId, session.id);
  assert.equal(hub.agentInfo(hub.agent(session.agentId)).state, "requires_action");
  assert.ok(updates.some(u => u._meta?.[Question.key]?.source === "acp"));
  resolve({ action: "accept", content: { question_0: "pg" } });
  await until(() => !session.busy && updates.some(u => u.content?.text?.includes('"question_0":"pg"')));
  assert.ok(updates.some(u => u.content?.text?.includes('"question_0":"pg"')));
  const answered = updates.find(u => u._meta?.[Question.key]?.state === "answered")._meta[Question.key];
  assert.deepEqual(answered.answers, ["Postgres"]);
  assert.equal(session.toolContext().turns.at(-1)?.id, turn);
  await send('!call ask {"questions":[{"question":"Own ask?","kind":"text"}]}');
  await until(() => !session.busy && session.rec.question);
  assert.ok(session.rec.question);
});

test("stop cancels the native form and fences a late answer from the next turn", async t => {
  const { client, session, updates, send } = await setup(t);
  let signal: AbortSignal | undefined, resolve!: (r: ElicitationResponse) => void;
  client.onRequest("elicitation/create", (_, ctx) => { signal = ctx.signal; return new Promise(r => resolve = r); });
  await send("!elicit " + JSON.stringify(form));
  await until(() => signal);
  client.notify("session/cancel", { sessionId: session.id });
  await until(() => !session.busy && signal!.aborted);
  await send("!sleep 80\n!say NEW WORK");
  const next = session.current!.id;
  resolve({ action: "accept", content: { question_0: "pg" } });
  await until(() => !session.busy);
  assert.ok(updates.some(u => u._meta?.[Question.key]?.state === "cancelled"));
  assert.ok(!updates.some(u => u._meta?.[Question.key]?.state === "answered"));
  assert.equal(session.toolContext().turns.at(-1)?.id, next);
});

test("invalid native answers cannot reach the backend as accepted choices", async t => {
  const { client, session, updates, send } = await setup(t);
  client.onRequest("elicitation/create", () => ({ action: "accept", content: { question_0: "not-an-option" } }));
  await send("!elicit " + JSON.stringify(form)); await until(() => !session.busy && updates.some(u => u.content?.text?.includes('native answer: {"action":"cancel"}')));
  assert.ok(updates.some(u => u.content?.text?.includes('native answer: {"action":"cancel"}')));
});

test("Codex does not receive form capability and continues to use xSB ask", async t => {
  const { session, updates, send } = await setup(t, "codex");
  await send("!elicit " + JSON.stringify(form)); await until(() => !session.busy && updates.some(u => u.content?.text?.includes("native forms disabled")));
  assert.ok(updates.some(u => u.content?.text?.includes("native forms disabled")));
  await send('!call ask {"questions":[{"question":"Codex choice","kind":"single","options":["A","B"]}]}');
  await until(() => !session.busy && session.rec.question); assert.ok(session.rec.question);
});
