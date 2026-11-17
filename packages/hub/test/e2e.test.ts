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
import { Agents, Assets, Backends, Boundaries, Connection, SpendExt, TurnFailure, LANGUAGES, LanguageExt, OriginExt, Roles, Steering, Tasks, Teams, explain, languageOf } from "@xsb/protocol";
import type { Language, Task } from "@xsb/protocol";
import { Hub } from "../src/hub.ts";
import { bridgeServer } from "../src/mcp.ts";
import { Paths } from "../src/paths.ts";
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
assert.equal(bridgeServer(paths.socket("mcp"), "test-token").env?.find((e) => e.name === "ELECTRON_RUN_AS_NODE")?.value, "1");
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
const removed: string[] = [];
/** Role changes the hub announced: the role's name and description, or its name alone once removed. */
const roleEvents: string[] = [];
/** Asset versions the hub announced. */
const assetEvents: string[] = [];
/** Agents that said they wait for the user (`ask_user`), with their question. */
const asks: string[] = [];

async function connect(): Promise<Connection> {
  const socket = net.connect(paths.socket("acp"));
  await new Promise((resolve) => socket.once("connect", resolve));
  const conn = new Connection(socket, socket, "test");
  conn.onNotification("session/update", ({ sessionId, update }) => {
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
    return { outcome: { outcome: "selected", optionId: p.options[0].optionId } };
  });
  const init = await conn.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { _meta: { [Agents.capability]: {} } },
  });
  assert.equal(init.protocolVersion, 1);
  assert.equal(init._meta[Steering.metaKey].supported, true);
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
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await sleep(25);
  }
}

let hub = new Hub(project);
await hub.start();
let conn = await connect();

const prompt = (sessionId: string, text: string) =>
  conn.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] });
const newSession = async (agentId: string): Promise<string> =>
  (await conn.request("session/new", { cwd: project, mcpServers: [], _meta: { [Agents.sessionKey]: agentId } })).sessionId;
const tasks = async (): Promise<Task[]> => (await conn.request(Tasks.list, {})).tasks;
const idle = (agentId: string) =>
  until(`${agentId} idle`, async () =>
    (await conn.request(Agents.list)).agents.find((a: any) => a.id === agentId).state === "idle",
  );

for (const [id, backend] of [["a", "mock"], ["b", "mock"], ["c", "steerable"], ["d", "bare"]]) {
  await conn.request(Agents.put, { agent: { id, backend, description: `agent ${id}` }, instructions: `You are ${id}.` });
}
const a = await newSession("a");

// 1. A plain turn. Without `_meta` a client reaches the default (first) agent.
{
  const plain = (await conn.request("session/new", { cwd: project, mcpServers: [] })).sessionId;
  assert.equal((await prompt(plain, "hello")).stopReason, "end_turn");
  assert.match(said.get(plain)!, /echo: hello/);
  console.log("ok 1 plain turn");
}

// 2. Dispatch returns at once; the result comes back as a turn of its own, marked with its origin.
{
  await prompt(a, `!call dispatch_task {"to":"b","title":"key light","instructions":"!say WARM-KEY","topic":"scene 3 lighting"}`);
  assert.match(said.get(a)!, /"status": "dispatched"/);
  const result = await until("task result in a", () => inputs.get(a)?.find((i) => i.text.includes("<xsb-task-result")));
  assert.match(result.text, /by="b"[^>]*status="completed">\nWARM-KEY/);
  assert.deepEqual([result.origin.kind, result.origin.agentId, result.origin.role], ["agent", "b", "task_result"]);
  await idle("a");
  console.log("ok 2 dispatch and result");
}

// 3. A gate: results of several tasks arrive together, and meanwhile the user's message is an ordinary turn.
{
  const before = inputs.get(a)!.length;
  await prompt(
    a,
    [
      `!call dispatch_task {"to":"b","title":"t-b","instructions":"!sleep 1500\\n!say B-DONE","topic":"gate"}`,
      `!call dispatch_task {"to":"c","title":"t-c","instructions":"!say C-DONE","topic":"gate"}`,
      `!await {"mode":"all","note":"merge both"}`,
    ].join("\n"),
  );
  assert.match(said.get(a)!, /Registered \(\d\/2 finished\)/);
  // The finished half of a join is not readable early; it would arrive twice.
  const early = (await until("t-c done", async () => (await tasks()).find((t) => t.title === "t-c" && t.status === "completed"))).id;
  await prompt(a, `!call get_task {"task_id":"${early}"}`);
  assert.match(said.get(a)!, /"result_delivery": "Held for your await_tasks/);
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
      `!call dispatch_task {"to":"b","title":"script","instructions":"!sleep 300\\n!say SCRIPT-V1","topic":"dep"}`,
      `!call dispatch_task {"to":"c","title":"storyboard","instructions":"draw it","topic":"dep","after":["$last"]}`,
    ].join("\n"),
  );
  const held = (await tasks()).find((t) => t.title === "storyboard")!;
  assert.equal(held.status, "blocked");
  const done = await until("storyboard done", async () => (await tasks()).find((t) => t.title === "storyboard" && t.status === "completed"));
  assert.match(done.result!, /SCRIPT-V1/);
  await until("both results in a", () => inputs.get(a)!.filter((i) => i.text.includes('topic="dep"')).length === 2);
  await idle("a");
  console.log("ok 4 dependency");
}

