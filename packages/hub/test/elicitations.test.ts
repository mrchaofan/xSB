import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agents, Boundaries, Connection, Question, RunExt, Workflow } from "@xsb/protocol";
import type { ElicitationResponse } from "@xsb/protocol";
import { Hub } from "../src/hub.ts";

const form = { message: "Choose storage", requestedSchema: {
  type: "object", properties: { question_0: { type: "string", oneOf: [{ const: "sqlite", title: "SQLite" }, { const: "pg", title: "Postgres" }] } }, required: ["question_0"],
} };
async function until(check: () => unknown) {
  for (let n = 0; n < 500; n++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); }
  throw Error("Timed out");
}
async function setup(t: any, backend = "claude", extraArgs: string[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-native-ask-"));
  const previous = process.env.XSB_HOME;
  process.env.XSB_HOME = path.join(dir, "home"); fs.mkdirSync(process.env.XSB_HOME);
  const spec = { command: process.execPath, args: [fileURLToPath(new URL("./mock-agent.ts", import.meta.url)), ...extraArgs] };
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

for (const backend of ["claude", "codex"]) test(`${backend} questions return on their ACP request and keep the same turn`, async t => {
  const { hub, client, session, updates, send } = await setup(t, backend);
  let asked: any, resolve!: (r: ElicitationResponse) => void;
  client.onRequest("elicitation/create", (p) => { asked = p; return new Promise(r => resolve = r); });
  await send("!elicit " + JSON.stringify(form));
  await until(() => asked);
  const turn = session.current!;
  const inputCount = turn.inputs.length;
  assert.equal(asked.sessionId, session.id);
  assert.equal(hub.agentInfo(hub.agent(session.agentId)).state, "requires_action");
  assert.equal(hub.agentInfo(hub.agent(session.agentId)).asking, true);
  assert.ok(updates.some(u => u._meta?.[Question.key]?.source === "acp"));
  resolve({ action: "accept", content: { question_0: "pg" } });
  await until(() => updates.some(u => u.sessionUpdate === "state_update" && u.state === "idle"));
  assert.ok(updates.some(u => u.content?.text?.includes('"question_0":"pg"')));
  const answered = updates.find(u => u._meta?.[Question.key]?.state === "answered")._meta[Question.key];
  assert.deepEqual(answered.answers, ["Postgres"]);
  assert.equal(session.toolContext().turns.at(-1)?.id, turn.id);
  assert.equal(turn.inputs.length, inputCount, "the response never became another prompt");
  assert.deepEqual(updates.filter(u => u.sessionUpdate === "state_update").map(u => u.state),
    ["running", "requires_action", "running", "idle"]);
  assert.equal(hub.agentInfo(hub.agent(session.agentId)).asking, undefined);
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

test("the backend receives the workflow MCP bridge and no built-in ask server", async t => {
  const { client, session, updates, send } = await setup(t);
  await send("!servers");
  await until(() => updates.some(u => u.sessionUpdate === "state_update" && u.state === "idle"));
  const names = updates.find(u => u.content?.text?.startsWith("servers: ")).content.text.trim().slice(9).split(", ");
  assert.ok(names.includes("workflow"));
  assert.ok(!names.includes("xsb"));

  const answer = { questionId: "retired", answers: ["Old answer"] };
  await assert.rejects(client.request("_dev.xsb/questions/answer", { sessionId: session.id, answer }), e => (e as { code: number }).code === -32601);
  for (const stale of [answer, null]) {
    await assert.rejects(client.request("session/prompt", { sessionId: session.id, prompt: [{ type: "text", text: "Old answer" }],
      _meta: { "dev.xsb/answer": stale } }), /expired/);
  }
  assert.equal(session.current, undefined);
});

test("ordinary input cancels a blocking form and reaches the conversation as an ordinary prompt", async t => {
  const { client, session, updates, send } = await setup(t);
  let signal: AbortSignal | undefined;
  client.onRequest("elicitation/create", (_, ctx) => { signal = ctx.signal; return new Promise(() => {}); });
  await send("!elicit " + JSON.stringify(form));
  await until(() => signal);
  await send("Do this instead");
  await until(() => !session.busy && signal!.aborted);
  assert.ok(updates.some(u => u._meta?.[Question.key]?.state === "cancelled"));
  assert.ok(updates.some(u => u.content?.text?.includes("echo: Do this instead")));
});

test("an async Codex question leaves the turn running and accepts a reply on its original request", async t => {
  const { hub, client, session, updates, send } = await setup(t, "codex", ["--steering"]);
  let respond: ((answer: ElicitationResponse) => void) | undefined;
  client.onRequest("elicitation/create", (request) => {
    assert.equal(request._meta.codex.delivery, "async");
    return new Promise(r => { respond = r; });
  });
  await send("!elicitAsync " + JSON.stringify(form) + "\n!waitForInput\n!waitForInput\n!say ORIGINAL DONE");
  await until(() => respond);
  const original = session.current!;
  assert.equal(hub.agentInfo(hub.agent(session.agentId)).state, "running");
  assert.equal(hub.agentInfo(hub.agent(session.agentId)).asking, undefined);
  await send("!say independent input");
  assert.equal(session.current?.id, original.id);
  respond!({ action: "accept", content: { question_0: "pg" } });
  await until(() => updates.some(u => u.content?.text?.includes("native answer:")));
  assert.equal(session.current?.id, original.id);
  assert.equal(original.protected, true);
  await send("!say finish this turn");
  await until(() => !session.busy);
  assert.equal(original.inputs.length, 3, "only the three explicit user prompts were submitted");
  assert.ok(!updates.some(u => u.sessionUpdate === "state_update" && u.state === "requires_action"));
  assert.equal(session.toolContext().turns.length, 1);
});

test("async forms stay independently answerable after idle; only the adapter starts the follow-up", async t => {
  const { client, session, updates, send } = await setup(t, "codex");
  const replies: ((answer: ElicitationResponse) => void)[] = [];
  client.onRequest("elicitation/create", () => new Promise(r => replies.push(r)));
  await send(Array(2).fill("!elicitAsync " + JSON.stringify(form)).join("\n"));
  await until(() => replies.length === 2 && !session.busy);
  replies[1]({ action: "decline" });
  replies[0]({ action: "accept", content: { question_0: "pg" } });
  await until(() => updates.some(u => u.content?.text?.includes("native answer:")));
  const response = updates.find(u => u.content?.text?.includes("native answer:"));
  assert.equal(response._meta[RunExt.key].turnId, null);
  assert.equal(session.current, undefined);
  assert.equal(session.toolContext().turns.length, 1);
  const history = updates.flatMap(u => u._meta?.[Question.key] ?? []);
  assert.deepEqual(history.map(q => q.state), ["open", "open", "skipped", "answered"]);
  assert.equal(history[0].id, history[3].id);
  assert.equal(history[1].id, history[2].id);
});

test("closing and resuming an idle session on the same connection reopens the original async form", async t => {
  const { client, session, updates, send } = await setup(t, "codex");
  const calls: { id: string; signal: AbortSignal; reply: (r: ElicitationResponse) => void }[] = [];
  client.onRequest("elicitation/create", (p, ctx) => new Promise(reply => {
    calls.push({ id: p._meta[Question.key].id, signal: ctx.signal, reply });
  }));
  await send("!elicitAsync " + JSON.stringify(form));
  await until(() => calls.length === 1 && !session.busy);
  await client.request("session/close", { sessionId: session.id });
  await until(() => calls[0].signal.aborted);
  await client.request("session/resume", { sessionId: session.id });
  await until(() => calls.length === 2);
  assert.equal(calls[0].id, calls[1].id);
  calls[0].reply({ action: "decline" });
  calls[1].reply({ action: "accept", content: { question_0: "pg" } });
  await until(() => updates.some(u => u._meta?.[Question.key]?.state === "answered"));
  assert.ok(!updates.some(u => u._meta?.[Question.key]?.state === "skipped"));
});

for (const action of ["stop", "clear", "next turn"] as const) test(`idle async reply is fenced by ${action}`, async t => {
  const { client, session, updates, send } = await setup(t, "codex");
  let respond: ((answer: ElicitationResponse) => void) | undefined, signal: AbortSignal | undefined;
  client.onRequest("elicitation/create", (_, ctx) => { signal = ctx.signal; return new Promise(r => respond = r); });
  await send("!elicitAsync " + JSON.stringify(form));
  await until(() => respond && !session.busy);
  if (action === "stop") client.notify("session/cancel", { sessionId: session.id });
  if (action === "clear") await client.request(Boundaries.clear, { sessionId: session.id });
  if (action === "next turn") await send("!say NEW WORK");
  await until(() => signal!.aborted && updates.some(u => u._meta?.[Question.key]?.state === "cancelled"));
  respond!({ action: "accept", content: { question_0: "pg" } });
  await send("!say STILL HERE");
  await until(() => !session.busy && updates.some(u => u.content?.text?.includes("STILL HERE")));
  assert.ok(!updates.some(u => u._meta?.[Question.key]?.state === "answered" || u.content?.text?.includes("native answer:")));
});
