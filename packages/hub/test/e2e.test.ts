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
import { Agents, Assets, Backends, Boundaries, Connection, Discarded, Ledger, TurnFailure, LANGUAGES, LanguageExt, OriginExt, PROTOCOL_VERSION, Roles, Tasks, Teams, explain, languageOf } from "@xsb/protocol";
import type { Language, Task } from "@xsb/protocol";
import { Hub } from "../src/hub.ts";
import { isVeto } from "../src/hooks.ts";
import { isTerminal as isTerminalStatus } from "@xsb/protocol";
import { USER, agentPrincipal } from "../src/kernel.ts";
import type { LiveSession } from "../src/session.ts";
import { bridgeServer } from "../src/mcp.ts";
import { callTool } from "../src/tools.ts";
import { Paths } from "../src/paths.ts";
import { loadProjectConfig, saveProjectConfig } from "../src/config.ts";
import { readRole } from "../src/roles.ts";
import { catalog, teamRole } from "../src/presets.ts";
import { setTimeout as sleep } from "node:timers/promises";

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
      steerable: { command: node, args: [MOCK, "--steering"] },
      codexlike: { command: node, args: [MOCK, "--steer-ext"] },
      old: { command: node, args: [MOCK, "--protocol", "1"] },
      bare: { command: node, args: [MOCK, "--no-system-prompt"] },
      "signed-out": { command: node, args: [MOCK, "--auth-required"] },
      "from-the-future": { command: node, args: [MOCK, "--protocol", "9"] },
      forgetful: { command: node, args: [MOCK, "--no-resume"] },
      crashing: { command: node, args: ["-e", "console.error('license expired'); process.exit(3)"] },
      missing: { command: "xsb-no-such-command" },
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
/** Role changes the hub announced: the role's name and description, or its name alone once removed. */
const roleEvents: string[] = [];
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
  conn.onNotification(Roles.update, ({ role }) => roleEvents.push(`${role.name}: ${role.description}`));
  conn.onNotification(Assets.update, ({ asset }) => assetEvents.push(`${asset.id}@${asset.version}`));
  conn.onNotification(Roles.removed, ({ name }) => roleEvents.push(name));
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
const newSession = async (agentId: string): Promise<string> =>
  (await conn.request("session/new", { cwd: project, mcpServers: [], _meta: { [Agents.sessionKey]: agentId } })).sessionId;
const call = (tool: string, args: unknown): string => `!call ${tool} ${JSON.stringify(args)}`;
/** What the tools do, called directly: as the session `from`. */
const addr = (s: LiveSession) => ({ agentId: s.agentId, sessionId: s.id });
const dispatch = (from: LiveSession, to: string, input: { title: string; topic: string; instructions: string; after: string[] }): Task => {
  const task = hub.kernel.dispatch(addr(from), { agentId: to, sessionId: hub.mainSession(to).id }, { deliveryPref: "wake", ...input });
  assert.ok(!isVeto(task));
  return task;
};
/** The dispatcher (an agent) cancels a task. */
const cancel = (task: Task, by = task.from!.agentId) => {
  const stopped = hub.kernel.stop(task, agentPrincipal(by), { status: "cancelled", reason: "cancelled", result: "Cancelled by the dispatcher." });
  assert.ok(!isVeto(stopped));
  return stopped;
};
const tasks = async (): Promise<Task[]> => (await conn.request(Tasks.list, {})).tasks;
const idle = (agentId: string) =>
  until(`${agentId} idle`, async () =>
    (await conn.request(Agents.list)).agents.find((a: any) => a.id === agentId).state === "idle",
  );

// a leads: its role's team policy lets it dispatch to and message anyone in every task it does (capabilities.ts).
await conn.request(Roles.put, { role: { name: "lead", description: "leads the team", grants: ["dispatch", "message"] } });
for (const [id, backend] of [["a", "mock"], ["b", "mock"], ["c", "steerable"], ["d", "bare"]]) {
  await conn.request(Agents.put, { agent: { id, backend, description: `agent ${id}`, ...(id === "a" ? { role: "lead" } : {}) }, instructions: `You are ${id}.` });
}
const a = await newSession("a");

// 1. A plain turn. Without `_meta` a client reaches the default (first) agent.
{
  const plain = (await conn.request("session/new", { cwd: project, mcpServers: [] })).sessionId;
  assert.equal((await prompt(plain, "hello")).stopReason, "end_turn");
  assert.match(said.get(plain)!, /echo: hello/);
  console.log("ok 1 plain turn");
}

// 2. Dispatch returns at once; the result is what the peer says last (implicit completion), and comes back as asked:
// waking the dispatcher, marked with its origin; or, by default, lazily, with the dispatcher's next turn.
{
  await prompt(a, `!call dispatch_task {"deliveryPref":"wake","to":"b","title":"key light","instructions":"!say WARM-KEY","topic":"scene 3 lighting"}`);
  assert.match(said.get(a)!, /"status": "dispatched"/);
  const result = await until("task result in a", () => inputs.get(a)?.find((i) => i.text.includes("<xsb-task-result")));
  assert.match(result.text, /by="b"[^>]*status="completed">\nWARM-KEY/);
  assert.deepEqual([result.origin.kind, result.origin.agentId, result.origin.role], ["agent", "b", "task_result"]);
  const keyLight = (await tasks()).find((t) => t.title === "key light")!;
  assert.deepEqual(keyLight.ended, { reason: "completed", stopper: { kind: "agent", agentId: "b" } });
  await idle("a");

  await prompt(a, `!call dispatch_task {"to":"b","title":"fill light","instructions":"!say SOFT-FILL","topic":"scene 3 lighting"}`);
  const fill = await until("fill done", async () => (await tasks()).find((t) => t.title === "fill light" && t.status === "completed"));
  const kept = await until("kept in the inbox", () => [...hub.state.mail.values()].find((m) => m.results?.taskIds[0] === fill.id && hub.state.ledger.get(m.id)?.state === "inboxed"));
  await sleep(200);
  assert.ok(!inputs.get(a)!.some((i) => i.text.includes('title="fill light"')), "lazy: nobody woken");
  said.set(a, "");
  await prompt(a, "next");
  assert.match(said.get(a)!, /this notification came for you[^]*title="fill light"[^]*SOFT-FILL/);
  await until("seen", () => hub.state.ledger.get(kept.id)?.state === "seen");
  await idle("a");
  console.log("ok 2 dispatch and result");
}