// 5. Steering a backend that cannot be steered: the hub interrupts and continues, still one turn.
{
  const started = Date.now();
  const turn = prompt(a, "!sleep 5000\n!say TOO-LATE");
  await until("a running", () => hub.session(a).current?.started);
  const answer = await conn.request(Steering.method, { sessionId: a, prompt: [{ type: "text", text: "use blue instead" }] });
  assert.equal(answer.outcome, "injected");
  assert.equal((await turn).stopReason, "end_turn");
  assert.ok(Date.now() - started < 4000, "did not wait for the sleep");
  assert.match(said.get(a)!, /echo: \[xsb\] A new message arrived.*use blue instead/);
  assert.doesNotMatch(said.get(a)!, /TOO-LATE/);
  console.log("ok 5 steering by interrupt");
}

// 6. Steering a backend that serves the extension: passed through, the turn runs on.
{
  const c = await newSession("c");
  const turn = prompt(c, "!sleep 400\n!say END");
  await until("c running", () => hub.session(c).current?.started);
  const answer = await conn.request(Steering.method, { sessionId: c, prompt: [{ type: "text", text: "!say MID" }] });
  assert.equal(answer.outcome, "injected");
  assert.equal((await turn).stopReason, "end_turn");
  assert.match(said.get(c)!, /MID\nEND/);
  // Idle: the caller may ask to keep the message and send it as a prompt itself.
  const idleAnswer = await conn.request(Steering.method, {
    sessionId: c,
    prompt: [{ type: "text", text: "x" }],
    _meta: { [Steering.metaKey]: { idleBehavior: "promptRequired" } },
  });
  assert.deepEqual(idleAnswer, { outcome: "promptRequired", reason: "noRunningTurn" });
  console.log("ok 6 native steering");
}

// 7. An agent interjects into a peer's running turn.
{
  const bMain = (await conn.request(Agents.list)).agents.find((x: any) => x.id === "b").mainSessionId;
  await conn.request("session/resume", { sessionId: bMain, cwd: project, mcpServers: [] });
  const busy = prompt(bMain, "!sleep 5000\n!say B-SLOW");
  await until("b running", () => hub.session(bMain).current?.started);
  // A topic b has no work session of: the message goes to its main session, where the user keeps it busy.
  await prompt(a, `!call send_message {"to":"b","content":"stop, plan changed","topic":"plans","interject":true}`);
  assert.match(said.get(a)!, /"delivery": "interjected"/);
  assert.equal((await busy).stopReason, "end_turn");
  const got = inputs.get(bMain)!.find((i) => i.text.includes("plan changed"))!;
  assert.equal(got.origin.steered, true);
  assert.equal(got.origin.agentId, "a");
  assert.doesNotMatch(said.get(bMain)!, /B-SLOW/);
  console.log("ok 7 agent interjects");
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
  console.log("ok 8 memory and continuity");
}

// 9. Permission: the hub decides nothing; a backend that asks is answered by a human.
{
  assert.equal(permissionAsked, 0);
  await prompt(a, "!perm");
  assert.equal(permissionAsked, 1);
  assert.match(said.get(a)!, /perm: selected yes/);

  // A client that cannot answer (a script: it serves no such request) is passed over for one that can.
  const socket = net.connect(paths.socket("acp"));
  await new Promise((resolve) => socket.once("connect", resolve));
  const script = new Connection(socket, socket, "script");
  await script.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  let heard = "";
  script.onNotification("session/update", ({ update }) => {
    if (update.sessionUpdate === "agent_message_chunk") heard += update.content.text;
  });
  const own = (await script.request("session/new", { cwd: project, mcpServers: [], _meta: { [Agents.sessionKey]: "b" } })).sessionId;
  await script.request("session/prompt", { sessionId: own, prompt: [{ type: "text", text: "!perm" }] });
  assert.equal(permissionAsked, 2);
  assert.match(heard, /perm: selected yes/);
  // With nobody connected who can, the turn the script waits for is not left hanging: its request is declined.
  conn.close();
  await sleep(50);
  await script.request("session/prompt", { sessionId: own, prompt: [{ type: "text", text: "!perm" }] });
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
  await prompt(a, `!call dispatch_task {"to":"b","title":"survivor","instructions":"!sleep 600\\n!say AGAIN","topic":"restart"}`);
  await until("survivor running", async () => (await tasks()).find((t) => t.title === "survivor" && t.status === "running"));
  await hub.shutdown();
  hub = new Hub(project);
  await hub.start();
  conn = await connect();

  const { agents } = await conn.request(Agents.list);
  assert.deepEqual(agents.map((x: any) => x.id), ["a", "b", "c", "d"]);
  inputs.delete(a);
  await conn.request("session/load", { sessionId: a, cwd: project, mcpServers: [] });
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
  await fails("nowhere", -33103, "backend_unknown", /no backend named "nowhere".*Known: claude, codex, gemini, grok/);
  await fails("missing", -33101, "backend_not_installed", /"xsb-no-such-command".*does not install/);
  await fails("crashing", -33102, "backend_start_failed", /exited \(3\).*license expired/);
  await fails("from-the-future", -33104, "backend_incompatible", /speaks ACP v9/);
  await fails("signed-out", -32000, "auth_required", /agent "x-signed-out".*not signed in.*Log in with the mock CLI/, true);
  console.log("ok 12 error codes");
}

