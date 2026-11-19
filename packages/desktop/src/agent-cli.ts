/** User-facing CLI lifecycle. Providers are data; filesystem, probes and installs share one service.
 * Probes never create a session or send a prompt. Authentication is local status, not proof of credit/network access.
 */
import { execFile } from "node:child_process";
import spawn from "cross-spawn";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import type { Language } from "@xsb/protocol";
import type { Clis } from "./clis.ts";

export type AgentCli = "codex" | "claude";
export type CliCheck = { state: "missing" | "broken" | "unauthenticated" | "unknown" | "ready"; version?: string; issue?: "timeout" | "execution" | "auth" };
export type CliConfig = { path: string; exists: boolean };
type Result = { code: number | null; stdout: string; stderr?: string; timedOut: boolean };
export type Runner = (file: string, args: string[], options?: { timeout?: number; cwd?: string }) => Promise<Result>;
const shQuote = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`;
const psQuote = (s: string): string => `'${s.replaceAll("'", "''")}'`;

/** Fixed executable + argument vector; no user-controlled shell command. Output is bounded and never returned to UI. */
export const run: Runner = (file, args, options = {}) => new Promise((resolve) => {
  const windows = process.platform === "win32";
  const child = spawn(file, args, { cwd: options.cwd, detached: !windows, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } });
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
  codex: { env: "CODEX_HOME", directory: ".codex", file: "config.toml", auth: ["login", "status"] },
  claude: { env: "CLAUDE_CONFIG_DIR", directory: ".claude", file: "settings.json", auth: ["auth", "status", "--json"] },
} as const;
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
  private clis: Pick<Clis, "executable" | "refresh" | "setPath">;
  private directory: string;
  private runner: Runner;
  private home: string;
  constructor(clis: Pick<Clis, "executable" | "refresh" | "setPath">, directory: string, runner: Runner = run, home = os.homedir()) {
    this.clis = clis;
    this.directory = directory;
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
    const result = await this.runner(executable, ["--version"]);
    const version = /\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/.exec(result.stdout)?.[0];
    if (result.code !== 0 || !version) return { state: "broken", issue: result.timedOut ? "timeout" : "execution" };
    const auth = await this.runner(executable, [...PROVIDERS[name].auth]);
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

  private async performInstall(name: AgentCli): Promise<CliCheck> {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "xsb-cli-"));
    try {
      let executable: string;
      if (name === "codex") {
        const target = codexTarget(process.platform, process.arch);
        const release = await fetch("https://api.github.com/repos/openai/codex/releases/latest", { headers: { "User-Agent": "xsb-desktop", Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(30000) });
        if (!release.ok) throw new Error(`GitHub: HTTP ${release.status}`);
        const data = await release.json() as { assets?: { name: string; browser_download_url: string }[] };
        const windows = process.platform === "win32";
        const asset = data.assets?.find((a) => a.name === `codex-${target}${windows ? ".exe.zip" : ".tar.gz"}`);
        if (!asset || !asset.browser_download_url.startsWith("https://github.com/openai/codex/releases/download/")) throw new Error("Official Codex release unavailable for this platform");
        const archive = path.join(temporary, windows ? "codex.zip" : "codex.tar.gz");
        await download(asset.browser_download_url, archive);
        const extracted = path.join(temporary, "extracted");
        await fs.mkdir(extracted);
        const result = await this.runner(windows ? "tar.exe" : "/usr/bin/tar", ["-xf", archive, "-C", extracted], { timeout: 60000 });
        if (result.code !== 0) throw new Error("Could not extract the official Codex release");
        const binary = `codex-${target}${windows ? ".exe" : ""}`;
        const destination = path.join(this.directory, "codex");
        await fs.mkdir(destination, { recursive: true });
        await fs.cp(extracted, destination, { recursive: true });
        executable = path.join(destination, windows ? "codex.exe" : "codex");
        await fs.copyFile(path.join(destination, binary), executable);
        if (!windows) await fs.chmod(executable, 0o755);
      } else {
        const windows = process.platform === "win32";
        const script = path.join(temporary, windows ? "install.ps1" : "install.sh");
        await download(`https://claude.ai/install.${windows ? "ps1" : "sh"}`, script);
        const result = await this.runner(windows ? "powershell.exe" : "/bin/bash", windows ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script] : [script], { timeout: 300000, cwd: temporary });
        if (result.code !== 0) throw new Error(result.timedOut ? "Claude installation timed out; retry or use the official setup guide" : "Claude installation failed; check your network and the official setup guide");
        executable = path.join(this.home, ".local", "bin", windows ? "claude.exe" : "claude");
      }
      if (!this.clis.setPath(name, executable)) throw new Error("Installer finished but the CLI executable could not be found");
      await this.clis.refresh([path.dirname(executable)]);
      await persistPath(path.dirname(executable), this.runner, this.home);
      await this.clis.refresh([path.dirname(executable)]);
      // A check that started before the install cannot supply its stale result.
      await this.checking.get(name);
      return this.check(name);
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }
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

/** Persist for new terminals; Clis refresh separately updates this app and existing hub launchers immediately. */
export async function persistPath(directory: string, runner: Runner = run, home = os.homedir(), shell = process.env.SHELL || "/bin/zsh", platform = process.platform): Promise<void> {
  if (platform === "win32") {
    const script = `$d=${psQuote(directory)}; $p=[Environment]::GetEnvironmentVariable('Path','User'); if (($p -split ';') -notcontains $d) { [Environment]::SetEnvironmentVariable('Path', ($d+';'+$p), 'User') }`;
    if ((await runner("powershell.exe", ["-NoProfile", "-Command", script])).code !== 0) throw new Error("CLI installed; could not update user PATH. Locate the installed executable or update PATH in system settings.");
    return;
  }
  const kind = path.basename(shell);
  if (!["zsh", "bash", "fish", "sh", "dash", "ksh"].includes(kind)) throw new Error(`CLI installed; update PATH in your ${kind} shell configuration`);
  let bashLogin = ".bash_profile";
  if (kind === "bash") {
    // Creating .bash_profile would hide an existing .bash_login/.profile. Extend whichever bash already loads.
    for (const file of [".bash_profile", ".bash_login", ".profile"]) {
      if (await fs.stat(path.join(home, file)).then(() => true, (e) => { if (e.code !== "ENOENT") throw e; return false; })) { bashLogin = file; break; }
    }
  }
  const files = kind === "zsh" ? [".zprofile", ".zshrc"] : kind === "bash" ? [bashLogin, ".bashrc"] : kind === "fish" ? [".config/fish/conf.d/xsb-cli.fish"] : [".profile"];
  const line = kind === "fish" ? `fish_add_path -- ${shQuote(directory)}` : `export PATH=${shQuote(directory)}:"$PATH"`;
  for (const relative of files) {
    const file = path.join(home, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const text = await fs.readFile(file, "utf8").catch((e) => { if (e.code !== "ENOENT") throw e; return ""; });
    if (!text.split("\n").includes(line)) await fs.appendFile(file, `\n# xsb CLI\n${line}\n`, { mode: 0o600 });
  }
}
