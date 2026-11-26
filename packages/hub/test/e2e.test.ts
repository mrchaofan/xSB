import { MessageDelivery } from "@xsb/protocol";
/**
 * End to end: a real hub, real sockets, the real MCP bridge, and scripted
 * agents in place of models: test/mock-agent.ts speaks ACP itself, and
 * test/third-party-agent.ts does not and is wrapped with @xsb/adapter.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { F, State } from "../src/state.ts";
import { Workflow, Agents, SessionControls, Assets, Backends, Boundaries, Connection, Discarded, History, Ledger, RunExt, TurnFailure, LANGUAGES, LanguageExt, OriginExt, PROTOCOL_VERSION, Tasks, explain, languageOf } from "@xsb/protocol";
import type { AgentInfo, Language, Task } from "@xsb/protocol";
import { Hub } from "../src/hub.ts";
import { isVeto } from "../src/hooks.ts";
import { isTerminal as isTerminalStatus } from "@xsb/protocol";
import { USER, agentPrincipal } from "../src/kernel.ts";
import type { LiveSession } from "../src/session.ts";
import { bridgeServer } from "../src/mcp.ts";
import { Paths } from "../src/paths.ts";
import { loadProjectConfig, saveProjectConfig } from "../src/config.ts";
import { setTimeout as sleep } from "node:timers/promises";

import { ToolContext } from "@xsb/protocol";

const MOCK = fileURLToPath(new URL("./mock-agent.ts", import.meta.url));
const GENERATOR = fileURLToPath(new URL("./mock-generator.ts", import.meta.url));
const THIRD_PARTY = fileURLToPath(new URL("./third-party-agent.ts", import.meta.url));
const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xsb-e2e-")));
const paths = new Paths(project);
// MCP hosts can filter inherited variables. Electron must still run the bridge
// as Node when only the explicitly declared MCP environment is forwarded.
const bridge = bridgeServer(paths.socket("mcp"), "test-token");
assert.equal(bridge.type === "stdio" && bridge.env?.find((e) => e.name === "ELECTRON_RUN_AS_NODE")?.value, "1");
fs.mkdirSync(paths.dir);
// Backends are machine settings: they live in the global directory, here a scratch one.
process.env.XSB_HOME = path.join(project, "home");
fs.mkdirSync(process.env.XSB_HOME);
const node = process.execPath;
fs.writeFileSync(
  path.join(process.env.XSB_HOME, "config.json"),
  JSON.stringify({
    version: 1,
    backends: {
      mock: { command: node, args: [MOCK] },
      wrapped: { command: node, args: [THIRD_PARTY] },
      steerable: { command: node, args: [MOCK, "--steering", "--legacy-steering-advertisement"] },
      old: { command: node, args: [MOCK, "--protocol", "1"] },
      bare: { command: node, args: [MOCK, "--no-system-prompt"] },
      "signed-out": { command: node, args: [MOCK, "--auth-required"] },
      "from-the-future": { command: node, args: [MOCK, "--protocol", "9"] },
      forgetful: { command: node, args: [MOCK, "--no-resume"] },
      crashing: { command: node, args: ["-e", "console.error('license expired'); process.exit(3)"] },
      missing: { command: "xsb-no-such-command" },
      "context-refusal": { command: node, args: [MOCK, "--context-refusal", "--context-refusal-file", path.join(project, "refused-once")] },
      "context-refusal-always": { command: node, args: [MOCK, "--context-refusal-always"] },
      unisolated: { command: node, args: [MOCK, "--no-turn-isolation"] },
    },
  }),
);

/** What a client saw, per session. */
const said = new Map<string, string>();
const inputs = new Map<string, { text: string; origin: any }[]>();
let permissionAsked = 0;
/** What the test's client answers to a permission request; the first option when unset. */
let permissionChoice: string | undefined;
const removed: string[] = [];
/** Asset versions the hub announced. */
const assetEvents: string[] = [];
/** Agents that said they wait for the user (`ask_user`), with their question. */
const asks: string[] = [];

/**
 * A client of the hub over ACP v2. `turn` sends a prompt and resolves with how the work it went into ended: the
 * answer to `session/prompt` comes once it is inserted, the end with the session's `idle`.
 */
type Client = Connection & { turn(sessionId: string, text: string, meta?: object): Promise<{ stopReason: string; error?: any }>; updates: ((sessionId: string, update: any) => void)[] };
async function client(name: string, capabilities: object = {}): Promise<Client> {
  const socket = net.connect(paths.socket("acp"));
  await new Promise((resolve) => socket.once("connect", resolve));
  const c = new Connection(socket, socket, name) as Client;
  c.updates = [];
  const idle = new Map<string, ((end: any) => void)[]>();
  c.onNotification("session/update", ({ sessionId, update }) => {
    for (const listen of c.updates) listen(sessionId, update);
    if (update.sessionUpdate === "state_update" && update.state === "idle") {
      for (const done of idle.get(sessionId)?.splice(0) ?? []) done({ stopReason: update.stopReason, ...(update.error ? { error: update.error } : {}) });
    }
  });
  c.turn = async (sessionId, text, meta = {}) => {
    const ended = new Promise<any>((resolve) => idle.set(sessionId, [...(idle.get(sessionId) ?? []), resolve]));
    await c.request("session/prompt", { sessionId, prompt: [{ type: "text", text }], _meta: meta });
    const end = await ended;
    if (end.error) throw Object.assign(new Error(end.error.message), end.error);
    return end;
  };
  const init = await c.request("initialize", { protocolVersion: PROTOCOL_VERSION, info: { name, version: "0" }, capabilities });
  assert.equal(init.protocolVersion, PROTOCOL_VERSION);
  return c;
}

async function connect(): Promise<Client> {
  const conn = await client("test", { _meta: { [Agents.capability]: {} } });
  conn.updates.push((sessionId, update) => {
    if (update.sessionUpdate === "agent_message_chunk") said.set(sessionId, (said.get(sessionId) ?? "") + update.content.text);
    if (update.sessionUpdate === "user_message_chunk") {
      const list = inputs.get(sessionId) ?? [];
      list.push({ text: update.content.text, origin: update._meta[OriginExt.key] });
      inputs.set(sessionId, list);
    }
  });
  conn.onNotification(Agents.removed, ({ id }) => removed.push(id));
  conn.onNotification(Assets.update, ({ asset }) => assetEvents.push(`${asset.id}@${asset.version}`));
  conn.onNotification(Agents.asks, ({ agentId, question }) => asks.push(`${agentId}: ${question}`));
  conn.onRequest("session/request_permission", (p) => {
    permissionAsked++;
    return { outcome: { outcome: "selected", optionId: permissionChoice ?? p.options[0].optionId } };
  });
  return conn;
}

