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
  ok("agent", "add", "a", "--backend", "mock", "--desc", "first");
  ok("agent", "add", "b", "--backend", "mock", "--desc", "second");
  assert.match(ok("hub", "status"), /hub running, pid \d+/);
  assert.match(ok("backends"), /mock\s+installed/); // now the running hub's word
  const noValue = xsb("agent", "add", "z", "--backend");
  assert.ok(noValue.code !== 0 && /--backend needs a value/.test(noValue.err), noValue.err);
  assert.match(ok("--help"), /^xsb: /); // a switch: it needs no value
  assert.match(ok("agent", "list"), /a\s+idle\s+mock/);
  console.log("ok 1 hub starts on demand");

  // 2. A turn, with a tool call through the MCP bridge of the background hub.
  assert.match(ok("send", "a", "hello"), /echo: hello/);
  // Every tool is there; what a's role may do with b is up to its role (none here: the user would be asked, @xsb/hub capabilities.ts).
  assert.match(ok("send", "a", "!call list_agents {}"), /"id": "b"[^]*"you_may": \[\]/);
  ok("send", "a", `!call put_asset {"type":"style","name":"noir","description":"the look","content":"high contrast"}`);
  assert.match(ok("assets", "--type", "style"), /style\/noir\s+v1\s+a\s+the look/);
  console.log("ok 2 send, tools through the bridge");

  // 3. A switch does not swallow the argument after it.
  assert.match(ok("send", "--new", "a", "again"), /echo: again/);
  assert.equal(ok("sessions").trim().split("\n").length, 1);
  console.log("ok 3 switches");

  // 3b. Roles: created from the command line, shown, checked, and what an agent of one is told.
  ok("role", "add", "painter", "--desc", "paints shots", "--backend", "mock", "--instructions", "ROLE-RULES");
  ok("agent", "add", "p", "--role", "painter");
  assert.match(ok("role", "list"), /painter\s+0 mcp, 0 skills, agents: p\s+paints shots/);
  assert.match(ok("role", "show", "painter"), /backend: mock[\s\S]*ROLE-RULES/);
  assert.match(ok("agent", "show", "p"), /You are "p"[\s\S]*ROLE-RULES/);
  assert.equal(xsb("role", "remove", "painter").code, 1);
  ok("agent", "restart", "p");
  ok("agent", "remove", "p");
  ok("role", "remove", "painter");
  console.log("ok 3b roles");

  // 4. An unknown backend is refused with its own exit code.
  const unknown = xsb("agent", "add", "c", "--backend", "nope");
  assert.equal(unknown.code, 13, unknown.err);
  console.log("ok 4 exit codes");

  // 5. A second hub for the same project refuses to start and disturbs nothing.
  const second = run(HUB, project);
  assert.equal(second.code, 1);
  assert.match(second.err, /already running/);
  assert.match(ok("send", "a", "still here"), /echo: still here/);
  console.log("ok 5 one hub per project");

  // 6. Stop; state survives, and the next command starts a hub again.
  assert.match(ok("hub", "stop"), /hub stopped/);
  assert.match(ok("hub", "status"), /not running/);
  assert.match(ok("status"), /a\s+idle\s+mock/);
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
  fs.writeFileSync(path.join(project, ".xsb", "run", "hub.json"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  assert.match(ok("hub", "status"), /not running/);
  assert.doesNotMatch(ok("hub", "stop"), /hub stopped/); // and nothing is sent a signal: this test is still here
  assert.match(ok("send", "a", "after the kill"), /echo: after the kill/);
  assert.notEqual(Number(/pid (\d+)/.exec(ok("hub", "status"))![1]), process.pid);
  console.log("ok 7 a killed hub, and a stale file");
  // Explicit template synchronization warns, requires confirmation, and replaces matching overrides.
  ok("team", "use", "software");
  ok("role", "add", "reviewer", "--instructions", "CUSTOM-SYNC-RULES");
  assert.match(ok("team", "sync", "software", "--preview"), /WARNING:.*Custom changes will be lost/);
  const unconfirmed = xsb("team", "sync", "software");
  assert.equal(unconfirmed.code, 1);
  assert.match(unconfirmed.err, /confirmation is required/);
  assert.match(ok("role", "show", "reviewer"), /CUSTOM-SYNC-RULES/);
  assert.match(ok("team", "sync", "software", "--yes"), /synchronized team software/);
  assert.doesNotMatch(ok("role", "show", "reviewer"), /CUSTOM-SYNC-RULES/);
  ok("team", "drop", "software");
  // 8. Preset teams and their scenarios: a team of the user's, its problems, and a run of the scenarios.
  const mine = path.join(home, "presets", "en", "mine");
  fs.mkdirSync(path.join(mine, "evals"), { recursive: true });
  fs.writeFileSync(path.join(mine, "team.json"), JSON.stringify({ title: "Mine", extends: "film", roles: [{ role: "director", name: "Director" }, { role: "ghost", name: "Ghost" }] }));
  fs.writeFileSync(path.join(mine, "evals", "S9.json"), JSON.stringify({ id: "S9", title: "replaced", role: "director", messages: ["!say DISPATCHED NOTHING"], peers: ["cinematographer"], expect: [{ calls: "dispatch_task" }] }));
  assert.match(ok("team", "list"), /mine\s+Mine \(yours, extends film\)/);
  const checked = xsb("team", "check", "mine");
  assert.equal(checked.code, 1, "an error makes the check fail");
  assert.match(checked.out, /error: team.json lists the role "ghost"/);
  // The film team's scenarios and this team's own, which takes the place of one of the same id; run on the mock
  // backend, which only echoes: the plumbing is tested, not a model.
  const evaluated = spawnSync(process.execPath, [XSB, "team", "eval", "mine", "--backend", "mock", "--runs", "1", "--only", "S9,S6", "--language", "en", "--timeout", "20"], {
    cwd: os.tmpdir(), env: { ...process.env, XSB_HOME: home, LC_ALL: "en_US.UTF-8" }, encoding: "utf8", timeout: 120_000,
  });
  assert.equal(evaluated.status, 0, evaluated.stderr);
  assert.match(evaluated.stdout, /2 scenarios, 1 runs each, on mock/);
  assert.match(evaluated.stdout, /S6\s+0\/1[^\n]*\n\s+did not say/);
  assert.match(evaluated.stdout, /S9\s+0\/1\s+replaced\n\s+no call of \/dispatch_task\//);
  assert.match(evaluated.stdout, /passed 0 of 2 runs/);
  assert.ok(!fs.readdirSync(os.tmpdir()).some((n) => n.startsWith("xsb-eval-home-")), "the runs leave nothing behind");
  console.log("ok 8 preset teams and their scenarios");
} finally {
  xsb("hub", "stop");
}
console.log("cli: ok");
