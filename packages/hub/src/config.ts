/**
 * Configuration, in two files with no field in common:
 *
 *   ~/.xsb2_global/config.json        about this machine: which backends exist and how to start them, plugins turned
 *                             off and project plugins approved (plugins.ts)
 *   <project>/.xsb2/config.json about this project: workflow limits, which language its agents work in, and
 *                             plugins turned off here
 *
 * xsb starts backends; it does not install them, sign them in, or decide what
 * they may do. Credentials and permission modes are each backend's own
 * settings, and a backend process simply inherits the hub's environment.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LANGUAGES, failure } from "@xsb/protocol";
import type { BackendInfo, Language } from "@xsb/protocol";
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
 * The official ACP entry point of each agent that serves ACP v2 (the hub speaks nothing older). Gemini CLI and Grok
 * serve ACP v1 only. `backends` in the global config replaces entries by name or adds others, which must serve v2.
 */
export const BUILTIN_BACKENDS: Record<string, BackendSpec> = {
  claude: { command: "claude-agent-acp" },
  codex: { command: "codex-acp" },
};

/** How to get a built-in backend, for the error message only. */
export const INSTALL_HINT: Record<string, string> = {
  "claude-agent-acp": "npm i -g @agentclientprotocol/claude-agent-acp",
  "codex-acp": "npm i -g @agentclientprotocol/codex-acp",
};

export type GlobalConfig = {
  version: 1;
  backends?: Record<string, BackendSpec>;
  /** Limits of each backend (`BACKEND_LIMITS`) and of the hub (`HUB_LIMITS`). */
  backendLimits?: Record<string, Partial<Record<BackendLimit, number>>>;
  limits?: Partial<Record<HubLimit, number>>;
  /** Plugins turned off on this machine (plugins.ts). */
  plugins?: Record<string, { enabled?: boolean }>;
  /** Fingerprints of the project plugins this machine approved (plugins.ts). */
  approvedPlugins?: string[];
};
/**
 * `language` is the language the project's agents speak and write,.
 * It is set once, from the first client that says which language its user reads (`LanguageExt`), and is the user's to edit.
 */
/**
 * Limits, all on this machine (~/.xsb2_global/config.json): xSB has no per-project or per-conversation ones. Each has a
 * default and the range a client may set (whole numbers); this table is the one place they are defined.
 *
 * Per backend, for they depend on its model (`backendLimits.<backend>`):
 *   sessionTokens            past how many tokens of context a conversation goes on in a new backend session
 *   promptTokens             the hub's estimated budget for standing instructions, input and handoff together
 *   contextReserveTokens     headroom kept within it for output, backend additions and estimation error
 *   toolOutputTokens         the estimated budget of one tool response or result the hub controls
 *   contextRecoveryAttempts  safe retries of a context refusal with no observed execution, per input; 0 disables
 * Of the hub (`limits`):
 *   jobsAtOnce               calls of one tool that run as jobs at a time; the others wait in the hub
 *   workflowValidationSteps  how far a workflow graph is explored when it is checked
 */
export const BACKEND_LIMITS = {
  sessionTokens: { default: 150_000, min: 10_000, max: 2_000_000 },
  promptTokens: { default: 32_000, min: 4_000, max: 2_000_000 },
  contextReserveTokens: { default: 8_192, min: 1_024, max: 200_000 },
  toolOutputTokens: { default: 4_000, min: 500, max: 200_000 },
  contextRecoveryAttempts: { default: 1, min: 0, max: 3 },
} as const;
export const HUB_LIMITS = {
  jobsAtOnce: { default: 2, min: 1, max: 16 },
  workflowValidationSteps: { default: 100_000, min: 1_000, max: 10_000_000 },
} as const;
export type BackendLimit = keyof typeof BACKEND_LIMITS;
export type HubLimit = keyof typeof HUB_LIMITS;
type Range = { default: number; min: number; max: number };

export type ProjectConfig = {
  version: 1 | 2;
  language?: Language;
  /** Plugins turned off in this project (plugins.ts). */
  plugins?: Record<string, { enabled?: boolean }>;
};

export const CONFIG_VERSION = 2;