/** What an agent was given, in every session of its own, as its transcripts have it (work goes to work sessions). */
const received = (agentId: string): { text: string; origin: any }[] =>
  [...hub.state.sessions.values()]
    .filter((s) => s.agentId === agentId)
    .flatMap((s) => hub.state.store.read(Paths.transcript(agentId, s.id)))
    .map((r: any) => r.update)
    .filter((u: any) => u?.sessionUpdate === "user_message_chunk")
    .map((u: any) => ({ text: u.content.text ?? "", origin: u._meta?.[OriginExt.key] }));

/** What an agent said, in every session of its own, as its transcripts have it. */
const answered = (agentId: string): string =>
  [...hub.state.sessions.values()]
    .filter((s) => s.agentId === agentId)
    .flatMap((s) => hub.state.store.read(Paths.transcript(agentId, s.id)))
    .map((r: any) => r.update)
    .filter((u: any) => u?.sessionUpdate === "agent_message_chunk")
    .map((u: any) => u.content.text)
    .join("");

async function until<T>(what: string, probe: () => T | Promise<T>, ms = 8000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  let told = false;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    if (!told && Date.now() > end - ms + 3000) {
      told = true;
      console.log(`(still waiting for: ${what})`);
    }
    await sleep(25);
  }
}

// A test that hangs says where.
setTimeout(() => {
  console.log("TIMEOUT");
  process.exit(1);
}, Number(process.env.E2E_TIMEOUT_MS ?? 600_000)).unref();

let hub = new Hub(project);
await hub.start();
let conn = await connect();

const prompt = (sessionId: string, text: string) => conn.turn(sessionId, text);
const create = async (backend = "mock") => {
  const {sessionId} = await conn.request("session/new",{cwd:project,mcpServers:[],_meta:{[Workflow.backend]:backend}});
  return hub.session(sessionId);
};
const call = (tool: string, args: unknown): string => `!call ${tool} ${JSON.stringify(args)}`;
const idle = (agentId: string) => until("agent idle",() => !hub.mainSession(agentId).busy);
const root = await create(), a = root.id;
await prompt(a,"hello");
assert.match(said.get(a)!, /echo: hello/);
assert.equal(hub.state.workflows.size,0);
await assert.rejects(conn.request("_dev.xsb/roles/put",{role:{name:"legacy"}}),/Method not found/);

