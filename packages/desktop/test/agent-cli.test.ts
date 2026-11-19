import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { AgentClis, agentCli, codexTarget, configPath, configTemplate, persistPath, run } from "../src/agent-cli.ts";
import type { Runner } from "../src/agent-cli.ts";

const ok = (stdout = "", code = 0) => ({ code, stdout, timedOut: false });
async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "xsb-cli-test-"));
  return { home, clean: () => fs.rm(home, { recursive: true, force: true }) };
}

function registry(executable: string | null = "/fake/cli") {
  return { executable: () => executable, refresh: async (_extra?: string[]) => {}, setPath: (_name: string, file: string) => { executable = file; return true; } };
}

test("providers reject arbitrary IPC names and respect CLI home overrides", () => {
  assert.throws(() => agentCli("../../elsewhere"));
  assert.equal(configPath("codex", "/home/test", {}), "/home/test/.codex/config.toml");
  assert.equal(configPath("claude", "/home/test", { CLAUDE_CONFIG_DIR: "/custom" }), "/custom/settings.json");
  assert.equal(configPath("codex", "/home/test", { CODEX_HOME: "/custom" }), "/custom/config.toml");
  assert.match(configTemplate("codex", "zh-CN"), /sandbox_mode = "read-only"/);
  assert.match(configTemplate("codex", "en"), /approval_policy = "on-request"/);
  const claude = JSON.parse(configTemplate("claude", "zh-CN"));
  assert.deepEqual(claude.permissions.allow, []);
  assert.equal(claude.permissions.defaultMode, "default");
  assert.equal(claude.permissions.disableBypassPermissionsMode, "disable");
  assert.ok(!("env" in claude));
  assert.equal(codexTarget("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(codexTarget("win32", "x64"), "x86_64-pc-windows-msvc");
  assert.throws(() => codexTarget("freebsd", "x64"));
});

test("inspection never creates files; concurrent creation never overwrites user settings", async () => {
  const { home, clean } = await fixture();
  const old = { codex: process.env.CODEX_HOME, claude: process.env.CLAUDE_CONFIG_DIR };
  delete process.env.CODEX_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    const service = new AgentClis(registry(), home, async () => ok(), home);
    const inspected = await service.config("codex");
    assert.equal(inspected.exists, false);
    await assert.rejects(fs.stat(path.dirname(inspected.path)), { code: "ENOENT" });
    await Promise.all([service.config("codex", true), service.config("codex", true)]);
    const content = await fs.readFile(inspected.path, "utf8");
    assert.equal(content, configTemplate("codex", "en"));
    if (process.platform !== "win32") assert.equal((await fs.stat(inspected.path)).mode & 0o777, 0o600);
    await fs.writeFile(inspected.path, "# user configuration\n");
    await service.config("codex", true);
    assert.equal(await fs.readFile(inspected.path, "utf8"), "# user configuration\n");
    const claude = await service.config("claude", true, "zh-CN");
    JSON.parse(await fs.readFile(claude.path, "utf8"));
    assert.match(await fs.readFile(path.join(path.dirname(claude.path), "settings.README.md"), "utf8"), /claude auth login/);
  } finally {
    if (old.codex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = old.codex;
    if (old.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old.claude;
    await clean();
  }
});

test("checks use only version and local auth commands and distinguish every failure", async () => {
  const calls: string[][] = [];
  let answer = ok('{"loggedIn":true,"email":"private@example.com","apiProvider":"firstParty"}');
  const runner: Runner = async (_file, args) => { calls.push(args); return args[0] === "--version" ? ok("cli 2.1.0") : answer; };
  const service = new AgentClis(registry(), "/unused", runner);
  assert.deepEqual(await service.check("claude"), { state: "ready", version: "2.1.0" });
  answer = ok('{"loggedIn":false}', 1);
  assert.equal((await service.check("claude")).state, "unauthenticated");
  answer = ok('{"loggedIn":false,"apiKeySource":"env"}');
  assert.equal((await service.check("claude")).state, "ready");
  answer = ok('{"loggedIn":false,"apiProvider":"bedrock"}');
  assert.equal((await service.check("claude")).state, "unknown");
  answer = ok("unsupported command", 1);
  assert.equal((await service.check("claude")).state, "unknown");
  answer = { ...ok("", 1), stderr: "Not logged in" };
  assert.equal((await service.check("codex")).state, "unauthenticated");
  answer = ok("", 1);
  assert.equal((await service.check("codex")).state, "unknown");
  answer = { code: null, stdout: "", timedOut: true };
  assert.deepEqual(await service.check("claude"), { state: "unknown", version: "2.1.0", issue: "timeout" });
  assert.ok(calls.every((args) => ["--version", "auth status --json", "login status"].includes(args.join(" "))));
  assert.deepEqual(await new AgentClis(registry(null), "/unused", runner).check("codex"), { state: "missing" });
  assert.deepEqual(await new AgentClis(registry(), "/unused", async () => ok("wrong executable")).check("codex"), { state: "broken", issue: "execution" });
});

test("simultaneous checks share one bounded probe", async () => {
  let count = 0;
  const service = new AgentClis(registry(), "/unused", async () => { count++; return ok("cli 2.1.0"); });
  const first = service.check("codex");
  assert.equal(first, service.check("codex"));
  await first;
  assert.equal(count, 2);
});

test("PATH persistence is idempotent and preserves user shell setup", async () => {
  const { home, clean } = await fixture();
  try {
    await fs.writeFile(path.join(home, ".zshrc"), "# user's setup\n");
    const directory = path.join(home, "dir with 'quotes'");
    await persistPath(directory, run, home, "/bin/zsh", "darwin");
    const first = await fs.readFile(path.join(home, ".zshrc"), "utf8");
    await persistPath(directory, run, home, "/bin/zsh", "darwin");
    assert.equal(await fs.readFile(path.join(home, ".zshrc"), "utf8"), first);
    assert.ok(first.startsWith("# user's setup\n"));
    await fs.writeFile(path.join(home, ".profile"), "# existing login setup\n");
    await persistPath(directory, run, home, "/bin/bash", "darwin");
    await assert.rejects(fs.stat(path.join(home, ".bash_profile")), { code: "ENOENT" });
    assert.ok((await fs.readFile(path.join(home, ".profile"), "utf8")).startsWith("# existing login setup\n"));
    const result = await run("/bin/sh", ["-c", 'HOME="$1"; . "$HOME/.zshrc"; printf "%s" "$PATH"', "sh", home]);
    assert.equal(result.stdout.split(path.delimiter)[0], directory);
    const scripts: string[][] = [];
    await persistPath("C:\\Users\\O'Brien\\bin", async (_file, args) => { scripts.push(args); return ok(); }, home, "", "win32");
    assert.match(scripts[0][2], /O''Brien/);
    await assert.rejects(persistPath("C:\\bin", async () => ok("", 1), home, "", "win32"), /could not update user PATH/);
  } finally { await clean(); }
});

test("runner terminates a hung process without prompting or exposing stderr", async () => {
  const result = await run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 100 });
  assert.equal(result.timedOut, true);
  assert.equal(result.code, null);
  assert.equal((await run("/definitely/missing", ["--version"])).code, null);
});

test("official Codex install preserves release helpers, publishes PATH and combines repeat clicks", async (t) => {
  const { home, clean } = await fixture();
  const directory = path.join(home, "installed");
  const target = codexTarget(process.platform, process.arch);
  const windows = process.platform === "win32";
  const asset = `codex-${target}${windows ? ".exe.zip" : ".tar.gz"}`;
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    requests.push(url);
    return url.includes("api.github.com")
      ? Response.json({ assets: [{ name: asset, browser_download_url: `https://github.com/openai/codex/releases/download/test/${asset}` }] })
      : new Response("mock archive");
  });
  let installed: string | null = null;
  const registry = { executable: () => installed, setPath: (_name: string, file: string) => { installed = file; return true; }, refresh: async (_extra?: string[]) => {} };
  const service = new AgentClis(registry, directory, async (_file, args) => {
    if (args[0] === "-xf") {
      await fs.writeFile(path.join(args[3], `codex-${target}${windows ? ".exe" : ""}`), "binary");
      await fs.writeFile(path.join(args[3], "helper"), "helper");
    }
    return args[0] === "--version" ? ok("codex-cli 1.2.3") : ok();
  }, home);
  try {
    const first = service.install("codex");
    assert.equal(first, service.install("codex"));
    assert.equal((await first).state, "ready");
    assert.equal(await fs.readFile(path.join(directory, "codex", "helper"), "utf8"), "helper");
    assert.equal(await fs.readFile(installed!, "utf8"), "binary");
    assert.equal(requests.length, 2);
    assert.ok(requests.every((url) => /^https:\/\/(api\.github\.com\/repos|github\.com)\/openai\/codex\//.test(url)));
  } finally { await clean(); }
});

test("failed official download does not register a nonexistent executable", async (t) => {
  let registered = false;
  t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
  const service = new AgentClis({ executable: () => null, refresh: async () => {}, setPath: () => { registered = true; return true; } }, "/unused");
  await assert.rejects(service.install("codex"), /HTTP 503/);
  assert.equal(registered, false);
});
