/**
 * The programs the app runs, where each kind is kept, and the environment its child processes are given.
 *
 * Built in, shipped with the app and read-only:
 *
 *   <app>/dist/bin/<program>          xSB's own programs: JavaScript, run with Electron as Node (rolldown.config.js);
 *                                     among them the ACP wrappers of the agents (claude-agent-acp, codex-acp)
 *   <app>/node_modules/…              native programs shipped as published (package.json): arkcli (ark.ts)
 *
 * Kept by the app in `<dir>` (userData/backends):
 *
 *   <dir>/builtin/bin/<command>       links to the built-in native programs, by command name (arkcli)
 *   <dir>/installed/<name>/<name>     a program the app downloaded from its publisher (agent-cli.ts): claude, codex
 *   <dir>/installed/bin/<command>     links to them
 *   <dir>/bin/<command>               launchers: each agent's ACP wrapper, told where the agent's program is and, when
 *                                     it uses one, the Volcengine Ark plan (`launchEnv`, ark.ts); and links to the
 *                                     programs the user pointed to
 *   <dir>/paths.json                  command name -> where the user said the program is
 *   <dir>/browser.sock                where the app's browser listens (browser.ts)
 *
 * A link is a symbolic link; where one cannot be made (Windows without the right to), a hard link, and else a .cmd
 * that runs the program.
 *
 * Every child process the app starts gets `env()`: the PATH is the app's directories first — bin, builtin/bin,
 * installed/bin — then the user's own. The hub inherits it (workspace.ts), and so the agents and tools it starts.
 * The app's own `process.env.PATH` stays the user's.
 *
 * Where a program of the user's machine is, for a command: where the user said, else what the app installed, else on
 * the user's PATH (`locate`). A launcher exists exactly while its program does, so "is it installed" keeps one
 * meaning: the command is on the child processes' PATH.
 *
 * The user's environment is the one their shell has. An app started from the Finder or the Dock is not given it (a
 * PATH of /usr/bin:/bin:/usr/sbin:/sbin, and none of the variables the shell's startup files set, such as the API
 * key an agent's own configuration names), so it is asked of the user's login shell. The PATH is the shell's; of the
 * rest, what this process already has stays as it is. What xSB withholds (`WITHHELD_ENV` of the hub:
 * `NODE_OPTIONS`) is neither taken from the shell nor kept, so nothing the app starts gets it.
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { findCommand, withhold, updateJsonFile } from "@xsb/hub";
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
const windows = process.platform === "win32";
/** A native program's file name for a command: Windows finds a program on PATH by its extension. */
const programFile = (command: string): string => `${command}${windows ? ".exe" : ""}`;
const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
const cmdQuote = (s: string): string => `"${s.replaceAll("%", "%%")}"`;

/** The environment of the user's shell; nothing where the shell does not say. */
function shellEnv(): Record<string, string> {
  if (windows) return {};
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
    const { stdout } = await promisify(execFile)(windows ? "powershell.exe" : process.env.SHELL || "/bin/zsh", windows
      ? ["-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"]
      : ["-ilc", 'printf "<xsb-path>%s</xsb-path>" "$PATH"'], { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 });
    return windows ? stdout.trim() : /<xsb-path>(.*)<\/xsb-path>/s.exec(stdout)?.[1] ?? "";
  } catch { return ""; }
}

const joinPath = (parts: string[]): string => [...new Set(parts.flatMap((p) => p.split(path.delimiter)).filter(Boolean))].join(path.delimiter);

/**
 * Write `file` (in a folder of its own) as a link to `target`: a symbolic link, else a hard link, else (Windows) a
 * program that runs it. Answers the name the link has: a .cmd, for the last, is named so.
 */
export function link(target: string, file: string, name: string): string {
  try {
    fs.symlinkSync(path.relative(path.dirname(file), target), file);
    return name;
  } catch { /* no right to make symbolic links (Windows without developer mode) */ }
  try {
    fs.linkSync(target, file);
    return name;
  } catch { /* another volume */ }
  if (!windows) throw new Error(`cannot link ${file} to ${target}`);
  fs.writeFileSync(file, `@echo off\r\n${cmdQuote(target)} %*\r\n`);
  return name.replace(/\.exe$/i, "") + ".cmd";
}

/**
 * Make `dir` hold exactly `entries`: name -> what writes it at a given path and answers the name it is to have. Each
 * is written beside and then renamed into place, so a hub starting a program meanwhile finds the old one or the new.
 */
