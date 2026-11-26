// Limits (src/config.ts): all on this machine, per backend for the context ones; read tolerantly, set within range.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BACKEND_LIMITS, GLOBAL_DIR, backendLimit, globalConfigPath, limitSettings, setLimit } from "../src/config.ts";
import { Paths } from "../src/paths.ts";

function machine(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-config-"));
  const home = process.env.XSB_HOME;
  process.env.XSB_HOME = dir;
  t.after(() => { if (home === undefined) delete process.env.XSB_HOME; else process.env.XSB_HOME = home; fs.rmSync(dir, { recursive: true, force: true }); });
}

test("each backend has its own context limits", (t) => {
  machine(t);
  setLimit("claude", "sessionTokens", 400_000);
  assert.equal(backendLimit("claude", "sessionTokens"), 400_000);
  assert.equal(backendLimit("codex", "sessionTokens"), BACKEND_LIMITS.sessionTokens.default, "codex is set apart");
  const shown = limitSettings();
  assert.deepEqual(Object.keys(shown.backends).sort(), ["claude", "codex"]);
  assert.equal(shown.backends.claude.find((l) => l.name === "sessionTokens")!.value, 400_000);
  assert.equal(shown.backends.codex.find((l) => l.name === "sessionTokens")!.value, undefined);
  setLimit("claude", "sessionTokens", null);
  assert.equal(backendLimit("claude", "sessionTokens"), BACKEND_LIMITS.sessionTokens.default, "null goes back to the default");
});

test("limits are checked when set and read tolerantly: out of range or a broken file means the default", (t) => {
  machine(t);
  assert.throws(() => setLimit("claude", "contextRecoveryAttempts", 4), /from 0 to 3/);
  assert.throws(() => setLimit(null, "jobsAtOnce", 1.5), /unknown limit/);
  assert.throws(() => setLimit("claude", "jobsAtOnce", 2), /unknown limit/, "a hub limit is not a backend's");
  assert.throws(() => setLimit("nope", "sessionTokens", 20_000), /unknown backend/);
  fs.writeFileSync(globalConfigPath(), JSON.stringify({ version: 1, limits: { jobsAtOnce: 99 }, backendLimits: { claude: { promptTokens: "lots" } } }));
  assert.equal(backendLimit("claude", "promptTokens"), BACKEND_LIMITS.promptTokens.default);
  fs.writeFileSync(globalConfigPath(), "{ broken");
  assert.equal(backendLimit("claude", "promptTokens"), BACKEND_LIMITS.promptTokens.default);
});

test("removed execution limits in old config are ignored and cannot be set", (t) => {
  machine(t);
  fs.writeFileSync(globalConfigPath(), JSON.stringify({ version: 1, limits: { jobsAtOnce: 1, workflowValidationSteps: 1 } }));
  const shown = limitSettings();
  assert.ok(!("hub" in shown));
  for (const name of ["jobsAtOnce", "workflowValidationSteps"]) {
    assert.throws(() => setLimit(null, name, 2), /unknown limit/);
    assert.throws(() => setLimit("claude", name, 2), /unknown limit/);
    assert.ok(Object.values(shown.backends).every(rows => rows.every(row => row.name !== name)));
  }
});

test("a workspace in the home folder and this machine's settings are two folders", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "xsb-home-"));
  const saved = { XSB_HOME: process.env.XSB_HOME, HOME: process.env.HOME };
  delete process.env.XSB_HOME;
  process.env.HOME = home;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const workspace = new Paths(home);
  assert.equal(globalConfigPath(), path.join(home, GLOBAL_DIR, "config.json"));
  assert.notEqual(path.dirname(globalConfigPath()), workspace.dir);
  assert.notEqual(path.dirname(globalConfigPath()), path.join(home, ".xsb"), "nor the earlier layout's folder");
});

test("a setting is not saved over a config file that cannot be read: what the user wrote in it stays", (t) => {
  machine(t);
  fs.writeFileSync(globalConfigPath(), '{ "backends": { "mine": { "command": "x" } }, broken');
  const before = fs.readFileSync(globalConfigPath(), "utf8");
  assert.throws(() => setLimit("claude", "promptTokens", 8000), /invalid_json|JSON/);
  assert.equal(fs.readFileSync(globalConfigPath(), "utf8"), before, "untouched");
  assert.equal(backendLimit("claude", "promptTokens"), BACKEND_LIMITS.promptTokens.default, "and reading it still works, with defaults");
});
