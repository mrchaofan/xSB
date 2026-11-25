/**
 * Programs of the user's machine that the app needs but does not ship: the
 * agents' own (claude, codex) and tools that roles work with
 * (ffmpeg, arkcli). AgentClis can install the two agents from official channels. A program is there when it is on
 * the user's PATH; when it is not, the user is asked where it is, and that
 * path is remembered (`paths.json`).
 *
 * The hub and the agents it starts find a program as a command on PATH, and
 * know nothing of this module: it puts a directory of launchers first on the
 * PATH the hub is started with. It also tells the hub where the plugins shipped
 * with the app are (`PLUGINS_ENV`, ../plugins next to this code) and where the
 * app's browser listens, for the browser plugin to be told (`SOCKET_ENV`).
 *
 *   <dir>/bin/claude-agent-acp   the ACP wrapper shipped in the app, told where the claude program is
 *   <dir>/bin/codex-acp          the same for codex
 *   <dir>/bin/ffmpeg, …          a program the user pointed to
 *   <dir>/browser.sock           where the app's browser listens (browser.ts)
 *   <dir>/paths.json             command name -> where the user said the program is
 *
 * A launcher exists exactly while its program does, so "is it installed"
 * keeps one meaning: the command is on PATH.
 *
 * The user's environment is the one their shell has. An app started from the
 * Finder or the Dock is not given it (a PATH of /usr/bin:/bin:/usr/sbin:/sbin,
 * and none of the variables the shell's startup files set, such as the API
 * key an agent's own configuration names), so it is asked of the user's login
 * shell. The PATH is the shell's; of the rest, what this process already has
 * stays as it is.
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { PLUGINS_ENV, findCommand } from "@xsb/hub";
import { SOCKET_ENV } from "./browser.ts";

/** The hub's built-in backends: each is named after the program of the user's machine it is, or is built around. */
export const AGENTS = new Set(["claude", "codex"]);

/** Programs that do not speak ACP themselves: the wrapper shipped in the app, and how it is told where the program is. */
const WRAPPERS: Record<string, { command: string; env: string }> = {
  claude: { command: "claude-agent-acp", env: "CLAUDE_CODE_EXECUTABLE" },
  codex: { command: "codex-acp", env: "CODEX_PATH" },
};
/** Where the app's own programs are bundled (rolldown.config.js). */
const SHIPPED = fileURLToPath(new URL("../bin/", import.meta.url));
/** The plugins shipped with the app: beside the code, outside any archive, in development as when packed. */
const PLUGINS = fileURLToPath(new URL("../plugins/", import.meta.url));
const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
/** A shell line that runs a JavaScript program shipped in the app: Electron's own binary is the Node. */
const node = (program: string): string => `ELECTRON_RUN_AS_NODE=1 exec ${quote(process.execPath)} ${quote(path.join(SHIPPED, program))} "$@"`;