function settle(dir: string, entries: Map<string, (file: string, name: string) => string>): void {
  fs.mkdirSync(dir, { recursive: true });
  const kept = new Set<string>();
  for (const [name, write] of entries) {
    const temporary = path.join(dir, `.${name}.${process.pid}.tmp`);
    fs.rmSync(temporary, { force: true });
    const final = write(temporary, name);
    fs.renameSync(temporary, path.join(dir, final));
    kept.add(final);
  }
  for (const name of fs.readdirSync(dir)) if (!kept.has(name)) fs.rmSync(path.join(dir, name), { force: true, recursive: true });
}

/** The program of the user's machine a wrapper is built around, for a wrapper's command: what is missing when the wrapper is. */
export const wrapped = (command: string): string | undefined => Object.keys(WRAPPERS).find((program) => WRAPPERS[program].command === command);

/** See `Clis.launchEnv`. locate: where a program is, as `executable` says. */
export type LaunchEnv = (program: string, windows: boolean, locate: (command: string) => string | null) => { lines: string[]; executable?: string };

export type ClisOptions = {
  /** How each agent the app starts is pointed at another service (ark.ts); nothing by default. */
  launchEnv?: LaunchEnv;
  /** The built-in native programs, by command name: where in the app each is (or null where this build has none). */
  builtins?: Record<string, string | null>;
};

export class Clis {
  /** Where the app's browser listens for agents; the browser plugin is told through `SOCKET_ENV`. */
  readonly browserSocket: string;
  /** Launchers, and links to the programs the user pointed to. */
  private bin: string;
  /** Links to the built-in native programs. */
  private builtinBin: string;
  /** The programs the app installed, one folder each, and `bin` of links to them. */
  private installedDir: string;
  private file: string;
  private paths: Record<string, string> = {};
  /** The PATH as the user has it, without the app's directories. */
  private userPath: string;
  private refreshing?: Promise<void>;
  /**
   * Lines a wrapper's launcher runs before the wrapper, by the program it is built around: how the agent xSB starts
   * is pointed at another service (ark.ts). The launcher stays the one place xSB's agents get their environment.
   */
  private launchEnv: LaunchEnv;
  private builtins: Record<string, string | null>;

  constructor(dir: string, options: ClisOptions = {}) {
    this.launchEnv = options.launchEnv ?? (() => ({ lines: [] }));
    this.builtins = options.builtins ?? {};
    const env = withhold(shellEnv());
    for (const [name, value] of Object.entries(env)) process.env[name] ??= value;
    withhold(process.env);
    this.userPath = joinPath([env.PATH ?? process.env.PATH ?? ""]);
    process.env.PATH = this.userPath;
    this.browserSocket = path.join(dir, "browser.sock");
    this.bin = path.join(dir, "bin");
    this.builtinBin = path.join(dir, "builtin", "bin");
    this.installedDir = path.join(dir, "installed");
    this.file = path.join(dir, "paths.json");
    try {
      this.paths = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      // No file yet, or one that cannot be read: the user locates the programs again.
    }
    this.sync();
  }

  /** The PATH of the app's child processes: its own directories, then the user's. */
  path(): string {
    return joinPath([this.bin, this.builtinBin, path.join(this.installedDir, "bin"), this.userPath]);
  }

  /** The environment of the app's child processes: the hubs, and what the app runs itself. */
  env(): NodeJS.ProcessEnv {
    return withhold({
      ...process.env,
      PATH: this.path(),
      // Where the browser plugin connects.
      [SOCKET_ENV]: this.browserSocket,
    });
  }

  /** Where the app installs program `name` (agent-cli.ts); the program itself is `<that>/<name>[.exe]`. */
  installDir(name: string): string {
    return path.join(this.installedDir, name);
  }

  /** Write the launchers and links again, with what `launchEnv` and the installed programs say now. */
  resync(): void {
    this.sync();
  }

  /** Whether a program can be found neither where the user said, nor installed by the app, nor on the user's PATH. */
  missing(command: string): boolean {
    return !this.locate(command);
  }

  executable(command: string): string | null {
    return this.locate(command)?.path ?? null;
  }

