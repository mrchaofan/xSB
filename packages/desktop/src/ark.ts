/**
 * Volcengine Ark (火山方舟) for the agents xSB starts, through its official CLI, arkcli.
 *
 * arkcli ships with the app: the program of this platform, from npm's `@volcengine/ark-cli-<platform>-<arch>`, an
 * optional dependency of package.json that is copied into the app as published, not bundled (electron-builder.config.mjs).
 * Those packages are the program alone; `@volcengine/ark-cli`, which wraps them, downloads it in its own install
 * script and adds arkcli's skills to every agent it finds, so it is not used. xSB's arkcli is always this one, the
 * version xSB was released with; the user's own, if any, is theirs. It is also available to the programs the app starts:
 * on the PATH of what the app starts, by its name (clis.ts, builtin/bin). Its credentials are arkcli's own, shared with any arkcli of the user's (`~/.arkcli`).
 *
 * Each step is the user's, confirmed in main before it runs (main.ts): signing in with `arkcli auth login volc-sso`,
 * and having xSB's Claude or Codex use a plan of the account. That last one is xSB's alone: the launcher of the
 * agent's ACP wrapper (clis.ts) is given the Ark address, model and key in its environment. Neither agent's own
 * configuration is written, so the terminal's claude and codex stay as they are.
 *
 *   <dir>/ark.json   agent -> { profile, model, baseUrl }: which plan each agent uses, never the key
 *
 * The key is arkcli's. A launcher asks arkcli for it each time the agent starts (`profile apikey get`), so it is not
 * stored here, follows a key the user rotates, and a backend fails to start, saying why, once the user signs out.
 *
 * What was verified against arkcli (docs/ARK-SETUP.md): the plan profile's `base_url` is the OpenAI-compatible
 * address (…/api/plan/v3) that Codex takes with `wire_api = "responses"`; Claude takes the same without `/v3`
 * (what `arkcli helper configure claude-code` writes).
 */
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import spawn from "cross-spawn";
import fs from "node:fs";
import { updateJsonFile, atomicWrite } from "@xsb/hub";
import path from "node:path";
import { run, type AgentCli, type Runner } from "./agent-cli.ts";
import type { Clis } from "./clis.ts";

/** The official overview of the plans, with where to buy one: arkcli itself buys only from a terminal. */
export const PLAN_GUIDE = "https://ark.volcengine.com/region:cn-beijing/docs/agent-plan-personal-plan-overview";
/** The plan's own routing model: Ark picks the model per request. */
export const ROUTED_MODEL = "ark-code-latest";
/** Profile and model names go into launcher scripts: only these characters. */
const NAME = /^[A-Za-z0-9][\w.\-]*$/;

/**
 * The arkcli program shipped for this platform, or null where none is (a platform the app is not built for, or a
 * checkout that was not installed). The package of each platform holds it as `bin/arkcli-<os>-<cpu>[.exe]`.
 */
export function shippedArkcli(platform: string = process.platform, arch: string = process.arch,
  resolve: (id: string) => string = createRequire(import.meta.url).resolve): string | null {
  const os = ({ darwin: "darwin", linux: "linux", win32: "windows" } as Record<string, string>)[platform];
  const cpu = ({ x64: "amd64", arm64: "arm64" } as Record<string, string>)[arch];
  if (!os || !cpu) return null;
  try {
    const manifest = resolve(`@volcengine/ark-cli-${platform}-${arch}/package.json`);
    return path.join(path.dirname(manifest), "bin", `arkcli-${os}-${cpu}${platform === "win32" ? ".exe" : ""}`);
  } catch {
    return null;
  }
}

export type ArkPlan = { profile: string; name: string; type: string; tier?: string; expiresAt?: string; expired: boolean };
export type ArkBinding = { profile: string; model: string; baseUrl: string };
/** `broken`: the shipped program is not there or does not run. */
export type ArkState = "broken" | "unauthenticated" | "noPlan" | "ready";
export type ArkStatus = { state: ArkState; version?: string; path?: string; issue?: "timeout" | "execution" | "auth"; plans: ArkPlan[]; bindings: Partial<Record<AgentCli, ArkBinding>> };
export type ArkModel = { name: string; context?: number };
export type ArkProfile = { profile: string; name: string; type: string; baseUrl: string };
/**
 * Why xSB's agent that uses a plan cannot use it now: arkcli is signed out, the plan is gone or has expired, or arkcli
 * cannot be asked (it does not run, or gives no answer).
 */