/** The environment of the user's shell; nothing where the shell does not say. */
function shellEnv(): Record<string, string> {
  if (process.platform === "win32") return {};
  try {
    // Between marks, because a shell's startup files may print things of their own.
    const out = execFileSync(process.env.SHELL || "/bin/zsh", ["-ilc", 'printf "<xsb-env>"; env -0; printf "</xsb-env>"'], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    const vars = /<xsb-env>(.*)<\/xsb-env>/s.exec(out)?.[1].split("\0") ?? [];
    return Object.fromEntries(vars.filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  } catch {
    return {};
  }
}

/** Read login PATH asynchronously on refresh: installers may have changed shell startup files. */
async function refreshedPath(): Promise<string> {
  try {
    const windows = process.platform === "win32";
    const { stdout } = await promisify(execFile)(windows ? "powershell.exe" : process.env.SHELL || "/bin/zsh", windows
      ? ["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"]
      : ["-ilc", 'printf "<xsb-path>%s</xsb-path>" "$PATH"'], { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 });
    return windows ? stdout.trim() : /<xsb-path>(.*)<\/xsb-path>/s.exec(stdout)?.[1] ?? "";
  } catch { return ""; }
}

/** The program of the user's machine a wrapper is built around, for a wrapper's command: what is missing when the wrapper is. */
export const wrapped = (command: string): string | undefined => Object.keys(WRAPPERS).find((program) => WRAPPERS[program].command === command);

/** See `Clis.launchEnv`. locate: where a program is, as `executable` says. */
export type LaunchEnv = (program: string, windows: boolean, locate: (command: string) => string | null) => { lines: string[]; executable?: string };

export class Clis {
  /** Where the app's browser listens for agents; the browser plugin is told through `SOCKET_ENV`. */
  readonly browserSocket: string;
  private bin: string;
  private file: string;
  private paths: Record<string, string> = {};
  /** The PATH as the user has it, without the launchers. */
  private userPath: string;
  private refreshing?: Promise<void>;
  /**
   * Lines a wrapper's launcher runs before the wrapper, by the program it is built around: how the agent xSB starts
   * is pointed at another service (ark.ts). The launcher stays the one place xSB's agents get their environment.
   */
  private launchEnv: LaunchEnv;

  constructor(dir: string, launchEnv: LaunchEnv = () => ({ lines: [] })) {
    this.launchEnv = launchEnv;
    const env = shellEnv();
    for (const [name, value] of Object.entries(env)) process.env[name] ??= value;
    this.userPath = [...new Set([env.PATH ?? process.env.PATH ?? "", path.join(os.homedir(), ".local", "bin")].flatMap((p) => p.split(path.delimiter)))].join(path.delimiter);
    this.browserSocket = path.join(dir, "browser.sock");
    this.bin = path.join(dir, "bin");
    this.file = path.join(dir, "paths.json");
    fs.mkdirSync(this.bin, { recursive: true });
    try {
      this.paths = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      // No file yet, or one that cannot be read: the user locates the programs again.
    }
    process.env.PATH = `${this.bin}${path.delimiter}${this.userPath}`;
    // The hubs this app starts inherit these: the shipped plugins, and where their browser plugin connects.
    process.env[PLUGINS_ENV] = PLUGINS;
    process.env[SOCKET_ENV] = this.browserSocket;
    this.sync();
  }

  /** Write the launchers again, with what `launchEnv` says now. */
  resync(): void {
    this.sync();
  }

  /** Whether a program can be found neither on the user's PATH nor where the user said. */
  missing(command: string): boolean {
    return !this.locate(command);
  }

  executable(command: string): string | null {
    return this.locate(command)?.path ?? null;
  }

  /** Rebuild the same launcher files existing hubs see, with the fresh PATH baked in. */
  async refresh(extra: string[] = []): Promise<void> {
    if (this.refreshing) {
      await this.refreshing;
      if (!extra.length) return;
      return this.refresh(extra);
    }
    const pending = (async () => {
      const fresh = await refreshedPath();
      this.userPath = [...new Set([...extra, ...fresh.split(path.delimiter), ...this.userPath.split(path.delimiter)].filter((p) => p && p !== this.bin))].join(path.delimiter);
      process.env.PATH = `${this.bin}${path.delimiter}${this.userPath}`;
      this.sync();
    })();
    this.refreshing = pending;
    try { await pending; } finally { if (this.refreshing === pending) this.refreshing = undefined; }
  }

  /** The user says where a program is. Whether it is one: a file that can be run. */
  setPath(command: string, file: string): boolean {
    if (!findCommand(file)) return false;
    this.paths[command] = file;
    fs.writeFileSync(this.file, JSON.stringify(this.paths, null, 2));
    this.sync();
    return true;
  }

  /** Where a program is: on the user's PATH, or else where the user said. */
  private locate(command: string): { path: string; configured: boolean } | null {
    // An explicit selection must override an older/broken copy on PATH; fall back if the selection disappears.
    const configured = this.paths[command] && findCommand(this.paths[command]);
    if (configured) return { path: configured, configured: true };
    const onPath = findCommand(command, this.userPath);
    return onPath ? { path: onPath, configured: false } : null;
  }

  /** Make the launchers say what is true now. */
  private sync(): void {
    if (process.platform === "win32") return this.syncWindows();
    const launchers = new Map<string, string>();
    for (const command of new Set([...Object.keys(WRAPPERS), ...Object.keys(this.paths)])) {
      const found = this.locate(command);
      if (!found) continue;
      const wrapper = WRAPPERS[command];
      if (wrapper) {
        const launch = this.launchEnv(command, false, (c) => this.executable(c));
        launchers.set(wrapper.command, [...launch.lines, `${wrapper.env}=${quote(launch.executable ?? found.path)} ${node(wrapper.command)}`].join("\n"));
      }
      // A program the user pointed to is not on PATH: with a launcher of its name, whatever runs it by name finds it.
      if (found.configured) launchers.set(command, `exec ${quote(found.path)} "$@"`);
    }
    for (const name of fs.readdirSync(this.bin)) if (!launchers.has(name)) fs.rmSync(path.join(this.bin, name));
    for (const [name, line] of launchers) fs.writeFileSync(path.join(this.bin, name), `#!/bin/sh\nexport PATH=${quote(process.env.PATH ?? "")}\n${line}\n`, { mode: 0o755 });
  }

  private syncWindows(): void {
    const cmdQuote = (s: string): string => `"${s.replaceAll("%", "%%")}"`;
    const set = (key: string, value: string): string => `set ${cmdQuote(`${key}=${value}`)}\r\n`;
    const node = (program: string): string => `${set("ELECTRON_RUN_AS_NODE", "1")}${cmdQuote(process.execPath)} ${cmdQuote(path.join(SHIPPED, program))} %*`;
    const launchers = new Map<string, string>();
    for (const command of new Set([...Object.keys(WRAPPERS), ...Object.keys(this.paths)])) {
      const found = this.locate(command);
      if (!found) continue;
      const wrapper = WRAPPERS[command];
      if (wrapper) {
        const launch = this.launchEnv(command, true, (c) => this.executable(c));
        launchers.set(`${wrapper.command}.cmd`, `${launch.lines.map((line) => `${line}\r\n`).join("")}${set(wrapper.env, launch.executable ?? found.path)}${node(wrapper.command)}`);
      }
      if (found.configured) launchers.set(`${command}.cmd`, `${cmdQuote(found.path)} %*`);
    }
    for (const name of fs.readdirSync(this.bin)) if (!launchers.has(name)) fs.rmSync(path.join(this.bin, name));
    for (const [name, body] of launchers) fs.writeFileSync(path.join(this.bin, name), `@echo off\r\n${set("PATH", process.env.PATH ?? "")}${body}\r\n`);
  }
}
