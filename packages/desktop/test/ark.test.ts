import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { Runner } from "../src/agent-cli.ts";
import { Ark, arkAnswer, arkLaunch, readArkBindings, shippedArkcli } from "../src/ark.ts";
import { Clis } from "../src/clis.ts";

const ok = (stdout = "", stderr = "") => ({ code: 0, stdout, stderr, timedOut: false });
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "xsb-ark-test-"));
/** What Ark rewrites the launchers with, counting how often. */
const launchers = () => { const l = { resyncs: 0, resync: () => { l.resyncs++; }, env: () => ({ PATH: "/xsb/bin" }) }; return l; };
/** A program that exists, for Ark to take as its arkcli; the runner answers in its stead. */
const PROGRAM = process.execPath;
const PLAN = { name: "agent-plan_cn-beijing_personal", display_name: "Agent Plan Medium", type: "agent-plan", plan_tier: "medium", expires_at: "2999-12-16T23:59:59+08:00" };
const PLATFORM = { name: "platform_cn-beijing_accountwide", display_name: "Pay as you go", type: "platform" };
const binding = { profile: PLAN.name, model: "ark-code-latest", baseUrl: "https://ark.cn-beijing.volces.com/api/plan/v3" };

test("arkcli's answer is found around its notices, and its error envelope on stderr", () => {
  assert.deepEqual(arkAnswer('{\n  "logged_in": true\n}\n\n发现 arkcli 新版本：1.0.50 → 1.0.65\n'), { logged_in: true });
  assert.deepEqual(arkAnswer("", 'progress\n{\n  "ok": false,\n  "error": { "message": "no" }\n}\n').error.message, "no");
  assert.deepEqual(arkAnswer('[\n  {\n    "a": 1\n  }\n]\n'), [{ a: 1 }]);
  assert.throws(() => arkAnswer("plain text"));
});

test("the shipped program is the one of this platform's package, and none where the app has none", () => {
  const resolve = (id: string) => {
    if (id === "@volcengine/ark-cli-darwin-arm64/package.json") return "/app/node_modules/@volcengine/ark-cli-darwin-arm64/package.json";
    if (id === "@volcengine/ark-cli-win32-x64/package.json") return "C:\\app\\node_modules\\@volcengine\\ark-cli-win32-x64\\package.json";
    throw new Error("Cannot find module");
  };
  assert.equal(shippedArkcli("darwin", "arm64", resolve), path.join("/app/node_modules/@volcengine/ark-cli-darwin-arm64", "bin", "arkcli-darwin-arm64"));
  assert.ok(shippedArkcli("win32", "x64", resolve)!.endsWith("arkcli-windows-amd64.exe"));
  assert.equal(shippedArkcli("linux", "x64", resolve), null);
  assert.equal(shippedArkcli("sunos", "x64", resolve), null);
  // This checkout installed its own platform's package (package.json optionalDependencies).
  const own = shippedArkcli();
  if (own) assert.ok(fs.existsSync(own));
});

