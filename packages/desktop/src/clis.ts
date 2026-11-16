/**
 * Programs of the user's machine that the app needs but does not ship: the
 * agents' own (claude, codex, gemini, grok) and tools that roles work with
 * (ffmpeg, arkcli). The app installs none of them. A program is there when it is on
 * the user's PATH; when it is not, the user is asked where it is, and that
 * path is remembered (`paths.json`).
 *
 * The hub and the agents it starts find a program as a command on PATH, and
 * know nothing of this module: it puts a directory of launchers first on the
 * PATH the hub is started with.
 *
 *   <dir>/bin/claude-agent-acp   the ACP wrapper shipped in the app, told where the claude program is
 *   <dir>/bin/codex-acp          the same for codex
 *   <dir>/bin/gemini, ffmpeg, …  a program the user pointed to
 *   <dir>/bin/xsb-media-mcp      an MCP server shipped in the app, for a role to name by its command
 *   <dir>/bin/xsb-browser-mcp    the same: the way to the browser in the app's side panel (browser.ts)
 *   <dir>/browser.sock           where that browser listens
 *   <dir>/paths.json             command name -> where the user said the program is
 *
 * A launcher exists exactly while its program does, so "is it installed"
 * keeps one meaning: the command is on PATH.
 *
 * The user's PATH is the one their shell has. An app started from the Finder
 * or the Dock is not given it (only /usr/bin:/bin:/usr/sbin:/sbin), so it is
 * asked of the user's login shell; nothing else of that shell's environment
 * is taken.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findCommand } from "@xsb/hub";
import { SOCKET_ENV } from "./browser.ts";

/** The hub's built-in backends, and the program of the user's machine each one is, or is built around. */
export const AGENTS: Record<string, string> = { claude: "claude", codex: "codex", gemini: "gemini", grok: "grok" };

/** Programs that do not speak ACP themselves: the wrapper shipped in the app, and how it is told where the program is. */
const WRAPPERS: Record<string, { command: string; env: string }> = {
  claude: { command: "claude-agent-acp", env: "CLAUDE_CODE_EXECUTABLE" },
  codex: { command: "codex-acp", env: "CODEX_PATH" },
};
/** MCP servers shipped in the app. A role names one by its command. */
const TOOLS = ["xsb-media-mcp", "xsb-browser-mcp"];

/** Where the app's own programs are bundled (rolldown.config.js). */
const SHIPPED = fileURLToPath(new URL("../bin/", import.meta.url));
const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
/** A shell line that runs a JavaScript program shipped in the app: Electron's own binary is the Node. */
const node = (program: string): string => `ELECTRON_RUN_AS_NODE=1 exec ${quote(process.execPath)} ${quote(path.join(SHIPPED, program))} "$@"`;

/** The PATH of the user's shell, or this process's own where the shell does not say. */
function shellPath(): string {
  const own = process.env.PATH ?? "";
  if (process.platform === "win32") return own;
  try {
    // Between marks, because a shell's startup files may print things of their own.
    const out = execFileSync(process.env.SHELL || "/bin/zsh", ["-ilc", 'printf "<xsb-path>%s</xsb-path>" "$PATH"'], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    return /<xsb-path>(.+)<\/xsb-path>/s.exec(out)?.[1] || own;
  } catch {
    return own;
  }
}

/** The program of the user's machine a wrapper is built around, for a wrapper's command: what is missing when the wrapper is. */
export const wrapped = (command: string): string | undefined => Object.keys(WRAPPERS).find((program) => WRAPPERS[program].command === command);

export class Clis {
  /** Where the app's browser listens for agents; `xsb-browser-mcp` is told by its launcher. */
  readonly browserSocket: string;
  private bin: string;
  private file: string;
  private paths: Record<string, string> = {};
  /** The PATH as the user has it, without the launchers. */
  private userPath = shellPath();

  constructor(dir: string) {
    this.browserSocket = path.join(dir, "browser.sock");
    this.bin = path.join(dir, "bin");
    this.file = path.join(dir, "paths.json");
    fs.mkdirSync(this.bin, { recursive: true });
    if (fs.existsSync(this.file)) this.paths = JSON.parse(fs.readFileSync(this.file, "utf8"));
    process.env.PATH = `${this.bin}${path.delimiter}${this.userPath}`;
    this.sync();
  }

  /** Whether a program can be found neither on the user's PATH nor where the user said. */
  missing(command: string): boolean {
    return !this.locate(command);
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
    const onPath = findCommand(command, this.userPath);
    if (onPath) return { path: onPath, configured: false };
    const configured = this.paths[command] && findCommand(this.paths[command]);
    return configured ? { path: configured, configured: true } : null;
  }

  /** Make the launchers say what is true now. */
  private sync(): void {
    const launchers = new Map<string, string>(TOOLS.map((tool) => [tool, `${SOCKET_ENV}=${quote(this.browserSocket)} ${node(tool)}`]));
    for (const command of new Set([...Object.keys(WRAPPERS), ...Object.keys(this.paths)])) {
      const found = this.locate(command);
      if (!found) continue;
      const wrapper = WRAPPERS[command];
      if (wrapper) launchers.set(wrapper.command, `${wrapper.env}=${quote(found.path)} ${node(wrapper.command)}`);
      // A program the user pointed to is not on PATH: with a launcher of its name, whatever runs it by name finds it.
      if (found.configured) launchers.set(command, `exec ${quote(found.path)} "$@"`);
    }
    for (const name of fs.readdirSync(this.bin)) if (!launchers.has(name)) fs.rmSync(path.join(this.bin, name));
    for (const [name, line] of launchers) fs.writeFileSync(path.join(this.bin, name), `#!/bin/sh\n${line}\n`, { mode: 0o755 });
  }
}