// Native background notifications have real ACP execution boundaries but no hub turn or task of their own.
{
  const session = await create("steerable"), updates: any[] = [];
  conn.updates.push((id, update) => { if (id === session.id) updates.push(update); });
  await prompt(session.id, "!say FRONT\n!background 100 250");
  const taskCount = hub.state.tasks.size;
  await until("native background execution ended", () => updates.some(u => u.sessionUpdate === "session_info_update" && u._meta?.[RunExt.key]?.turnId === null && u._meta[RunExt.key].state === "idle"));
  const background = updates.filter(u => u._meta?.[RunExt.key]?.turnId === null);
  assert.deepEqual(background.filter(u => u.sessionUpdate === "session_info_update").map(u => u._meta[RunExt.key].state), ["running", "idle"]);
  assert.ok(background.filter(u => u.sessionUpdate === "agent_message_chunk").every(u => u._meta[RunExt.key].id === background[0]._meta[RunExt.key].id));
  assert.deepEqual(background.at(-1)._meta[RunExt.key].origin, { kind: "task-notification" });
  assert.equal(hub.state.tasks.size, taskCount);
  assert.equal(session.busy, false);
  assert.equal(updates.filter(u => u.sessionUpdate === "state_update").length, 2, "only the foreground turn changes agent state");
  const page = await conn.request(History.page, { sessionId: session.id });
  assert.deepEqual(page.updates.filter((u: any) => u.sessionUpdate === "session_info_update" && u._meta?.[RunExt.key]?.turnId === null), background.filter(u => u.sessionUpdate === "session_info_update"));

  // The new prompt is inserted into native work: this run gains an owner at the receipt, keeping its original id.
  const joined = await create("steerable"), joinedUpdates: any[] = [];
  conn.updates.push((id, update) => { if (id === joined.id) joinedUpdates.push(update); });
  await prompt(joined.id, "!say FRONT\n!background 100 500");
  await until("autonomous output before input", () => joinedUpdates.find(u => u.sessionUpdate === "agent_message_chunk" && u.content.text.includes("BACKGROUND START")));
  const unowned = joinedUpdates.find(u => u.sessionUpdate === "agent_message_chunk" && u.content.text.includes("BACKGROUND START"))._meta[RunExt.key];
  await prompt(joined.id, "!sleep 25\n!say JOINED");
  const claimed = joinedUpdates.find(u => u.sessionUpdate === "agent_message_chunk" && u.content.text.includes("JOINED"))._meta[RunExt.key];
  assert.equal(unowned.turnId, null);
  assert.equal(claimed.id, unowned.id);
  assert.ok(claimed.turnId);
  assert.equal(joined.busy, false);
  console.log("ok native background runs, history boundaries and insertion-based ownership");
}
// Switching a conversation's backend. A new conversation may already have a backend session, opened for its settings;
// one without records simply runs on the other. One with records moves to a new conversation, whose model is told so
// with its first message and reads the old one with previous_conversation; never while a turn runs.
{
  const empty = await create("mock");
  const controls = await conn.request(SessionControls.get, { sessionId: empty.id, discover: true });
  assert.equal(controls.connected, true, "a new conversation's settings come from its backend session");
  assert.ok(hub.session(empty.id).rec.backendSessionId, "opened before the first message");
  assert.ok(!(await conn.request(Agents.list)).agents.find((x: any) => x.id === empty.agentId).conversed, "no records yet");
  await conn.request(Agents.set, { agentId: empty.agentId, backend: "steerable" });
  assert.equal(hub.session(empty.id).rec.backendSessionId, undefined, "the old backend session held nothing and is dropped");
  await prompt(empty.id, "!say ON-STEERABLE");
  assert.match(said.get(empty.id)!, /ON-STEERABLE/);
  const marks = (sid: string, agentId: string) => hub.state.store.read(Paths.transcript(agentId, sid)).map((r: any) => r.update?._meta?.["dev.xsb/boundary"]?.kind).filter(Boolean);
  assert.deepEqual(marks(empty.id, empty.agentId), [], "nothing to hand over: no boundary");

  const talked = await create("mock");
  await prompt(talked.id, "!say REMEMBER-THE-RED-COAT");
  assert.equal((await conn.request(Agents.list)).agents.find((x: any) => x.id === talked.agentId).conversed, true);
  await assert.rejects(conn.request(Agents.set, { agentId: talked.agentId, backend: "steerable" }), /moves it to a new conversation/);
  // Records outlast the backend session: a cleared context still cannot switch in place.
  const cleared = await create("mock");
  await prompt(cleared.id, "!say SAID");
  await conn.request(Boundaries.clear, { sessionId: cleared.id });
  await assert.rejects(conn.request(Agents.set, { agentId: cleared.agentId, backend: "steerable" }), /moves it to a new conversation/);
  const running = conn.turn(talked.id, "!sleep 400");
  await until("turn running", () => hub.session(talked.id).busy);
  await assert.rejects(conn.request(Agents.migrate, { agentId: talked.agentId, backend: "steerable" }), /current turn has not ended/);
  await running;
  await idle(talked.agentId);
  await assert.rejects(conn.request(Agents.migrate, { agentId: talked.agentId, backend: "no-such-backend" }), /backend/);
  const { agent: moved } = await conn.request(Agents.migrate, { agentId: talked.agentId, backend: "steerable" });
  assert.equal(moved.backend, "steerable");
  assert.ok(!moved.conversed, "no records yet: its own backend can still change");
  const next = moved.mainSessionId;
  assert.deepEqual(marks(next, moved.id), ["migrated"]);
  await prompt(next, `!echo\n${call("previous_conversation", { offset: 0 })}`);
  assert.match(said.get(next)!, /continues an earlier one[^]*previous_conversation/, "told with the first message");
  assert.match(said.get(next)!, /REMEMBER-THE-RED-COAT/, "and reads the old conversation with the tool");
  assert.equal(hub.session(next).rec.migratedFrom?.pending, undefined, "told once");
  await prompt(next, "!echo");
  assert.doesNotMatch(said.get(next)!.split("!echo").at(-1)!, /continues an earlier one/);
  assert.equal(hub.agent(talked.agentId).backend, "mock", "the old conversation stays as it was");
  console.log("ok backend switch: in place without records, a new conversation with them");
}
// A conversation's icon is the user's to choose, kept with the agent and told to every observer.
{
  const updated: any[] = [];
  conn.onNotification(Agents.update, ({ agent }) => updated.push(agent));
  const { agent } = await conn.request(Agents.set, { agentId: root.agentId, avatar: "animal-fox" });
  assert.equal(agent.avatar, "animal-fox");
  assert.equal(hub.state.agents.get(root.agentId)!.avatar, "animal-fox");
  await until("icon broadcast", () => updated.some((a) => a.id === root.agentId && a.avatar === "animal-fox"));
  await assert.rejects(conn.request(Agents.set, { agentId: root.agentId, avatar: "../x" }), /bundled avatar/);
  assert.equal((await conn.request(Agents.set, { agentId: root.agentId, avatar: "" })).agent.avatar, undefined);
  console.log("ok conversation icon");
}
// User titles persist, are broadcast, and win over backend suggestions even when renamed during a turn.
{
  const session = await create("mock");
  const updates: any[] = [];
  const observer = await client("rename observer", { _meta: { [Agents.capability]: {} } });
  observer.onNotification(Agents.update, ({ agent }) => updates.push(agent));
  const set = (title: unknown, extra = {}) => conn.request(Agents.set, { agentId: session.agentId, title, ...extra });
  await prompt(session.id, "!titlelater 100 First generated title\n!say READY");
  await until("automatic title published after idle", () => !session.busy && updates.some(a => a.id === session.agentId && a.name === "First generated title"));
  assert.equal(session.rec.title, "First generated title");
  await prompt(session.id, "!title Automatic title");
  assert.equal(hub.agentInfo(hub.agent(session.agentId)).name, "Automatic title");
  const running = prompt(session.id, "!sleep 500\n!title Late automatic title\n!say FINISHED");
  await until("rename turn running", () => hub.session(session.id).current?.started);
  const turn = hub.session(session.id).current;
  const { agent } = await set("  用户指定的名称  ");
  assert.equal(agent.name, "用户指定的名称");
  assert.equal(hub.session(session.id).current, turn, "renaming keeps the current turn");
  await until("rename broadcast", () => updates.some(a => a.id === session.agentId && a.name === agent.name));
  assert.equal((await running).stopReason, "end_turn");
  assert.match(said.get(session.id)!, /FINISHED/);
  assert.equal(hub.session(session.id).rec.title, agent.name, "late backend title cannot overwrite the user's title");
  for (const title of ["", "   ", "x".repeat(65), 42, null]) await assert.rejects(set(title), /title must be/);
  await assert.rejects(set("", { avatar: "animal-fox" }), /title must be/);
  assert.equal(hub.agent(session.agentId).avatar, undefined, "invalid rename changes nothing else");
  assert.equal((await conn.request<{ agents: AgentInfo[] }>(Agents.list)).agents.find(a => a.id === session.agentId)?.name, agent.name);
  assert.equal((await conn.request<{ sessions: { sessionId: string; title: string }[] }>("session/list", {})).sessions.find(s => s.sessionId === session.id)?.title, agent.name);
  const replay = new State(hub.state.store); replay.load();
  assert.equal(replay.sessions.get(session.id)?.title, agent.name);
  assert.equal(replay.sessions.get(session.id)?.titleEdited, true);
  const empty = await create("mock");
  await conn.request(Agents.set, { agentId: empty.agentId, title: "Named before chatting" });
  await prompt(empty.id, "!say FIRST MESSAGE");
  assert.equal(hub.session(empty.id).rec.title, "Named before chatting");
  const explicit = await conn.request("session/new", { title: "Title chosen on creation", _meta: { [Workflow.backend]: "mock" } });
  await prompt(explicit.sessionId, "!title Backend title");
  assert.equal(hub.session(explicit.sessionId).rec.title, "Title chosen on creation");
  observer.close();
  console.log("ok conversation rename: persistence, broadcasts, backend titles and running turn");
}
// 5. The user's word never waits. To a generic backend that holds what comes while it works, it goes in when
// the work it does is done, and the turn goes on with it: one turn, answered when the message is inserted.
{
  const turn = prompt(a, "!sleep 600\n!say FIRST");
  await until("a running", () => hub.session(a).current?.started);
  const second = conn.turn(a, "!say SECOND");
  assert.equal((await turn).stopReason, "end_turn");
  assert.equal((await second).stopReason, "end_turn");
  assert.match(said.get(a)!, /FIRST\n[^]*SECOND/);
  const steered = received(root.agentId).find((i) => i.text === "!say SECOND")!;
  assert.equal(steered.origin.steered, true);
  console.log("ok 5 the user's word into held work");
}