const inRange = (range: Range, value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= range.min && value <= range.max;


/** A limit of a backend: what this machine sets for it, or the default. */
export function backendLimit(backend: string, name: BackendLimit): number {
  return backendLimits(backend)[name];
}

/** Every limit of a backend, from one read of the machine's config. */
export function backendLimits(backend: string): Record<BackendLimit, number> {
  const set = machineConfig().backendLimits?.[backend];
  return Object.fromEntries((Object.keys(BACKEND_LIMITS) as BackendLimit[])
    .map((name) => [name, inRange(BACKEND_LIMITS[name], set?.[name]) ? set![name]! : BACKEND_LIMITS[name].default])) as Record<BackendLimit, number>;
}

/** A limit of the hub: what this machine sets, or the default. */
export function hubLimit(name: HubLimit): number {
  const value = machineConfig().limits?.[name];
  return inRange(HUB_LIMITS[name], value) ? value : HUB_LIMITS[name].default;
}

/** The limits as a client shows them: each with its range, default and what this machine sets. */
export function limitSettings() {
  const config = machineConfig();
  const row = (table: Record<string, Range>, set: Record<string, unknown> | undefined) => Object.entries(table)
    .map(([name, range]) => ({ name, ...range, value: inRange(range, set?.[name]) ? set![name] as number : undefined }));
  return {
    hub: row(HUB_LIMITS, config.limits),
    backends: Object.fromEntries(Object.keys(backends()).map((name) => [name, row(BACKEND_LIMITS, config.backendLimits?.[name])])),
  };
}

/** Set a limit: of a backend when `backend` is given, else of the hub. `null` goes back to the default. */
export function setLimit(backend: string | null, name: string, value: unknown): ReturnType<typeof limitSettings> {
  const table: Record<string, Range> = backend ? BACKEND_LIMITS : HUB_LIMITS;
  if (!Object.hasOwn(table, name)) throw new Error(`unknown limit ${name}`);
  if (value !== null && !inRange(table[name], value)) throw new Error(`${name} must be a whole number from ${table[name].min} to ${table[name].max}`);
  if (backend && !Object.hasOwn(backends(), backend)) throw new Error(`unknown backend ${backend}`);
  const put = (set: Record<string, number> | undefined) => {
    const { [name]: _old, ...rest } = set ?? {};
    return value === null ? rest : { ...rest, [name]: value as number };
  };
  updateGlobalConfig((config) => backend
    ? { ...config, backendLimits: { ...config.backendLimits, [backend]: put(config.backendLimits?.[backend]) } }
    : { ...config, limits: put(config.limits) });
  return limitSettings();
}

/** Set the project's working language. */
export function setProjectLanguage(paths: Paths, language: unknown): Language {
  if (!LANGUAGES.includes(language as Language)) throw new Error(`language must be one of ${LANGUAGES.join(", ")}`);
  updateProjectConfig(paths, (config) => ({ ...config, language: language as Language }));
  return language as Language;
}

/** The project's working language, if it has one; a broken file has none. */
export const projectLanguageSetting = (paths: Paths): Language | undefined => projectConfig(paths).language;

/** Agents whose spec names no backend get this one. */
export const DEFAULT_BACKEND = "claude";

/**
 * The machine's own folder in the user's home. Its name is not the project folder's (`.xsb2`, paths.ts): a workspace
 * may be the home folder itself, and the two must not be one folder. Nor is it the earlier layout's `.xsb`.
 */
export const GLOBAL_DIR = ".xsb2_global";
export const globalDir = (): string => process.env.XSB_HOME ?? path.join(os.homedir(), GLOBAL_DIR);
export const globalConfigPath = (): string => path.join(globalDir(), "config.json");

/** A config file's object; missing is `fallback`. Throws `invalid_json` when it is not a JSON object. */
function readJson<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw failure("invalid_json", { file, detail: (e as Error).message });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("invalid_json", { file, detail: "not a JSON object" });
  return value as T;
}

/** Write a config file whole or not at all: a reader never sees it half written. */
function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(temporary, file);
}

/**
 * Change a config file: read strictly, change, write atomically. A file that cannot be read is refused, not
 * overwritten: what the user wrote in it is theirs, and an empty stand-in would wipe it.
 */
function updateJson<T>(file: string, fallback: T, change: (config: T) => T): T {
  const next = change(readJson(file, fallback));
  writeJson(file, next);
  return next;
}

/** The machine's config for reading, empty when it cannot be read: a broken file sets nothing and stops nothing. */
export const machineConfig = (): GlobalConfig => { try { return loadGlobalConfig(); } catch { return { version: 1 }; } };
/** The project's config for reading, likewise. */
export const projectConfig = (paths: Paths): ProjectConfig => { try { return loadProjectConfig(paths); } catch { return { version: CONFIG_VERSION }; } };

/** Change the machine's config (`updateJson`). */
export const updateGlobalConfig = (change: (config: GlobalConfig) => GlobalConfig): GlobalConfig =>
  updateJson(globalConfigPath(), { version: 1 } as GlobalConfig, change);
/** Change the project's config (`updateJson`). */
export const updateProjectConfig = (paths: Paths, change: (config: ProjectConfig) => ProjectConfig): ProjectConfig =>
  updateJson(paths.config, { version: CONFIG_VERSION } as ProjectConfig, change);

export function loadProjectConfig(paths: Paths): ProjectConfig {
  return readJson<ProjectConfig>(paths.config, { version: CONFIG_VERSION });
}

/** The project's working language. English until a client has declared one. */
export const projectLanguage = (paths: Paths): Language => {
  const language = projectConfig(paths).language;
  return LANGUAGES.includes(language as Language) ? language! : "en";
};

export function saveProjectConfig(paths: Paths, config: ProjectConfig): void {
  writeJson(paths.config, config);
}

/** Make a directory a project. Returns whether that also created the machine's config. */
export function initProject(paths: Paths): boolean {
  fs.mkdirSync(paths.shared, { recursive: true });
  fs.mkdirSync(paths.run, { recursive: true });
  if (!fs.existsSync(paths.config)) saveProjectConfig(paths, { version: CONFIG_VERSION });
  fs.writeFileSync(path.join(paths.dir, ".gitignore"), "run/\n");
  return initGlobalConfig();
}

export const loadGlobalConfig = (): GlobalConfig => readJson<GlobalConfig>(globalConfigPath(), { version: 1 });

export function saveGlobalConfig(config: GlobalConfig): void {
  writeJson(globalConfigPath(), config);
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
  return { ...BUILTIN_BACKENDS, ...loadGlobalConfig().backends };
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