export type ArkProblem = "signedOut" | "planGone" | "unavailable";
/** An agent's credentials when they are Ark's (`Ark.agentCheck`): its own sign-in is not what it uses then. */
export type ArkAgentCheck = { state: "ready" | "unauthenticated" | "unknown"; via: "ark"; ark?: ArkProblem; issue?: "timeout" };

/** The one JSON value arkcli answers: all of stdout, or the error envelope on stderr. Notices around it are skipped. */
export function arkAnswer(stdout: string, stderr = ""): any {
  for (const said of [stdout, stderr]) {
    // Top-level values start at the margin; what is inside one is indented.
    const start = [...said.matchAll(/^[[{]/gm)].at(-1)?.index;
    if (start === undefined) continue;
    const end = Math.max(said.lastIndexOf("}"), said.lastIndexOf("]"));
    try { return JSON.parse(said.slice(start, end + 1)); } catch { /* the other stream */ }
  }
  throw new Error("arkcli printed no JSON");
}

/** arkcli's own words for a failure, short: its envelope's message, or the end of what it printed. */
function failure(result: { stdout: string; stderr?: string; timedOut: boolean }, what: string): Error {
  if (result.timedOut) return new Error(`${what}: timed out`);
  try {
    const message = arkAnswer(result.stdout, result.stderr)?.error?.message;
    if (message) return new Error(`${what}: ${message}`);
  } catch { /* no envelope */ }
  return new Error(`${what}: ${(result.stderr || result.stdout).trim().split("\n").slice(-6).join("\n")}`);
}

/** Whether the profile is a plan (what the agents are given), not the account's pay-as-you-go platform profile. */
const planOf = (p: any): ArkPlan | null => typeof p?.name === "string" && typeof p.type === "string" && p.type !== "platform" && NAME.test(p.name)
  ? { profile: p.name, name: String(p.display_name || p.name), type: p.type, tier: p.plan_tier || undefined, expiresAt: p.expires_at || undefined,
      expired: !!p.expires_at && Date.parse(p.expires_at) < Date.now() }
  : null;

const shQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;

export class Ark {
  /** The shipped arkcli (`shippedArkcli`), or null where there is none. */
  readonly program: string | null;
  private clis: Pick<Clis, "resync" | "env">;
  private dir: string;
  private file: string;
  private runner: Runner;
  private signingIn?: { done: Promise<ArkStatus>; cancel: () => void };

  /**
   * dir: where the bindings are kept (`ark.json`, also read by the launchers through `arkLaunch`); clis: rewrites the
   * launchers, and gives arkcli the environment of the app's child processes.
   */
  constructor(clis: Pick<Clis, "resync" | "env">, dir: string, program: string | null = shippedArkcli(), runner: Runner = run) {
    this.clis = clis;
    this.dir = dir;
    this.file = path.join(dir, "ark.json");
    this.program = program && fs.existsSync(program) ? program : null;
    this.runner = runner;
    writeClaudeFiles(dir, this.bindings().claude);
  }

  bindings(): Partial<Record<AgentCli, ArkBinding>> {
    return readArkBindings(this.file);
  }

  async status(): Promise<ArkStatus> {
    const bindings = this.bindings();
    const file = this.program;
    if (!file) return { state: "broken", issue: "execution", plans: [], bindings };
    const env = this.clis.env();
    const v = await this.runner(file, ["--version"], { env });
    const version = /\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/.exec(v.stdout)?.[0];
    if (v.code !== 0 || !version) return { state: "broken", path: file, issue: v.timedOut ? "timeout" : "execution", plans: [], bindings };
    const auth = await this.runner(file, ["auth", "status", "--format", "json"], { timeout: 20000, env });
    let status: any;
    try { status = arkAnswer(auth.stdout, auth.stderr); } catch { status = null; }
    if (!status?.logged_in) return { state: "unauthenticated", version, path: file, issue: status ? undefined : auth.timedOut ? "timeout" : "auth", plans: [], bindings };
    const plans = (Array.isArray(status.profiles_summary) ? status.profiles_summary : []).map(planOf).filter((p: ArkPlan | null): p is ArkPlan => !!p);
    return { state: plans.some((p: ArkPlan) => !p.expired) ? "ready" : "noPlan", version, path: file, plans, bindings };
  }

  /**
   * Whether xSB's `name` can use the plan it is bound to, as its sign-in is checked otherwise (agent-cli.ts): null when
   * it uses its own configuration. Like that check, it asks arkcli locally and sends no model request.
   */
  async agentCheck(name: AgentCli): Promise<ArkAgentCheck | null> {
    const binding = this.bindings()[name];
    if (!binding) return null;
    const status = await this.status();
    if (status.state === "unauthenticated") {
      return status.issue ? { state: "unknown", via: "ark", ark: "unavailable", ...(status.issue === "timeout" ? { issue: "timeout" as const } : {}) }
        : { state: "unauthenticated", via: "ark", ark: "signedOut" };
    }
    if (status.state === "broken") return { state: "unknown", via: "ark", ark: "unavailable" };
    const plan = status.plans.find((p) => p.profile === binding.profile);
    if (!plan || plan.expired) return { state: "unauthenticated", via: "ark", ark: "planGone" };
    return { state: "ready", via: "ark" };
  }

  private arkcli(): string {
    if (!this.program) throw new Error("arkcli is not part of this build of the app");
    return this.program;
  }

  /** A plan profile as arkcli shows it, with the address its models are served at. */
  async profile(profile: string): Promise<ArkProfile> {
    if (!NAME.test(profile)) throw new Error("Unknown Ark profile");
    const result = await this.runner(this.arkcli(), ["profile", "show", "--profile", profile, "--format", "json"], { timeout: 20000, env: this.clis.env() });
    if (result.code !== 0) throw failure(result, "arkcli profile show");
    const shown = arkAnswer(result.stdout, result.stderr);
    if (!planOf(shown) || typeof shown.base_url !== "string" || !/^https:\/\/[^\s'"]+$/.test(shown.base_url)) throw new Error("This Ark profile is not a plan with a model address");
    return { profile, name: String(shown.display_name || profile), type: shown.type, baseUrl: shown.base_url.replace(/\/+$/, "") };
  }

  /** The models of a plan: its routing model first, then the ones it serves directly. */
  async models(profile: string): Promise<ArkModel[]> {
    const { type } = await this.profile(profile);
    const result = await this.runner(this.arkcli(), ["plans", "model-list", "--plan", type, "--mode", "direct", "--format", "json"], { timeout: 30000, env: this.clis.env() });
    if (result.code !== 0) throw failure(result, "arkcli plans model-list");
    const list = arkAnswer(result.stdout, result.stderr);
    const direct = (Array.isArray(list?.direct_models) ? list.direct_models : [])
      // Models an agent can talk to: text out. A plan also lists embedding, image, speech and transcription models; a
      // model without modalities is a chat model when it reports load (the same list arkcli gives agents).
      .filter((m: any) => typeof m?.model_name === "string" && NAME.test(m.model_name)
        && (Array.isArray(m.output_modalities) ? m.output_modalities.includes("text") : !!m.load))
      .map((m: any) => ({ name: m.model_name, context: typeof m.context_window === "number" ? m.context_window : undefined }));
    return [{ name: ROUTED_MODEL }, ...direct.filter((m: ArkModel) => m.name !== ROUTED_MODEL)];
  }

  /**
   * Have xSB's `name` use the plan (binding) or its own configuration again (null). A conversation's agent program
   * started before keeps what it was started with (main.ts, `effect`).
   */
  async bind(name: AgentCli, binding: ArkBinding | null): Promise<void> {
    const all = updateJsonFile<Partial<Record<AgentCli, ArkBinding>>>(this.file, () => fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : {}, all => {
      if (binding) all[name] = { profile: binding.profile, model: binding.model, baseUrl: binding.baseUrl };
      else delete all[name];
      return all;
    }, all => {
      if (!all || typeof all !== "object" || Array.isArray(all) || Object.entries(all).some(([name, b]) => !["claude", "codex"].includes(name) || !b || !NAME.test(b.profile) || !NAME.test(b.model) || !/^https:\/\/[^\s'"]+$/.test(b.baseUrl))) throw new Error("Invalid Ark binding");
    });
    writeClaudeFiles(this.dir, all.claude);
    // The launchers (clis.ts) read the bindings through `arkLaunch`.
    this.clis.resync();
  }

  /** `arkcli auth login volc-sso`: arkcli opens the browser and waits for it. onUrl gets the address it prints, for when no browser opened. */
  login(onUrl: (url: string) => void): Promise<ArkStatus> {
    if (this.signingIn) return this.signingIn.done;
    const windows = process.platform === "win32";
    const child = spawn(this.arkcli(), ["auth", "login", "volc-sso"], { detached: !windows, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...this.clis.env(), ELECTRON_RUN_AS_NODE: undefined } });
    let said = "", told = false, cancelled = false;
    const stop = () => {
      if (!child.pid) return;
      if (windows) execFile("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
      else try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    };
    const hear = (data: Buffer) => {
      said = (said + data.toString()).slice(-16384);
      const url = /https:\/\/[\w.-]*volcengine\.com\/\S+/.exec(said)?.[0];
      if (url && !told) { told = true; onUrl(url); }
    };
    child.stdout?.on("data", hear);
    child.stderr?.on("data", hear);
    const timer = setTimeout(stop, 10 * 60000);
    const done = new Promise<ArkStatus>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => {
        if (cancelled) reject(new Error("Sign-in cancelled"));
        else if (code !== 0) reject(failure({ stdout: said, timedOut: false }, "arkcli auth login"));
        else resolve(this.status());
      });
    }).finally(() => { clearTimeout(timer); this.signingIn = undefined; });
    this.signingIn = { done, cancel: () => { cancelled = true; stop(); } };
    return done;
  }

  cancelLogin(): void {
    this.signingIn?.cancel();
  }
}

/** Which plan each of xSB's agents uses (`ark.json`), what is valid of it. */
export function readArkBindings(file: string): Partial<Record<AgentCli, ArkBinding>> {
  try {
    const all = JSON.parse(fs.readFileSync(file, "utf8"));
    return Object.fromEntries(Object.entries(all).filter(([name, b]: [string, any]) =>
      (name === "claude" || name === "codex") && NAME.test(b?.profile) && NAME.test(b?.model) && /^https:\/\/[^\s'"]+$/.test(b?.baseUrl)));
  } catch { return {}; }
}

/**
 * Claude reads its own settings over the environment it is started with, so a user whose settings.json names another
 * address or key would keep using it. Settings given on its command line (`--settings`) rank above the user's: xSB
 * starts claude through `<dir>/ark/claude`, which adds them. They hold the address and models and clear
 * `ANTHROPIC_API_KEY`; the key itself stays in the environment (`ANTHROPIC_AUTH_TOKEN`), never in a file or argv.
 * Windows has no such program: Node does not start a .cmd without a shell, so there only the environment is set.
 */
export function claudeFiles(dir: string): { settings: string; program: string } {
  return { settings: path.join(dir, "ark", "claude-settings.json"), program: path.join(dir, "ark", "claude") };
}

function writeClaudeFiles(dir: string, binding: ArkBinding | undefined): void {
  if (process.platform === "win32") return;
  const files = claudeFiles(dir);
  if (!binding) return void fs.rmSync(path.dirname(files.program), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(files.program), { recursive: true, mode: 0o700 });
  const env = Object.fromEntries(Object.entries(claudeEnv(binding)).filter(([key]) => key !== "ANTHROPIC_AUTH_TOKEN"));
  atomicWrite(files.settings, JSON.stringify({ env: { ...env, ANTHROPIC_API_KEY: "", CLAUDE_CODE_USE_BEDROCK: "", CLAUDE_CODE_USE_VERTEX: "", CLAUDE_CODE_USE_FOUNDRY: "" } }, null, 2) + "\n");
  atomicWrite(files.program, '#!/bin/sh\n# xSB: the user\'s claude, with the Volcengine Ark settings above their own (ark.ts).\nexec "$XSB_ARK_CLAUDE" --settings "$XSB_ARK_CLAUDE_SETTINGS" "$@"\n', 0o755);
}

/**
 * What a launcher of `program`'s ACP wrapper (clis.ts) runs before it — getting the plan's key from arkcli, and the
 * environment that points the agent at the plan — and the program the wrapper is to start instead of the agent's own.
 * Nothing when xSB's `program` uses its own configuration.
 */
export function arkLaunch(binding: ArkBinding | undefined, program: string, windows: boolean, arkcli: string | null,
  dir?: string, agent?: string | null): { lines: string[]; executable?: string } {
  if (!binding) return { lines: [] };
  const lines = launchLines(binding, program, windows, arkcli);
  const claude = dir && claudeFiles(dir);
  if (program !== "claude" || windows || !claude || !agent || !fs.existsSync(claude.program)) return { lines };
  return { lines: [...lines, `export XSB_ARK_CLAUDE=${shQuote(agent)} XSB_ARK_CLAUDE_SETTINGS=${shQuote(claude.settings)}`], executable: claude.program };
}

function launchLines(binding: ArkBinding, program: string, windows: boolean, arkcli: string | null): string[] {
  const env = program === "claude" ? claudeEnv(binding) : codexEnv(binding);
  // What would take the agent elsewhere than the plan: another key, or another provider chosen in the environment.
  const unset = program === "claude" ? ["ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"] : ["MODEL_PROVIDER", "OPENAI_BASE_URL"];
  const message = `xSB: the Volcengine Ark key of profile ${binding.profile} could not be read from arkcli: sign in to arkcli again in the xSB settings, Backends, Volcengine Ark.`;
  if (windows) {
    const set = (key: string, value: string) => `set "${key}=${value === "$XSB_ARK_API_KEY" ? "%XSB_ARK_API_KEY%" : value.replaceAll("%", "%%")}"`;
    return [
      `set "XSB_ARK_API_KEY="`,
      // `call` keeps cmd from stripping the quotes of a quoted program in for /f.
      arkcli ? `for /f "usebackq delims=" %%k in (\`call "${arkcli}" profile apikey get --profile ${binding.profile} --format json --transform api_key 2^>nul\`) do set "XSB_ARK_API_KEY=%%k"` : "",
      `if not defined XSB_ARK_API_KEY (echo ${message} 1>&2 & exit /b 1)`,
      `set "XSB_ARK_API_KEY=%XSB_ARK_API_KEY:"=%"`,
      ...unset.map((key) => `set "${key}="`),
      ...Object.entries(env).map(([key, value]) => set(key, value)),
    ].filter(Boolean);
  }
  return [
    `XSB_ARK_API_KEY=${arkcli ? `$(${shQuote(arkcli)} profile apikey get --profile ${shQuote(binding.profile)} --format json --transform api_key 2>/dev/null | tr -d '"\\r\\n')` : ""}`,
    `[ -n "$XSB_ARK_API_KEY" ] || { echo ${shQuote(message)} >&2; exit 1; }`,
    `export XSB_ARK_API_KEY`,
    ...unset.map((key) => `unset ${key}`),
    ...Object.entries(env).map(([key, value]) => `export ${key}=${value.startsWith("$") ? `"${value}"` : shQuote(value)}`),
  ];
}

/** Claude Code against the plan's Anthropic-compatible address. Every model tier is the chosen model: the plan serves no Claude model. */
export function claudeEnv(binding: ArkBinding): Record<string, string> {
  const model = binding.model;
  return {
    ANTHROPIC_BASE_URL: binding.baseUrl.replace(/\/v3$/, ""),
    ANTHROPIC_AUTH_TOKEN: "$XSB_ARK_API_KEY",
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    API_TIMEOUT_MS: "3000000",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
}

/** Codex through codex-acp's `CODEX_CONFIG`, which it passes to codex as `-c` overrides. The key stays in the environment (`env_key`): codex-acp logs the config. */
export function codexEnv(binding: ArkBinding): Record<string, string> {
  return {
    CODEX_CONFIG: JSON.stringify({
      model_provider: "xsb-ark",
      model: binding.model,
      model_providers: { "xsb-ark": { name: "Volcengine Ark", base_url: binding.baseUrl, env_key: "XSB_ARK_API_KEY", wire_api: "responses" } },
    }),
  };
}
