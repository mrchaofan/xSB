import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { AgentClis, agentCli, claudePlatform, codexTarget, configPath, configTemplate, run } from "../src/agent-cli.ts";
import type { Runner } from "../src/agent-cli.ts";

const ok = (stdout = "", code = 0) => ({ code, stdout, timedOut: false });
async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "xsb-cli-test-"));
  return { home, clean: () => fs.rm(home, { recursive: true, force: true }) };
}

/** The parts of Clis an AgentClis uses; `installs` is the folder of installed programs. */
function registry(executable: string | null = "/fake/cli", installs = "/unused") {
  const r = {
    forgotten: [] as string[], resyncs: 0,
    executable: (_command?: string) => executable, refresh: async () => {}, resync: () => { r.resyncs++; },
    installDir: (name: string) => path.join(installs, name), env: () => ({ PATH: "/xsb/bin:/usr/bin", MARK: "child" }),
    forget: (name: string) => { r.forgotten.push(name); },
  };
  return r;
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
  assert.equal(claudePlatform("darwin", "arm64"), "darwin-arm64");
  assert.equal(claudePlatform("win32", "x64"), "win32-x64");
  assert.throws(() => claudePlatform("freebsd", "x64"));
});

test("inspection never creates files; concurrent creation never overwrites user settings", async () => {
  const { home, clean } = await fixture();
  const old = { codex: process.env.CODEX_HOME, claude: process.env.CLAUDE_CONFIG_DIR };
  delete process.env.CODEX_HOME;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    const service = new AgentClis(registry(), async () => ok(), home);
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
    assert.match(await fs.readFile(path.join(path.dirname(claude.path), "settings.README.md"), "utf8"), /后端与服务配置/);
  } finally {
    if (old.codex === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = old.codex;
    if (old.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old.claude;
    await clean();
  }
});

test("checks only run the executable version, regardless of account/provider setup", async () => {
  const calls: string[][] = [];
  const runner: Runner = async (_file, args, options) => {
    calls.push(args);
    assert.equal(options?.env?.MARK, "child");
    assert.deepEqual(args, ["--version"], "no authentication or provider requests");
    return ok("cli 2.1.0");
  };
  const service = new AgentClis(registry(), runner);
  for (const name of ["claude", "codex"] as const) {
    assert.deepEqual(await service.check(name), { state: "ready", version: "2.1.0" });
  }
  assert.equal(calls.length, 2);
  assert.deepEqual(await new AgentClis(registry(null), runner).check("codex"), { state: "missing" });
  assert.deepEqual(await new AgentClis(registry(), async () => ok("wrong executable")).check("codex"), { state: "broken", issue: "execution" });
  assert.deepEqual(await new AgentClis(registry(), async () => ({ code: null, stdout: "", timedOut: true })).check("claude"), { state: "broken", issue: "timeout" });
});

test("simultaneous checks share one bounded probe", async () => {
  let count = 0;
  const service = new AgentClis(registry(), async () => { count++; return ok("cli 2.1.0"); });
  const first = service.check("codex");
  assert.equal(first, service.check("codex"));
  await first;
  assert.equal(count, 1);
});

test("runner terminates a hung process without prompting or exposing stderr", async () => {
  const result = await run(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 100 });
  assert.equal(result.timedOut, true);
  assert.equal(result.code, null);
  assert.equal((await run("/definitely/missing", ["--version"])).code, null);
});