// 6. To a priority-prompt backend (as the pinned Claude/Codex adapters do), it goes in at once, and the work goes on with it.
{
  const c = (await create("steerable")).id;
  const turn = prompt(c, "!sleep 400\n!say END");
  await until("c running", () => hub.session(c).current?.started);
  const originalTurn = hub.session(c).current;
  await conn.request("session/prompt", { sessionId: c, prompt: [{ type: "text", text: "!say MID" }] });
  assert.ok(originalTurn?.inputs.some(i => i.in && i.content.some(b => b.type === "text" && b.text === "!say MID")), "the standard prompt was inserted under its original Hub turn");
  assert.equal((await turn).stopReason, "end_turn");
  assert.match(said.get(c)!, /MID\nEND/);
  console.log("ok 6 the user's word steered in");
}

// 9. Permission: the hub decides nothing; a backend that asks is answered by a human.
{
  const before = permissionAsked;
  await prompt(a, "!perm");
  assert.equal(permissionAsked, before + 1);
  assert.match(said.get(a)!, /perm: selected yes/);

  // A client that cannot answer (a script: it serves no such request) is passed over for one that can.
  const script = await client("script");
  let heard = "";
  script.updates.push((_, update) => {
    if (update.sessionUpdate === "agent_message_chunk") heard += update.content.text;
  });
  const own = (await script.request("session/new", { cwd: project, mcpServers: [], _meta: { [Workflow.backend]: "mock" } })).sessionId;
  await script.turn(own, "!perm");
  assert.equal(permissionAsked, before + 2);
  assert.match(heard, /perm: selected yes/);
  // With nobody connected who can, the turn the script waits for is not left hanging: its request is declined.
  conn.close();
  await sleep(50);
  await script.turn(own, "!perm");
  assert.match(heard, /perm: cancelled/);
  script.close();
  conn = await connect();
  console.log("ok 9 permissions go to a human");
}

// Standing instructions also reach ACP backends without a system-prompt capability.
{
  const session = await create("bare");
  await prompt(session.id,"hi");
  assert.match(said.get(session.id)!,/Each conversation has one effective execution turn/);
  said.set(session.id,"");
  await prompt(session.id,"again");
  assert.equal(said.get(session.id),"echo: again\n");
}
// Node profiles reach ACP session/new, survive rebinding, and expose portable skills through real MCP.
for (const backend of ["mock", "bare"]) {
  const main = await create(backend);
  const profile = { systemPrompt: "E2E stable reviewer role", skills: [{ name: "review", description: "Inspect evidence", content: "E2E portable skill procedure" }] };
  const program = "!instructions\n!echo\n" + call("load_skill", { name: "review" }) + "\n" + call("finish", { summary: "profile tested", assets: [] });
  const rows = [{ node: "reviewer", prompt: program, agent: profile }, { node: "done", kind: "end" }, { from: "reviewer", to: "done" }];
  await prompt(main.id, call("execute", { graphJsonl: rows.map(row => JSON.stringify(row)).join("\n") }));
  await until("configured node completes", () => hub.workflows.read(main.id).instances.reviewer.last?.valid);
  const instance = hub.workflows.read(main.id).instances.reviewer;
  const worker = hub.session(instance.sessionId!);
  await idle(worker.agentId);
  const prefix = worker.rec.workflowPrompt!;
  assert.ok(prefix.includes(profile.systemPrompt) && !prefix.includes(profile.skills[0].content));
  assert.match(answered(worker.agentId), /E2E portable skill procedure/);
  const source = received(worker.agentId).find(message => message.text.startsWith("# Workflow task") || message.text.startsWith("# 工作流任务"))!.text;
  assert.ok(source.includes(program));
  if (backend === "mock") assert.ok(answered(worker.agentId).includes(JSON.stringify({ mode: "append", content: [{ type: "text", text: prefix }] })), "the exact prefix was applied as ACP systemPrompt");
  else assert.ok(answered(worker.agentId).includes("E2E stable reviewer role"), "fallback instructions are in the received prompt");
  hub.backends.stop(worker.agentId);
  await prompt(worker.id, "!instructions");
  await idle(worker.agentId);
  assert.equal(worker.rec.workflowPrompt, prefix);
  if (backend === "mock") assert.ok(said.get(worker.id)!.includes(JSON.stringify({ mode: "append", content: [{ type: "text", text: prefix }] })), "resume receives the identical prefix");
}

// 14. An agent without ACP, wrapped with @xsb/adapter, goes through the same chain as the others.
{
  const e = (await create("wrapped")).id;
  await prompt(e, "hello");
  assert.match(said.get(e)!, /third party \(instructed\) heard: hello/);

  // It has no steering of its own: the wrapper holds what comes while it works, and gives it after, in the same turn.
  const turn = prompt(e, "wait 600");
  await until("e running", () => hub.session(e).current?.started);
  const more = conn.turn(e, "change of plan");
  assert.equal((await turn).stopReason, "end_turn");
  await more;
  assert.match(said.get(e)!, /heard: wait 600\n[^]*heard: change of plan/);

}
// 20. A client that shows transcripts opts in to its own input: it learns when its message got into the conversation.
{
  const echoing = await client("echoing", { _meta: { [OriginExt.capability]: {} } });
  const seen: string[] = [];
  echoing.updates.push((_, update) => {
    if (update.sessionUpdate === "user_message_chunk") seen.push(`in ${update.messageId}${update._meta[OriginExt.key].steered ? " steered" : ""}`);
    if (update.sessionUpdate === "agent_message_chunk" && /ONE|TWO/.test(update.content.text)) seen.push(`out ${update.content.text.trim()}`);
  });
  const sessionId = (await echoing.request("session/new", { cwd: project, mcpServers: [], _meta: { [Workflow.backend]: "steerable" } })).sessionId;
  const mine = (messageId: string) => ({ [OriginExt.key]: { messageId } });
  const first = echoing.turn(sessionId, "!sleep 300\n!say ONE", mine("mine-1"));
  await until("first turn running", () => seen.includes("in mine-1"));
  // The user's word never waits behind work: a second prompt while it works goes into it. Each is answered with the
  // id it was given, once it is inserted.
  const second = echoing.turn(sessionId, "!say TWO", mine("mine-2"));
  assert.deepEqual(await echoing.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "!say MID" }], _meta: mine("mine-3") }), { messageId: "mine-3" });
  await Promise.all([first, second]);
  assert.deepEqual(seen.filter((l) => l.startsWith("in")), ["in mine-1", "in mine-2 steered", "in mine-3 steered"]);
  assert.deepEqual(seen.filter((l) => l.startsWith("out")).sort(), ["out ONE", "out TWO"]);
  // None of them was ever queued: the ledger has them seen, and never "queued".
  for (const id of ["mine-1", "mine-2", "mine-3"]) await until(`${id} inserted`, () => hub.state.ledger.get(id)?.state === "inserted");
  const ledger = hub.state.store.read(F.ledger).map((r: any) => r.entry).filter((e: any) => e.messageId.startsWith("mine-"));
  assert.ok(!ledger.some((e: any) => e.state === "queued"), "the user's word is never queued");
  // An agent has one conversation: another client's new session of it is that one. A client that did not opt in is not
  // sent its own input, as in plain ACP.
  const quiet = (await create("steerable")).id;
  assert.notEqual(quiet, sessionId);
  await prompt(quiet, "!say THREE");
  assert.ok(!inputs.get(quiet)?.some((i) => i.text.includes("THREE")));
  echoing.close();
  console.log("ok 20 own input, echoed when it becomes a turn");
}

