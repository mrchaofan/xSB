/**
 * Configuration, in two files with no field in common:
 *
 *   ~/.xsb/config.json        about this machine: which backends exist and how to start them
 *   <project>/.xsb/config.json about this project: which agent is the default, which preset teams it uses,
 *                             which language its agents work in
 *
 * xsb starts backends; it does not install them, sign them in, or decide what
 * they may do. Credentials and permission modes are each backend's own
 * settings, and a backend process simply inherits the hub's environment.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { failure } from "@xsb/protocol";
import type { BackendInfo, Language } from "@xsb/protocol";
import { DIR } from "./paths.ts";
import type { Paths } from "./paths.ts";

/**
 * A backend is a command that speaks ACP on stdio. That is the whole contract:
 * the hub runs an agent's official ACP entry point and a wrapper written for
 * an agent without one (@xsb/adapter) through the same code.
 */
export type BackendSpec = {
  /** Executable, looked up on PATH unless it is a path. */
  command: string;
  args?: string[];
};

/**
 * The official ACP entry point of each agent, as listed in the ACP registry
 * (https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json).
 * `backends` in the global config replaces entries by name or adds others.
 */
export const BUILTIN_BACKENDS: Record<string, BackendSpec> = {
  claude: { command: "claude-agent-acp" },
  codex: { command: "codex-acp" },
  gemini: { command: "gemini", args: ["--acp"] },
  grok: { command: "grok", args: ["agent", "stdio"] },
};

/** How to get a built-in backend, for the error message only. */
export const INSTALL_HINT: Record<string, string> = {
  "claude-agent-acp": "npm i -g @agentclientprotocol/claude-agent-acp",
  "codex-acp": "npm i -g @agentclientprotocol/codex-acp",
  gemini: "npm i -g @google/gemini-cli",
  grok: "npm i -g @xai-official/grok",
};

export type GlobalConfig = { version: 1; backends?: Record<string, BackendSpec> };
/**
 * `language` is the language the project's agents speak and write, and the one its preset teams are read in.
 * It is set once, from the first client that says which language its user reads (`LanguageExt`), and is the user's to edit.
 */
export type ProjectConfig = { version: 1; defaultAgent?: string; teams?: string[]; language?: Language };

/** Agents whose spec names no backend get this one. */
export const DEFAULT_BACKEND = "claude";

export const globalDir = (): string => process.env.XSB_HOME ?? path.join(os.homedir(), DIR);
export const globalConfigPath = (): string => path.join(globalDir(), "config.json");

function readJson<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw failure("invalid_json", { file, detail: (e as Error).message });
  }
}

export function loadProjectConfig(paths: Paths): ProjectConfig {
  return readJson<ProjectConfig>(paths.config, { version: 1 });
}

/** The project's working language. English until a client has declared one. */
export const projectLanguage = (paths: Paths): Language => loadProjectConfig(paths).language ?? "en";

export function saveProjectConfig(paths: Paths, config: ProjectConfig): void {
  fs.writeFileSync(paths.config, JSON.stringify(config, null, 2) + "\n");
}

/** Make a directory a project. Returns whether that also created the machine's config. */
export function initProject(paths: Paths): boolean {
  fs.mkdirSync(paths.shared, { recursive: true });
  fs.mkdirSync(paths.run, { recursive: true });
  if (!fs.existsSync(paths.config)) saveProjectConfig(paths, { version: 1 });
  fs.writeFileSync(path.join(paths.dir, ".gitignore"), "run/\n");
  return initGlobalConfig();
}

/** Create the global config if there is none. Returns whether it did. */
function initGlobalConfig(): boolean {
  if (fs.existsSync(globalConfigPath())) return false;
  fs.mkdirSync(globalDir(), { recursive: true });
  fs.writeFileSync(globalConfigPath(), JSON.stringify({ version: 1, backends: {} } satisfies GlobalConfig, null, 2) + "\n");
  return true;
}

/** The backends of this machine. Read on every use, so an edit needs no hub restart. */
export function backends(): Record<string, BackendSpec> {
  return { ...BUILTIN_BACKENDS, ...readJson<GlobalConfig>(globalConfigPath(), { version: 1 }).backends };
}

/** The backends as a client is told of them: each with whether its command is found on this process's PATH. */
export function describeBackends(): BackendInfo[] {
  return Object.entries(backends()).map(([name, spec]) => ({
    name,
    command: spec.command,
    args: spec.args ?? [],
    installed: findCommand(spec.command) !== null,
    installHint: INSTALL_HINT[spec.command],
  }));
}

/** Absolute path of a command on `searchPath` (the process's PATH unless given), or null when it is not installed. */
export function findCommand(command: string, searchPath = process.env.PATH ?? ""): string | null {
  const runnable = (file: string): boolean => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  };
  if (command.includes(path.sep)) return runnable(command) ? path.resolve(command) : null;
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of searchPath.split(path.delimiter)) {
    for (const ext of exts) {
      const file = path.join(dir, command + ext);
      if (dir && runnable(file)) return file;
    }
  }
  return null;
}