// 13. A dispatcher can cancel a task. It ends like any other: the result comes back, as "cancelled".
{
  await idle("a");
  await prompt(
    a,
    [
      `!call dispatch_task {"to":"b","title":"first","instructions":"!sleep 300\\n!say FIRST","topic":"cancel"}`,
      `!call dispatch_task {"to":"b","title":"second","instructions":"!say NEVER","topic":"cancel"}`,
      `!call cancel_task {"task_id":"$last"}`,
    ].join("\n"),
  );
  assert.match(said.get(a)!, /Task t_\w+ cancelled\./);
  const result = (title: string) =>
    until(`result of ${title}`, () => inputs.get(a)!.find((i) => i.text.includes(`title="${title}"`) && i.text.includes("<xsb-task-result")));
  assert.match((await result("second")).text, /status="cancelled"/);
  assert.match((await result("first")).text, /status="completed">\nFIRST/);
  await idle("a");
  console.log("ok 13 cancel a task");
}

// 14. An agent without ACP, wrapped with @xsb/adapter, goes through the same chain as the others.
{
  await conn.request(Agents.put, { agent: { id: "e", backend: "wrapped", description: "agent e" }, instructions: "You are e." });
  const e = await newSession("e");
  await prompt(e, "hello");
  assert.match(said.get(e)!, /third party \(instructed\) heard: hello/);

  // It has no steering of its own; the hub makes up for it as for any backend.
  const turn = prompt(e, "wait 5000");
  await until("e running", () => hub.session(e).current?.started);
  const answer = await conn.request(Steering.method, { sessionId: e, prompt: [{ type: "text", text: "change of plan" }] });
  assert.deepEqual(answer, { outcome: "injected" });
  assert.equal((await turn).stopReason, "end_turn");
  assert.match(said.get(e)!, /heard: \[xsb\][^\n]*\nchange of plan/);

  // And it is a peer like the others: a task from an ACP agent, the result back.
  await prompt(a, `!call dispatch_task {"to":"e","title":"wrapped work","instructions":"do the thing","topic":"wrapped"}`);
  const result = await until("result from e", () => inputs.get(a)!.find((i) => i.text.includes('title="wrapped work"')));
  assert.match(result.text, /by="e"[^>]*status="completed">\nthird party \(instructed\) heard: [\s\S]*do the thing/);
  await idle("a");
  console.log("ok 14 wrapped third-party agent");
}