// 21. Input is content blocks, not only text. An image reaches a backend that reads images as it is; another is told one was there.
{
  const picture = [{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }, { type: "resource_link", uri: "file:///tmp/notes.md", name: "notes.md" }];
  const sighted = (await create("steerable")).id;
  await conn.request("session/prompt", { sessionId: sighted, prompt: picture });
  await until("the image read", () => /echo: look \| <image image\/png> \| <resource_link file:\/\/\/tmp\/notes\.md>/.test(said.get(sighted)!));
  const blind = (await create()).id;
  await conn.request("session/prompt", { sessionId: blind, prompt: picture });
  await until("the image named", () => /echo: look \| \[An image \(image\/png\) was attached here; you cannot see images\.\] \| <resource_link/.test(said.get(blind)!));
  // What was sent is what the transcript keeps, whatever the backend could read.
  // b's one conversation has more before: the last input is this one.
  const kept = hub.state.store.read(Paths.transcript(hub.session(blind).agentId, blind)).map((r: any) => r.update).filter((u: any) => u.sessionUpdate === "user_message_chunk").slice(-3);
  assert.deepEqual(kept.map((u: any) => u.content.type), ["text", "image", "resource_link"]);
  assert.equal(new Set(kept.map((u: any) => u.messageId)).size, 1);
  console.log("ok 21 images and files in input");
}

const addr = (s: LiveSession) => ({ agentId: s.agentId, sessionId: s.id });
const dispatch = (from: LiveSession, to: string, input: { title: string; topic: string; instructions: string; after: string[] }): Task => {
  const task = hub.kernel.dispatch(addr(from), { agentId: to, sessionId: hub.mainSession(to).id }, { deliveryPref: "wake", ...input });
  assert.ok(!isVeto(task));
  return task;
};
// Exercise the shared causal graph through real backend turns, including a
// terminal intermediate task and a queued ordering-only dependency.
{
  const [parent,middle,leaf,waiting]=await Promise.all([create(),create(),create(),create()]);
  const give=(from:LiveSession,to:LiveSession,title:string,after:string[]=[])=>dispatch(from,to.agentId,{title,topic:title,instructions:"!sleep 10000",after});
  const started=(t:Task)=>until("inserted "+t.title,()=>hub.session(t.to.sessionId).current?.inserted);
  const p=give(root,parent,"parent"); await started(p);
  const x=give(parent,middle,"middle"); await started(x);
  const z=give(middle,leaf,"leaf"); await started(z);
  const y=give(parent,waiting,"waiting",[z.id]);
  hub.kernel.complete(hub.state.tasks.get(x.id)!,"completed","middle done",[]);
  const cancelled=hub.kernel.stop(hub.state.tasks.get(p.id)!,agentPrincipal(root.agentId),{status:"cancelled",reason:"cancelled",result:"stop parent"});
  assert.ok(!isVeto(cancelled));
  assert.deepEqual(cancelled.with.map(t=>t.id).sort(),[y.id,z.id].sort());
  await until("leaf stopped through terminal middle",()=>hub.state.tasks.get(z.id)?.status==="cancelled");
  assert.equal(received(waiting.agentId).some(i=>i.text.includes(y.id)),false);
}
// 37. User stop withdraws the accepted backlog on every backend; new work is a separate turn.
{
  const b=await create();
  for (const backend of ["mock", "steerable"]) {
    const session=await create(backend), agentId=session.agentId, sessionId=session.id;
    const work = dispatch(hub.session(a), agentId, { title: `stop running ${backend}`, topic: "stop queue", instructions: "!sleep 3000\n!say OLD-RUN", after: [] });
    await until("old work inserted", () => session.current?.inserted);
    const queued = dispatch(hub.session(a), agentId, { title: `stop queued ${backend}`, topic: "stop queue", instructions: "!say OLD-QUEUE", after: [] });
    const blocked = dispatch(hub.session(a), agentId, { title: `stop blocked ${backend}`, topic: "stop queue", instructions: "!say OLD-BLOCKED", after: [work.id] });
    const ordinary = hub.kernel.post({ to: addr(session), from: { kind: "agent", ...addr(hub.session(a)) }, kind: "message", content: "OLD-MESSAGE", pref: "wake" }).item;
    const fact = dispatch(session, b.agentId, { title: `stop fact ${backend}`, topic: "stop queue", instructions: "!say SAVED-FACT", after: [] });
    await until("fact completed", () => hub.state.tasks.get(fact.id)?.status === "completed");
    assert.ok(![...hub.state.mail.values()].some(m => m.results?.taskIds.includes(fact.id)), "ordinary agent calls do not send return prompts");
    hub.kernel.post({ to: addr(session), from: { kind: "system" }, kind: "results", results: { taskIds: [fact.id] }, pref: "lazy" });
    conn.notify("session/cancel", { sessionId });
    // Same connection preserves the boundary: this prompt arrives after stop, while confirmation can still be pending.
    await conn.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "!say FRESH-WORK" }] });
    await until("fresh work completed", () => answered(agentId).includes("FRESH-WORK") && !session.busy);
    await until("all old tasks cancelled", () => [work, queued, blocked].every((t) => hub.state.tasks.get(t.id)?.status === "cancelled"));
    assert.ok(!received(agentId).some((i) => i.origin?.messageId === ordinary.id));
    assert.ok(!received(agentId).some((i) => i.text.includes(`task-id="${queued.id}"`) || i.text.includes(`task-id="${blocked.id}"`)));
    assert.doesNotMatch(answered(agentId), /OLD-RUN|OLD-QUEUE|OLD-BLOCKED|OLD-MESSAGE/);
    assert.ok(received(agentId).some((i) => i.text.includes("SAVED-FACT")), "completed facts survive for the new turn");
    assert.equal(hub.state.ledger.get(ordinary.id)?.state, "discarded_unseen");
    const generation = hub.kernel.generation(sessionId);
    const late = hub.kernel.post({ to: addr(session), from: { kind: "system" }, kind: "results", results: { taskIds: [fact.id] }, pref: "wake", workGeneration: generation - 1 }).item;
    await hub.kernel.hooks.settled();
    assert.equal(hub.state.ledger.get(late.id)?.state, "inboxed");
    assert.equal(session.busy, false, "late old results cannot wake the stopped agent");
    await idle(root.agentId);
    await idle(b.agentId);
  }
  console.log("ok 37 user stop withdraws backlog, preserves facts, and accepts new work");
}