  /** Read the user's PATH again (an installer may have changed it) and rebuild what existing hubs see. */
  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const pending = (async () => {
      const fresh = await refreshedPath();
      this.userPath = joinPath([fresh, this.userPath]);
      process.env.PATH = this.userPath;
      this.sync();
    })();
    this.refreshing = pending;
    try { await pending; } finally { if (this.refreshing === pending) this.refreshing = undefined; }
  }

  /** The user says where a program is. Whether it is one: a file that can be run. */
  setPath(command: string, file: string): boolean {
    if (!findCommand(file)) return false;
    this.changePaths(paths => ({ ...paths, [command]: file }));
    this.sync();
    return true;
  }

  /**
   * Forget where the user said `command` is: the app has just installed it (agent-cli.ts), which the user asked for
   * after that, so it is the one to use.
   */
  forget(command: string): void {
    if (!(command in this.paths)) return;
    this.changePaths(paths => { const { [command]: _old, ...rest } = paths; return rest; });
  }

  private changePaths(change: (paths: Record<string, string>) => Record<string, string>): void {
    this.paths = updateJsonFile(this.file, () => fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, "utf8")) : {}, change, paths => {
      if (!paths || typeof paths !== "object" || Array.isArray(paths) || Object.values(paths).some(value => typeof value !== "string")) throw new Error("Invalid program paths configuration");
    });
  }

  /** The program the app installed for `command`, if it did. */
  private installed(command: string): string | null {
    const file = path.join(this.installDir(command), programFile(command));
    return findCommand(file);
  }

  /** Where a program is: where the user said, else what the app installed, else on the user's PATH. */
  private locate(command: string): { path: string; configured: boolean } | null {
    // An explicit selection must override an older/broken copy; fall back if the selection disappears.
    const configured = this.paths[command] && findCommand(this.paths[command]);
    if (configured) return { path: configured, configured: true };
    const installed = this.installed(command);
    if (installed) return { path: installed, configured: false };
    const onPath = findCommand(command, this.userPath);
    return onPath ? { path: onPath, configured: false } : null;
  }

  /** Make the launchers and links say what is true now. */
  private sync(): void {
    const name = (command: string, target: string) => windows ? `${command}${path.extname(target) || ".exe"}` : command;
    // Built in: what this build ships.
    const links = (targets: [string, string][]) => new Map(targets.map(([file, target]) => [file, (temporary: string, final: string) => link(target, temporary, final)]));
    settle(this.builtinBin, links(Object.entries(this.builtins).filter((e): e is [string, string] => !!e[1] && fs.existsSync(e[1]))
      .map(([command, target]) => [name(command, target), target])));
    // Installed: a folder of each program the app downloaded.
    fs.mkdirSync(this.installedDir, { recursive: true });
    const installed: [string, string][] = [];
    for (const entry of fs.readdirSync(this.installedDir)) {
      const program = entry !== "bin" && this.installed(entry);
      if (program) installed.push([name(entry, program), program]);
    }
    settle(path.join(this.installedDir, "bin"), links(installed));
    // Launchers: the wrappers of the programs found, and the programs the user pointed to.
    const launchers = new Map<string, (file: string, name: string) => string>();
    const script = (text: string) => (file: string, name: string) => { fs.writeFileSync(file, text, { mode: 0o755 }); return name; };
    for (const command of new Set([...Object.keys(WRAPPERS), ...Object.keys(this.paths)])) {
      const found = this.locate(command);
      if (!found) continue;
      const wrapper = WRAPPERS[command];
      if (wrapper) {
        const launch = this.launchEnv(command, windows, (c) => this.executable(c));
        launchers.set(windows ? `${wrapper.command}.cmd` : wrapper.command, script(this.launcher(wrapper, launch, launch.executable ?? found.path)));
      }
      // A program the user pointed to is not on PATH: with a link of its name, whatever runs it by name finds it.
      // A built-in program is the app's own (an earlier version let the user point to arkcli): it is not replaced.
      if (found.configured && !(command in this.builtins)) launchers.set(name(command, found.path), (file, final) => link(found.path, file, final));
    }
    settle(this.bin, launchers);
  }

  /** A script that runs a wrapper shipped in the app, with Electron as its Node, told where its agent's program is. */
  private launcher(wrapper: { command: string; env: string }, launch: { lines: string[] }, program: string): string {
    const shipped = path.join(SHIPPED, wrapper.command);
    // The PATH of the hubs started before is baked in, so that they too see what is true now.
    if (windows) {
      const set = (key: string, value: string): string => `set ${cmdQuote(`${key}=${value}`)}\r\n`;
      return `@echo off\r\n${set("PATH", this.path())}${launch.lines.map((line) => `${line}\r\n`).join("")}${set(wrapper.env, program)}`
        + `${set("ELECTRON_RUN_AS_NODE", "1")}${cmdQuote(process.execPath)} ${cmdQuote(shipped)} %*\r\n`;
    }
    return [`#!/bin/sh`, `export PATH=${quote(this.path())}`, ...launch.lines,
      `${wrapper.env}=${quote(program)} ELECTRON_RUN_AS_NODE=1 exec ${quote(process.execPath)} ${quote(shipped)} "$@"`, ""].join("\n");
  }
}