test("Codex installs from its official release into the app's folder for it, helpers kept; repeat clicks combine", async (t) => {
  const { home, clean } = await fixture();
  const installs = path.join(home, "installed");
  const target = codexTarget(process.platform, process.arch);
  const windows = process.platform === "win32";
  const asset = `codex-${target}${windows ? ".exe.zip" : ".tar.gz"}`;
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    requests.push(url);
    return new Response("mock archive");
  });
  const clis = registry(null, installs);
  const program = path.join(installs, "codex", windows ? "codex.exe" : "codex");
  clis.executable = () => (existsSync(program) ? program : null);
  const service = new AgentClis(clis, async (_file, args) => {
    if (args[0] === "-xf") {
      await fs.writeFile(path.join(args[3], `codex-${target}${windows ? ".exe" : ""}`), "binary");
      await fs.writeFile(path.join(args[3], "helper"), "helper");
    }
    return args[0] === "--version" ? ok("codex-cli 1.2.3") : ok();
  }, home);
  try {
    await fs.mkdir(path.join(installs, "codex"), { recursive: true });
    await fs.writeFile(path.join(installs, "codex", "old"), "an older install");
    const first = service.install("codex");
    assert.equal(first, service.install("codex"));
    assert.equal((await first).state, "ready");
    assert.deepEqual((await fs.readdir(path.join(installs, "codex"))).sort(), [windows ? "codex.exe" : "codex", "helper"].sort());
    assert.equal(await fs.readFile(program, "utf8"), "binary");
    // Nothing is left beside it, and the user's earlier choice of a program gives way to the one just installed.
    assert.deepEqual(await fs.readdir(installs), ["codex"]);
    assert.deepEqual(clis.forgotten, ["codex"]);
    assert.equal(clis.resyncs, 1);
    // The latest release's file by its fixed name: no API request, which GitHub limits.
    assert.deepEqual(requests, [`https://github.com/openai/codex/releases/latest/download/${asset}`]);
    // Nothing of the user's home is touched.
    assert.deepEqual(await fs.readdir(home), ["installed"]);
  } finally { await clean(); }
});

test("Claude installs its official release's program after checking it against the published checksum", async (t) => {
  const { home, clean } = await fixture();
  const installs = path.join(home, "installed");
  const windows = process.platform === "win32";
  const platform = claudePlatform(process.platform, process.arch);
  const binary = Buffer.from("claude program");
  let checksum = createHash("sha256").update(binary).digest("hex");
  const requests: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string) => {
    requests.push(url);
    if (url.endsWith("/latest")) return new Response("2.1.332\n");
    if (url.endsWith("/manifest.json")) return Response.json({ version: "2.1.332", platforms: { [platform]: { binary: windows ? "claude.exe" : "claude", checksum, size: binary.length } } });
    return new Response(binary);
  });
  const clis = registry(null, installs);
  const program = path.join(installs, "claude", windows ? "claude.exe" : "claude");
  clis.executable = () => (existsSync(program) ? program : null);
  const service = new AgentClis(clis, async (_file, args) => args[0] === "--version" ? ok("2.1.332 (Claude Code)") : ok('{"loggedIn":true}'), home);
  try {
    assert.equal((await service.install("claude")).state, "ready");
    assert.equal(await fs.readFile(program, "utf8"), "claude program");
    if (!windows) assert.equal((await fs.stat(program)).mode & 0o111, 0o111);
    assert.deepEqual(requests, ["latest", "2.1.332/manifest.json", `2.1.332/${platform}/${windows ? "claude.exe" : "claude"}`]
      .map((p) => `https://downloads.claude.ai/claude-code-releases/${p}`));
    // A download that does not match leaves the installed program as it was.
    checksum = "0".repeat(64);
    await assert.rejects(service.install("claude"), /checksum/);
    assert.equal(await fs.readFile(program, "utf8"), "claude program");
    assert.deepEqual(await fs.readdir(installs), ["claude"]);
    assert.deepEqual(await fs.readdir(home), ["installed"]);
  } finally { await clean(); }
});

test("failed official download installs nothing", async (t) => {
  const { home, clean } = await fixture();
  t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status: 503 }));
  const clis = registry(null, path.join(home, "installed"));
  try {
    await assert.rejects(new AgentClis(clis).install("codex"), /HTTP 503/);
    assert.deepEqual(await fs.readdir(path.join(home, "installed")), []);
    assert.equal(clis.resyncs, 0);
  } finally { await clean(); }
});