// 12. Hub failures identify the backend; ACP provider errors preserve their original response.
{
  const fails = async (backend: string, code: number, reason: string | undefined, message: RegExp): Promise<void> => {
    let error: any;
    try {
      const session=await create(backend);
      await prompt(session.id,"hi");
    } catch (e) {
      error = e;
    }
    assert.ok(error, `${backend} should fail`);
    assert.deepEqual([error.code, error.data?.reason], [code, reason], error.message);
    assert.match(error.message, message);
  };
  await fails("nowhere", -33103, "backend_unknown", /no backend named "nowhere".*Known: claude, codex, mock/);
  await fails("missing", -33101, "backend_not_installed", /"xsb-no-such-command".*does not install/);
  await fails("crashing", -33102, "backend_start_failed", /exited \(3\).*license expired/);
  await fails("from-the-future", -33104, "backend_incompatible", /speaks ACP v9/);
  // An agent that speaks only ACP v1 (as Gemini CLI and Grok do) is not one the hub can run.
  await fails("old", -33104, "backend_incompatible", /speaks ACP v1/);
  await fails("signed-out", -32000, undefined, /^Authentication required$/);
  console.log("ok 12 error codes");
}

// 40. Confirmed stops keep the backend conversation, image context and attached MCP bridge.
{
  for (const backend of ["mock", "steerable"]) {
    const session = await create(backend), agentId=session.agentId, sessionId=session.id;
    const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" };
    const boundaries = () => hub.state.store.read(Paths.transcript(agentId, sessionId))
      .map((r: any) => r.update._meta?.[Boundaries.key]).filter(Boolean);
    const boundaryCount = boundaries().length;
    let backendId: string | undefined, bridgeToken: string | undefined;
    for (let n = 0; n < 3; n++) {
      const blocks = [{ type: "text", text: "!sleep 3000\n!say MUST-NOT-RUN" },
        ...(backend === "steerable" && n === 0 ? [image] : [])];
      await conn.request("session/prompt", { sessionId, prompt: blocks });
      await until("context work inserted", () => session.current?.inserted);
      backendId ??= session.rec.backendSessionId;
      bridgeToken ??= session.bridgeToken;
      session.given.notes.set("retained-context", "v1");
      conn.notify("session/cancel", { sessionId });
      await until("context work stopped", () => !session.busy);
      assert.equal(session.rec.backendSessionId, backendId);
      assert.equal(session.bridgeToken, bridgeToken);
      assert.notEqual(session.rec.renew, "stopped");
      await prompt(sessionId, `${call("asset_list", { name:"example" })}\n!images\n!say CONTEXT-AFTER-${n}`);
      await idle(agentId);
      assert.match(answered(agentId), /result\(asset_list\):/);
      assert.doesNotMatch(answered(agentId), /work was stopped|revoked|MUST-NOT-RUN/);
      if (backend === "steerable") assert.ok(answered(agentId).includes(`images: ["${image.data}"]`), "original image bytes remain in backend context");
      assert.equal(session.rec.backendSessionId, backendId);
      assert.equal(session.bridgeToken, bridgeToken);
      assert.equal(session.given.notes.get("retained-context"), "v1");
      assert.equal(boundaries().length, boundaryCount, "normal stop adds no summary handoff boundary");
    }
  }
  console.log("ok 40 repeated stops preserve context, images and subsequent MCP calls");
}

// 41. Tools can observe runtime turns without posting prompts or waking an agent.
{
  const session = await create(), agentId=session.agentId, sessionId=session.id;
  const scoped = hub.withToolContext({ type: 'stdio', name: 'browser', command: 'browser' }, session);
  assert.ok(scoped.type === 'stdio');
  const token = scoped.env!.find(e => e.name === ToolContext.tokenEnv)!.value;
  const socket = net.connect(paths.socket('mcp')); await new Promise(resolve => socket.once('connect', resolve));
  const watcher = new Connection(socket, socket, 'tool-context'), frames: any[] = [];
  watcher.onNotification(ToolContext.changed, frame => frames.push(frame));
  assert.equal((await watcher.request(ToolContext.attach, { token })).turnId, null);
  await conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '!sleep 300\n!say FIRST' }] });
  await until('first runtime turn observed', () => frames.some(f => f.active));
  const first = (await watcher.request(ToolContext.current)).turnId;
  assert.ok(first); await idle(agentId);
  await until('runtime end observed', () => frames.some(f => !f.active && f.turns.some((t: any) => t.id === first && t.endedAt)));
  await conn.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '!sleep 300\n!say SECOND' }] });
  await until('second runtime turn observed', () => frames.some(f => f.active && f.turnId !== first));
  const second = (await watcher.request(ToolContext.current)).turnId;
  assert.notEqual(second, first); await idle(agentId);
  assert.equal(received(agentId).length, 2, 'runtime notifications never become model input');
  await assert.rejects(watcher.request('_xsb/tool-events/publish', {}), /Method not found/);
  hub.rotateBridge(session);
  await assert.rejects(watcher.request(ToolContext.current), /revoked/);
  watcher.close();
  console.log('ok 41 runtime turn identity is read-only, changes between turns, and never wakes the model');
}

let refusedId: string;
// 42. A real ACP refusal recovers the same task/receipt; persistent refusals stop after a finite attempt.
{
  const session = await create("context-refusal"),sessionId=session.id;
  refusedId=sessionId;
  await conn.request("session/set_config_option", { sessionId, configId: "model", value: "chosen" });
  const end = await prompt(sessionId, "!model\n!say RECOVERED");
  assert.equal(end.stopReason, "end_turn");
  assert.match(answered(session.agentId), /RECOVERED/);
  assert.match(answered(session.agentId), /model: chosen/);
  assert.equal(received(session.agentId).length, 1, "one user-facing insertion receipt despite retry");
  assert.equal(session.rec.contextEpoch, 2);
  const own = [...hub.state.tasks.values()].filter(t => t.to.agentId === session.agentId);
  assert.equal(own.length, 1);
  assert.equal(own[0].status, "completed");
  assert.equal(session.rec.contextRecovery, undefined);

  const permanentId = (await create("context-refusal-always")).id;
  await assert.rejects(prompt(permanentId, "!say NEVER"), /Prompt is too long/);
  await idle(hub.session(permanentId).agentId);
  const permanent = hub.session(permanentId);
  assert.equal(permanent.rec.contextEpoch, 2, "initial attempt and one retry only");
  assert.equal(permanent.rec.contextRecovery?.attempts, 1);
  assert.equal([...hub.state.tasks.values()].filter(t => t.to.agentId === permanent.agentId).length, 1);
  console.log("ok 42 context refusal recovery preserves tasks and limits retries");
}

