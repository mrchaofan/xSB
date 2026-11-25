/** User-facing CLI lifecycle. Providers are data; filesystem, probes and installs share one service.
 * Probes never create a session or send a prompt. Authentication is local status, not proof of credit/network access.
 * An install downloads the publisher's own release into the app's folder for it (clis.ts `installDir`); it changes
 * nothing of the user's: no shell startup file, no PATH, nothing in their home folder.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import spawn from "cross-spawn";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream } from "node:fs";
import type { Language } from "@xsb/protocol";
import type { ArkAgentCheck, ArkProblem } from "./ark.ts";
import type { Clis } from "./clis.ts";

export type AgentCli = "codex" | "claude";
export type CliCheck = { state: "missing" | "broken" | "unauthenticated" | "unknown" | "ready"; version?: string; issue?: "timeout" | "execution" | "auth";
  /** The credentials are a Volcengine Ark plan's (ark.ts), not the agent's own sign-in; `ark` says why they cannot be used now. */
  via?: "ark"; ark?: ArkProblem };
export type CliConfig = { path: string; exists: boolean };
type Result = { code: number | null; stdout: string; stderr?: string; timedOut: boolean };
export type Runner = (file: string, args: string[], options?: { timeout?: number; cwd?: string; env?: Record<string, string | undefined> }) => Promise<Result>;

/**
 * Fixed executable + argument vector; no user-controlled shell command. Output is bounded and never returned to UI.
 * `env` is the child's whole environment (the app's child processes get `Clis.env`); this process's by default.
 */
export const run: Runner = (file, args, options = {}) => new Promise((resolve) => {
  const windows = process.platform === "win32";
  const child = spawn(file, args, { cwd: options.cwd, detached: !windows, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...(options.env ?? process.env), ELECTRON_RUN_AS_NODE: undefined } });
  let stdout = "", stderr = "", ended = false;
  const finish = (code: number | null, timedOut = false) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    resolve({ code, stdout, stderr, timedOut });
  };
  const stop = () => {
    if (!child.pid) return;
    if (windows) execFile("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
    else try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  };
  const timer = setTimeout(() => { stop(); finish(null, true); }, options.timeout ?? 15000);
  const collect = (stream: "stdout" | "stderr", data: Buffer) => {
    if (stream === "stdout") stdout += data.toString(); else stderr += data.toString();
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 1024 * 1024) { stop(); finish(null); }
  };
  child.stdout?.on("data", (data) => collect("stdout", data));
  child.stderr?.on("data", (data) => collect("stderr", data));
  child.on("error", () => finish(null));
  child.on("close", (code) => finish(code));
});

const PROVIDERS = {
  codex: { env: "CODEX_HOME", directory: ".codex", file: "config.toml", auth: ["login", "status"], login: ["login"] },
  claude: { env: "CLAUDE_CONFIG_DIR", directory: ".claude", file: "settings.json", auth: ["auth", "status", "--json"], login: ["auth", "login"] },
} as const;

/**
 * The command the user runs in their terminal to sign `name` in, for the program the app uses (`program`). That is
 * found by its name only when it is what the user's PATH finds (`onUserPath`); one the app installed in its own folder
 * is named by its path, quoted for the terminal of the platform (PowerShell on Windows).
 */