test("status: broken, signed out, no plan and ready; the platform profile and expired plans are no plan", async () => {
  const dir = temp();
  try {
    const answer = (auth: object): Runner => async (_file, args) => args[0] === "--version" ? ok("arkcli version 1.0.65") : ok(JSON.stringify(auth, null, 2));
    const none = await new Ark(launchers(), dir, null, answer({})).status();
    assert.deepEqual([none.state, none.issue], ["broken", "execution"]);
    assert.equal((await new Ark(launchers(), dir, path.join(dir, "no-arkcli"), answer({})).status()).state, "broken");
    assert.equal((await new Ark(launchers(), dir, PROGRAM, async () => ok("garbage")).status()).state, "broken");
    assert.equal((await new Ark(launchers(), dir, PROGRAM, answer({ logged_in: false })).status()).state, "unauthenticated");
    const expired = { ...PLAN, expires_at: "2000-01-01T00:00:00+08:00" };
    const noPlan = await new Ark(launchers(), dir, PROGRAM, answer({ logged_in: true, profiles_summary: [PLATFORM, expired] })).status();
    assert.equal(noPlan.state, "noPlan");
    assert.deepEqual(noPlan.plans.map((p) => [p.profile, p.expired]), [[PLAN.name, true]]);
    const calls: string[][] = [];
    const readyAnswer = answer({ logged_in: true, profiles_summary: [PLATFORM, PLAN] });
    const ready = await new Ark(launchers(), dir, PROGRAM, async (file, args, options) => {
      calls.push(args);
      return readyAnswer(file, args, options);
    }).status();
    assert.equal(ready.state, "ready");
    assert.deepEqual(ready.plans, [{ profile: PLAN.name, name: "Agent Plan Medium", type: "agent-plan", tier: "medium", expiresAt: PLAN.expires_at, expired: false }]);
    assert.equal(ready.version, "1.0.65");
    assert.deepEqual(calls, [["--version"], ["auth", "status", "--format", "json"]], "checks version, sign-in and returned plans without key, quota or model calls");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("an agent bound to a plan is checked by arkcli's sign-in and that plan, not its own", async () => {
  const dir = temp();
  try {
    const answer = (auth: object | null, timedOut = false): Runner => async (_file, args) => args[0] === "--version" ? ok("arkcli version 1.0.65")
      : auth ? ok(JSON.stringify(auth)) : { code: null, stdout: "", stderr: "", timedOut };
    const check = async (runner: Runner, program: string | null = PROGRAM) => {
      const ark = new Ark(launchers(), dir, program, runner);
      return ark.agentCheck("codex");
    };
    fs.writeFileSync(path.join(dir, "ark.json"), JSON.stringify({ codex: binding }));
    assert.deepEqual(await check(answer({ logged_in: true, profiles_summary: [PLAN] })), { state: "ready", via: "ark" });
    assert.deepEqual(await check(answer({ logged_in: false })), { state: "unauthenticated", via: "ark", ark: "signedOut" });
    assert.deepEqual(await check(answer({ logged_in: true, profiles_summary: [{ ...PLAN, expires_at: "2000-01-01T00:00:00+08:00" }] })), { state: "unauthenticated", via: "ark", ark: "planGone" });
    assert.deepEqual(await check(answer({ logged_in: true, profiles_summary: [{ ...PLAN, name: "another_plan" }] })), { state: "unauthenticated", via: "ark", ark: "planGone" });
    assert.deepEqual(await check(answer(null, true)), { state: "unknown", via: "ark", ark: "unavailable", issue: "timeout" });
    assert.deepEqual(await check(answer({}), null), { state: "unknown", via: "ark", ark: "unavailable" });
    // Not bound: its own sign-in is what is checked (agent-cli.ts).
    assert.equal(await new Ark(launchers(), dir, PROGRAM, answer({})).agentCheck("claude"), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("models: the routing model first, then the plan's direct models", async () => {
  const runner: Runner = async (_file, args) => args[0] === "profile"
    ? ok(JSON.stringify({ ...PLAN, base_url: binding.baseUrl }))
    : (assert.deepEqual(args.slice(0, 6), ["plans", "model-list", "--plan", "agent-plan", "--mode", "direct"]),
      ok(JSON.stringify({ direct_models: [
        { model_name: "doubao-seed-2.1-pro", context_window: 1048576, output_modalities: ["text"] }, { model_name: "bad name; rm", output_modalities: ["text"] },
        { model_name: "doubao-seed-evolving", load: { status: 1 } }, { model_name: "doubao-seed-tts-2.0" },
        { model_name: "doubao-embedding-vision", output_modalities: ["embedding"] }, { model_name: "doubao-seedream-5.5", output_modalities: ["image"] },
      ] })));
  assert.deepEqual(await new Ark(launchers(), "/unused", PROGRAM, runner).models(PLAN.name),
    [{ name: "ark-code-latest" }, { name: "doubao-seed-2.1-pro", context: 1048576 }, { name: "doubao-seed-evolving", context: undefined }]);
});

test("bindings are kept without the key, and what cannot be put in a launcher is dropped", async () => {
  const dir = temp();
  try {
    const relaunch = launchers();
    const ark = new Ark(relaunch, dir, PROGRAM, async () => ok());
    await ark.bind("claude", binding);
    await ark.bind("codex", { ...binding, model: "doubao-seed-2.1-pro" });
    await ark.bind("claude", null);
    // Each change rewrites the launchers, which read the bindings.
    assert.equal(relaunch.resyncs, 3);
    assert.deepEqual(readArkBindings(path.join(dir, "ark.json")), { codex: { ...binding, model: "doubao-seed-2.1-pro" } });
    assert.ok(!fs.readFileSync(path.join(dir, "ark.json"), "utf8").includes("ark-"));
    await assert.rejects(ark.bind("codex", { ...binding, profile: "x'; rm -rf ~" }), /Invalid/);
    fs.writeFileSync(path.join(dir, "ark.json"), JSON.stringify({ claude: { ...binding, model: "$(evil)" }, other: binding }));
    assert.deepEqual(readArkBindings(path.join(dir, "ark.json")), {});
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a launcher reads the key from arkcli each start and points the agent at the plan; without it, it fails saying why", { skip: process.platform === "win32" }, () => {
  const dir = temp();
  try {
    const arkcli = path.join(dir, "ark cli");
    fs.writeFileSync(arkcli, `#!/bin/sh\n[ "$5" = "${PLAN.name}" ] && printf '"ark-secret-123"\\n' || exit 3\n`, { mode: 0o755 });
    const script = (program: string, file: string | null) => {
      const body = ["#!/bin/sh", ...arkLaunch(binding, program, false, file).lines, "env"].join("\n");
      return spawnSync("/bin/sh", ["-c", body], { encoding: "utf8", env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "old", CLAUDE_CODE_USE_BEDROCK: "1" } });
    };
    const claude = script("claude", arkcli);
    assert.equal(claude.status, 0);
    const env = Object.fromEntries(claude.stdout.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "ark-secret-123");
    assert.equal(env.ANTHROPIC_BASE_URL, "https://ark.cn-beijing.volces.com/api/plan");
    assert.equal(env.ANTHROPIC_MODEL, "ark-code-latest");
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
    const codex = script("codex", arkcli);
    const codexEnv = Object.fromEntries(codex.stdout.trim().split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    assert.equal(codexEnv.XSB_ARK_API_KEY, "ark-secret-123");
    const config = JSON.parse(codexEnv.CODEX_CONFIG);
    assert.equal(config.model_provider, "xsb-ark");
    assert.deepEqual(config.model_providers["xsb-ark"], { name: "Volcengine Ark", base_url: binding.baseUrl, env_key: "XSB_ARK_API_KEY", wire_api: "responses" });
    // The key is never in the configuration codex-acp logs.
    assert.ok(!codexEnv.CODEX_CONFIG.includes("ark-secret"));
    for (const missing of [script("claude", null), script("claude", path.join(dir, "nothing"))]) {
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /could not be read from arkcli/);
    }
    assert.deepEqual(arkLaunch(undefined, "claude", false, arkcli), { lines: [] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("windows launcher lines read the key with for /f and set the environment", () => {
  const { lines, executable } = arkLaunch(binding, "claude", true, "C:\\Users\\me\\arkcli.exe", "C:\\data", "C:\\claude.exe");
  assert.equal(executable, undefined);
  assert.ok(lines.some((l) => l.startsWith('for /f "usebackq delims=" %%k in (`call "C:\\Users\\me\\arkcli.exe" profile apikey get --profile agent-plan_cn-beijing_personal')));
  assert.ok(lines.includes('set "ANTHROPIC_AUTH_TOKEN=%XSB_ARK_API_KEY%"'));
  assert.ok(lines.includes('set "ANTHROPIC_API_KEY="'));
  // The message is echoed inside cmd's parentheses: nothing in it may redirect, pipe or close the block.
  assert.ok(lines.some((l) => l.startsWith("if not defined XSB_ARK_API_KEY (echo ") && !/[<>|()&]/.test(l.slice(37, l.lastIndexOf(" 1>&2")))));
});

test("the launcher of xSB's agent carries the plan from the first one written, and drops it when unbound", { skip: process.platform === "win32" }, async () => {
  const directory = temp();
  const saved = { ...process.env };
  try {
    const bin = path.join(directory, "programs");
    fs.mkdirSync(bin);
    for (const name of ["claude", "arkcli"]) fs.writeFileSync(path.join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
    process.env.SHELL = path.join(directory, "no-shell");
    process.env.PATH = `${bin}${path.delimiter}${saved.PATH}`;
    const state = path.join(directory, "state");
    fs.mkdirSync(state);
    fs.writeFileSync(path.join(state, "ark.json"), JSON.stringify({ claude: binding }));
    const arkcli = path.join(bin, "arkcli");
    const clis = new Clis(state, { launchEnv: (program, windows, locate) => arkLaunch(readArkBindings(path.join(state, "ark.json"))[program as "claude"], program, windows, arkcli, state, locate(program)) });
    const launcher = () => fs.readFileSync(path.join(state, "bin", "claude-agent-acp"), "utf8");
    assert.ok(launcher().includes(`${path.join(bin, "arkcli")}' profile apikey get --profile '${PLAN.name}'`));
    assert.ok(launcher().indexOf("ANTHROPIC_BASE_URL") < launcher().indexOf("CLAUDE_CODE_EXECUTABLE="));
    // Ark writes the program Claude is started through; once it exists the launcher names it, and it the user's claude.
    const ark = new Ark(clis, state, arkcli, async () => ok());
    clis.resync();
    assert.ok(launcher().includes(`CLAUDE_CODE_EXECUTABLE='${path.join(state, "ark", "claude")}'`));
    assert.ok(launcher().includes(`XSB_ARK_CLAUDE='${path.join(bin, "claude")}'`));
    execFileSync("/bin/sh", ["-n", path.join(state, "bin", "claude-agent-acp")]);
    const settings = JSON.parse(fs.readFileSync(path.join(state, "ark", "claude-settings.json"), "utf8"));
    assert.equal(settings.env.ANTHROPIC_BASE_URL, "https://ark.cn-beijing.volces.com/api/plan");
    assert.equal(settings.env.ANTHROPIC_API_KEY, "");
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, undefined);
    // The program passes the settings before whatever claude is asked to do.
    fs.writeFileSync(path.join(bin, "claude"), '#!/bin/sh\nprintf "%s|" "$@"\n', { mode: 0o755 });
    const out = execFileSync(path.join(state, "ark", "claude"), ["-p", "hi"], { encoding: "utf8", env: { ...process.env, XSB_ARK_CLAUDE: path.join(bin, "claude"), XSB_ARK_CLAUDE_SETTINGS: "/s.json" } });
    assert.equal(out, "--settings|/s.json|-p|hi|");
    await ark.bind("claude", null);
    assert.ok(!launcher().includes("ANTHROPIC_BASE_URL"));
    assert.ok(launcher().includes(`CLAUDE_CODE_EXECUTABLE='${path.join(bin, "claude")}'`));
    assert.ok(!fs.existsSync(path.join(state, "ark")));
  } finally {
    process.env = saved;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