// 43. A handoff committed before the first prompt survives a hub crash/restart and is consumed exactly once.
{
  const session = hub.session(refusedId);
  await prompt(session.id, "!say KEEP-THIS-DECISION");
  hub.backends.stop(session.agentId);
  session.save({ backendSessionId: undefined, renew: true });
  await session.ensureBackend();
  assert.ok(session.rec.contextHandoffPending);
  const pending = session.rec.contextHandoffPending;
  await hub.shutdown(); conn.close();
  hub = new Hub(project); await hub.start(); conn = await connect();
  const resumed = refusedId; await conn.request("session/resume",{sessionId:resumed});
  assert.equal(hub.session(resumed).rec.contextHandoffPending, pending);
  await prompt(resumed, "!echo\n!model");
  assert.match(answered(session.agentId), /KEEP-THIS-DECISION/);
  assert.match(said.get(resumed)!, /handoff[^]*KEEP-THIS-DECISION/);
  assert.match(said.get(resumed)!, /model: chosen/);
  assert.equal(hub.session(resumed).rec.contextHandoffPending, undefined);
  console.log("ok 43 pending handoffs and selected model survive restart");
}

// 43b. A new conversation's backend session is opened for its settings and given nothing: one that cannot be resumed
// is replaced without a boundary, keeping the settings chosen. One that was given input and cannot be resumed says so.
{
  const { sessionId } = await conn.request("session/new", { cwd: project, mcpServers: [], _meta: { [Workflow.backend]: "forgetful" } });
  const controls = await conn.request(SessionControls.get, { sessionId, discover: true });
  const agentId = hub.session(sessionId).agentId;
  assert.ok(Array.isArray(controls.configOptions) && controls.configOptions.length, "settings before the first message");
  assert.equal(hub.session(sessionId).rec.backendFresh, true);
  await conn.request("session/set_config_option", { sessionId, configId: "model", type: "id", value: "x" });
  assert.equal(hub.session(sessionId).rec.selectedConfig?.model, "x");
  const boundaries = () => hub.state.store.read(Paths.transcript(agentId, sessionId))
    .map((r: any) => r.update?._meta?.["dev.xsb/boundary"]?.kind).filter(Boolean);
  hub.backends.stop(agentId);
  await prompt(sessionId, "!say USED\n!model");
  assert.deepEqual(boundaries(), [], "nothing to hand over");
  assert.match(said.get(sessionId)!, /model: x/, "the choice made before the first message holds");
  assert.equal(hub.session(sessionId).rec.backendFresh, undefined);
  assert.equal(hub.session(sessionId).rec.conversed, true);
  hub.backends.stop(agentId);
  await prompt(sessionId, "!say AGAIN");
  assert.deepEqual(boundaries(), ["not_restored"]);
  const restoredInput = received(agentId).at(-1)!.text;
  assert.ok(!restoredInput.includes("USED"), "missing old context is not reconstructed as a handoff");
  console.log("ok 43b a new conversation's backend session, given nothing");
}

// 43c. A setting the backend no longer offers is dropped; it does not undo a resume that worked.
{
  const s = hub.session(a);
  s.save({ selectedConfig: { ...s.rec.selectedConfig, effort: "extreme" } });
  const before = s.rec.backendSessionId;
  const boundaries = hub.state.store.read(Paths.transcript(s.agentId, a)).filter((r: any) => r.update?._meta?.["dev.xsb/boundary"]).length;
  hub.backends.stop(s.agentId);
  await prompt(a, "!say AFTER-UPDATE");
  assert.equal(hub.session(a).rec.backendSessionId, before);
  assert.equal(hub.session(a).rec.selectedConfig?.effort, undefined);
  assert.equal(hub.state.store.read(Paths.transcript(s.agentId, a)).filter((r: any) => r.update?._meta?.["dev.xsb/boundary"]).length, boundaries);
  console.log("ok 43c a lost setting does not break the resume");
}

// 44. Without an ordering guarantee, even an already-attached old bridge cannot submit into a new turn.
{
  const session = await create("unisolated"),sessionId=session.id;
  await session.ensureBackend();
  const originalId = session.rec.backendSessionId, oldToken = session.bridgeToken;
  const socket = net.connect(paths.socket("mcp")); await new Promise(resolve => socket.once("connect", resolve));
  const oldBridge = new Connection(socket, socket, "old-turn-tools");
  await oldBridge.request("_xsb/attach", { token: oldToken });
  await conn.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "!sleep 5000\n!say MUST-NOT-RESUME" }] });
  conn.notify("session/cancel", { sessionId });
  await idle(session.agentId);
  assert.notEqual(session.bridgeToken, oldToken);
  assert.equal(session.rec.backendSessionId, originalId);
  await conn.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "!say NEW-TURN\n!sleep 500" }] });
  assert.equal(session.current?.started, true);
  await assert.rejects(oldBridge.request("tools/call", { name: "start_job", arguments: {} }), /bridge revoked/);
  oldBridge.close();
  await idle(session.agentId);
  assert.doesNotMatch(answered(session.agentId), /MUST-NOT-RESUME/);
  assert.match(answered(session.agentId), /NEW-TURN/);
  console.log("ok 44 unisolated stop fences old tools before the next turn");
}