// 15. A role gives its agents their instructions, their MCP servers and their skills.
const call = (tool: string, args: unknown): string => `!call ${tool} ${JSON.stringify(args)}`;
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
  await assert.rejects(conn.request(Agents.put, { agent: { id: "p2", role: "nope" } }), /no role "nope" \(roles: painter\)/);

  await prompt(p, "hi");
  const first = said.get(p)!;
  assert.match(first, /ROLE-RULES: keep to the house style\..*You are p1\./);
  assert.match(first, /- grading: Grading a shot.*- shots: How to break a scene into shots \(arrives with tasks that produce "shot_list"\)/);
  await prompt(p, "!servers");
  assert.match(said.get(p)!, /servers: xsb, gen\n/);
  // Where each tool comes from is in the system prompt: the servers it was given, and that every other tool is the agent program's own.
  const shown = (await conn.request(Agents.get, { id: "p1" })).systemPrompt;
  assert.match(shown, /# Where your tools come from\n[^#]*- xsb: the hub of this team[^#]*- gen: your role's\.[^#]*comes with the agent program itself/);
  assert.doesNotMatch(shown, /- browser:/);
  process.env.XSB_MCP_SERVERS = JSON.stringify({ browser: { command: "xsb-browser-mcp", about: "The side-panel browser; IAB means this one." } });
  // What the provider of a server says of it stands next to its name: agents choose between tools of several sources by it.
  assert.match((await conn.request(Agents.get, { id: "p1" })).systemPrompt, /- browser: given to every agent by the app the user runs xsb in\. The side-panel browser; IAB means this one\./);
  delete process.env.XSB_MCP_SERVERS;
  assert.match(shown, /# How you work\n- Say how you checked\./);
  await prompt(p, call("load_skill", { name: "grading" }));
  assert.match(said.get(p)!, /GRADE-PROCEDURE/);
  // An agent that waits for the user says so, and the observers hear of it.
  await prompt(p, call("ask_user", { question: "Which cast?" }));
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
  // Cancelling is asked of the tool itself, and what it says became of the call is the result.
  assert.match((await resultOf("shot 3")).text, /status="cancelled">\nCancelled by the dispatcher\. render of never was called off and is not billed/);
  await prompt(p, call("start_job", { server: "nope", tool: "render", title: "x" }));
  assert.match(said.get(p)!, /your role has no MCP server "nope"/);
  await idle("p1");
  console.log("ok 16 jobs");
}

// 17. Assets: one library, ids and versions; a task says what it works from and what it must deliver.
{
  await prompt(a, call("put_asset", { type: "character", name: "lin", description: "the lead", content: "LIN: red coat" }));
  assert.match(said.get(a)!, /"id": "character\/lin",\s*"version": 1/);

  const work = [call("put_asset", { type: "shot_list", name: "scene-1", description: "shots of scene 1", content: "SHOT A" }), "!say SHOTS-DONE"];
  await prompt(
    a,
    call("dispatch_task", { to: "p1", title: "shots", instructions: work.join("\n"), topic: "scene 1", inputs: ["character/lin"], produces: "shot_list" }),
  );
  const given = await until("task in p1", () => received("p1").find((i) => i.text.includes('title="shots"')));
  assert.match(given.text, /<xsb-asset id="character\/lin" version="1" by="a"[^>]*>\nthe lead\n---\nLIN: red coat/);
  assert.match(given.text, /has to produce a "shot_list" asset/);
  assert.match(given.text, /<xsb-skill name="shots">\n[\s\S]*SHOT-PROCEDURE/);
  // The dispatcher is told what the contract asks for and the task did not come with.
  assert.match(said.get(a)!, /p1\\" produces \\"shot_list\\" from character, script, but `inputs` has no script asset/);
  const delivered = await until("shots result", () => inputs.get(a)!.find((i) => i.text.includes('title="shots"')));
  assert.match(delivered.text, /SHOTS-DONE[\s\S]*<xsb-asset id="shot_list\/scene-1" version="1" by="p1"/);
  assert.doesNotMatch(delivered.text, /No "shot_list" asset/);

  // The contract is checked by the hub: a task that did not deliver says so in its result.
  await prompt(a, call("dispatch_task", { to: "p1", title: "board", instructions: "!say nothing made", topic: "scene 1", produces: "storyboard" }));
  const empty = await until("board result", () => inputs.get(a)!.find((i) => i.text.includes('title="board"')));
  assert.match(empty.text, /No "storyboard" asset was registered/);
  assert.match(said.get(a)!, /p1\\" has no procedure for producing \\"storyboard\\" and works without one\. Nobody on this team has one/);
  await prompt(a, call("dispatch_task", { to: "b", title: "shots by b", instructions: "!say no", topic: "scene 1b", produces: "shot_list" }));
  assert.match(said.get(a)!, /b\\" has no procedure for producing \\"shot_list\\" and works without one\. On this team it is produced by: p1\./);
  await until("shots by b result", () => inputs.get(a)!.find((i) => i.text.includes('title="shots by b"')));
  await prompt(a, call("dispatch_task", { to: "p1", title: "x", instructions: "x", inputs: ["character/nobody"] }));
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

  // A task that awaits a job of its own stays open: its result, and what it delivered, are those of the turn the job's result starts.
  const then = [call("put_asset", { type: "shot", name: "s1", description: "the take", content: "TAKE" }), "!say TAKE-DONE"];
  const take = [
    call("start_job", { server: "gen", tool: "render", arguments: { prompt: "dawn", ms: 500 }, title: "take 1" }),
    `!await ${JSON.stringify({ note: `\n${then.join("\n")}` })}`,
  ];
  await prompt(a, call("dispatch_task", { to: "p1", title: "render", instructions: take.join("\n"), topic: "scene 1", produces: "shot" }));
  await until("p1 waiting", () => answered("p1").includes("The task you are working on"));
  await idle("p1");
  assert.equal((await tasks()).find((t) => t.title === "render")!.status, "running");
  assert.ok(!inputs.get(a)!.some((i) => i.text.includes('title="render"')), "no result while the task waits");
  const rendered = await until("render result", () => inputs.get(a)!.find((i) => i.text.includes('title="render"')));
  assert.match(rendered.text, /status="completed">\n[\s\S]*TAKE-DONE[\s\S]*<xsb-asset id="shot\/s1" version="1" by="p1"/);
  assert.doesNotMatch(rendered.text, /No "shot" asset/);
  assert.ok(received("p1").some((i) => /rendered: dawn[\s\S]*You awaited these for the task "render" \(t_\w+\) from a, which is still open/.test(i.text)));

  // Cancelling a task that waits cancels what it waits for: nobody wants that any more.
  const slow = [call("start_job", { server: "gen", tool: "render", arguments: { prompt: "dusk", ms: 5000 }, title: "take 2" }), "!await {}"];
  await prompt(a, call("dispatch_task", { to: "p1", title: "render again", instructions: slow.join("\n"), topic: "scene 1" }));
  const waiting = await until("p1 waiting again", async () => (await tasks()).find((t) => t.title === "take 2" && t.status === "running"));
  await idle("p1");
  const again = (await tasks()).find((t) => t.title === "render again")!;
  await prompt(a, call("cancel_task", { task_id: again.id }));
  const gone = await until("take 2 cancelled", async () => (await tasks()).find((t) => t.id === waiting.id && t.status === "cancelled"));
  assert.match(gone.result!, /render of dusk was called off/);
  assert.equal((await tasks()).find((t) => t.id === again.id)!.status, "cancelled");
  assert.ok(![...hub.state.gates.values()].some((gate) => gate.taskId === again.id), "cancelled task leaves no join to resume it");
  await until("a told", () => inputs.get(a)!.some((i) => i.text.includes('title="render again"') && i.text.includes('status="cancelled"')));
  await idle("p1");
  assert.ok(!received("p1").some((i) => i.text.includes('title="take 2"')), "p1 is not handed a result nobody wants");

  // When the user stops the turn, that is not cancelling the work: the task stays open, what it awaits goes on,
  // and the turn that brings the results ends it. Its dispatcher is told.
  const stoppable = [call("start_job", { server: "gen", tool: "render", arguments: { prompt: "noon", ms: 700 }, title: "take 3" }), "!await {}", "!sleep 5000"];
  await prompt(a, call("dispatch_task", { to: "p1", title: "render once more", instructions: stoppable.join("\n"), topic: "scene 1" }));
  const third = await until("take 3 running", async () => (await tasks()).find((t) => t.title === "take 3" && t.status === "running"));
  // The task runs in p1's work session of its topic; that is the turn the user stops.
  conn.notify("session/cancel", { sessionId: hub.findWorkSession("p1", "scene 1")!.id });
  await until("a told of the stop", () => inputs.get(a)!.some((i) => i.text.includes('The user stopped p1\'s turn on your task "render once more"')));
  const done = await until("take 3 done", async () => (await tasks()).find((t) => t.id === third.id && t.status === "completed"));
  assert.match(done.result!, /rendered: noon/);
  await until("render once more finished", async () => (await tasks()).find((t) => t.title === "render once more")?.status === "completed");
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
  const { roles } = await conn.request(Roles.list);
  assert.deepEqual(roles.map((r: any) => [r.name, r.agents, r.skills.map((s: any) => s.name)]), [["painter", ["p1"], ["grading", "shots"]]]);
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
  assert.match(said.get(p)!, /servers: xsb, gen\n$/);
  delete process.env.XSB_MCP_SERVERS;

  // A changed role reaches a running agent once its backend is restarted.
  await prompt(p, "!servers");
  await conn.request(Roles.put, { role: { name: "painter", mcpServers: {} } });
  await conn.request(Agents.restart, { id: "p1" });
  await until("p1 backend gone", () => !hub.session(p)["backend"]);
  await prompt(p, "!servers");
  assert.match(said.get(p)!, /servers: xsb\n$/);

  // Servers the client that started the hub gives every agent, whatever its role.
  process.env.XSB_MCP_SERVERS = JSON.stringify({ browser: { command: "xsb-browser-mcp" } });
  await conn.request(Agents.restart, { id: "p1" });
  await until("p1 backend gone", () => !hub.session(p)["backend"]);
  await prompt(p, "!servers");
  assert.match(said.get(p)!, /servers: xsb, browser\n$/);
  delete process.env.XSB_MCP_SERVERS;

  await assert.rejects(conn.request(Roles.remove, { name: "painter" }), /in use by p1/);
  await conn.request(Agents.put, { agent: { id: "w1", role: "writer", backend: "mock" } });
  await conn.request(Agents.remove, { id: "w1" });
  await until("removal announced", () => removed.includes("w1"));
  await conn.request(Roles.remove, { name: "writer" });
  assert.deepEqual((await conn.request(Roles.list)).roles.map((r: any) => r.name), ["painter"]);
  // Observers hear of every change made through the hub, and of none that was refused.
  await until("role changes announced", () => roleEvents.length === 4);
  assert.deepEqual(roleEvents, ["writer: writes", "writer: writes dialogue", "painter: paints shots", "writer"]);

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

// 20. A client that shows transcripts opts in to its own input: it learns when its message became a turn.
{
  const socket = net.connect(paths.socket("acp"));
  await new Promise((resolve) => socket.once("connect", resolve));
  const echoing = new Connection(socket, socket, "echoing");
  const seen: string[] = [];
  echoing.onNotification("session/update", ({ update }) => {
    if (update.sessionUpdate === "user_message_chunk") seen.push(`in ${update.messageId}${update._meta[OriginExt.key].steered ? " steered" : ""}`);
    if (update.sessionUpdate === "agent_message_chunk" && /ONE|TWO/.test(update.content.text)) seen.push(`out ${update.content.text.trim()}`);
  });
  await echoing.request("initialize", { protocolVersion: 1, clientCapabilities: { _meta: { [OriginExt.capability]: {} } } });
  const sessionId = (await echoing.request("session/new", { cwd: project, mcpServers: [], _meta: { [Agents.sessionKey]: "c" } })).sessionId;
  const mine = (messageId: string, text: string) => ({ sessionId, prompt: [{ type: "text", text }], _meta: { [OriginExt.key]: { messageId } } });
  const first = echoing.request("session/prompt", mine("mine-1", "!sleep 300\n!say ONE"));
  const second = echoing.request("session/prompt", mine("mine-2", "!say TWO")); // waits behind the first
  await until("first turn running", () => seen.includes("in mine-1"));
  assert.deepEqual(seen, ["in mine-1"]); // the waiting message is not announced yet
  assert.equal((await echoing.request(Steering.method, mine("mine-3", "!say MID"))).outcome, "injected");
  await Promise.all([first, second]);
  assert.deepEqual(seen, ["in mine-1", "in mine-3 steered", "out ONE", "in mine-2", "out TWO"]);
  // A message that waits for its turn can be sent now instead: steered under its own id, it joins the running turn and never has one of its own.
  seen.length = 0;
  const running = echoing.request("session/prompt", mine("mine-4", "!sleep 300\n!say ONE"));
  const waiting = echoing.request("session/prompt", mine("mine-5", "!say TWO"));
  await until("the turn running", () => seen.includes("in mine-4"));
  assert.equal((await echoing.request(Steering.method, mine("mine-5", "!say TWO"))).outcome, "injected");
  assert.deepEqual([await running, await waiting], [{ stopReason: "end_turn" }, { stopReason: "cancelled" }]);
  assert.deepEqual(seen.filter((line) => line.startsWith("in")), ["in mine-4", "in mine-5 steered"]);
  assert.equal(seen.filter((line) => line === "out TWO").length, 1, "said once, not again as a turn of its own");
  // A client that did not opt in is not sent its own input, as in plain ACP.
  const quiet = await newSession("c");
  await prompt(quiet, "!say THREE");
  assert.equal(inputs.get(quiet), undefined);
  echoing.close();
  console.log("ok 20 own input, echoed when it becomes a turn");
}

// 21. Input is content blocks, not only text. An image reaches a backend that reads images as it is; another is told one was there.
{
  const picture = [{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }, { type: "resource_link", uri: "file:///tmp/notes.md", name: "notes.md" }];
  const sighted = await newSession("c");
  await conn.request("session/prompt", { sessionId: sighted, prompt: picture });
  assert.match(said.get(sighted)!, /echo: look \| <image image\/png> \| <resource_link file:\/\/\/tmp\/notes\.md>/);
  const blind = await newSession("b");
  await conn.request("session/prompt", { sessionId: blind, prompt: picture });
  assert.match(said.get(blind)!, /echo: look \| \[An image \(image\/png\) was attached here; you cannot see images\.\] \| <resource_link/);
  // What was sent is what the transcript keeps, whatever the backend could read.
  const kept = hub.state.store.read(Paths.transcript("b", blind)).map((r: any) => r.update).filter((u: any) => u.sessionUpdate === "user_message_chunk");
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
  assert.deepEqual(left, [["painter", undefined], ["qa", undefined]]);
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

  const declare = async (language: string): Promise<Connection> => {
    const socket = net.connect(paths.socket("acp"));
    const client = new Connection(socket, socket, `client-${language}`);
    await client.request("initialize", { protocolVersion: 1, clientCapabilities: { _meta: { [LanguageExt.key]: language } } });
    return client;
  };
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
  assert.match((await chinese.request(Agents.get, { id: "ad" })).systemPrompt, /- casting: you, from brief, script, style_guide\n- character: you, from brief, script, casting/);

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
  await prompt(a, `!call dispatch_task {"to":"b","title":"dropped","instructions":"!sleep 600\\n!say NEVER-AGAIN","topic":"quit"}`);
  await prompt(a, `!call dispatch_task {"to":"b","title":"dropped too","instructions":"!say NOR-THIS","topic":"quit"}`); // waits behind the first
  await until("dropped running", async () => (await tasks()).find((t) => t.title === "dropped" && t.status === "running"));
  await hub.shutdown();
  fs.writeFileSync(paths.abandonMark, ""); // what `stopHub(paths, true)` leaves
  hub = new Hub(project);
  await hub.start();
  conn = await connect();
  assert.ok(!fs.existsSync(paths.abandonMark), "the mark is for one start");
  assert.equal(hub.state.mail.size, 0);
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

// 25. Task lifecycle: jobs keep their task open; the user writing past a dispatcher is told to it; a turn that mail
// started and that failed is recorded where the user sees it; the same wait asked for twice is one.
{
  await conn.request(Roles.put, { role: { name: "renderer", mcpServers: { gen: { command: node, args: [GENERATOR] } } } });
  await conn.request(Agents.put, { agent: { id: "r9", role: "renderer", backend: "mock" } });
  const p = await newSession("r9");
  // Not awaited, a job still holds its task: the result is not complete while it is being made.
  await prompt(a, call("dispatch_task", { to: "r9", title: "fire and forget", instructions: [call("start_job", { server: "gen", tool: "render", arguments: { prompt: "rain", ms: 600 }, title: "rain take" }), "!say STARTED"].join("\n"), topic: "lifecycle" }));
  const job = await until("rain take running", async () => (await tasks()).find((t) => t.title === "rain take" && t.status === "running"));
  const parent = (await tasks()).find((t) => t.title === "fire and forget")!;
  assert.equal(job.partOf, parent.id);
  await until("its turn over", () => !hub.live.get(p)!.busy || (hub.state.tasks.get(parent.id)!.status === "running" && [...hub.state.gates.values()].some((g) => g.taskId === parent.id)));
  assert.equal(hub.state.tasks.get(parent.id)!.status, "running", "still open while the job runs");
  await until("finished with the job", async () => (await tasks()).find((t) => t.id === parent.id)?.status === "completed");
  await idle("r9");
  await idle("a");

  // The user writes to p1 while it works on a's task: a is told, once for what is said within a short while.
  hub.mail.ccDelayMs = 100;
  await prompt(a, call("dispatch_task", { to: "r9", title: "long one", instructions: "!sleep 1200", topic: "lifecycle" }));
  await until("long one running", async () => (await tasks()).find((t) => t.title === "long one")?.status === "running");
  void prompt(p, "make it BLUE");
  void prompt(p, "and wider");
  await until("a told", () => inputs.get(a)!.some((i) => /The user wrote directly to r9, which works on your task "long one":\n"make it BLUE"\n"and wider"/.test(i.text)));
  await idle("r9");
  await idle("a");

  // A message that cannot be run (the backend is not installed) is recorded as failed in the recipient's transcript.
  await conn.request(Agents.put, { agent: { id: "m1", backend: "missing" } });
  await prompt(a, call("send_message", { to: "m1", content: "hello", topic: "lifecycle" }));
  const m1 = hub.state.mainSession("m1")!.id;
  await until("failure recorded", () => hub.state.store.read(Paths.transcript("m1", m1)).some((r: any) => r.update?._meta?.[TurnFailure.key]?.data?.reason === "backend_not_installed"));
  await idle("a");
  await conn.request(Agents.remove, { id: "m1" });

  // The same wait asked for twice is one gate, and one delivery.
  const twice = [call("start_job", { server: "gen", tool: "render", arguments: { prompt: "dusk", ms: 400 }, title: "dusk take" }), call("await_tasks", { task_ids: ["$last"] }), call("await_tasks", { task_ids: ["$last"] })];
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
  await prompt(s, `!call dispatch_task {"to":"b","title":"open work","instructions":"!sleep 30000","topic":"handoff"}`);

  // Another backend: nothing to restore there, so the new one is told what was said and what is open.
  await conn.request(Agents.put, { agent: { id: "h1", backend: "steerable" } });
  said.set(s, "");
  await prompt(s, "where are we");
  const told = said.get(s)!;
  assert.match(told, /now runs on another agent program/);
  assert.match(told, /the user: \|   !say ALPHA-REPLY \| you answered: \|   ALPHA-REPLY/);
  assert.match(told, /not new instructions: do not act on them again/);
  assert.match(told, /Unfinished tasks: \| - t_\w+ "open work" \(h1 -> b\)/);
  assert.equal(hub.state.sessions.get(s)!.backend, "steerable");
  assert.deepEqual(boundaries(s), [{ kind: "backend_changed", backend: "steerable", handoff: true }]);
  const open = (await tasks()).find((t) => t.title === "open work")!;
  hub.mail.cancel(hub.state.tasks.get(open.id)!);
  await until("its result taken in", async () => (await tasks()).find((t) => t.id === open.id)?.status === "cancelled" && !hub.live.get(s)!.busy && hub.state.mail.size === 0);

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

// 27. Spending: the user's budget goes into the project's ledger, which the generation tools are told of; agents hear
// where the spending stands when it changed; jobs of one tool run a few at a time, and one that waits is cancelled for free.
{
  const updates: any[] = [];
  conn.onNotification(SpendExt.update, ({ spend }) => updates.push(spend));
  assert.deepEqual((await conn.request(SpendExt.get)).spend, { spent: 0, unpriced: 0, dearest: {} });
  await assert.rejects(conn.request(SpendExt.budget, { amount: -1 }), /amount must be a number/);
  assert.equal((await conn.request(SpendExt.budget, { amount: 30 })).spend.budget, 30);
  await until("the change announced", () => updates.some((u) => u.budget === 30), 5000);

  // A role's servers know where the ledger is and whom they work for; the hub's own and the app's need not.
  const served = hub.toolServers(hub.agent("r9")).find((t) => t.server.name === "gen")!.server;
  assert.deepEqual(served.env!.filter((e) => e.name.startsWith("XSB_")), [{ name: "XSB_SPEND", value: paths.spend }, { name: "XSB_AGENT", value: "r9" }]);

  // Told once, and again when it changed.
  const s9 = await newSession("r9");
  await prompt(s9, "hello");
  assert.match(said.get(s9)!, /Spent on generation in this project so far: about 0\.00 yuan of the budget of 30\.00 yuan/);
  said.set(s9, "");
  await prompt(s9, "again");
  assert.doesNotMatch(said.get(s9)!, /Spent on generation/);
  fs.appendFileSync(paths.spend, JSON.stringify({ op: "spend", at: "t", tool: "generate_video", output: "a.mp4", usage: "48437 tokens", amount: 2.23, basis: "test" }) + "\n");
  await prompt(s9, "and now");
  assert.match(said.get(s9)!, /about 2\.23 yuan of the budget of 30\.00 yuan \(estimates\)\. So far generate_video up to about 2\.23 yuan a call\./);

  // Three jobs of one tool: two run, one waits; the one that waits is cancelled without the tool being asked.
  const job = (title: string) => call("start_job", { server: "gen", tool: "render", arguments: { prompt: title, ms: 500 }, title });
  await prompt(s9, [job("q1"), job("q2"), job("q3")].join("\n"));
  const byTitle = async (title: string) => (await tasks()).find((t) => t.title === title)!;
  assert.deepEqual([(await byTitle("q1")).status, (await byTitle("q2")).status, (await byTitle("q3")).status], ["running", "running", "queued"]);
  await prompt(s9, call("cancel_task", { task_id: (await byTitle("q3")).id }));
  assert.match((await byTitle("q3")).result!, /before it started: it waited for its turn in xsb, nothing was submitted, nothing is billed/);
  // One that waits starts when a place is free.
  await prompt(s9, job("q4"));
  assert.equal((await byTitle("q4")).status, "queued");
  await until("q4 done", async () => (await byTitle("q4")).status === "completed");
  await idle("r9");
  console.log("ok 27 spending and jobs at a time");
}

// 28. Work sessions: a peer's work goes to the agent's session of its topic, not to its main one; one that grew past
// the limit takes no new work, and the session that continues it is handed its conversation. A session is not given
// again what it was given already: an unchanged asset is referred to, a changed one comes with what changed.
{
  const bInfo = async () => (await conn.request(Agents.list)).agents.find((x: any) => x.id === "b");
  const sessionOf = (title: string) => hub.state.tasks.get([...hub.state.tasks.values()].find((t) => t.title === title)!.id)!.to.sessionId;
  const done = (title: string) => until(`${title} done`, async () => (await tasks()).find((t) => t.title === title)?.status === "completed");
  const send = async (title: string, topic: string, instructions: string, more: object = {}) => {
    await prompt(a, call("dispatch_task", { to: "b", title, instructions, topic, ...more }));
    await done(title);
  };
  await send("w1", "Story ROOM", "!say W1-DONE");
  await send("w2", "story room", "!say W2-DONE");
  await send("w3", "other room", "!say W3-DONE");
  const main = (await bInfo()).mainSessionId;
  assert.equal(sessionOf("w1"), sessionOf("w2"), "one topic, one work session");
  assert.notEqual(sessionOf("w1"), sessionOf("w3"));
  assert.ok(![sessionOf("w1"), sessionOf("w3")].includes(main), "not the main session");
  assert.deepEqual((await bInfo()).workSessions.filter((w: any) => /room/.test(w.topic)).map((w: any) => [w.topic, w.retired]), [["story room", false], ["other room", false]]);

  // Grown past the limit: the next work of the topic goes to a new session that continues it, with a handoff.
  const config = JSON.parse(fs.readFileSync(paths.config, "utf8"));
  fs.writeFileSync(paths.config, JSON.stringify({ ...config, limits: { sessionTokens: 1000 } }));
  await send("w4", "story room", "!usage 5000\n!say W4-DONE");
  await send("w5", "story room", "what do you know");
  const old = sessionOf("w1");
  const renewed = sessionOf("w5");
  assert.notEqual(renewed, old);
  assert.deepEqual([hub.state.sessions.get(old)!.retired, hub.state.sessions.get(renewed)!.continues], [true, old]);
  const handed = hub.state.store.read(Paths.transcript("b", renewed)).map((r: any) => r.update).filter((u: any) => u.sessionUpdate === "agent_message_chunk").map((u: any) => u.content.text).join("");
  assert.match(handed, /takes over the work of this topic from an earlier session of yours/);
  assert.match(handed, /W1-DONE[^]*W4-DONE/);
  assert.ok(hub.state.store.read(Paths.transcript("b", renewed)).some((r: any) => r.update._meta?.[Boundaries.key]?.kind === "renewed"));
  fs.writeFileSync(paths.config, JSON.stringify(config));

  // Given once in full; then by reference; then, changed, with what changed.
  await prompt(a, call("put_asset", { type: "doc", name: "plan", description: "the plan", content: "LINE A\nLINE B\nLINE D" }));
  await send("i1", "inputs", "!say I1", { inputs: ["doc/plan"] });
  await send("i2", "inputs", "!say I2", { inputs: ["doc/plan"] });
  await prompt(a, call("put_asset", { type: "doc", name: "plan", description: "the plan", content: "LINE A\nLINE C\nLINE D" }));
  await send("i3", "inputs", "!say I3", { inputs: ["doc/plan"] });
  const taskText = (title: string) => received("b").find((i) => i.text.includes(`title="${title}"`))!.text;
  assert.match(taskText("i1"), /---\nLINE A\nLINE B\nLINE D/);
  assert.match(taskText("i2"), /Its text is the version you were given with task t_\w+ earlier in this conversation, unchanged: it is not repeated here\./);
  assert.doesNotMatch(taskText("i2"), /LINE B/);
  assert.match(taskText("i3"), /What changed since version 1, which you were given before:\n<xsb-changes asset="doc\/plan">\n@@ line 2\n\+ LINE C\n- LINE B\n<\/xsb-changes>\n<xsb-asset id="doc\/plan" version="2"[^]*LINE C/);

  // A long result that a task builds on is told in part; the rest is a get_task away.
  const long = "R".repeat(3000);
  await prompt(a, call("dispatch_task", { to: "b", title: "long result", instructions: `!say ${long}`, topic: "chain" }));
  const first = (await tasks()).find((t) => t.title === "long result")!;
  await prompt(a, call("dispatch_task", { to: "b", title: "builds on it", instructions: "!say OK", topic: "chain", after: [first.id] }));
  await done("builds on it");
  assert.match(taskText("builds on it"), new RegExp(`R{1500}…\\n\\(The result goes on; get_task ${first.id} has all of it\\.\\)`));
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

  // An edit holds at once.
  write("en/solo/roles/poet/instructions.md", "POET-RULES-2");
  assert.match((await conn.request(Agents.get, { id: "poet1" })).systemPrompt, /POET-RULES-2/);

  // Made the project's own, a laid-over role is written out as it applies.
  await conn.request(Roles.put, { role: { name: "reviewer", description: "ours" } });
  assert.match(fs.readFileSync(path.join(paths.roleDir("reviewer"), "instructions.md"), "utf8"), /STRICT-EXTRA$/);
  assert.ok(fs.existsSync(path.join(paths.roleDir("reviewer"), "skills", "extra", "SKILL.md")));
  await conn.request(Roles.remove, { name: "reviewer" });

  // A team of the user's that builds on another is started from the app.
  const { team: mine } = await conn.request(Teams.derive, { id: "film-mine", base: "film" });
  assert.deepEqual([mine.source, mine.extends, mine.language], ["user", "film", "zh-CN"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "zh-CN/film-mine/team.json"), "utf8")).extends, "film");
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

// 31. Parallel work: an agent's peer work runs one turn at a time, unless the dispatcher says a task depends on no
// other (`parallel`): then up to `limits.sessionsAtOnce` of its work sessions run at once. The user is never kept waiting.
{
  const statusOf = async (title: string) => (await tasks()).find((t) => t.title === title)?.status;
  const send = (title: string, parallel?: boolean) => prompt(a, call("dispatch_task", { to: "b", title, instructions: "!sleep 900\n!say DONE", topic: `par ${title}`, ...(parallel ? { parallel } : {}) }));
  // Without it: one after the other, though the topics differ.
  await send("serial 1");
  await send("serial 2");
  await until("serial 1 running", async () => (await statusOf("serial 1")) === "running");
  assert.equal(await statusOf("serial 2"), "queued", "waits for its place");
  await until("serial 2 done", async () => (await statusOf("serial 2")) === "completed", 8000);
  // With it: two at once, the third waits.
  await send("par 1", true);
  await send("par 2", true);
  await send("par 3", true);
  await until("two running", async () => (await statusOf("par 1")) === "running" && (await statusOf("par 2")) === "running");
  assert.equal(await statusOf("par 3"), "queued");
  // Meanwhile the user is answered at once.
  const bMain = (await conn.request(Agents.list)).agents.find((x: any) => x.id === "b").mainSessionId;
  said.set(bMain, "");
  await prompt(bMain, "are you there");
  assert.match(said.get(bMain)!, /echo: [^\n]*are you there/);
  await until("all done", async () => (await statusOf("par 3")) === "completed", 8000);
  await idle("b");
  await idle("a");
  console.log("ok 31 parallel work");
}

await hub.shutdown();
fs.rmSync(project, { recursive: true, force: true });
console.log("e2e: ok");
process.exit(0);
