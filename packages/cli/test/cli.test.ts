/**
 * The command line against a real background hub: the daemon is started on
 * demand, found again, refuses a second copy, and stops. Backends are the
 * scripted mock agent of @xsb/hub.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const XSB = fileURLToPath(new URL("../bin/xsb", import.meta.url));
const HUB = fileURLToPath(new URL("../../hub/bin/xsb-hub", import.meta.url));
const MOCK = fileURLToPath(new URL("../../hub/test/mock-agent.ts", import.meta.url));

const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "xsb-cli-")));
const home = path.join(project, "home");
fs.mkdirSync(home);
fs.writeFileSync(
  path.join(home, "config.json"),
  JSON.stringify({ version: 1, backends: { mock: { command: process.execPath, args: [MOCK] } } }),
);

function run(bin: string, ...args: string[]): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [bin, ...args], {
    cwd: project,
    // The words are the terminal's language; the assertions below are about the English ones.
    env: { ...process.env, XSB_HOME: home, LC_ALL: "en_US.UTF-8" },
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
  const graph = [ {node:"A",prompt:'!call finish {"summary":"done","assets":[]}'}, {node:"end",kind:"end"}, {from:"A",to:"end"} ].map(v=>JSON.stringify(v)).join("\n");
  assert.match(ok("send",a,"!call execute "+JSON.stringify({graphJsonl:graph})),/version/);
  let result;
  for (let i=0;i<15;i++) {
    result=JSON.parse(ok("workflow","show",a));
    if (result.nodes.at(-1)?.status === "completed") break;
  }
  assert.equal(result.nodes.at(-1)?.status,"completed",JSON.stringify(result));
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