export function loginCommand(name: AgentCli, program: string | null, onUserPath: boolean, platform: NodeJS.Platform = process.platform): string {
  const args = PROVIDERS[name].login.join(" ");
  if (!program || onUserPath) return `${name} ${args}`;
  return platform === "win32" ? `& '${program.replaceAll("'", "''")}' ${args}` : `'${program.replaceAll("'", `'\\''`)}' ${args}`;
}
export function agentCli(name: unknown): AgentCli {
  if (name !== "codex" && name !== "claude") throw new Error("Unknown CLI");
  return name;
}

export function configPath(name: AgentCli, home = os.homedir(), env = process.env): string {
  const provider = PROVIDERS[name];
  return path.join(path.resolve(env[provider.env] || path.join(home, provider.directory)), provider.file);
}

export function configTemplate(name: AgentCli, language: Language): string {
  if (name === "claude") return JSON.stringify({
    $schema: "https://json.schemastore.org/claude-code-settings.json",
    permissions: { defaultMode: "default", allow: [], ask: ["Bash", "Edit", "Write"], disableBypassPermissionsMode: "disable" },
  }, null, 2) + "\n";
  return language === "zh-CN"
    ? '# 使用前运行 codex login 登录；模板不包含凭据。\n# approval_policy：执行命令需用户确认；如需调整，参阅官方权限说明。\napproval_policy = "on-request"\n# sandbox_mode：默认只读；需要写入项目时可改为 "workspace-write"。\nsandbox_mode = "read-only"\n# 使用第三方服务时按官方说明添加 model_provider / model_providers，密钥放在环境变量中。\n'
    : '# Run codex login before use; this template contains no credentials.\n# approval_policy: request approval for commands; consult the official permissions guide before changing.\napproval_policy = "on-request"\n# sandbox_mode: read-only; change to "workspace-write" if project writes are needed.\nsandbox_mode = "read-only"\n# For third-party services, configure model_provider / model_providers per the official guide; keep keys in environment variables.\n';
}

/** JSON has no comments: Claude has no required editable fields; put login and optional field notes alongside it. */
function claudeNotes(language: Language): string {
  return language === "zh-CN"
    ? '# Claude 配置说明\n\n使用前运行 `claude auth login` 登录。无需填写占位密钥。\n\n- `permissions.defaultMode`：默认逐项确认权限。\n- `permissions.allow`：默认空列表；只添加你明确允许自动执行的操作。\n- `permissions.ask`：执行命令、编辑和写入需确认。\n- `permissions.disableBypassPermissionsMode`：关闭跳过权限确认。\n- 第三方服务可按 https://code.claude.com/docs/en/settings 配置 `env`；API 密钥建议放在系统环境变量中。\n\nsettings.json 使用标准 JSON，不支持注释，因此说明保存在本文件。\n'
    : '# Claude settings notes\n\nRun `claude auth login` before use. No placeholder API key is required.\n\n- `permissions.defaultMode`: confirm permissions by default.\n- `permissions.allow`: empty by default; add only operations you explicitly trust.\n- `permissions.ask`: confirm commands, edits and writes.\n- `permissions.disableBypassPermissionsMode`: disable skipping permission checks.\n- For third-party services configure `env` per https://code.claude.com/docs/en/settings; prefer system environment variables for API keys.\n\nsettings.json uses standard JSON; comments are kept in this file.\n';
}

export class AgentClis {
  private installing = new Map<AgentCli, Promise<CliCheck>>();
  private checking = new Map<AgentCli, Promise<CliCheck>>();
  private clis: Pick<Clis, "executable" | "refresh" | "resync" | "installDir" | "env" | "forget">;
  private runner: Runner;
  private home: string;
  /**
   * The check of credentials that are not the agent's own (`Ark.agentCheck`), done instead of its sign-in's; null when
   * they are its own. Given the PATH this check has just read again.
   */
  credentials: (name: AgentCli) => Promise<ArkAgentCheck | null> = async () => null;
  constructor(clis: Pick<Clis, "executable" | "refresh" | "resync" | "installDir" | "env" | "forget">, runner: Runner = run, home = os.homedir()) {
    this.clis = clis;
    this.runner = runner;
    this.home = home;
  }

  async config(name: AgentCli, create = false, language: Language = "en"): Promise<CliConfig> {
    const file = configPath(name, this.home);
    if (create) {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      // Exclusive creation also protects a config created by another window between inspection and confirmation.
      try {
        await fs.writeFile(file, configTemplate(name, language), { flag: "wx", mode: 0o600 });
        if (name === "claude") await fs.writeFile(path.join(path.dirname(file), "settings.README.md"), claudeNotes(language), { flag: "wx", mode: 0o600 }).catch((e) => { if (e.code !== "EEXIST") throw e; });
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    }
    const stat = await fs.stat(file).catch((e) => { if (e.code !== "ENOENT") throw e; return null; });
    if (stat && !stat.isFile()) throw new Error(`${file}: expected a configuration file`);
    return { path: file, exists: !!stat };
  }

  check(name: AgentCli): Promise<CliCheck> {
    const existing = this.checking.get(name);
    if (existing) return existing;
    const pending = this.probe(name).finally(() => this.checking.delete(name));
    this.checking.set(name, pending);
    return pending;
  }

  private async probe(name: AgentCli): Promise<CliCheck> {
    await this.clis.refresh();
    const executable = this.clis.executable(name);
    if (!executable) return { state: "missing" };
    const env = this.clis.env();
    const result = await this.runner(executable, ["--version"], { env });
    const version = /\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/.exec(result.stdout)?.[0];
    if (result.code !== 0 || !version) return { state: "broken", issue: result.timedOut ? "timeout" : "execution" };
    const delegated = await this.credentials(name);
    if (delegated) return { ...delegated, version };
    const auth = await this.runner(executable, [...PROVIDERS[name].auth], { env });
    if (auth.timedOut || auth.code === null) return { state: "unknown", version, issue: auth.timedOut ? "timeout" : "auth" };
    if (name === "codex") {
      if (auth.code === 0) return { state: "ready", version };
      if (/not logged in/i.test(auth.stdout + auth.stderr)) return { state: "unauthenticated", version };
      return { state: "unknown", version, issue: "auth" };
    }
    try {
      const status = JSON.parse(auth.stdout);
      const external = !!status.apiProvider && status.apiProvider !== "firstParty";
      if (external) return { state: "unknown", version, issue: "auth" };
      if (typeof status.loggedIn === "boolean") return { state: status.loggedIn || status.apiKeySource ? "ready" : "unauthenticated", version };
    } catch { /* Old CLIs or invalid settings: do not claim the credentials work. */ }
    return { state: "unknown", version, issue: "auth" };
  }

  install(name: AgentCli): Promise<CliCheck> {
    const existing = this.installing.get(name);
    if (existing) return existing;
    const pending = this.performInstall(name).finally(() => this.installing.delete(name));
    this.installing.set(name, pending);
    return pending;
  }

  /**
   * Download `name`'s official release into the app's folder for it (`installDir`): the new one is put beside the old
   * and then takes its place, so a failed download leaves the old one as it was.
   */
  private async performInstall(name: AgentCli): Promise<CliCheck> {
    const windows = process.platform === "win32";
    const destination = this.clis.installDir(name);
    const program = `${name}${windows ? ".exe" : ""}`;
    await fs.mkdir(path.dirname(destination), { recursive: true });
    const staging = await fs.mkdtemp(path.join(path.dirname(destination), `.${name}-`));
    try {
      if (name === "codex") await this.downloadCodex(staging, program);
      else await downloadClaude(staging, program);
      if (!windows) await fs.chmod(path.join(staging, program), 0o755);
      const previous = `${destination}.previous`;
      await fs.rm(previous, { recursive: true, force: true });
      await fs.rename(destination, previous).catch((e) => { if (e.code !== "ENOENT") throw e; });
      await fs.rename(staging, destination);
      await fs.rm(previous, { recursive: true, force: true });
      // Installed at the user's word: it, not a copy they pointed to before, is the one. The link in installed/bin
      // and the launcher of its ACP wrapper now name it.
      this.clis.forget(name);
      this.clis.resync();
      // A check that started before the install cannot supply its stale result.
      await this.checking.get(name);
      return this.check(name);
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
  }

  /**
   * Codex's newest release on GitHub: an archive of its program and the programs that come with it. Its name is fixed
   * by the platform, so it is fetched by GitHub's address of the latest release's file, not looked up with GitHub's
   * API, which refuses a network past 60 requests an hour.
   */
  private async downloadCodex(into: string, program: string): Promise<void> {
    const windows = process.platform === "win32";
    const target = codexTarget(process.platform, process.arch);
    const asset = `${CODEX_RELEASES}/codex-${target}${windows ? ".exe.zip" : ".tar.gz"}`;
    const archive = path.join(os.tmpdir(), `xsb-codex-${process.pid}-${Date.now()}${windows ? ".zip" : ".tar.gz"}`);
    try {
      await download(asset, archive);
      const result = await this.runner(windows ? "tar.exe" : "/usr/bin/tar", ["-xf", archive, "-C", into], { timeout: 60000 });
      if (result.code !== 0) throw new Error("Could not extract the official Codex release");
    } finally { await fs.rm(archive, { force: true }); }
    await fs.rename(path.join(into, `codex-${target}${windows ? ".exe" : ""}`), path.join(into, program));
  }
}

/** The files of Codex's newest official release. */
const CODEX_RELEASES = "https://github.com/openai/codex/releases/latest/download";

/** Where Claude Code's official releases are published, as its own installer downloads them (https://claude.ai/install.sh). */
const CLAUDE_RELEASES = "https://downloads.claude.ai/claude-code-releases";

/** Claude Code's platform names in its releases' manifest. */
export function claudePlatform(platform: NodeJS.Platform, arch: string): string {
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  const system = ({ darwin: "darwin", linux: "linux", win32: "win32" } as Partial<Record<NodeJS.Platform, string>>)[platform];
  if (!cpu || !system) throw new Error("Unsupported CLI platform");
  return `${system}-${cpu}`;
}

/**
 * Claude Code's newest release, its program alone: what its official installer downloads and checks before it sets
 * the program up in the user's home. That setting up is not done: the app runs the program from its own folder.
 */
async function downloadClaude(into: string, program: string, fetcher: typeof fetch = fetch): Promise<void> {
  const text = async (url: string) => {
    const response = await fetcher(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Official download: HTTP ${response.status}`);
    return response.text();
  };
  const version = (await text(`${CLAUDE_RELEASES}/latest`)).trim();
  if (!/^\d+\.\d+\.\d+[\w.+-]*$/.test(version)) throw new Error("Claude Code's release service gave no version");
  const platform = claudePlatform(process.platform, process.arch);
  const entry = (JSON.parse(await text(`${CLAUDE_RELEASES}/${version}/manifest.json`)) as { platforms?: Record<string, { binary?: string; checksum?: string; size?: number }> })
    .platforms?.[platform];
  if (!entry?.binary || !/^[\w.-]+$/.test(entry.binary) || !/^[a-f0-9]{64}$/.test(entry.checksum ?? "")) throw new Error("Official Claude Code release unavailable for this platform");
  const file = path.join(into, program);
  await download(`${CLAUDE_RELEASES}/${version}/${platform}/${entry.binary}`, file);
  if (await sha256(file) !== entry.checksum) throw new Error("Claude Code's download did not match its published checksum");
}

async function sha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

export function codexTarget(platform: NodeJS.Platform, arch: string): string {
  const cpu = arch === "arm64" ? "aarch64" : arch === "x64" ? "x86_64" : null;
  const system = ({ darwin: "apple-darwin", linux: "unknown-linux-musl", win32: "pc-windows-msvc" } as Partial<Record<NodeJS.Platform, string>>)[platform];
  if (!cpu || !system) throw new Error("Unsupported CLI platform");
  return `${cpu}-${system}`;
}

async function download(url: string, file: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok || !response.body) throw new Error(`Official download: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(file, { flags: "wx", mode: 0o600 }));
}