// 3. A gate: results of several tasks arrive together, and meanwhile the user's message is an ordinary turn.
{
  const before = inputs.get(a)!.length;
  await prompt(
    a,
    [
      `!call dispatch_task {"deliveryPref":"wake","to":"b","title":"t-b","instructions":"!sleep 1500\\n!done B-DONE","topic":"gate"}`,
      `!call dispatch_task {"deliveryPref":"wake","to":"c","title":"t-c","instructions":"!done C-DONE","topic":"gate"}`,
      `!await {"mode":"all","note":"merge both"}`,
    ].join("\n"),
  );
  assert.match(said.get(a)!, /Subscribed \(\d\/2 finished\)/);
  // The finished half of a join is not readable early; it would arrive twice.
  const early = (await until("t-c done", async () => (await tasks()).find((t) => t.title === "t-c" && t.status === "completed"))).id;
  await prompt(a, `!call task_status {"task_id":"${early}"}`);
  assert.match(said.get(a)!, /"result_delivery": "Held for your subscription/);
  assert.doesNotMatch(said.get(a)!, /"result": "C-DONE/);
  const reply = await prompt(a, "are you there?");
  assert.equal(reply.stopReason, "end_turn");
  assert.match(said.get(a)!, /echo: are you there\?/);
  const together = await until("joined results", () => inputs.get(a)!.find((i) => i.text.includes("<xsb-task-results")));
  assert.match(together.text, /B-DONE/);
  assert.match(together.text, /C-DONE/);
  assert.match(together.text, /merge both/);
  assert.equal(together.origin.kind, "system");
  // c finished long before b, yet nothing arrived on its own.
  const fresh = inputs.get(a)!.slice(before).filter((i) => i.origin.kind !== "user");
  assert.equal(fresh.length, 1, "exactly one delivery for the gate");
  await idle("a");
  console.log("ok 3 gate, user turn while waiting");
}

// 4. A task held back until another finished receives that task's result.
{
  await prompt(
    a,
    [
      `!call dispatch_task {"deliveryPref":"wake","to":"b","title":"script","instructions":"!sleep 300\\n!done SCRIPT-V1","topic":"dep"}`,
      `!call dispatch_task {"deliveryPref":"wake","to":"c","title":"storyboard","instructions":"!done DRAWN","topic":"dep","after":["$last"]}`,
    ].join("\n"),
  );
  const held = (await tasks()).find((t) => t.title === "storyboard")!;
  assert.equal(held.status, "blocked");
  const done = await until("storyboard done", async () => (await tasks()).find((t) => t.title === "storyboard" && t.status === "completed"));
  assert.equal(done.result, "DRAWN");
  assert.match(received("c").find((i) => i.text.includes('title="storyboard"'))!.text, /This task was held until[^]*SCRIPT-V1/);
  await until("both results in a", () => inputs.get(a)!.filter((i) => i.text.includes('topic="dep"')).length === 2);
  await idle("a");
  console.log("ok 4 dependency");
}

// 5. The user's word never waits. To a backend that holds what comes while it works (as codex does), it goes in when
// the work it does is done, and the turn goes on with it: one turn, answered when the message is inserted.
{
  const turn = prompt(a, "!sleep 600\n!say FIRST");
  await until("a running", () => hub.session(a).current?.started);
  const second = conn.turn(a, "!say SECOND");
  assert.equal((await turn).stopReason, "end_turn");
  assert.equal((await second).stopReason, "end_turn");
  assert.match(said.get(a)!, /FIRST\n[^]*SECOND/);
  const steered = received("a").find((i) => i.text === "!say SECOND")!;
  assert.equal(steered.origin.steered, true);
  console.log("ok 5 the user's word into held work");
}

// 6. To a backend that steers (as claude does), it goes in at once, and the work goes on with it.
{
  const c = await newSession("c");
  const turn = prompt(c, "!sleep 400\n!say END");
  await until("c running", () => hub.session(c).current?.started);
  await conn.request("session/prompt", { sessionId: c, prompt: [{ type: "text", text: "!say MID" }] });
  assert.equal((await turn).stopReason, "end_turn");
  assert.match(said.get(c)!, /MID\nEND/);
  console.log("ok 6 the user's word steered in");
}

// 7. Only the user's word goes into a peer's running work. An agent's waits, unseen, for the turn to end, even from
// whoever gave the peer that work; to change that work, its dispatcher replaces it with a new task (onBusy "replace").
{
  await prompt(a, call("dispatch_task", { deliveryPref: "wake", to: "c", title: "long take", instructions: "!sleep 750\n!done LONG", topic: "interject" }));
  await until("c at work", () => (hub.mainSession("c").current?.inserted ? hub.mainSession("c") : undefined));
  said.set(a, "");
  await prompt(a, call("send_message", { to: "c", content: "plan changed", topic: "interject" }));
  assert.match(said.get(a)!, /"delivery": "queued behind the peer's current work"/);
  assert.match(said.get(a)!, /"warning": "c is at work on t_\w+ \\"long take\\" of yours, and sees this message only once that is done\. To change what it does, dispatch_task the new instructions with onBusy \\"replace\\"\."/);
  assert.ok(!received("c").some((i) => i.text.includes("plan changed")));
  const later = await until("read after the turn", () => received("c").find((i) => i.text.includes("plan changed")));
  assert.notEqual(later.origin.steered, true);
  await until("the work done, not interrupted", async () => (await tasks()).find((t) => t.title === "long take" && t.status === "completed" && t.result === "LONG"));
  await idle("c");

  // A second task of the same dispatcher waits behind the first, and both are done.
  await prompt(a, call("dispatch_task", { deliveryPref: "wake", to: "b", title: "take 1", instructions: "!sleep 400\n!done TAKE-1", topic: "interject" }));
  await until("b at work", () => (hub.mainSession("b").current?.inserted ? hub.mainSession("b") : undefined));
  said.set(a, "");
  await prompt(a, call("dispatch_task", { deliveryPref: "wake", to: "b", title: "take 2", instructions: "!done TAKE-2", topic: "interject" }));
  assert.match(said.get(a)!, /queued: b is at work on t_\w+ \\"take 1\\" of yours/);
  await until("both done", async () => (await tasks()).filter((t) => ["take 1", "take 2"].includes(t.title) && t.status === "completed").length === 2);
  await idle("b");

  // Replaced: the work is stopped and ends as superseded; the new task runs; the dispatcher is told of nothing.
  await prompt(a, call("dispatch_task", { deliveryPref: "wake", to: "b", title: "old cut", instructions: "!sleep 2500\n!done OLD", topic: "interject" }));
  await until("b at work again", () => (hub.mainSession("b").current?.inserted ? hub.mainSession("b") : undefined));
  said.set(a, "");
  await prompt(a, call("dispatch_task", { deliveryPref: "wake", to: "b", title: "new cut", instructions: "!done NEW", topic: "interject", onBusy: "replace", target_turn_id: hub.mainSession("b").current!.id }));
  assert.match(said.get(a)!, /it replaces t_\w+ \\"old cut\\"/);
  const old = await until("old cut superseded", async () => (await tasks()).find((t) => t.title === "old cut" && t.status === "cancelled"));
  assert.deepEqual(old.ended, { reason: "superseded", stopper: { kind: "agent", agentId: "a" } });
  await until("new cut done", async () => (await tasks()).find((t) => t.title === "new cut" && t.status === "completed" && t.result === "NEW"));
  await idle("b");
  await idle("a");
  assert.ok(!received("a").some((i) => i.text.includes(old.id)), "its dispatcher replaced it, and is not told");
  await idle("c");
  console.log("ok 7 only the user interjects; agents queue or replace");
}

// 8. Memory: the hub knows who handled a topic, the agent keeps notes, both survive.
{
  await prompt(a, `!call send_message {"to":"c","content":"dim the key","topic":"Scene 3 Lighting"}`);
  assert.match(said.get(a)!, /has so far been handled with b \(\d+x/);
  await prompt(a, `!call remember {"topic":"scene 3 lighting","content":"warm key, owner b"}`);
  await prompt(a, `!call recall {"query":"scene 3"}`);
  assert.match(said.get(a)!, /"content": "warm key, owner b"/);
  await prompt(a, `!call list_agents {}`);
  assert.match(said.get(a)!, /"topics_with_you": \[\s*"scene 3 lighting"/);
  await idle("c");
  // b has no role that lets it work with others (docs/KERNEL.md 8). It is listed every tool all the same; what its role
  // is not allowed is put to the user: rejected, the call says so; allowed always, the project's config keeps it, and
  // the user is not asked again.
  const bs = await newSession("b");
  await prompt(bs, "!tools");
  assert.match(said.get(bs)!, /tools: [^\n]*dispatch_task[^\n]*list_agents[^\n]*send_message[^\n]*escalate_to_user/);
  const asked = permissionAsked;
  permissionChoice = "no";
  await prompt(bs, call("send_message", { to: "c", content: "hello" }));
  assert.equal(permissionAsked, asked + 1);
  assert.match(said.get(bs)!, /the user did not allow you to send a message to c\./);
  permissionChoice = "always";
  said.set(bs, "");
  await prompt(bs, call("send_message", { to: "c", content: "hello" }));
  assert.match(said.get(bs)!, /"delivery": /);
  assert.deepEqual(loadProjectConfig(paths).permissions, { "agent:b": { message: ["agent:c"] } });
  permissionChoice = undefined;
  await prompt(bs, call("send_message", { to: "c", content: "hello again" }));
  assert.equal(permissionAsked, asked + 2, "allowed always: not asked again");
  await idle("c");
  console.log("ok 8 memory and continuity, and what a role may");
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
  const own = (await script.request("session/new", { cwd: project, mcpServers: [], _meta: { [Agents.sessionKey]: "b" } })).sessionId;
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

// 10. A backend without the system prompt capability gets its instructions on the first prompt.
{
  const d = await newSession("d");
  await prompt(d, "hi");
  assert.match(said.get(d)!, /echo: \[xsb\] Your standing instructions.*<xsb-instructions> \| # Who you are.*You are d\..*<\/xsb-instructions> \| hi$/m);
  said.set(d, "");
  await prompt(d, "again");
  assert.equal(said.get(d), "echo: again\n");
  console.log("ok 10 instructions without capability");
}

// 11. Restart: state is rebuilt from the logs, history replays, unfinished work runs again.
{
  await prompt(a, `!call dispatch_task {"deliveryPref":"wake","to":"b","title":"survivor","instructions":"!sleep 600\\n!done AGAIN","topic":"restart"}`);
  await until("survivor running", async () => (await tasks()).find((t) => t.title === "survivor" && t.status === "running"));
  await hub.shutdown();
  hub = new Hub(project);
  await hub.start();
  conn = await connect();

  const { agents } = await conn.request(Agents.list);
  assert.deepEqual(agents.map((x: any) => x.id), ["a", "b", "c", "d"]);
  inputs.delete(a);
  await conn.request("session/resume", { sessionId: a, cwd: project, mcpServers: [], replayFrom: { type: "start" } });
  assert.ok(inputs.get(a)!.some((i) => i.text.includes("are you there?")), "history replayed");
  const survivor = await until("survivor completed", async () => (await tasks()).find((t) => t.title === "survivor" && t.status === "completed"));
  assert.match(survivor.result!, /AGAIN/);
  await until("result reached a after restart", () => inputs.get(a)!.some((i) => i.text.includes("AGAIN")));
  await prompt(a, `!call recall {"query":"scene 3"}`);
  assert.match(said.get(a)!.split("result(recall)").at(-1)!, /warm key, owner b[\s\S]*"agent": "b"/);
  console.log("ok 11 restart");
}

// 12. Backend failures carry a code and a reason, and name the agent.
{
  const fails = async (backend: string, code: number, reason: string, message: RegExp, turn = false): Promise<void> => {
    let error: any;
    try {
      if (backend === "nowhere") await conn.request(Agents.put, { agent: { id: "x", backend } });
      else {
        await conn.request(Agents.put, { agent: { id: `x-${backend}`, backend } });
        const sid = await newSession(`x-${backend}`);
        if (turn) await prompt(sid, "hi");
      }
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
  await fails("signed-out", -32000, "auth_required", /agent "x-signed-out".*not signed in.*Log in with the mock CLI/, true);
  console.log("ok 12 error codes");
}

// 13. A dispatcher can cancel a task. It ends at once, as "cancelled", and no result comes back: the dispatcher knows.
{
  await idle("a");
  await prompt(
    a,
    [
      `!call dispatch_task {"deliveryPref":"wake","to":"b","title":"first","instructions":"!sleep 300\\n!done FIRST","topic":"cancel"}`,
      `!call dispatch_task {"deliveryPref":"wake","to":"b","title":"second","instructions":"!say NEVER","topic":"cancel"}`,
      `!call cancel_task {"task_id":"$last"}`,
    ].join("\n"),
  );
  assert.match(said.get(a)!, /Task t_\w+ cancelled\./);
  const result = (title: string) =>
    until(`result of ${title}`, () => inputs.get(a)!.find((i) => i.text.includes(`title="${title}"`) && i.text.includes("<xsb-task-result")));
  assert.match((await result("first")).text, /status="completed">\nFIRST/);
  await idle("a");
  assert.equal((await tasks()).find((t) => t.title === "second")!.status, "cancelled");
  assert.ok(!inputs.get(a)!.some((i) => i.text.includes('title="second"') && i.text.includes("<xsb-task-result")));
  console.log("ok 13 cancel a task");
}

// 14. An agent without ACP, wrapped with @xsb/adapter, goes through the same chain as the others.
{
  await conn.request(Agents.put, { agent: { id: "e", backend: "wrapped", description: "agent e" }, instructions: "You are e." });
  const e = await newSession("e");
  await prompt(e, "hello");
  assert.match(said.get(e)!, /third party \(instructed\) heard: hello/);

  // It has no steering of its own: the wrapper holds what comes while it works, and gives it after, in the same turn.
  const turn = prompt(e, "wait 600");
  await until("e running", () => hub.session(e).current?.started);
  const more = conn.turn(e, "change of plan");
  assert.equal((await turn).stopReason, "end_turn");
  await more;
  assert.match(said.get(e)!, /heard: wait 600\n[^]*heard: change of plan/);

  // And it is a peer like the others: it is given tasks. It uses no tools, and needs none: its turn's end ends the
  // task, and what it said last is the result (implicit completion).
  await prompt(a, `!call dispatch_task {"deliveryPref":"wake","to":"e","title":"wrapped work","instructions":"do the thing","topic":"wrapped"}`);
  const result = await until("a has e's result", () => inputs.get(a)!.find((i) => i.text.includes('title="wrapped work"') && i.text.includes("<xsb-task-result")));
  assert.match(result.text, /status="completed">\nthird party \(instructed\) heard: <xsb-task[^]*do the thing/);
  await idle("a");

  // Cancelled while e works on it: the work e does only for it is stopped, and the task is recorded as cancelled once
  // e stopped; its dispatcher stopped it and is told nothing.
  await prompt(a, `!call dispatch_task {"deliveryPref":"wake","to":"e","title":"slow wrapped","instructions":"wait 5000","topic":"wrapped"}`);
  const slow = await until("slow running", async () => (await tasks()).find((t) => t.title === "slow wrapped" && t.status === "running"));
  const started = Date.now();
  said.set(a, "");
  await prompt(a, `!call cancel_task {"task_id":"${slow.id}"}`);
  assert.match(said.get(a)!, new RegExp(`Task ${slow.id} is being stopped`));
  const stopped = await until("recorded", async () => (await tasks()).find((t) => t.id === slow.id && t.status === "cancelled"));
  assert.ok(Date.now() - started < 4000, "e's turn was stopped, not waited for");
  assert.deepEqual(stopped.ended, { reason: "cancelled", stopper: { kind: "agent", agentId: "a" } });
  await idle("e");
  await idle("a");
  assert.ok(!inputs.get(a)!.some((i) => i.text.includes(`task-id="${slow.id}"`)), "a stopped it and is not told");
  console.log("ok 14 wrapped third-party agent");
}

// 15. A role gives its agents their instructions, their MCP servers and their skills.
const roleDir = paths.roleDir("painter");
fs.mkdirSync(path.join(roleDir, "skills", "shots"), { recursive: true });
fs.mkdirSync(path.join(roleDir, "skills", "grading"));
fs.writeFileSync(
  path.join(roleDir, "role.json"),
  JSON.stringify({
    description: "paints shots",
    backend: "bare",
    mcpServers: { gen: { command: node, args: [GENERATOR], env: { GEN_KEY: "k1" } } },
  }),
);
fs.writeFileSync(path.join(roleDir, "instructions.md"), "ROLE-RULES: keep to the house style.");
fs.writeFileSync(
  path.join(roleDir, "skills", "shots", "SKILL.md"),
  "---\ndescription: How to break a scene into shots\nproduces: shot_list\ninputs: character, script\n---\nSHOT-PROCEDURE: one line per shot.",
);
fs.writeFileSync(path.join(roleDir, "skills", "grading", "SKILL.md"), "# Grading a shot\nGRADE-PROCEDURE: match the reference.");
const { agent: painter } = await conn.request(Agents.put, { agent: { id: "p1", role: "painter" }, instructions: "You are p1." });
const p = await newSession("p1");
{
  // What the role says of a new agent: its description, its backend, where it works.
  assert.deepEqual([painter.role, painter.backend, painter.description, painter.workspace], ["painter", "bare", "paints shots", project]);
  await assert.rejects(conn.request(Agents.put, { agent: { id: "p2", role: "nope" } }), /no role "nope" \(roles: lead, painter\)/);

  await prompt(p, "hi");
  const first = said.get(p)!;
  assert.match(first, /ROLE-RULES: keep to the house style\..*You are p1\./);
  assert.match(first, /- grading: Grading a shot.*- shots: How to break a scene into shots \(arrives with tasks that produce "shot_list"\)/);
  await prompt(p, "!servers");
  assert.match(said.get(p)!, /servers: team, gen\n/);
  // Where each tool comes from is in the system prompt: the servers it was given, and that every other tool is the agent program's own.
  const shown = (await conn.request(Agents.get, { id: "p1" })).systemPrompt;
  assert.match(shown, /# Where your tools come from\n[^#]*- team: the hub of this team[^#]*- gen: your role's\.[^#]*comes with the agent program itself/);
  assert.doesNotMatch(shown, /- browser:/);
  process.env.XSB_MCP_SERVERS = JSON.stringify({ browser: { command: "xsb-browser-mcp", about: "The side-panel browser; IAB means this one." } });
  // What the provider of a server says of it stands next to its name: agents choose between tools of several sources by it.
  assert.match((await conn.request(Agents.get, { id: "p1" })).systemPrompt, /- browser: given to every agent by the app the user runs xsb in\. The side-panel browser; IAB means this one\./);
  delete process.env.XSB_MCP_SERVERS;
  assert.match(shown, /# How you work\n- Say how you checked\./);
  await prompt(p, call("load_skill", { name: "grading" }));
  assert.match(said.get(p)!, /GRADE-PROCEDURE/);
  // An agent that waits for the user says so, and the observers hear of it.
  await prompt(p, call("escalate_to_user", { question: "Which cast?" }));
  assert.match(said.get(p)!, /End your turn now/);
  await until("ask announced", () => asks.includes("p1: Which cast?"));

  // The team is what the roles of its agents declare: every agent is told who makes what from what.
  assert.match(first, /# The team .* - shot_list: you, from character, script \|/);
  const { systemPrompt: told } = await conn.request(Agents.get, { id: "a" });
  assert.match(told, /\n- shot_list: p1, from character, script\n/);
  await prompt(a, call("list_agents", {}));
  assert.match(said.get(a)!.split("result(list_agents)").at(-1)!, /"id": "p1",[\s\S]*?"produces": \[\s*"shot_list"\s*\]/);
  console.log("ok 15 roles");
}

// 16. A job: a slow tool call runs in the background and its result comes back like a task's.
{
  const job = (title: string, prompt: string, ms: number) =>
    call("start_job", { server: "gen", tool: "render", arguments: { prompt, ms }, title, topic: "jobs" });
  const resultOf = (title: string) =>
    until(`result of ${title}`, () => inputs.get(p)?.find((i) => i.text.includes(`title="${title}"`)));

  await prompt(p, job("shot 1", "sunset", 400));
  assert.match(said.get(p)!, /"status": "started/);
  assert.ok(!inputs.get(p)?.some((i) => i.text.includes('title="shot 1"')), "the turn ended before the tool did");
  const done = await resultOf("shot 1");
  assert.match(done.text, /by="gen\/render"[^>]*status="completed">\nrendered: sunset \(key k1\)/);
  assert.equal(done.origin.kind, "system");

  await prompt(p, job("shot 2", "fail", 0));
  assert.match((await resultOf("shot 2")).text, /status="failed">\nthe renderer refused/);
  await prompt(p, [job("shot 3", "never", 5000), call("cancel_task", { task_id: "$last" })].join("\n"));
  // Cancelling is asked of the tool itself, and what it says became of the call is the result, kept for get_task.
  const shot3 = await until("shot 3 called off", async () => (await tasks()).find((t) => t.title === "shot 3" && t.status === "cancelled"));
  assert.match(shot3.result!, /^Cancelled by the dispatcher\. render of never was called off and is not billed/);
  assert.ok(!inputs.get(p)!.some((i) => i.text.includes('title="shot 3"')), "no result comes back for it");
  await prompt(p, call("start_job", { server: "nope", tool: "render", title: "x" }));
  assert.match(said.get(p)!, /your role has no MCP server "nope"/);
  await idle("p1");
  console.log("ok 16 jobs");
}

// 17. Assets: one library, ids and versions; a task says what it works from and what it must deliver.
{
  await prompt(a, call("put_asset", { type: "character", name: "lin", description: "the lead", content: "LIN: red coat" }));
  assert.match(said.get(a)!, /"id": "character\/lin",\s*"version": 1/);

  const work = [
    call("put_asset", { type: "shot_list", name: "scene-1", description: "shots of scene 1", content: "SHOT A" }),
    call("report_result", { task_id: "$task", result: "SHOTS-DONE", assets: ["shot_list/scene-1"] }),
  ];
  await prompt(
    a,
    call("dispatch_task", { deliveryPref: "wake", to: "p1", title: "shots", instructions: work.join("\n"), topic: "scene 1", inputs: ["character/lin"], produces: "shot_list" }),
  );
  const given = await until("task in p1", () => received("p1").find((i) => i.text.includes('title="shots"')));
  assert.match(given.text, /<xsb-asset id="character\/lin" version="1" by="a"[^>]*>\nthe lead\n---\nLIN: red coat/);
  assert.match(given.text, /has to produce a "shot_list" asset/);
  assert.match(given.text, /<xsb-skill name="shots">\n[\s\S]*SHOT-PROCEDURE/);
  // The dispatcher is told what the contract asks for and the task did not come with.
  assert.match(said.get(a)!, /p1\\" produces \\"shot_list\\" from character, script, but `inputs` has no script asset/);
  const delivered = await until("shots result", () => inputs.get(a)!.find((i) => i.text.includes('title="shots"')));
  assert.match(delivered.text, /status="completed">\nSHOTS-DONE\nAssets it delivered:\n<xsb-asset id="shot_list\/scene-1" version="1" by="p1"/);

  // The contract is checked by the hub: a task that has to produce a type is not completed without it, only failed.
  const nothing = ["!done nothing made", call("report_result", { task_id: "$task", result: "no board: nothing to draw from", failed: true })];
  await prompt(a, call("dispatch_task", { deliveryPref: "wake", to: "p1", title: "board", instructions: nothing.join("\n"), topic: "scene 1", produces: "storyboard" }));
  const empty = await until("board result", () => inputs.get(a)!.find((i) => i.text.includes('title="board"')));
  assert.match(empty.text, /status="failed">\nno board: nothing to draw from/);
  assert.match(answered("p1"), /task t_\w+ has to produce a "storyboard" asset: register it with put_asset and name it in "assets"/);
  assert.match(said.get(a)!, /p1\\" has no procedure for producing \\"storyboard\\" and works without one\. Nobody on this team has one/);
  await prompt(a, call("dispatch_task", { deliveryPref: "wake", to: "b", title: "shots by b", instructions: call("report_result", { task_id: "$task", result: "no", failed: true }), topic: "scene 1b", produces: "shot_list" }));
  assert.match(said.get(a)!, /b\\" has no procedure for producing \\"shot_list\\" and works without one\. On this team it is produced by: p1\./);
  await until("shots by b result", () => inputs.get(a)!.find((i) => i.text.includes('title="shots by b"')));
  // (a reads that result in a turn of its own: what the user says now is the next.)
  await idle("a");
  await prompt(a, call("dispatch_task", { deliveryPref: "wake", to: "p1", title: "x", instructions: "x", inputs: ["character/nobody"] }));
  assert.match(said.get(a)!, /no asset "character\/nobody"/);

  // A changed definition is a new version of the same id; a file is copied into the library.
  await prompt(a, call("put_asset", { type: "character", name: "lin", description: "the lead", content: "LIN: blue coat" }));
  await prompt(a, call("get_asset", { id: "character/lin@1" }));
  assert.match(said.get(a)!.split("result(get_asset)").at(-1)!, /red coat/);
  await prompt(a, call("get_asset", { id: "character/lin" }));
  assert.match(said.get(a)!.split("result(get_asset)").at(-1)!, /version="2"[\s\S]*blue coat/);
  fs.writeFileSync(path.join(project, "frame.png"), "PNG");
  await prompt(a, call("put_asset", { type: "image", name: "frame-1", description: "first frame", path: "frame.png" }));
  const { assets } = await conn.request(Assets.list, {});
  assert.deepEqual(assets.map((x: any) => `${x.id}@${x.version}`), ["character/lin@2", "shot_list/scene-1@1", "image/frame-1@1"]);
  // Observers heard of every version as it was registered.
  assert.deepEqual(assetEvents, ["character/lin@1", "shot_list/scene-1@1", "character/lin@2", "image/frame-1@1"]);
  assert.equal(fs.readFileSync(assets[2].path, "utf8"), "PNG");
  assert.ok(assets[2].path.startsWith(paths.assets) && assets[2].path.endsWith("v1.png"));

  // A task that awaits a job of its own stays open, and is finished in the turn the job's result starts.
  const then = [
    call("put_asset", { type: "shot", name: "s1", description: "the take", content: "TAKE" }),
    call("report_result", { task_id: "$task", result: "TAKE-DONE", assets: ["shot/s1"] }),
  ];
  const take = [
    call("start_job", { server: "gen", tool: "render", arguments: { prompt: "dawn", ms: 500 }, title: "take 1" }),
    `!await ${JSON.stringify({ note: `\n${then.join("\n")}` })}`,
  ];
  await prompt(a, call("dispatch_task", { deliveryPref: "wake", to: "p1", title: "render", instructions: take.join("\n"), topic: "scene 1", produces: "shot" }));
  await until("p1 waiting", () => answered("p1").includes("result(subscribe): Subscribed"));
  await idle("p1");
  assert.equal((await tasks()).find((t) => t.title === "render")!.status, "running");
  assert.ok(!inputs.get(a)!.some((i) => i.text.includes('title="render"')), "no result while the task waits");
  const rendered = await until("render result", () => inputs.get(a)!.find((i) => i.text.includes('title="render"')));
  assert.match(rendered.text, /status="completed">\nTAKE-DONE\nAssets it delivered:\n<xsb-asset id="shot\/s1" version="1" by="p1"/);

  // Cancelling a task ends it at once, and with it what its assignee started while it had it (the hub knows that
  // without being told). The assignee is told once, with all of it; the dispatcher is told nothing.
  const slow = [call("start_job", { server: "gen", tool: "render", arguments: { prompt: "dusk", ms: 1500 }, title: "take 2" }), "!await {}"];
  await prompt(a, call("dispatch_task", { deliveryPref: "wake", to: "p1", title: "render again", instructions: slow.join("\n"), topic: "scene 1" }));
  const waiting = await until("p1 waiting again", async () => (await tasks()).find((t) => t.title === "take 2" && t.status === "running"));
  await idle("p1");
  const again = (await tasks()).find((t) => t.title === "render again")!;
  assert.deepEqual(waiting.parents, [again.id]);
  await prompt(a, call("cancel_task", { task_id: again.id }));
  assert.match(said.get(a)!, new RegExp(`Task ${again.id} cancelled\\. Stopped with it, as started for it: ${waiting.id} "take 2"\\.`));
  assert.equal(hub.state.tasks.get(again.id)!.status, "cancelled");
  // p1 is idle, waiting: it is notified to its inbox, and reads it with its next turn there.
  const told = await until("p1 told", () => [...hub.state.mail.values()].find((m) => m.to.agentId === "p1" && m.content?.includes(`a cancelled the task "render again" (${again.id}). Stop working on it`)));
  await until("inboxed", () => hub.state.ledger.get(told.id)?.state === "inboxed");
  assert.match(told.content!, new RegExp(`xsb cancelled with it what you started for it:\\n- the job "take 2" \\(${waiting.id}\\)`));
  const take2 = await until("take 2 called off", async () => (await tasks()).find((t) => t.id === waiting.id && t.status === "cancelled"));
  assert.match(take2.result!, /^Cancelled with "render again" \(t_\w+\), which a cancelled\./);
  // p1 knows: its join no longer waits, and the job's end is not sent to it.
  assert.ok(![...hub.state.gates.values()].some((g) => g.taskIds.includes(waiting.id)));
  await idle("p1");
  assert.ok(!received("p1").some((i) => i.text.includes('title="take 2"') && i.text.includes("<xsb-task-result")));
  assert.ok(!inputs.get(a)!.some((i) => i.text.includes('title="render again"') && i.text.includes('status="cancelled"')), "a is not told of its own cancel");

  // The user stops p1 (Esc) while it works on a task: the user stops the work, and with it the task and what was
  // started for it (the user being the stopper); the task's dispatcher is told, for it did not stop it itself.
  const stoppable = [call("start_job", { server: "gen", tool: "render", arguments: { prompt: "noon", ms: 3000 }, title: "take 3" }), "!sleep 5000"];
  await prompt(a, call("dispatch_task", { deliveryPref: "wake", to: "p1", title: "render once more", instructions: stoppable.join("\n"), topic: "scene 1" }));
  const third = await until("take 3 running", async () => (await tasks()).find((t) => t.title === "take 3" && t.status === "running"));
  // The task runs in p1's conversation, where the user stops it.
  conn.notify("session/cancel", { sessionId: hub.mainSession("p1").id });
  const once = await until("render once more stopped", async () => (await tasks()).find((t) => t.title === "render once more" && t.status === "cancelled"));
  assert.deepEqual(once.ended, { reason: "cancelled", stopper: { kind: "user" } });
  const take3 = await until("take 3 called off", async () => (await tasks()).find((t) => t.id === third.id && t.status === "cancelled"));
  assert.deepEqual(take3.ended, { reason: "cascaded", stopper: { kind: "user" }, cause: once.id });
  await until("a told of the stop", () => inputs.get(a)!.some((i) => i.text.includes('title="render once more"') && i.text.includes('status="cancelled"')));
  assert.equal([...hub.state.gates.values()].length, 0);
  await idle("p1");
  await idle("a");
  console.log("ok 17 assets and what a task delivers");
}

// 18. A job the hub did not see the end of is not run again: it may have cost money already.
{
  await prompt(p, call("start_job", { server: "gen", tool: "render", arguments: { prompt: "long", ms: 5000 }, title: "shot 4" }));
  await hub.shutdown();
  hub = new Hub(project);
  await hub.start();
  conn = await connect();
  const lost = await until("shot 4 failed", async () => (await tasks()).find((t) => t.title === "shot 4" && t.status === "failed"));
  assert.match(lost.result!, /not run again/);
  assert.equal((await conn.request(Assets.list, { type: "character" })).assets[0].version, 2);
  await idle("p1");
  console.log("ok 18 jobs and assets across a restart");
}

// 19. What an editor of roles and agents needs: read, write, preview, check, apply.
{
  const { roles: all } = await conn.request(Roles.list);
  assert.deepEqual(all.map((r: any) => [r.name, r.agents, r.skills.map((s: any) => s.name)]), [["lead", ["a"], []], ["painter", ["p1"], ["grading", "shots"]]]);
  assert.deepEqual(all[0].grants, ["dispatch", "message"]);
  const roles = all.slice(1);
  assert.deepEqual(roles[0].skills.map((s: any) => [s.produces, s.inputs]), [[undefined, []], ["shot_list", ["character", "script"]]]);
  assert.equal(roles[0].mcpServers.gen.env.GEN_KEY, "k1");

  const mcpServers = { gen: { command: node, args: [GENERATOR] }, broken: { command: "xsb-no-such-command" } };
  const skills = [{ name: "script", content: "# Writing a scene\nSCRIPT-PROCEDURE" }];
  await conn.request(Roles.put, { role: { name: "writer", description: "writes", instructions: "WRITER-RULES", mcpServers, skills } });
  const { role: writer } = await conn.request(Roles.get, { name: "writer" });
  assert.deepEqual([writer.description, writer.instructions, writer.agents], ["writes", "WRITER-RULES", []]);
  // A skill says where its files are: the hub's to know, whether the role is the project's own or a team's.
  assert.deepEqual(writer.skills, [{ name: "script", description: "Writing a scene", inputs: [], dir: path.join(paths.roleDir("writer"), "skills", "script"), content: skills[0].content }]);
  // A field left out stays; a set that is given is the whole set.
  const { role: fewer } = await conn.request(Roles.put, { role: { name: "writer", description: "writes dialogue", skills: [] } });
  assert.deepEqual([fewer.description, fewer.skills, Object.keys(fewer.mcpServers)], ["writes dialogue", [], ["gen", "broken"]]);
  assert.equal((await conn.request(Roles.get, { name: "writer" })).role.instructions, "WRITER-RULES");
  await assert.rejects(conn.request(Roles.put, { role: { name: "writer", backend: "nope" } }), /no backend named "nope"/);
  await assert.rejects(conn.request(Roles.put, { role: { name: "../x" } }), /role name must be/);

  const { servers } = await conn.request(Roles.check, { name: "writer" });
  assert.deepEqual(servers[0], { server: "gen", tools: [{ name: "render", description: "Render a shot." }] });
  assert.match(servers[1].error, /cannot start MCP server "broken"/);

  const shown = await conn.request(Agents.get, { id: "p1" });
  assert.equal(shown.instructions, "You are p1.");
  assert.match(shown.systemPrompt, /You are "p1"[\s\S]*ROLE-RULES[\s\S]*You are p1\.[\s\S]*- shots: How to break a scene into shots/);

  // A server every agent has gives way to the role's of the same name.
  process.env.XSB_MCP_SERVERS = JSON.stringify({ gen: { command: "common-gen" } });
  await conn.request(Agents.restart, { id: "p1" });
  await until("p1 backend gone", () => !hub.session(p)["backend"]);
  await prompt(p, "!servers");
  assert.match(said.get(p)!, /servers: team, gen\n$/);
  delete process.env.XSB_MCP_SERVERS;

  // A changed role reaches a running agent once its backend is restarted.
  await prompt(p, "!servers");
  await conn.request(Roles.put, { role: { name: "painter", mcpServers: {} } });
  await conn.request(Agents.restart, { id: "p1" });
  await until("p1 backend gone", () => !hub.session(p)["backend"]);
  await prompt(p, "!servers");
  assert.match(said.get(p)!, /servers: team\n$/);

  // Servers the client that started the hub gives every agent, whatever its role.
  process.env.XSB_MCP_SERVERS = JSON.stringify({ browser: { command: "xsb-browser-mcp" } });
  await conn.request(Agents.restart, { id: "p1" });
  await until("p1 backend gone", () => !hub.session(p)["backend"]);
  await prompt(p, "!servers");
  assert.match(said.get(p)!, /servers: team, browser\n$/);
  delete process.env.XSB_MCP_SERVERS;

  await assert.rejects(conn.request(Roles.remove, { name: "painter" }), /in use by p1/);
  await conn.request(Agents.put, { agent: { id: "w1", role: "writer", backend: "mock" } });
  await conn.request(Agents.remove, { id: "w1" });
  await until("removal announced", () => removed.includes("w1"));
  await conn.request(Roles.remove, { name: "writer" });
  assert.deepEqual((await conn.request(Roles.list)).roles.map((r: any) => r.name), ["lead", "painter"]);
  // Observers hear of every change made through the hub, and of none that was refused.
  await until("role changes announced", () => roleEvents.length === 5);
  assert.deepEqual(roleEvents, ["lead: leads the team", "writer: writes", "writer: writes dialogue", "painter: paints shots", "writer"]);

  // A newly created role may have no skills; put returns the detail observers need without another get.
  const { role: empty } = await conn.request(Roles.put, { role: { name: "empty-role", instructions: "empty skill set", skills: [] } });
  assert.equal(empty.instructions, "empty skill set");
  assert.deepEqual(empty.skills, []);
  await conn.request(Roles.remove, { name: "empty-role" });

  // The backends an agent can be given, as the hub (which starts them) sees them.
  const { backends } = await conn.request(Backends.list);
  const backend = (name: string): any => backends.find((b: any) => b.name === name);
  assert.deepEqual(backend("steerable"), { name: "steerable", command: node, args: [MOCK, "--steering"], installed: true });
  assert.equal(backend("missing").installed, false);
  assert.equal(backend("claude").installHint, "npm i -g @agentclientprotocol/claude-agent-acp");
  console.log("ok 19 editing roles and agents");
}

// 20. A client that shows transcripts opts in to its own input: it learns when its message got into the conversation.
{
  const echoing = await client("echoing", { _meta: { [OriginExt.capability]: {} } });
  const seen: string[] = [];
  echoing.updates.push((_, update) => {
    if (update.sessionUpdate === "user_message_chunk") seen.push(`in ${update.messageId}${update._meta[OriginExt.key].steered ? " steered" : ""}`);
    if (update.sessionUpdate === "agent_message_chunk" && /ONE|TWO/.test(update.content.text)) seen.push(`out ${update.content.text.trim()}`);
  });
  const sessionId = (await echoing.request("session/new", { cwd: project, mcpServers: [], _meta: { [Agents.sessionKey]: "c" } })).sessionId;
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
  for (const id of ["mine-1", "mine-2", "mine-3"]) await until(`${id} seen`, () => hub.state.ledger.get(id)?.state === "seen");
  const ledger = hub.state.store.read("ledger.jsonl").map((r: any) => r.entry).filter((e: any) => e.messageId.startsWith("mine-"));
  assert.ok(!ledger.some((e: any) => e.state === "queued"), "the user's word is never queued");
  // An agent has one conversation: another client's new session of it is that one. A client that did not opt in is not
  // sent its own input, as in plain ACP.
  const quiet = await newSession("c");
  assert.equal(quiet, sessionId);
  await prompt(quiet, "!say THREE");
  assert.ok(!inputs.get(quiet)?.some((i) => i.text.includes("THREE")));
  echoing.close();
  console.log("ok 20 own input, echoed when it becomes a turn");
}

// 21. Input is content blocks, not only text. An image reaches a backend that reads images as it is; another is told one was there.
{
  const picture = [{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }, { type: "resource_link", uri: "file:///tmp/notes.md", name: "notes.md" }];
  const sighted = await newSession("c");
  await conn.request("session/prompt", { sessionId: sighted, prompt: picture });
  await until("the image read", () => /echo: look \| <image image\/png> \| <resource_link file:\/\/\/tmp\/notes\.md>/.test(said.get(sighted)!));
  const blind = await newSession("b");
  await conn.request("session/prompt", { sessionId: blind, prompt: picture });
  await until("the image named", () => /echo: look \| \[An image \(image\/png\) was attached here; you cannot see images\.\] \| <resource_link/.test(said.get(blind)!));
  // What was sent is what the transcript keeps, whatever the backend could read.
  // b's one conversation has more before: the last input is this one.
  const kept = hub.state.store.read(Paths.transcript("b", blind)).map((r: any) => r.update).filter((u: any) => u.sessionUpdate === "user_message_chunk").slice(-3);
  assert.deepEqual(kept.map((u: any) => u.content.type), ["text", "image", "resource_link"]);
  assert.equal(new Set(kept.map((u: any) => u.messageId)).size, 1);
  console.log("ok 21 images and files in input");
}

// 22. Preset teams: a project uses a team's roles as they ship, without a copy. A role it changes is its own; removing that brings the team's back.
{
  const roleOf = async (name: string) => (await conn.request(Roles.list)).roles.find((r: any) => r.name === name);
  const { teams: shipped } = await conn.request(Teams.list);
  const software = shipped.find((t: any) => t.id === "software");
  assert.equal(software.used, false);
  assert.ok(software.roles.some((r: any) => r.role.name === "reviewer" && r.role.instructions && r.role.skills.length));
  await assert.rejects(conn.request(Agents.put, { agent: { id: "r1", role: "reviewer", backend: "mock" } }), /no role "reviewer"/);
  await assert.rejects(conn.request(Teams.use, { id: "nope" }), /no team "nope"/);

  roleEvents.length = 0;
  await conn.request(Teams.use, { id: "software" });
  await conn.request(Teams.use, { id: "software" }); // using it again changes nothing
  await until("the team's roles announced", () => roleEvents.length === software.roles.length);
  assert.deepEqual((await roleOf("reviewer")).preset, { team: "software", teamTitle: "Software Development", own: false, title: "Code Reviewer" });
  assert.ok(!fs.existsSync(paths.roleDir("reviewer")), "nothing was copied into the project");
  const { agent: r1 } = await conn.request(Agents.put, { agent: { id: "r1", role: "reviewer", backend: "mock" } });
  assert.equal(r1.workspace, project);
  assert.ok(fs.existsSync(paths.scratch("r1")));
  assert.ok((await conn.request(Agents.get, { id: "r1" })).systemPrompt.includes(`in your own folder ${paths.scratch("r1")}`));
  const shippedText = (await conn.request(Roles.get, { name: "reviewer" })).role.instructions;
  assert.match((await conn.request(Agents.get, { id: "r1" })).systemPrompt, /- review: you, from prd, architecture, change/);

  // A team's role cannot be removed, and the team cannot be dropped while an agent has a role only it gives.
  await assert.rejects(conn.request(Roles.remove, { name: "reviewer" }), /is the team "software"'s/);
  await assert.rejects(conn.request(Teams.drop, { id: "software" }), /team "software" is in use by r1/);
  assert.equal((await conn.request(Teams.list)).teams.find((t: any) => t.id === "software").used, true);

  // Changing it makes it the project's own, with everything the team's had; removing that brings the team's back, agents or not.
  await conn.request(Roles.put, { role: { name: "reviewer", instructions: "OWN-RULES" } });
  const own = (await conn.request(Roles.get, { name: "reviewer" })).role;
  assert.deepEqual([own.preset, own.instructions, own.skills.length], [{ team: "software", teamTitle: "Software Development", own: true, title: "Code Reviewer" }, "OWN-RULES", 2]);
  assert.ok(fs.existsSync(path.join(paths.roleDir("reviewer"), "skills", "review", "SKILL.md")));
  await conn.request(Roles.remove, { name: "reviewer" });
  const back = (await conn.request(Roles.get, { name: "reviewer" })).role;
  assert.deepEqual([back.preset, back.instructions], [{ team: "software", teamTitle: "Software Development", own: false, title: "Code Reviewer" }, shippedText]);

  // Dropped, the team's roles are gone; a role the project made its own stays, as an ordinary role.
  await conn.request(Roles.put, { role: { name: "qa", description: "ours" } });
  await conn.request(Agents.remove, { id: "r1" });
  await conn.request(Teams.drop, { id: "software" });
  const left = (await conn.request(Roles.list)).roles.map((r: any) => [r.name, r.preset]);
  assert.deepEqual(left, [["lead", undefined], ["painter", undefined], ["qa", undefined]]);
  await until("the drop announced", () => roleEvents.includes("reviewer") && roleEvents.includes("qa: ours"));
  console.log("ok 22 preset teams");
}

// 23. Language: the project works in the language of the first client that declares one; the teams ship once per language.
{
  assert.deepEqual(
    [["zh-Hans-CN", "en-US"], ["zh_CN.UTF-8"], ["fr-FR", "en-GB"], ["C", undefined], []].map(languageOf),
    ["zh-CN", "zh-CN", "en", "en", "en"],
  );

  // Every language has the same teams, roles, skills, contracts and tools; only the words differ.
  const builtin = (language: Language) => [...catalog(language).teams.values()].filter((team) => team.source === "builtin");
  const roleOf = (language: Language, team: string, role: string) => teamRole(catalog(language), team, role)!;
  const shape = (language: Language) =>
    builtin(language).map((team) => [
      team.id,
      Object.keys(team.assets ?? {}),
      team.roles.map((entry) => {
        const role = roleOf(language, team.id, entry.role);
        const programs = (entry.requires ?? []).map((program) => program.command);
        return [entry.role, programs, role.servers, role.skills.map((skill) => [skill.name, skill.produces, skill.inputs])];
      }),
    ]);
  for (const language of LANGUAGES) assert.deepEqual(shape(language), shape("en"), `the ${language} teams differ from the English ones in more than words`);
  // What a team makes is named: every type one of its skills produces (and the types registered on the way, which no task asks for).
  for (const language of LANGUAGES) {
    for (const team of builtin(language)) {
      const made = team.roles.flatMap((entry) => roleOf(language, team.id, entry.role).skills.flatMap((skill) => skill.produces ?? []));
      const unnamed = made.filter((type) => !team.assets?.[type]);
      assert.deepEqual(unnamed, [], `${language}/${team.id}: asset types without a name`);
    }
  }

  const declare = (language: string): Promise<Connection> => client(`client-${language}`, { _meta: { [LanguageExt.key]: language } });
  assert.match((await conn.request(Agents.get, { id: "a" })).systemPrompt, /# Language\nThe user reads English\./);
  const chinese = await declare("zh-CN");
  assert.equal(JSON.parse(fs.readFileSync(paths.config, "utf8")).language, "zh-CN");
  (await declare("en")).close(); // a later client does not move the project
  (await declare("tlh")).close(); // nor does a language xsb has no words in
  assert.equal(JSON.parse(fs.readFileSync(paths.config, "utf8")).language, "zh-CN");

  // The agents are told, and the teams are the Chinese ones.
  assert.match((await conn.request(Agents.get, { id: "a" })).systemPrompt, /The user reads Simplified Chinese/);
  const film = (await chinese.request(Teams.list)).teams.find((t: any) => t.id === "film");
  assert.deepEqual([film.title, film.roles[0].name, film.assets.casting], ["电影创作", "导演", "选角"]);
  await chinese.request(Teams.use, { id: "film" });
  assert.equal((await chinese.request(Roles.get, { name: "director" })).role.preset.title, "导演");
  await chinese.request(Agents.put, { agent: { id: "ad", role: "art-director", backend: "mock" } });
  assert.match((await chinese.request(Agents.get, { id: "ad" })).systemPrompt, /- casting: you, from brief, script, style_guide\n- character: you, from brief, script, style_guide, casting/);

  // An error says why in a way a client can word for its reader.
  const refused = await chinese.request(Teams.drop, { id: "film" }).then(() => undefined, (e) => e);
  assert.deepEqual([refused.data.reason, refused.data.agents], ["team_in_use", ["ad"]]);
  assert.equal(explain(refused, "zh-CN"), "团队“film”正在被 ad 使用");
  assert.equal(explain(refused, "en"), refused.message);
  assert.equal(explain(new Error("plain"), "zh-CN"), "plain");
  chinese.close();
  console.log("ok 23 language");
}

// 24. A stop that gives up the unfinished: nothing runs again on the next start, and what had not ended is cancelled.
{
  const a = await newSession("a");
  await prompt(a, `!call dispatch_task {"deliveryPref":"wake","to":"b","title":"dropped","instructions":"!sleep 600\\n!say NEVER-AGAIN","topic":"quit"}`);
  await prompt(a, `!call dispatch_task {"deliveryPref":"wake","to":"b","title":"dropped too","instructions":"!say NOR-THIS","topic":"quit"}`); // waits behind the first
  await until("dropped running", async () => (await tasks()).find((t) => t.title === "dropped" && t.status === "running"));
  await hub.shutdown();
  fs.writeFileSync(paths.abandonMark, ""); // what `stopHub(paths, true)` leaves
  hub = new Hub(project);
  await hub.start();
  conn = await connect();
  assert.ok(!fs.existsSync(paths.abandonMark), "the mark is for one start");
  // What is left in the inboxes is the word of it to whom it concerns, waking nobody.
  assert.ok([...hub.state.mail.values()].every((m) => m.pref === "lazy" && hub.state.ledger.get(m.id)?.state === "inboxed"));
  await sleep(900); // longer than the task would have taken
  const after = (await tasks()).filter((t) => t.topic === "quit");
  assert.deepEqual(after.map((t) => t.status), ["interrupted", "interrupted"]);
  assert.match(after[0].result!, /chose not to have it continued/);
  const { agents } = await conn.request(Agents.list);
  assert.ok(agents.every((x: any) => x.state === "idle"), "nobody was set to work again");
  // The dispatcher hears of it with its next turn, not before: a turn of its own now would take the work up again.
  await prompt(a, "anything new");
  assert.match(said.get(a)!, /xsb was quit while work of yours was unfinished[^]*the task "dropped" \(t_\w+\) to b: interrupted/);
  // The start after that is an ordinary one.
  await hub.shutdown();
  hub = new Hub(project);
  await hub.start();
  conn = await connect();
  console.log("ok 24 a stop that gives up the unfinished");
}

// 25. Task lifecycle: a task ends with its executor's turn unless something it started for it is to come back; one
// that has to produce an asset and did not is asked for it a few times, then fails; the user writing past a
// dispatcher is told to it; a turn that mail started and that failed is recorded where the user sees it; the same
// wait asked for twice is one.
{
  await conn.request(Roles.put, { role: { name: "renderer", mcpServers: { gen: { command: node, args: [GENERATOR] } } } });
  await conn.request(Agents.put, { agent: { id: "r9", role: "renderer", backend: "mock" } });
  const p = await newSession("r9");
  // The turn ends with the task open, for a job it started for it is on its way; the turn the job's result brings
  // ends it, with what was said last then.
  await prompt(a, call("dispatch_task", { deliveryPref: "wake", to: "r9", title: "rainy", instructions: [call("start_job", { server: "gen", tool: "render", arguments: { prompt: "rain", ms: 600 }, title: "rain take" }), "!say STARTED"].join("\n"), topic: "lifecycle" }));
  const job = await until("rain take running", async () => (await tasks()).find((t) => t.title === "rain take" && t.status === "running"));
  const parent = (await tasks()).find((t) => t.title === "rainy")!;
  await until("r9's first turn over", () => answered("r9").includes("STARTED") && !hub.mainSession("r9").busy);
  assert.equal(hub.state.tasks.get(parent.id)!.status, "running", "not ended while the job runs");
  const result = await until("result in a", () => inputs.get(a)!.find((i) => i.text.includes(`task-id="${parent.id}"`) && i.text.includes("<xsb-task-result")));
  assert.match(result.text, new RegExp(`status="completed">\\necho: [^]*task-id="${job.id}"[^]*rendered: rain`));
  await idle("a");

  // A task that has to produce an asset ends only with one: the turn that ended without is asked for it, twice; then
  // the task fails, and says why.
  await prompt(a, call("dispatch_task", { deliveryPref: "wake", to: "r9", title: "no frame", instructions: "!say I made nothing", topic: "lifecycle", produces: "frame" }));
  const failed = await until("no frame failed", async () => (await tasks()).find((t) => t.title === "no frame" && t.status === "failed"));
  assert.equal(failed.ended!.reason, "error");
  assert.match(failed.result!, /did not register a "frame" asset/);
  assert.equal(received("r9").filter((i) => i.text.includes(`is not done: It did not register a "frame" asset`)).length, 2, "asked twice");
  await idle("r9");
  await idle("a");

  // The user writes to an agent while it works on a's task: a is not told. What the user's word changes shows in the
  // result a gets; a stop by the user is told by the task's end.
  await prompt(a, call("dispatch_task", { deliveryPref: "wake", to: "r9", title: "long one", instructions: "!sleep 1200\n!say LONG", topic: "lifecycle" }));
  await until("long one running", async () => (await tasks()).find((t) => t.title === "long one")?.status === "running");
  await prompt(p, "make it BLUE");
  await until("long one done", async () => (await tasks()).find((t) => t.title === "long one")?.status === "completed");
  await idle("r9");
  await idle("a");
  assert.ok(!inputs.get(a)!.some((i) => i.text.includes("wrote directly")), "the dispatcher is not copied");

  // A message that cannot be run (the backend is not installed) is recorded as failed in the recipient's transcript.
  await conn.request(Agents.put, { agent: { id: "m1", backend: "missing" } });
  await prompt(a, call("send_message", { to: "m1", content: "hello", topic: "lifecycle" }));
  const m1 = hub.state.mainSession("m1")!.id;
  await until("failure recorded", () => hub.state.store.read(Paths.transcript("m1", m1)).some((r: any) => r.update?._meta?.[TurnFailure.key]?.data?.reason === "backend_not_installed"));
  await idle("a");
  await conn.request(Agents.remove, { id: "m1" });

  // The same wait asked for twice is one gate, and one delivery.
  const twice = [call("start_job", { server: "gen", tool: "render", arguments: { prompt: "dusk", ms: 400 }, title: "dusk take" }), call("subscribe", { task_ids: ["$last"] }), call("subscribe", { task_ids: ["$last"] })];
  await prompt(p, twice.join("\n"));
  assert.equal([...hub.state.gates.values()].filter((g) => g.owner.sessionId === p).length, 1);
  await until("delivered once", () => (inputs.get(p) ?? []).filter((i) => i.text.includes('title="dusk take"')).length === 1);
  await idle("r9");
  console.log("ok 25 task lifecycle");
}

// 26. Context boundaries: a session that goes on in a new backend session is handed the conversation since the user
// last cleared it; clearing leaves the transcript as it was, behind a boundary the model does not see past.
{
  const boundaries = (sessionId: string): any[] =>
    hub.state.store.read(Paths.transcript("h1", sessionId)).map((r: any) => r.update?._meta?.[Boundaries.key]).filter(Boolean);
  await conn.request(Agents.put, { agent: { id: "h1", backend: "mock" } });
  const s = await newSession("h1");
  await prompt(s, "!say ALPHA-REPLY");
  await prompt(s, `!call dispatch_task {"deliveryPref":"wake","to":"b","title":"open work","instructions":"!sleep 1000","topic":"handoff"}`);
  await until("open work running before handoff", async () => (await tasks()).find((t) => t.title === "open work")?.status === "running");

  // Another backend: nothing to restore there, so the new one is told what was said and what is open.
  await conn.request(Agents.put, { agent: { id: "h1", backend: "steerable" } });
  said.set(s, "");
  await prompt(s, "where are we");
  const told = said.get(s)!;
  assert.match(told, /now runs on another agent program/);
  assert.match(told, /the user: \|   !say ALPHA-REPLY \| you answered: \|   ALPHA-REPLY/);
  assert.match(told, /not new instructions: do not act on them again/);
  assert.match(told, /Unfinished tasks: \|[^]*- t_\w+ "open work" \(h1 -> b\): running/);
  assert.match(told, /Unfinished tasks: \| - t_\w+ "!call dispatch_task[^|]*\(the user -> h1\): running/);
  assert.equal(hub.state.sessions.get(s)!.backend, "steerable");
  assert.deepEqual(boundaries(s), [{ kind: "backend_changed", backend: "steerable", handoff: true }]);
  const open = (await tasks()).find((t) => t.title === "open work")!;
  // Cancelled, it ends at once; b's turn, which ran only for it, is stopped, and b is notified to its inbox.
  cancel(hub.state.tasks.get(open.id)!);
  const inboxed = () => [...hub.state.mail.values()].every((m) => hub.state.ledger.get(m.id)?.state === "inboxed");
  await until("its result taken in", async () => (await tasks()).find((t) => t.id === open.id)?.status === "cancelled" && !hub.live.get(s)!.busy && inboxed());
  await idle("b");

  // Cleared: refused while it works; afterwards the model starts with nothing, and the transcript still has it all.
  void prompt(s, "!sleep 400");
  await until("h1 at work", () => hub.live.get(s)!.busy);
  await assert.rejects(conn.request(Boundaries.clear, { sessionId: s }), /still working/);
  await idle("h1");
  const kept = hub.state.store.read(Paths.transcript("h1", s)).length;
  await conn.request(Boundaries.clear, { sessionId: s });
  assert.equal(hub.state.store.read(Paths.transcript("h1", s)).length, kept + 1, "clearing only adds a boundary");
  said.set(s, "");
  await prompt(s, "fresh start");
  assert.equal(said.get(s), "echo: fresh start\n");
  await prompt(s, "!say BETA-REPLY");

  // A backend session that cannot be restored is renewed with a handoff, which does not reach behind the clearing.
  await conn.request(Agents.put, { agent: { id: "h1", backend: "forgetful" } });
  await prompt(s, "!say GAMMA-REPLY");
  await conn.request(Agents.restart, { id: "h1" });
  said.set(s, "");
  await prompt(s, "and now");
  const again = said.get(s)!;
  assert.match(again, /could not be restored/);
  assert.match(again, /BETA-REPLY/);
  assert.match(again, /GAMMA-REPLY/);
  assert.doesNotMatch(again, /ALPHA-REPLY/);
  assert.deepEqual(boundaries(s).map((b) => b.kind), ["backend_changed", "cleared", "backend_changed", "not_restored"]);
  await conn.request(Agents.put, { agent: { id: "h1", backend: "mock" } });
  console.log("ok 26 context boundaries and handoffs");
}

// 27. Jobs of one tool run a few at a time; cancelling a queued job never submits it.
{
  const served = hub.toolServers(hub.agent("r9")).find((t) => t.server.name === "gen")!.server;
  assert.ok(served.type === "stdio");
  assert.deepEqual((served.env ?? []).filter((e) => e.name.startsWith("XSB_")), []);
  const s9 = await newSession("r9");
  // Three jobs of one tool: two run, one waits; the one that waits is cancelled without the tool being asked.
  const job = (title: string) => call("start_job", { server: "gen", tool: "render", arguments: { prompt: title, ms: 500 }, title });
  await prompt(s9, [job("q1"), job("q2"), job("q3")].join("\n"));
  const byTitle = async (title: string) => (await tasks()).find((t) => t.title === title)!;
  assert.deepEqual([(await byTitle("q1")).status, (await byTitle("q2")).status, (await byTitle("q3")).status], ["running", "running", "queued"]);
  await prompt(s9, call("cancel_task", { task_id: (await byTitle("q3")).id }));
  assert.match((await byTitle("q3")).result!, /It had not started: it waited for its turn in xsb, nothing was submitted, nothing is billed/);
  // One that waits starts when a place is free.
  await prompt(s9, job("q4"));
  assert.equal((await byTitle("q4")).status, "queued");
  await until("q4 done", async () => (await byTitle("q4")).status === "completed");
  await idle("r9");
  console.log("ok 27 jobs at a time");
}

// 28. One conversation per agent: a peer's work, of whatever topic, goes to the agent's main session, the one the user
// talks to it in. Grown past the limit, the conversation goes on in a new backend session, handed what came before;
// the session stays the same. A session is not given again what it was given already: an unchanged asset is referred
// to, a changed one comes with what changed.
{
  const bInfo = async () => (await conn.request(Agents.list)).agents.find((x: any) => x.id === "b");
  const sessionOf = (title: string) => hub.state.tasks.get([...hub.state.tasks.values()].find((t) => t.title === title)!.id)!.to.sessionId;
  const done = (title: string) => until(`${title} done`, async () => (await tasks()).find((t) => t.title === title)?.status === "completed");
  const send = async (title: string, topic: string, instructions: string, more: object = {}) => {
    await prompt(a, call("dispatch_task", { deliveryPref: "wake", to: "b", title, instructions, topic, ...more }));
    await done(title);
  };
  await send("w1", "Story ROOM", "!done W1-DONE");
  await send("w3", "other room", "!done W3-DONE");
  const main = (await bInfo()).mainSessionId;
  assert.deepEqual([sessionOf("w1"), sessionOf("w3")], [main, main], "every topic, the one conversation");

  // Grown past the limit: the next turn starts a new backend session in the same conversation, with a handoff.
  const config = JSON.parse(fs.readFileSync(paths.config, "utf8"));
  fs.writeFileSync(paths.config, JSON.stringify({ ...config, limits: { sessionTokens: 1000 } }));
  const before = hub.state.sessions.get(main)!.backendSessionId;
  await send("w4", "story room", "!usage 5000\n!done W4-DONE");
  await send("w5", "story room", "!echo\n!done W5-DONE");
  assert.equal(sessionOf("w5"), main);
  assert.notEqual(hub.state.sessions.get(main)!.backendSessionId, before, "a new backend session");
  assert.ok(!hub.state.sessions.get(main)!.renew);
  const handed = hub.state.store.read(Paths.transcript("b", main)).map((r: any) => r.update).filter((u: any) => u.sessionUpdate === "agent_message_chunk").map((u: any) => u.content.text).join("");
  assert.match(handed, /This conversation had grown long, and goes on in a new session of the agent program/);
  assert.match(handed, /W1-DONE[^]*W4-DONE/);
  assert.ok(hub.state.store.read(Paths.transcript("b", main)).some((r: any) => r.update._meta?.[Boundaries.key]?.kind === "renewed"));
  fs.writeFileSync(paths.config, JSON.stringify(config));

  // Given once in full; then by reference; then, changed, with what changed.
  await prompt(a, call("put_asset", { type: "doc", name: "plan", description: "the plan", content: "LINE A\nLINE B\nLINE D" }));
  await send("i1", "inputs", "!done I1", { inputs: ["doc/plan"] });
  await send("i2", "inputs", "!done I2", { inputs: ["doc/plan"] });
  await prompt(a, call("put_asset", { type: "doc", name: "plan", description: "the plan", content: "LINE A\nLINE C\nLINE D" }));
  await send("i3", "inputs", "!done I3", { inputs: ["doc/plan"] });
  const taskText = (title: string) => received("b").find((i) => i.text.includes(`title="${title}"`))!.text;
  assert.match(taskText("i1"), /---\nLINE A\nLINE B\nLINE D/);
  assert.match(taskText("i2"), /Its text is the version you were given with task t_\w+ earlier in this conversation, unchanged: it is not repeated here\./);
  assert.doesNotMatch(taskText("i2"), /LINE B/);
  assert.match(taskText("i3"), /What changed since version 1, which you were given before:\n<xsb-changes asset="doc\/plan">\n@@ line 2\n\+ LINE C\n- LINE B\n<\/xsb-changes>\n<xsb-asset id="doc\/plan" version="2"[^]*LINE C/);

  // A long result that a task builds on is told in part; the rest is a get_task away.
  const long = "R".repeat(3000);
  await prompt(a, call("dispatch_task", { deliveryPref: "wake", to: "b", title: "long result", instructions: `!done ${long}`, topic: "chain" }));
  const first = (await tasks()).find((t) => t.title === "long result")!;
  await prompt(a, call("dispatch_task", { deliveryPref: "wake", to: "b", title: "builds on it", instructions: "!done OK", topic: "chain", after: [first.id] }));
  await done("builds on it");
  assert.match(taskText("builds on it"), new RegExp(`R{1500}…\\n\\(The result goes on; task_status ${first.id} has all of it\\.\\)`));
  await idle("b");
  await idle("a");
  console.log("ok 28 work sessions and what a session is given");
}

// 29. Preset teams of the user's: ~/.xsb/presets, organised as xsb's own. A team may extend another and hold only
// what differs; what is wrong is said, and the rest stays usable; edits apply without a restart.
{
  const root = path.join(process.env.XSB_HOME!, "presets");
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };
  const json = (value: unknown) => JSON.stringify(value);
  // A team in English only: the project works in Chinese by now, and uses it all the same.
  write("en/solo/team.json", json({ title: "Solo", description: "one poet", roles: [{ role: "poet", name: "Poet" }], assets: { poem: "Poem" } }));
  write("en/solo/roles/poet/role.json", json({ description: "writes poems", avatar: "role" }));
  write("en/solo/roles/poet/avatar.png", "PNG");
  write("en/solo/roles/poet/instructions.md", "POET-RULES");
  write("en/solo/roles/poet/skills/poem/SKILL.md", "---\ndescription: write a poem\nproduces: poem\ninputs: theme\n---\nPOEM-PROCEDURE");
  // One that takes a builtin id, two that go round in a circle, one whose base is missing.
  write("en/software/team.json", json({ title: "Mine", roles: [] }));
  write("en/loop-a/team.json", json({ title: "A", extends: "loop-b", roles: [] }));
  write("en/loop-b/team.json", json({ title: "B", extends: "loop-a", roles: [] }));
  write("en/orphan/team.json", json({ title: "Orphan", extends: "nowhere", roles: [] }));
  // One that builds on software and changes only the reviewer.
  write("en/strict/team.json", json({ title: "Strict", extends: "software", roles: [{ role: "reviewer", name: "Strict Reviewer" }] }));
  write("en/strict/roles/reviewer/role.json", json({ description: "reviews strictly" }));
  write("en/strict/roles/reviewer/instructions.md", "STRICT-EXTRA");
  write("en/strict/roles/reviewer/skills/extra/SKILL.md", "---\ndescription: the extra checks\n---\nEXTRA-CHECKS");

  const list = async () => await conn.request(Teams.list);
  const { teams: all, problems } = await list();
  const byId = (id: string) => all.find((t: any) => t.id === id);
  assert.deepEqual([byId("solo").source, byId("solo").language, byId("software").source], ["user", "en", "builtin"]);
  assert.ok(problems.some((p: any) => p.code === "team_shadows_builtin" && p.team === "software"));
  assert.ok(!byId("loop-a") && !byId("orphan"), "teams that cannot be resolved are left out");
  assert.deepEqual([...new Set(problems.filter((p: any) => /^loop|orphan/.test(p.team)).map((p: any) => p.code))].sort(), ["team_extends_cycle", "team_extends_missing"]);
  assert.ok(byId("solo").problems.some((p: any) => p.code === "input_unmade" && /"theme"/.test(p.detail)));
  assert.equal(byId("solo").roles[0].role.avatarFile, path.join(root, "en/solo/roles/poet/avatar.png"));
  assert.equal(byId("strict").extends, "software");

  // Used, its roles are the project's; the one it lays over its base's is both.
  await conn.request(Teams.use, { id: "solo" });
  await conn.request(Agents.put, { agent: { id: "poet1", role: "poet", backend: "mock" } });
  assert.match((await conn.request(Agents.get, { id: "poet1" })).systemPrompt, /POET-RULES/);
  await conn.request(Teams.use, { id: "strict" });
  const strict = (await conn.request(Roles.get, { name: "reviewer" })).role;
  assert.equal(strict.description, "reviews strictly");
  assert.match(strict.instructions, /\n\nSTRICT-EXTRA$/);
  assert.deepEqual(strict.skills.map((s: any) => s.name).sort(), ["extra", "review", "security-checklist"]);
  assert.equal(strict.preset.title, "Strict Reviewer");

  // Two teams that both have a reviewer, neither built on the other, are not used together.
  write("en/other/team.json", json({ title: "Other", roles: [{ role: "reviewer", name: "R" }] }));
  write("en/other/roles/reviewer/role.json", json({}));
  const refused = await conn.request(Teams.use, { id: "other" }).then(() => undefined, (e) => e);
  assert.deepEqual([refused.data.reason, refused.data.role], ["team_clash", "reviewer"]);

  // Source edits leave the project copy unchanged until a confirmed synchronization.
  write("en/solo/roles/poet/instructions.md", "POET-RULES-2");
  assert.doesNotMatch((await conn.request(Agents.get, { id: "poet1" })).systemPrompt, /POET-RULES-2/);
  const preview = await conn.request(Teams.syncPreview, { id: "solo" });
  await assert.rejects(conn.request(Teams.sync, { id: "solo", revision: preview.revision }), /explicit confirmation/);
  await conn.request(Teams.sync, { id: "solo", revision: preview.revision, confirm: true });
  assert.match((await conn.request(Agents.get, { id: "poet1" })).systemPrompt, /POET-RULES-2/);

  // Made the project's own, a laid-over role is written out as it applies.
  await conn.request(Roles.put, { role: { name: "reviewer", description: "ours" } });
  assert.match(fs.readFileSync(path.join(paths.roleDir("reviewer"), "instructions.md"), "utf8"), /STRICT-EXTRA$/);
  assert.ok(fs.existsSync(path.join(paths.roleDir("reviewer"), "skills", "extra", "SKILL.md")));
  await conn.request(Roles.remove, { name: "reviewer" });

  // A team of the user's that builds on another is started from the app.
  const { team: mine } = await conn.request(Teams.derive, { id: "film-mine", base: "film" });
  assert.deepEqual([mine.source, mine.extends, mine.language], ["user", "film", "zh-CN"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "film-mine/zh-CN/team.json"), "utf8")).extends, "film");
  await assert.rejects(conn.request(Teams.derive, { id: "film", base: "software" }), /there is a team "film" already/);

  await conn.request(Agents.remove, { id: "poet1" });
  for (const id of ["solo", "strict"]) await conn.request(Teams.drop, { id });
  fs.rmSync(root, { recursive: true, force: true });
  console.log("ok 29 preset teams of the user's");
}

// 30. Two film teams: "film" is bound to no generation models; "film-ark" is film with Volcengine Ark, and holds
// only what differs. A project of an earlier xsb that used "film" (which was Ark's then) uses "film-ark" now.
{
  for (const language of LANGUAGES) {
    const cat = catalog(language);
    const generic = teamRole(cat, "film", "cinematographer")!;
    const ark = teamRole(cat, "film-ark", "cinematographer")!;
    assert.deepEqual(generic.servers, {}, `${language}: the generic team names no generation server`);
    assert.equal(ark.servers.media.env!.VIDEO_PROVIDER, "seedance");
    assert.deepEqual(ark.skills.map((s) => s.name).sort(), ["seedance", "shot"]);
    assert.ok(ark.instructions.startsWith(generic.instructions) && ark.instructions.length > generic.instructions.length, "film-ark's instructions follow film's");
    assert.equal(teamRole(cat, "film-ark", "storyboard-artist")!.servers.media.env!.IMAGE_PROVIDER, "seedream");
    assert.deepEqual(teamRole(cat, "film-ark", "screenwriter")!.instructions, teamRole(cat, "film", "screenwriter")!.instructions, "a role it does not change is film's");
    const arkTeam = cat.teams.get("film-ark")!;
    assert.ok(arkTeam.roles.find((r) => r.role === "cinematographer")!.requires!.some((p) => p.command === "arkcli"));
    assert.ok(!cat.teams.get("film")!.roles.some((r) => r.requires?.some((p) => p.command === "arkcli")));
    // Nothing of Ark is left in the generic team's words.
    const words = cat.teams.get("film")!.roles.map((r) => { const role = teamRole(cat, "film", r.role)!; return [role.instructions, ...role.skills.map((s) => fs.readFileSync(path.join(s.dir, "SKILL.md"), "utf8"))].join("\n"); }).join("\n");
    // (The brief may point to the Ark team by its name; it knows nothing of Ark.)
    assert.doesNotMatch(words.replaceAll("火山方舟视频创作", "").replaceAll("Volcengine Ark video", ""), /Seedance|Seedream|arkcli|方舟|\bArk\b|`media`|generate_video|generate_image/);
  }
  // An earlier config: "film" becomes "film-ark" on the next start, once.
  const config = JSON.parse(fs.readFileSync(paths.config, "utf8"));
  fs.writeFileSync(paths.config, JSON.stringify({ ...config, version: 1, teams: ["film", "software"] }));
  await hub.shutdown();
  hub = new Hub(project);
  await hub.start();
  conn = await connect();
  assert.deepEqual([JSON.parse(fs.readFileSync(paths.config, "utf8")).version, JSON.parse(fs.readFileSync(paths.config, "utf8")).teams], [2, ["film-ark", "software"]]);
  fs.writeFileSync(paths.config, JSON.stringify({ ...JSON.parse(fs.readFileSync(paths.config, "utf8")), teams: ["film"] }));
  await hub.shutdown();
  hub = new Hub(project);
  await hub.start();
  conn = await connect();
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.config, "utf8")).teams, ["film"], "a version-2 config is left as it is");
  fs.writeFileSync(paths.config, JSON.stringify({ ...config }));
  console.log("ok 30 two film teams, and the move of earlier projects");
}

// 31. One agent, one conversation, one thing at a time: its peer work runs a turn after the other, whatever the topic,
// and the user's word goes into the work under way.
{
  const statusOf = async (title: string) => (await tasks()).find((t) => t.title === title)?.status;
  const send = (title: string) => prompt(a, call("dispatch_task", { deliveryPref: "wake", to: "b", title, instructions: "!sleep 300\n!done DONE", topic: `one ${title}` }));
  await send("one 1");
  await send("one 2");
  await until("one 1 running", async () => (await statusOf("one 1")) === "running");
  assert.equal(await statusOf("one 2"), "queued", "waits, though the topic differs");
  const bMain = hub.mainSession("b").id;
  // Whoever opens a session of b gets that one; there is no other to talk to it in.
  assert.equal(await newSession("b"), bMain);
  const listed = (await conn.request("session/list", { _meta: { [Agents.sessionKey]: "b" } })).sessions;
  assert.deepEqual(listed.map((x: any) => x.sessionId), [bMain]);
  assert.equal([...hub.live.values()].filter((x) => x.agentId === "b").length, 1);
  await prompt(bMain, "are you there");
  assert.ok(received("b").find((i) => i.text === "are you there")!.origin.steered, "the user's word goes into the work under way");
  await until("both done", async () => (await statusOf("one 2")) === "completed");
  await idle("b");
  await idle("a");
  console.log("ok 31 one conversation per agent");
}

// 32. A stop is the user's (Esc): the work of the session stops, and so do the tasks it works on, the user being the
// stopper. User stop also withdraws pending input; hub task cancellation retains its narrower semantics. What was inserted stays in the
// conversation: if nothing followed, it is "inserted, not processed".
{
  const watching = await client("watching", { _meta: { [OriginExt.capability]: {} } });
  const seen: string[] = [];
  watching.updates.push((_, update) => {
    if (update.sessionUpdate === "user_message_chunk") seen.push(`in ${update.messageId}`);
    const discarded = update._meta?.[Discarded.key];
    if (discarded) seen.push(`discarded ${discarded.messageId}: ${discarded.content[0].text}`);
    if (update.sessionUpdate === "agent_message_chunk") seen.push(`out ${update.content.text.trim()}`);
  });
  const open = async (agentId: string) => (await watching.request("session/new", { cwd: project, mcpServers: [], _meta: { [Agents.sessionKey]: agentId } })).sessionId;
  const mine = (messageId: string) => ({ [OriginExt.key]: { messageId } });

  // A backend that holds what comes while it works: the user's second message is held, and the stop answers it
  // with -32800; the hub withdraws it rather than carrying it into new work. The user's task in the session is stopped by the user.
  const s = await open("a");
  const running = watching.turn(s, "!busy 600\n!say LATE", mine("stop-1"));
  await until("the turn running", () => seen.includes("in stop-1"));
  let heldAnswer: any;
  const held = watching.request("session/prompt", { sessionId: s, prompt: [{ type: "text", text: "!say HELD" }], _meta: mine("stop-2") }).then((r) => (heldAnswer = r), (e) => (heldAnswer = e.code));
  await until("given to the backend", () => hub.session(s).current?.inputs.some((i) => i.messageId === "stop-2" && i.sent));
  const userTask = hub.kernel.userTask(s)!;
  watching.notify("session/cancel", { sessionId: s });
  assert.equal((await running).stopReason, "cancelled");
  await idle("a");
  await sleep(100);
  assert.deepEqual(seen, ["in stop-1", "discarded stop-2: !say HELD"]);
  assert.equal(await held, -32800, "withdrawn input is answered as cancelled");
  assert.equal(heldAnswer, -32800);
  assert.equal(hub.state.ledger.get("stop-2")!.state, "discarded_unseen");
  assert.deepEqual(hub.state.tasks.get(userTask.id)!.ended, { reason: "cancelled", stopper: { kind: "user" } });
  // The next user request is new work; withdrawn instructions are never replayed.
  seen.length = 0;
  await watching.turn(s, "!say AGAIN", mine("stop-3"));
  await until("both answered", () => seen.includes("out AGAIN"));
  assert.deepEqual(seen, ["in stop-3", "out AGAIN"]);
  assert.notEqual(hub.kernel.userTask(s)?.id ?? (await tasks()).find((t) => t.instructions === "!say AGAIN")!.id, userTask.id);
  await idle("a");

  // Mail whose turn has not reached the backend yet is not the user's: it runs, without what the user put into it,
  // which waits for the next turn.
  seen.length = 0;
  const m = await open("b");
  const caught = new Promise<{ mailId: string; started: boolean }>((resolve) => {
    let once = false;
    hub.kernel.hooks.on("message.routed", ({ item }) => {
      if (once || item.to.sessionId !== m) return;
      once = true;
      const mail = hub.session(m);
      const started = mail.current!.started;
      void mail.steer({ prompt: [{ type: "text", text: "!say USER" }], origin: { kind: "user", messageId: "stop-10" } })!.inserted.promise;
      mail.cancel();
      resolve({ mailId: item.id, started });
    });
  });
  hub.kernel.tell({ agentId: "b", sessionId: m }, undefined, "!say MAIL");
  const { mailId, started } = await caught;
  assert.equal(started, false);
  await until("the mail answered", () => seen.includes("out MAIL"));
  await idle("b");
  assert.deepEqual(seen, [`in ${mailId}`, "out MAIL"]);
  assert.ok(!hub.state.mail.has(mailId), "the mail is acknowledged once its turn ran");
  // Mail that comes next starts a turn: what the user said goes first.
  seen.length = 0;
  hub.kernel.tell({ agentId: "b", sessionId: m }, undefined, "!say MAIL2");
  await until("the next mail answered", () => seen.includes("out MAIL2"));
  await idle("b");
  assert.deepEqual(seen.filter((l) => l.startsWith("out")), ["out USER", "out MAIL2"]);
  assert.equal(seen[0], "in stop-10");

  // The dispatcher's cancel stops the work that ran only for the task, and records the task once it stopped.
  await watching.turn(s, call("dispatch_task", { deliveryPref: "wake", to: "b", title: "esc", instructions: "!sleep 3000\n!say WORK", topic: "esc" }));
  const work = await until("b at work", () => (hub.mainSession("b").current?.inserted ? hub.mainSession("b") : undefined));
  const task = [...hub.state.tasks.values()].find((t) => t.title === "esc")!;
  await until("esc running", () => hub.state.tasks.get(task.id)!.status === "running");
  assert.equal(cancel(task).stopping, true);
  await until("recorded once stopped", () => hub.state.tasks.get(task.id)!.status === "cancelled");
  assert.ok(!work.busy);
  assert.ok(!answered("b").includes("WORK"));
  await idle("b");
  await idle("a");

  // Steering as claude does: what it took is in the conversation, and stopped before it acted, it is not processed yet;
  // what it had not taken yet (it waited for the work's next step) is withdrawn.
  seen.length = 0;
  const c = await open("c");
  const turn = watching.turn(c, "!sleep 3000\n!say AFTER", mine("stop-4"));
  await until("c running", () => hub.session(c).current?.inserted);
  const five = watching.request("session/prompt", { sessionId: c, prompt: [{ type: "text", text: "!say FIVE" }], _meta: mine("stop-5") }).then(() => 0, (e) => e.code);
  await until("given to the backend", () => hub.session(c).current?.inputs.some((i) => i.messageId === "stop-5" && i.sent));
  watching.notify("session/cancel", { sessionId: c });
  assert.equal((await turn).stopReason, "cancelled");
  assert.deepEqual(seen, ["in stop-4", "discarded stop-5: !say FIVE"]);
  await until("not processed", () => hub.state.ledger.get("stop-4")?.state === "inserted_unprocessed");
  await watching.turn(c, "!say SIX", mine("stop-6"));
  assert.equal(await five, -32800);
  await until("six said", () => seen.includes("out SIX"));
  assert.deepEqual(seen, ["in stop-4", "discarded stop-5: !say FIVE", "in stop-6", "out SIX"]);
  await idle("c");
  watching.close();
  console.log("ok 32 a stop is the user's: the work and its tasks stop, what was not in never gets in");
}

// 33. A task that arrives while its assignee works, even from whoever gave it that work, waits for the work under way
// and is a turn of its own after it; each is finished on its own.
{
  await prompt(a, call("dispatch_task", { deliveryPref: "wake", to: "c", title: "cut 1", instructions: "!sleep 800\n!done CUT-1", topic: "edit" }));
  await until("c at work", () => (hub.mainSession("c").current?.inserted ? hub.mainSession("c") : undefined));
  await prompt(a, call("dispatch_task", { deliveryPref: "wake", to: "c", title: "cut 2", instructions: "!done CUT-2", topic: "edit" }));
  const result = (title: string) => until(`result of ${title}`, () => inputs.get(a)!.find((i) => i.text.includes(`title="${title}"`) && i.text.includes("<xsb-task-result")));
  const given = await until("cut 2 given", () => received("c").find((i) => i.text.includes('title="cut 2"')));
  assert.notEqual(given.origin.steered, true, "not put into the running turn");
  assert.equal([...hub.state.tasks.values()].find((t) => t.title === "cut 1")!.status, "completed", "given once cut 1 was done");
  assert.match((await result("cut 2")).text, /status="completed">\nCUT-2/);
  assert.match((await result("cut 1")).text, /status="completed">\nCUT-1/);
  // A task is reported by whom it was given to, and once: report_result is there only while the work is a task from
  // an agent, and refuses one that is not the caller's or has ended.
  const cut = (await tasks()).find((t) => t.title === "cut 1")!;
  await prompt(a, call("report_result", { task_id: cut.id, result: "mine" }));
  assert.match(said.get(a)!, /report_result is not available in the work you are doing now/);
  await prompt(a, call("dispatch_task", { deliveryPref: "wake", to: "c", title: "cut 3", instructions: call("report_result", { task_id: cut.id, result: "again" }), topic: "edit" }));
  await until("refused", () => answered("c").includes(`task ${cut.id} is completed already`));
  await idle("c");
  await idle("a");
  console.log("ok 33 a task waits for the work under way");
}

// 34. The task graph (docs/TASK-GRAPH.md): what a task is started for is what the session it comes from had open;
// stopping a task takes along what nothing else holds up, in one go: the sessions that worked only for what goes are
// stopped, and the stop is recorded once they did; an executor that goes on with other work is told.
{
  for (const [id, backend] of [["g1", "mock"], ["g2", "steerable"], ["g3", "mock"], ["g4", "mock"], ["g5", "mock"]]) {
    await conn.request(Agents.put, { agent: { id, backend, description: `agent ${id}` } });
  }
  const mine = hub.session(a);
  const task = (id: string) => hub.state.tasks.get(id)!;
  const running = (id: string) => until(`${id} running`, () => task(id).status === "running");
  const give = (from: any, to: string, title: string, extra: any = {}) =>
    dispatch(from, to, { title, topic: `graph ${title}`, instructions: "!sleep 1500", after: [], ...extra });
  const work = (t: Task) => hub.live.get(t.to.sessionId)!;
  const ended = (id: string) => until(`${id} recorded`, () => isTerminalStatus(task(id).status));
  // Told: given in a turn, or notified to its inbox when its turn was stopped with the work.
  const has = (agentId: string, text: string) =>
    received(agentId).some((i) => i.text.includes(text)) || [...hub.state.mail.values()].some((m) => m.to.agentId === agentId && m.content?.includes(text));

  // A chain, with a middle task that already finished: a -> g1 (P) -> g3 (X, finished) -> g4 (Z); and Y, held back
  // after Z, for an idle g5. Stopping P stops Z through X, and Y is not handed over on the way.
  const P = give(mine, "g1", "P");
  await running(P.id);
  const X = give(work(P), "g3", "X");
  await running(X.id);
  assert.deepEqual(X.parents, [P.id]);
  const Z = give(work(X), "g4", "Z");
  await running(Z.id);
  hub.kernel.complete(task(X.id), "completed", "X done, Z still renders", []);
  const Y = give(work(P), "g5", "Y", { after: [Z.id], instructions: "!say Y-RAN" });
  assert.equal(Y.status, "blocked");
  const { with: went, stopping } = cancel(task(P.id));
  assert.deepEqual(went.map((t) => t.title).sort(), ["Y", "Z"]);
  assert.equal(stopping, true, "g1 and g4 worked only for it: they are stopped first");
  await ended(P.id);
  assert.deepEqual([task(P.id).status, task(Y.id).status, task(Z.id).status], ["cancelled", "cancelled", "cancelled"]);
  assert.match(task(Z.id).result!, /^Cancelled with "P" \(t_\w+\), which a cancelled\. g4 had it, and was stopped\./);
  assert.deepEqual(task(Z.id).ended, { reason: "cascaded", stopper: { kind: "agent", agentId: "a" }, cause: P.id });
  // (g1 then reads the result of X, which came while it worked: a turn of its own.)
  await until("their work stopped", () => !work(P).busy && !work(Z).busy);
  // g3 finished X, so it is not told in a notice: Z's result reaches it as any result would.
  await until("g3 has Z's result", () => received("g3").some((i) => i.text.includes(`title="Z"`) && i.text.includes('status="cancelled"')));
  await sleep(300);
  assert.ok(!has("g5", 'title="Y"'), "Y was never handed over");
  assert.ok(!answered("g5").includes("Y-RAN"));
  assert.ok(!inputs.get(a)!.some((i) => i.text.includes(`task-id="${P.id}"`)), "a stopped P itself and is not told");

  // Work started while a session had two tasks goes on while one of them does. (The user's task in g2 waits for
  // what it dispatched; a's task runs there meanwhile.)
  const g2 = hub.mainSession("g2").id;
  await prompt(g2, call("dispatch_task", { deliveryPref: "wake", to: "g5", title: "for the user", instructions: "!sleep 6000", topic: "graph user" }));
  const Q = (await until("the user's task there", () => hub.kernel.userTask(g2)))!;
  await running(Q.id);
  const P2 = give(mine, "g2", "both", { topic: "graph shared", instructions: "!sleep 4000" });
  await running(P2.id);
  const c = give(work(P2), "g4", "for both");
  assert.deepEqual([...c.parents!].sort(), [P2.id, Q.id].sort());
  assert.deepEqual(cancel(task(P2.id)).with, []);
  assert.ok(["queued", "running"].includes(task(c.id).status), "it goes on");
  await until("g2 told what goes on", () => has("g2", `Not cancelled, for it is also for other work of yours that goes on:\n- "for both" to g4 (${c.id})`));
  assert.ok(!isVeto(hub.kernel.stop(task(Q.id), USER, { status: "cancelled", reason: "cancelled", result: "The user stopped it." })));
  await ended(c.id);
  assert.equal(task(c.id).status, "cancelled");

  // Cancelled by the dispatcher from another session of its own: it stopped it, so it is not told (the principal is
  // the agent, not the session); the session that waits for it is not left waiting.
  const T = give(mine, "g1", "T");
  hub.kernel.subscribe(addr(mine), [T], "all", "after T");
  cancel(task(T.id), "a");
  await ended(T.id);
  assert.ok(![...hub.state.gates.values()].some((g) => g.taskIds.includes(T.id)), "the wait is gone");
  assert.deepEqual(task(T.id).ended, { reason: "cancelled", stopper: { kind: "agent", agentId: "a" } });
  await sleep(200);
  assert.ok(!inputs.get(a)!.some((i) => i.text.includes(`task-id="${T.id}"`)), "a is not told of its own cancel");

  // The hub fails a task: what it held up goes too, its assignee is told, its dispatcher has the failure.
  const F = give(mine, "g1", "F");
  await running(F.id);
  const under = give(work(F), "g3", "under F");
  await running(under.id);
  hub.kernel.fail(task(F.id), "backend crashed");
  await ended(F.id);
  assert.deepEqual([task(F.id).status, task(F.id).ended!.reason], ["failed", "error"]);
  assert.match(task(under.id).result!, /^Cancelled with "F" \(t_\w+\), which failed\./);
  await until("a has the failure", () => inputs.get(a)!.some((i) => i.text.includes(`task-id="${F.id}"`) && i.text.includes('status="failed"')));

  for (const id of ["a", "g1", "g2", "g3", "g4", "g5"]) await idle(id);
  console.log("ok 34 the task graph: what goes with a stopped task");
}

// 35. Delivery preferences, asking, the inbox, the user's stop of any task, the ledger and the audit, on real sessions.
{
  await conn.request(Agents.put, { agent: { id: "w1", role: "lead", backend: "mock" } });
  const s = await newSession("w1");
  // sync: the dispatch call returns the result; no turn is spent on it.
  said.set(s, "");
  await prompt(s, call("dispatch_task", { deliveryPref: "sync", to: "b", title: "quick", instructions: "!say QUICK", topic: "modes" }));
  assert.match(said.get(s)!, /result\(dispatch_task\): <xsb-task-result [^>]*title="quick" status="completed">\nQUICK/);
  await sleep(300);
  assert.ok(!(inputs.get(s) ?? []).some((i) => i.text.includes('title="quick"')), "no turn for it");

  // Longer than the call may wait: it returns a receipt, and the result wakes the dispatcher later.
  const config = loadProjectConfig(paths);
  saveProjectConfig(paths, { ...config, limits: { ...config.limits, awaitSeconds: 0.2 } });
  said.set(s, "");
  await prompt(s, call("dispatch_task", { deliveryPref: "sync", to: "b", title: "slow", instructions: "!sleep 900\n!say SLOW", topic: "modes" }));
  assert.match(said.get(s)!, /not finished within 0.2 seconds/);
  await until("slow result as a turn", () => (inputs.get(s) ?? []).some((i) => i.text.includes('title="slow"') && i.text.includes("SLOW")));
  saveProjectConfig(paths, config);
  await idle("w1");

  // ask: the executor asks whoever gave it its task, in the session that gave it, and waits in the call.
  said.set(s, "");
  const asking = [call("ask", { question: "which colour?" }), "!say DONE ASKING"].join("\n");
  await prompt(s, call("dispatch_task", { deliveryPref: "wake", to: "b", title: "asks back", instructions: asking, topic: "modes" }));
  const question = await until("asked", () => inputs.get(s)?.find((i) => i.text.includes("b asks you, and waits for your answer")));
  assert.match(question.text, /which colour\?/);
  const asked = await until("answered", async () => (await tasks()).find((t) => t.title === "asks back" && t.status === "completed"));
  assert.match(asked.result!, /DONE ASKING/);
  assert.match(answered("b"), /result\(ask\): <xsb-task-result [^>]*title="Question from b" status="completed">\necho: <xsb-task from="b"/);
  await idle("w1");
  await idle("b");

  // lazy (the default): the result waits, also while the dispatcher works; the next turn brings it, or inbox now.
  said.set(s, "");
  await prompt(s, [call("dispatch_task", { to: "b", title: "later", instructions: "!say LATER", topic: "modes" }), "!sleep 600", call("inbox", { action: "ack" })].join("\n"));
  assert.match(said.get(s)!, /result\(inbox\): <xsb-task-result [^>]*title="later"[^]*LATER/);
  const later = (await tasks()).find((t) => t.title === "later")!;
  assert.ok(![...hub.state.mail.values()].some((m) => m.results?.taskIds[0] === later.id), "acknowledged");
  said.set(s, "");
  await prompt(s, "anything?");
  assert.doesNotMatch(said.get(s)!, /this notification came for you/);

  // broadcast: one message each.
  said.set(s, "");
  await prompt(s, call("broadcast", { to: ["b", "c"], content: "wrap up by noon", topic: "modes" }));
  assert.equal((said.get(s)!.match(/"message_id"/g) ?? []).length, 2);
  await until("both read it", () => received("b").some((i) => i.text.includes("wrap up by noon")) && received("c").some((i) => i.text.includes("wrap up by noon")));

  // The user stops any task: its dispatcher is notified, its executor's turn that ran for it is stopped.
  await prompt(s, call("dispatch_task", { deliveryPref: "wake", to: "b", title: "long", instructions: "!sleep 2500\n!say NEVER", topic: "modes" }));
  const long = await until("long running", async () => (await tasks()).find((t) => t.title === "long" && t.status === "running"));
  await conn.request(Tasks.cancel, { taskId: long.id });
  const stopped = await until("recorded", async () => (await tasks()).find((t) => t.id === long.id && t.status === "cancelled"));
  assert.deepEqual(stopped.ended, { reason: "cancelled", stopper: { kind: "user" } });
  await until("w1 notified", () => (inputs.get(s) ?? []).some((i) => i.text.includes(`task-id="${long.id}"`) && i.text.includes('status="cancelled"')));
  await until("b's turn stopped", () => !hub.live.get(long.to.sessionId)!.current);

  // message_status: whether the peer's model has seen a message.
  said.set(s, "");
  await prompt(s, call("send_message", { to: "c", content: "fyi", topic: "modes" }));
  const messageId = /"message_id": "(m_\w+)"/.exec(said.get(s)!)![1];
  await until("c saw it", () => hub.state.ledger.get(messageId)?.state === "seen");
  said.set(s, "");
  await prompt(s, call("message_status", { message_id: messageId }));
  assert.match(said.get(s)!, /"state": "seen"/);

  // The audit has what happened, and what was refused.
  await idle("w1");
  await hub.kernel.hooks.settled();
  const audit = hub.state.store.read("audit.jsonl");
  assert.ok(audit.some((r: any) => r.point === "task.ended" && r.event.ended.some((e: any) => e.task.id === long.id)));
  assert.ok(audit.some((r: any) => r.point === "notify.delivered"));
  const refused = hub.kernel.stop(hub.state.tasks.get(long.id)!, agentPrincipal("c"), { status: "cancelled", reason: "cancelled", result: "" });
  assert.ok(isVeto(refused));
  assert.ok(hub.state.store.read("audit.jsonl").some((r: any) => r.point === "task.pre_stop" && r.veto));
  await idle("b");
  await idle("c");
  console.log("ok 35 delivery preferences, ask, inbox, broadcast, the user's stop, the ledger, the audit");
}

// 36. The user's word into a peer's task (docs/DESIGN.md 3.1, 2, 4, 5, 10), on each kind of backend: as claude does
// (into the work at its next step), as codex does with `_session/steering` (the same; dropped if the work ends first),
// and as codex does without it (after the work). In before the work ended, it opens no task and is part of the
// task's result, the record of the whole work; too late, the task ends as if it had not been said, and it is a turn of
// its own, the user's task.
{
  for (const [id, backend] of [["k1", "steerable"], ["k2", "codexlike"], ["k3", "mock"]]) {
    await conn.request(Agents.put, { agent: { id, backend, description: `agent ${id}` } });
  }
  const resultOf = async (id: string): Promise<string> => {
    const ended = await until(`${id} ended`, () => (isTerminalStatus(hub.state.tasks.get(id)!.status) ? hub.state.tasks.get(id)! : undefined));
    return ended.result ?? "";
  };
  const interject = async (agent: string, instructions: string, word: string, late = false): Promise<string> => {
    const task = dispatch(hub.session(a), agent, { title: `${agent} ${word}`, topic: "interjection", instructions, after: [] });
    await until(`${task.id} running`, () => hub.state.tasks.get(task.id)!.status === "running");
    const count = hub.state.tasks.size;
    const answer = conn.request("session/prompt", { sessionId: hub.mainSession(agent).id, prompt: [{ type: "text", text: `!say ${word}` }] });
    const result = await resultOf(task.id);
    await answer;
    await until(`${word} said`, () => answered(agent).includes(word));
    await idle(agent);
    const opened = [...hub.state.tasks.values()].slice(count);
    assert.deepEqual(opened.map((t) => [t.initiator.kind, t.instructions, t.status]), late ? [["user", `!say ${word}`, "completed"]] : []);
    return result;
  };
  const work = `${call("list_agents", {})}\n!sleep 400\n!say DONE`;
  for (const agent of ["k1", "k2"]) {
    // In time: the task's result is all of its work, with the user's word where it came.
    const result = await interject(agent, work, `MID-${agent}`);
    assert.match(result, new RegExp(`^\\[tool\\] list_agents: completed\nresult\\(list_agents\\): [^]*\n\\[the user\\] !say MID-${agent}\nMID-${agent}\nDONE$`), result);
    // Too late (the work has no step left): the task ends without it; it is the next turn.
    assert.doesNotMatch(await interject(agent, "!sleep 400", `LATE-${agent}`, true), /LATE/);
  }
  // A backend that runs what comes while it works after that work: too late, always.
  assert.equal(await interject("k3", "!sleep 400\n!say DONE", "LATE-k3", true), "DONE");
  await idle("a");
  console.log("ok 36 the user's word into a peer's task");
}

// 37. User stop withdraws the accepted backlog on every backend; new work is a separate turn.
{
  for (const backend of ["mock", "steerable", "codexlike"]) {
    const agentId = `stop-queue-${backend}`;
    await conn.request(Agents.put, { agent: { id: agentId, backend } });
    const sessionId = await newSession(agentId);
    const session = hub.session(sessionId);
    const work = dispatch(hub.session(a), agentId, { title: `stop running ${backend}`, topic: "stop queue", instructions: "!sleep 3000\n!say OLD-RUN", after: [] });
    await until("old work inserted", () => session.current?.inserted);
    const queued = dispatch(hub.session(a), agentId, { title: `stop queued ${backend}`, topic: "stop queue", instructions: "!say OLD-QUEUE", after: [] });
    const blocked = dispatch(hub.session(a), agentId, { title: `stop blocked ${backend}`, topic: "stop queue", instructions: "!say OLD-BLOCKED", after: [work.id] });
    const ordinary = hub.kernel.post({ to: addr(session), from: { kind: "agent", ...addr(hub.session(a)) }, kind: "message", content: "OLD-MESSAGE", pref: "wake" }).item;
    const fact = dispatch(session, "b", { title: `stop fact ${backend}`, topic: "stop queue", instructions: "!say SAVED-FACT", after: [] });
    await until("fact queued", () => hub.state.tasks.get(fact.id)?.status === "completed" && [...hub.state.mail.values()].some((m) => m.to.sessionId === sessionId && m.results?.taskIds.includes(fact.id)));
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
    await idle("a");
    await idle("b");
  }
  console.log("ok 37 user stop withdraws backlog, preserves facts, and accepts new work");
}

// 38. Even an already-granted authorization yields: recheck before dispatching after a user stop.
{
  const source = hub.session(a);
  await idle("a");
  const pending = callTool(hub, source, "dispatch_task", { to: "b", title: "MUST-NOT-DISPATCH-AFTER-STOP", instructions: "!say NEVER", topic: "stop race" });
  hub.delivery.userStop(source);
  const result = await pending;
  assert.equal(result.isError, true);
  assert.match(result.text, /work was stopped/);
  assert.ok(![...hub.state.tasks.values()].some((t) => t.title === "MUST-NOT-DISPATCH-AFTER-STOP"));
  console.log("ok 38 in-flight authorization cannot create new work after stop");
}

// 39. Dynamic types, instances and bounded delegation use the same dispatch policy.
{
  hub.putAgent({ id: "team-builder", role: "lead", backend: "mock" });
  const builder = hub.mainSession("team-builder");
  const invoke = (session: LiveSession, name: string, args: unknown) => callTool(hub, session, name, args);
  const ok = async (session: LiveSession, name: string, args: unknown) => {
    const result = await invoke(session, name, args);
    assert.equal(result.isError, false, result.text);
    return JSON.parse(result.text);
  };
  // Exercise the new tool through the actual backend and MCP bridge, not just the tool entry point.
  await prompt(builder.id, call("create_role", { name: "dynamic-worker", instructions: "DYNAMIC-WORKER", skills: [{ name: "research", content: "---\ndescription: Research\nproduces: research\n---\nRESEARCH-PROCEDURE" }] }));
  const worker = (await conn.request(Roles.get, { name: "dynamic-worker" })).role;
  assert.equal(worker.instructions, "DYNAMIC-WORKER");
  assert.equal(worker.grants, undefined);
  assert.equal(worker.skills[0].produces, "research");
  await until("dynamic role announced", () => roleEvents.includes("dynamic-worker: undefined"));
  await ok(builder, "grant_permission", { role: "dynamic-worker", cap: "dispatch", to: ["painter"] });
  await ok(builder, "create_agent", { id: "dw1", role: "dynamic-worker" });
  await ok(builder, "create_agent", { id: "dw2", role: "dynamic-worker" });
  const w1 = hub.mainSession("dw1"), w2 = hub.mainSession("dw2");
  assert.equal(hub.agent("dw1").backend, "mock");
  assert.match(hub.systemPromptFor(hub.agent("dw1")), /DYNAMIC-WORKER/);
  const types = await ok(w1, "list_roles", {});
  assert.deepEqual(types.roles.find((r: any) => r.name === "painter").you_may, ["dispatch", "create_agent", "grant_permission"]);
  // Inherited dispatch works through real delivery; it does not imply permission to send messages.
  let asked = permissionAsked;
  const task = await ok(w2, "dispatch_task", { to: "p1", title: "dynamic dispatch", instructions: "!say DYNAMIC-RESULT", topic: "dynamic team" });
  await until("dynamic task complete", () => hub.state.tasks.get(task.task_id)?.status === "completed");
  assert.equal(permissionAsked, asked);
  permissionChoice = "no";
  assert.equal((await invoke(w1, "send_message", { to: "p1", content: "unauthorized message" })).isError, true);
  assert.equal(permissionAsked, asked + 1);
  // Dispatch authority to the recipient is necessary, and only owned destination rights can be transferred.
  await ok(builder, "create_role", { name: "dynamic-specialist", instructions: "SPECIALIST" });
  asked = permissionAsked;
  assert.equal((await invoke(w1, "grant_permission", { role: "dynamic-specialist", cap: "dispatch", to: ["painter"] })).isError, true);
  assert.equal(permissionAsked, asked + 1);
  assert.equal(loadProjectConfig(paths).permissions?.["dynamic-specialist"], undefined);
  assert.match((await invoke(w1, "grant_permission", { role: "painter", cap: "message", to: ["painter"] })).text, /only message permissions/);
  assert.match((await invoke(w1, "grant_permission", { role: "painter", cap: "dispatch", to: ["*"] })).text, /only dispatch permissions/);
  assert.match((await invoke(w1, "grant_permission", { role: "painter", cap: "dispatch", to: ["lead"] })).text, /only dispatch permissions/);
  // Rejection leaves no role. Once creates a type, without persisting an authorization edge.
  assert.equal((await invoke(w1, "create_role", { name: "dynamic-denied", instructions: "NO" })).isError, true);
  assert.ok(!fs.existsSync(paths.roleDir("dynamic-denied")));
  permissionChoice = "once";
  await ok(w1, "create_role", { name: "dynamic-once", instructions: "ONCE" });
  assert.ok(!loadProjectConfig(paths).permissions?.["dynamic-worker"]?.dispatch?.includes("dynamic-once"));
  permissionChoice = "no";
  assert.equal((await invoke(w1, "create_agent", { id: "once-instance", role: "dynamic-once" })).isError, true);
  assert.ok(!hub.state.agents.has("once-instance"));
  // Always stores type names before there are instances, and another instance reuses both edges.
  permissionChoice = "always";
  await ok(w1, "create_role", { name: "dynamic-always", instructions: "ALWAYS" });
  asked = permissionAsked;
  await ok(w2, "create_agent", { id: "always-instance", role: "dynamic-always" });
  await ok(w2, "grant_permission", { role: "dynamic-always", cap: "dispatch", to: ["painter", "painter"] });
  assert.equal(permissionAsked, asked);
  assert.deepEqual(loadProjectConfig(paths).permissions?.["dynamic-always"], { dispatch: ["painter"] });
  const inherited = await ok(hub.mainSession("always-instance"), "list_agents", {});
  assert.ok(inherited.agents.find((agent: any) => agent.id === "p1").you_may.includes("dispatch"));
  assert.ok(!inherited.agents.find((agent: any) => agent.id === "p1").you_may.includes("message"));
  // Cannot use the creation tools to overwrite roles/instances or smuggle universal grants.
  assert.match((await invoke(builder, "create_role", { name: "dynamic-worker", instructions: "OVERWRITE" })).text, /already exists/);
  assert.match((await invoke(builder, "create_agent", { id: "dw1", role: "lead" })).text, /already exists/);
  assert.match((await invoke(builder, "create_role", { name: "dynamic-escalation", instructions: "BAD", grants: ["dispatch"] })).text, /starts without grants/);
  assert.equal((await invoke(builder, "create_role", { name: "../escape", instructions: "BAD" })).isError, true);
  assert.equal((await invoke(builder, "create_role", { name: "bad-skill", instructions: "BAD", skills: [{ name: "s" }] })).isError, true);
  assert.ok(!fs.existsSync(paths.roleDir("dynamic-escalation")));
  assert.equal((await conn.request(Roles.get, { name: "dynamic-worker" })).role.instructions, "DYNAMIC-WORKER");
  // Already-authorized calls also yield. Stopping at that boundary must prevent every mutation.
  for (const [tool, args] of [
    ["create_role", { name: "dynamic-admitted-stop", instructions: "STOP" }],
    ["create_agent", { id: "dynamic-admitted-instance", role: "dynamic-specialist" }],
    ["grant_permission", { role: "dynamic-specialist", cap: "dispatch", to: ["lead"] }],
  ] as const) {
    const id = `race-${tool}`;
    hub.putAgent({ id, role: "lead", backend: "mock" });
    const source = hub.mainSession(id);
    const pending = invoke(source, tool, args);
    hub.delivery.userStop(source);
    const result = await pending;
    assert.equal(result.isError, true, tool);
    assert.match(result.text, /work was stopped/);
  }
  assert.ok(!fs.existsSync(paths.roleDir("dynamic-admitted-stop")));
  assert.ok(!hub.state.agents.has("dynamic-admitted-instance"));
  assert.equal(loadProjectConfig(paths).permissions?.["dynamic-specialist"], undefined);
  // A stop while waiting on approval voids the creation and its persistent authorization.
  const pending = invoke(w2, "create_role", { name: "dynamic-stopped", instructions: "STOPPED" });
  hub.delivery.userStop(w2);
  const stopped = await pending;
  assert.equal(stopped.isError, true);
  assert.match(stopped.text, /work was stopped/);
  assert.ok(!fs.existsSync(paths.roleDir("dynamic-stopped")));
  assert.ok(!loadProjectConfig(paths).permissions?.["dynamic-worker"]?.dispatch?.includes("dynamic-stopped"));
  permissionChoice = undefined;
  console.log("ok 39 dynamic roles, shared type authorization and bounded delegation");
}

// 40. Confirmed stops keep the backend conversation, image context and attached MCP bridge.
{
  for (const backend of ["mock", "steerable", "codexlike"]) {
    const agentId = `stop-context-${backend}`;
    await conn.request(Agents.put, { agent: { id: agentId, backend } });
    const sessionId = await newSession(agentId), session = hub.session(sessionId);
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
      await prompt(sessionId, `${call("list_agents", {})}\n!images\n!say CONTEXT-AFTER-${n}`);
      await idle(agentId);
      assert.match(answered(agentId), /result\(list_agents\):/);
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

await hub.shutdown();
fs.rmSync(project, { recursive: true, force: true });
console.log("e2e: ok");
process.exit(0);
