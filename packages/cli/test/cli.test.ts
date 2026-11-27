/**
 * The command line against a real background hub: the daemon is started on
 * demand, found again, refuses a second copy, and stops. Backends are the
 * scripted mock agent of @xsb/hub.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConversationEvent } from "@xsb/protocol";

const XSB = fileURLToPath(new URL("../bin/xsb", import.meta.url));
const HUB = fileURLToPath(new URL("../../hub/bin/xsb-hub", import.meta.url));
const MOCK = fileURLToPath(new URL("../../hub/test/mock-agent.ts", import.meta.url));

const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xsb-cli-")));
const home = path.join(project, "home");
const env = { ...process.env, XSB_HOME: home, LC_ALL: "en_US.UTF-8" };
fs.mkdirSync(home);
fs.writeFileSync(
  path.join(home, "config.json"),
  JSON.stringify({ version: 1, backends: { mock: { command: process.execPath, args: [MOCK] } } }),
);

function run(bin: string, ...args: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [bin, ...args], {
    cwd: project,
    // The words are the terminal's language; the assertions below are about the English ones.
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
const xsb = (...args: string[]) => run(XSB, ...args);
const ok = (...args: string[]): string => {
  const r = xsb(...args);
  assert.equal(r.code, 0, `xsb ${args.join(" ")}: ${r.err}`);
  return r.out;
};

function chat(sessionId: string, ...flags: string[]) {
  const child = spawn(process.execPath, [XSB, "chat", sessionId, ...flags], { cwd: project, env, timeout: 30_000 });
  const closed = once(child, "close");
  const chunks = child.stdout.setEncoding("utf8")[Symbol.asyncIterator]();
  let output = "";
  return {
    async until(marker: string) {
      while (!output.includes(marker)) {
        const chunk = await chunks.next();
        assert.ok(!chunk.done, `chat ended before printing ${marker}: ${output}`);
        output += chunk.value;
      }
      return output;
    },
    async close() {
      child.stdin.end("/quit\n");
      for await (const chunk of chunks) output += chunk;
      assert.equal((await closed)[0], 0);
    },
  };
}

try {
  ok("init");
  assert.match(ok("backends"), /mock\s+installed/);

  // 1. The first command that needs the hub starts it.
  assert.match(ok("hub", "status"), /not running/);
  const a = ok("session","new","First","--backend","mock").trim();
  const b = ok("session","new","Second","--backend","mock").trim();
  assert.notEqual(a,b);
  assert.match(ok("hub","status"),/hub running, pid \d+/);
  assert.match(ok("--help"),/session new/);
  assert.equal(ok("sessions").trim().split("\n").length,2);
  assert.match(ok("send",a,"hello"),/echo: hello/);
  assert.equal(JSON.parse(ok("workflow","show",a)).nodes.length,0);
  const live = chat(a);
  await live.until(`talking to ${a}.`);
  const graph = [ {node:"A",prompt:'!call finish {"summary":"done"}'}, {node:"end",kind:"end"}, {from:"A",to:"end"} ].map(v=>JSON.stringify(v)).join("\n");
  assert.match(ok("send",a,"!call execute "+JSON.stringify({graphJsonl:graph})),/version/);
  let result;
  for (let i=0;i<15;i++) {
    result=JSON.parse(ok("workflow","show",a));
    if (result.nodes.at(-1)?.status === "completed") break;
  }
  assert.equal(result.nodes.at(-1)?.status,"completed",JSON.stringify(result));
  const liveReport = await live.until("> done");
  assert.match(liveReport, /\[Workflow\]\n# Workflow completed\n[\s\S]*## `A`\n\n> done/);
  await live.close();
  assert.match(ok("send",result.nodes[0].sessionId,"hello task","--history-only"),/\[xSB task conversation\][^]*hello task/);
  assert.equal(JSON.parse(ok("workflow","show",b)).nodes.length,0);
  assert.equal(xsb("session","new","--backend","nope").code,13);
  assert.notEqual(xsb("role","add","painter").code,0);
  console.log("ok independent sessions, direct chat, workflow through the MCP bridge and task chat");
  // 5. A second hub for the same project refuses to start and disturbs nothing.
  const second = run(HUB, project);
  assert.equal(second.code, 1);
  assert.match(second.err, /already running/);
  assert.match(ok("send", b, "still here"), /echo: still here/);
  console.log("ok 5 one hub per project");

  // 6. Stop; state survives, and the next command starts a hub again.
  assert.match(ok("hub", "stop"), /hub stopped/);
  assert.match(ok("hub", "status"), /not running/);
  // A legacy transcript can contain overlapping entries alongside ordinary streamed output.
  const agentsDir = path.join(project, ".xsb2", "agents");
  const transcript = fs.readdirSync(agentsDir).map(agent => path.join(agentsDir, agent, "sessions", a + ".jsonl")).find(file => fs.existsSync(file))!;
  const publication = (id: string, label: string, markdown: string) => ({ sessionUpdate: "session_info_update", _meta: { [ConversationEvent.key]: {
    schemaVersion: 1, id: "shared", sessionId: a, source: { kind: "plugin", id, label }, markdown,
  } } });
  const stream = (value: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: value } });
  const inspection = publication("inspector", "Inspection", "## Lights\r\n\n\x1b[31mPass\x1b[0m\x07");
  for (const update of [stream("before report"), inspection, stream("after "), inspection, stream("report"),
    publication("second", "Second plugin", "other output")]) {
    fs.appendFileSync(transcript, JSON.stringify({ ts: new Date().toISOString(), update }) + "\n");
  }
  const replay = chat(a, "--history");
  const history = await replay.until(`talking to ${a}.`);
  assert.match(history, /\[Workflow\]\n# Workflow completed\n[\s\S]*## `A`\n\n> done/);
  assert.match(history, /before report\n\[Inspection\]\n## Lights\n\nPass\nafter report\n\[Second plugin\]\nother output\n/);
  assert.equal(history.split("[Inspection]").length, 2);
  assert.doesNotMatch(history, /[\x07\x1b\r]/);
  await replay.close();
  assert.ok(ok("sessions").includes(a));
  console.log("ok 6 stop and restart");

  // 7. Whether a hub runs is whether its lock is held, not what a file says. A hub that was killed leaves its file
  // behind, and the process id in it may be another program's by now: here, this test's own.
  const hubPid = Number(/pid (\d+)/.exec(ok("hub", "status"))![1]);
  process.kill(hubPid, "SIGKILL");
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(hubPid, 0);
      spawnSync("sleep", ["0.05"]);
    } catch {
      break;
    }
  }
  fs.writeFileSync(path.join(project, ".xsb2", "run", "hub.json"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  assert.match(ok("hub", "status"), /not running/);
  assert.doesNotMatch(ok("hub", "stop"), /hub stopped/); // and nothing is sent a signal: this test is still here
  assert.match(ok("send", b, "after the kill"), /echo: after the kill/);
  assert.notEqual(Number(/pid (\d+)/.exec(ok("hub", "status"))![1]), process.pid);
  console.log("ok 7 a killed hub, and a stale file");
} finally {
  xsb("hub", "stop");
}
console.log("cli: ok");