// Real ACP/MCP attempts, including an old worker still inside a prompt when its
// delivery basis disappears. The independent sibling must keep the same turn.
{
  const session = await create(), id = session.id;
  const finish = (summary: string, ms = 0) => (ms ? "!sleep " + ms + "\n" : "") + call("finish",{summary,assets:[]});
  const graphJsonl = [
    {node:"A",prompt:finish("A1")},{node:"D",prompt:finish("composition",1000)},
    {node:"E",prompt:finish("music",2800)},{node:"end",kind:"end"},
    {from:"A",to:"D"},{from:"D",to:"end"},{from:"E",to:"end"}
  ].map(v => JSON.stringify(v)).join("\n");
  await prompt(id,call("plan",{graphJsonl}));
  assert.deepEqual(hub.workflows.get(id).nodes,[]);
  await prompt(id,call("execute",{}));
  const instances = () => hub.workflows.read(id).instances;
  await until("D and E have inserted old assignments",() => instances().D.work?.inserted && instances().E.work?.inserted);
  const oldD = instances().D.work!.attempt, music = instances().E.work!.attempt, dSession = instances().D.sessionId;
  await prompt(id,call("execute",{replaceNode:{node:"A",prompt:finish("A2",450)}}));
  assert.equal(instances().E.work?.attempt,music);
  assert.notEqual(instances().D.work?.attempt,oldD);
  await until("D received updated basis",() => instances().D.work?.inserted);
  assert.equal(instances().D.sessionId,dSession);
  assert.equal((instances().D.work!.assignment.predecessors as any[])[0].summary,"A2");
  await until("adopted film delivered",() => instances().end.last?.valid);
  assert.match(instances().end.last!.summary,/A2/);
  assert.doesNotMatch(instances().end.last!.summary,/A1/);
  // A user speaks to an idle node about the current delivery. Only its scope
  // pauses. A single explicit resume must clear this exact redirection.
  const paint=instances().A.sessionId!;
  await prompt(paint,call("escalate",{message:"wrong base",pauseSelf:true,invalidateSelf:true}));
  assert.equal(instances().A.replan,"wrong base");
  assert.equal(instances().A.interruptions.length,0);
  assert.equal(instances().end.last?.valid,false);
  await conn.request(Workflow.resume,{sessionId:id,nodes:["A"]});
  await until("resumed end delivered",()=>instances().end.last?.valid);
  assert.equal(instances().A.replan,undefined);
  console.log("ok workflow revisions, task chat redirection, scoped resume and unaffected siblings");
}

// Additional assignments survive losing the issuing process between receipt and
// completion. The first inserted work is resumed before the next duplicate text.
{
  const main=await create(), owner=main.id;
  const finish=call("finish",{summary:"base",assets:[]});
  const graphJsonl=[{node:"A",prompt:finish},{node:"end",kind:"end"},{from:"A",to:"end"}].map(v=>JSON.stringify(v)).join("\n");
  await prompt(owner,call("execute",{graphJsonl}));
  const state=()=>hub.workflows.read(owner);
  await until("initial result",()=>state().instances.end?.last?.valid);
  const extra={node:"A",text:"!sleep 750\n"+call("finish",{summary:"extra",assets:[]})};
  await prompt(owner,[call("prompt",extra),call("prompt",extra)].join("\n"));
  await until("first extra inserted",()=>state().instances.A.work?.inserted);
  const first=state().instances.A.work!, id=state().instances.A.sessionId!;
  assert.equal(state().instances.A.extras.length,1);
  await hub.shutdown(); conn.close();
  hub=new Hub(project); await hub.start(); conn=await connect();
  await conn.request("session/resume",{sessionId:owner});
  assert.equal(state().instances.A.work?.state,"suspended");
  assert.equal(state().instances.A.work?.id,first.id);
  await prompt(owner,"!say STATUS");
  assert.equal(state().instances.A.work?.attempt,undefined);
  await conn.request(Workflow.resume,{sessionId:owner});
  await until("first extra resumed",()=>state().instances.A.work?.inserted && state().instances.A.work?.attempt);
  assert.notEqual(state().instances.A.work?.attempt,first.attempt);
  assert.equal(state().instances.A.sessionId,id);
  const returned=()=>received(main.agentId).filter(i=>i.text.startsWith('{"additionalResult":"A"'));
  await until("two additional deliveries in the ledger",()=>state().instances.A.additionalResults?.length === 2);
  assert.equal(returned().length, 0, "additional calls do not prompt results to their caller");
  const deliveries = state().instances.A.additionalResults!;
  assert.notEqual(deliveries[0].id, deliveries[1].id);
  assert.equal(state().instances.A.extras.length,0);
  assert.equal(state().instances.A.work,undefined);
  assert.equal(state().instances.A.last!.summary,"base");
  console.log("ok additional results persist across restart without return prompts");

  await idle(main.agentId);
  const busy = prompt(owner,call("prompt",{node:"A",text:finish})+"\n!sleep 1200");
  await until("additional result stored while caller is busy",() => state().instances.A.additionalResults?.length === 3);
  assert.ok(!state().outbox.some(n => n.text.includes("additionalResult")));
  await busy;
  assert.equal(returned().length, 0);
  console.log("ok additional completion does not queue a return prompt behind a busy caller");
}

// Queue controls cross the real ACP connection, preserving the unresolved head.
{
  const session = await create();
  const running = prompt(session.id, "!sleep 2500\n!say USER-WORK");
  await until("protected turn for queue controls", () => session.current?.inserted);
  const one = dispatch(hub.session(a), session.agentId, { title: "queued first", topic: "queue", instructions: "!say FIRST-QUEUE", after: [] });
  const two = dispatch(hub.session(a), session.agentId, { title: "queued second", topic: "queue", instructions: "!say MUST-NOT-SEND", after: [] });
  const idOf = (task: Task) => [...hub.state.mail.values()].find(m => m.taskId === task.id)?.id;
  const first = await until("first queued message", () => idOf(one));
  const second = await until("second queued message", () => idOf(two));
  const queueView = (id: string) => hub.state.store.read(Paths.transcript(session.agentId, session.id))
    .map(r => r.update?._meta?.[MessageDelivery.key]).filter(v => v?.messageId === id).at(-1);
  await until("head control published", () => queueView(first)?.canSendNow);
  const turnId = session.current!.id;
  await assert.rejects(conn.request(MessageDelivery.sendNow, { sessionId: session.id, messageId: second, targetTurnId: turnId }), /queue head/);
  await conn.request(MessageDelivery.sendNow, { sessionId: session.id, messageId: first, targetTurnId: turnId });
  assert.equal(queueView(second)?.isHead, false);
  await assert.rejects(conn.request(MessageDelivery.cancel, { sessionId: session.id, messageId: first }), /no longer queued/);
  await conn.request(MessageDelivery.cancel, { sessionId: session.id, messageId: second });
  await until("queued cancellation committed", () => hub.state.tasks.get(two.id)?.status === "cancelled");
  await running;
  await until("first queued input inserted", () => hub.state.ledger.get(first)?.state === "inserted");
  assert.ok(!received(session.agentId).some(i => i.text.includes("MUST-NOT-SEND")));
  console.log("ok queue head send-now and cancellation over ACP v2");
}

await hub.shutdown();
fs.rmSync(project, { recursive: true, force: true });
console.log("e2e: ok");
process.exit(0);
