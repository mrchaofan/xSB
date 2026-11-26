/**
 * User-local defaults and project overrides. Trust records live separately in trust.json.
 *
 *   ~/.xsb2_global/config.json        about this machine: which backends exist and how to start them, plugins turned
 *                             off and project plugins approved (plugins.ts), and default decision consultation preferences
 *   <project>/.xsb2/config.json about this project: which language its agents work in, and
 *                             plugins turned off here, and decision consultation overrides
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
import { updateJsonFile, lastGoodJson } from "./config-files.ts";

/**
 * A backend is a command that speaks ACP on stdio. That is the whole contract:
 * the hub runs an agent's official ACP entry point and a wrapper written for
 * an agent without one (@xsb/adapter) through the same code.
 */
export type BackendSpec = {
  /** Preserve AIR-only suggestions of released Codex adapters; false disables the compatibility handshake. */
  airCompatibility?: boolean;
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
  /** Invite user input at consequential decisions in complex work. Defaults to false. */
  consultUser?: boolean;
  backends?: Record<string, BackendSpec>;
  /** Context limits of each backend (`BACKEND_LIMITS`). */
  backendLimits?: Record<string, Partial<Record<BackendLimit, number>>>;
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
 */
export const BACKEND_LIMITS = {
  sessionTokens: { default: 150_000, min: 10_000, max: 2_000_000 },
  promptTokens: { default: 32_000, min: 4_000, max: 2_000_000 },
  contextReserveTokens: { default: 8_192, min: 1_024, max: 200_000 },
  toolOutputTokens: { default: 4_000, min: 500, max: 200_000 },
  contextRecoveryAttempts: { default: 1, min: 0, max: 3 },
} as const;
export type BackendLimit = keyof typeof BACKEND_LIMITS;
type Range = { default: number; min: number; max: number };

export type ProjectConfig = {
  version: 1 | 2;
  language?: Language;
  /** Overrides the machine preference; absence inherits it. */
  consultUser?: boolean;
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

/** The limits as a client shows them: each with its range, default and what this machine sets. */
export function limitSettings() {
  const config = machineConfig();
  const row = (table: Record<string, Range>, set: Record<string, unknown> | undefined) => Object.entries(table)
    .map(([name, range]) => ({ name, ...range, value: inRange(range, set?.[name]) ? set![name] as number : undefined }));
  return {
    backends: Object.fromEntries(Object.keys(backends()).map((name) => [name, row(BACKEND_LIMITS, config.backendLimits?.[name])])),
    issues: globalConfiguration().issues,
  };
}

/** Set a backend's context limit. A null value goes back to the default. */
export function setLimit(backend: string | null, name: string, value: unknown): ReturnType<typeof limitSettings> {
  const table: Record<string, Range> = BACKEND_LIMITS;
  if (!backend || !Object.hasOwn(table, name)) throw new Error(`unknown limit ${name}`);
  if (value !== null && !inRange(table[name], value)) throw new Error(`${name} must be a whole number from ${table[name].min} to ${table[name].max}`);
  if (backend && !Object.hasOwn(backends(), backend)) throw new Error(`unknown backend ${backend}`);
  const put = (set: Record<string, number> | undefined) => {
    const { [name]: _old, ...rest } = set ?? {};
    return value === null ? rest : { ...rest, [name]: value as number };
  };
  updateGlobalConfig((config) => ({ ...config, backendLimits: { ...config.backendLimits, [backend]: put(config.backendLimits?.[backend]) } }));
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

/** Model behavior belongs in durable Hub configuration, shared by every client and backend. */
export function consultationSettings(paths?: Paths): { global: boolean; project: boolean | null; effective: boolean } {
  const global = machineConfig().consultUser === true;
  const value = paths ? projectConfig(paths).consultUser : undefined;
  const project = typeof value === "boolean" ? value : null;
  return { global, project, effective: project ?? global };
}

export function setConsultation(scope: "global" | "project", value: unknown, paths?: Paths): ReturnType<typeof consultationSettings> {
  if (scope !== "global" && scope !== "project") throw new Error("Invalid consultation scope");
  if (typeof value !== "boolean" && !(scope === "project" && value === null)) throw new Error("Consultation preference must be a boolean; null inherits the global preference for a project");
  if (scope === "global") updateGlobalConfig(config => ({ ...config, consultUser: value as boolean }));
  else {
    if (!paths) throw new Error("No workspace is open");
    updateProjectConfig(paths, config => {
      const { consultUser: _previous, ...rest } = config;
      return value === null ? rest : { ...rest, consultUser: value as boolean };
    });
  }
  return consultationSettings(paths);
}

/** Agents whose spec names no backend get this one. */
export const DEFAULT_BACKEND = "claude";

/**
 * The machine's own folder in the user's home. Its name is not the project folder's (`.xsb2`, paths.ts): a workspace
 * may be the home folder itself, and the two must not be one folder. Nor is it the earlier layout's `.xsb`.
 */
export const GLOBAL_DIR = ".xsb2_global";
export const globalDir = (): string => {
  const override = process.env.XSB_HOME;
  if (override !== undefined && (!override.trim() || !path.isAbsolute(override))) throw new Error("XSB_HOME must be a nonempty absolute directory path");
  return path.resolve(override ?? path.join(os.homedir(), GLOBAL_DIR));
};
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
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const backendSpec = (value: unknown): value is BackendSpec => object(value) && typeof value.command === "string" && !!value.command.trim() &&
  (value.airCompatibility === undefined || typeof value.airCompatibility === "boolean") &&
  (value.args === undefined || Array.isArray(value.args) && value.args.every((arg: unknown) => typeof arg === "string"));

export function validateGlobal(config: GlobalConfig): void {
  if (config.version !== 1) throw new Error(`Unsupported global configuration version: ${config.version}`);
  if (config.consultUser !== undefined && typeof config.consultUser !== "boolean") throw new Error("Invalid consultation preference");
  if (config.backends !== undefined && (!object(config.backends) || Object.values(config.backends).some(v => !backendSpec(v)))) throw new Error("Invalid backend command or arguments");
  if (config.plugins !== undefined && (!object(config.plugins) || Object.values(config.plugins).some(v => !object(v) || v.enabled !== undefined && typeof v.enabled !== "boolean"))) throw new Error("Invalid plugin setting");
  if (config.backendLimits !== undefined && !object(config.backendLimits)) throw new Error("Invalid backend limits");
  for (const [backend, limits] of Object.entries(config.backendLimits ?? {})) {
    if (!object(limits)) throw new Error(`Invalid limits for ${backend}`);
    for (const [name, value] of Object.entries(limits)) if (Object.hasOwn(BACKEND_LIMITS, name) && !inRange(BACKEND_LIMITS[name as BackendLimit], value)) throw new Error(`Invalid ${name} for ${backend}`);
    if ((limits.contextReserveTokens ?? BACKEND_LIMITS.contextReserveTokens.default) >= (limits.promptTokens ?? BACKEND_LIMITS.promptTokens.default))
      throw new Error(`contextReserveTokens must be smaller than promptTokens for ${backend}`);
  }
}

function validateProject(config: ProjectConfig): void {
  if (![1, CONFIG_VERSION].includes(config.version)) throw new Error(`Unsupported project configuration version: ${config.version}`);
  if (config.language !== undefined && !LANGUAGES.includes(config.language)) throw new Error("Invalid project language");
  if (config.consultUser !== undefined && typeof config.consultUser !== "boolean") throw new Error("Invalid consultation preference");
}

/**
 * Change a config file: read strictly, change, write atomically. A file that cannot be read is refused, not
 * overwritten: what the user wrote in it is theirs, and an empty stand-in would wipe it.
 */
const goodGlobal = new Map<string, GlobalConfig>();
const goodProject = new Map<string, ProjectConfig>();

export function globalConfiguration(): { config: GlobalConfig; available: boolean; issues: string[] } {
  const file = globalConfigPath();
  try {
    const raw = loadGlobalConfig();
    const issues: string[] = [];
    const config: GlobalConfig = { ...raw, backends: {} };
    if (raw.consultUser !== undefined && typeof raw.consultUser !== "boolean") {
      delete config.consultUser;
      issues.push("Invalid consultation preference ignored");
    }
    if (raw.backends !== undefined && !object(raw.backends)) issues.push("Invalid backends configuration");
    else for (const [name, value] of Object.entries(raw.backends ?? {})) {
      if (backendSpec(value)) config.backends![name] = value;
      else issues.push(`Backend ${name}: invalid command or arguments`);
    }
    if (raw.plugins !== undefined && !object(raw.plugins)) throw new Error("Invalid plugins configuration");
    for (const value of Object.values(raw.plugins ?? {})) if (!object(value) || value.enabled !== undefined && typeof value.enabled !== "boolean") throw new Error("Invalid plugin setting");
    if (raw.backendLimits !== undefined && !object(raw.backendLimits)) delete config.backendLimits;
    else if (raw.backendLimits) {
      config.backendLimits = {};
      for (const [name, limits] of Object.entries(raw.backendLimits)) {
        if (!object(limits)) { issues.push(`Backend ${name}: invalid limits`); continue; }
        const valid = Object.fromEntries(Object.entries(limits).filter(([key, value]) => Object.hasOwn(BACKEND_LIMITS, key) && inRange(BACKEND_LIMITS[key as BackendLimit], value))) as Partial<Record<BackendLimit, number>>;
        if (Object.keys(valid).length !== Object.keys(limits).length) issues.push(`Backend ${name}: invalid limit values ignored`);
        if ((valid.contextReserveTokens ?? BACKEND_LIMITS.contextReserveTokens.default) >= (valid.promptTokens ?? BACKEND_LIMITS.promptTokens.default)) {
          delete valid.contextReserveTokens; delete valid.promptTokens;
          issues.push(`Backend ${name}: invalid prompt/reserve combination ignored`);
        }
        config.backendLimits[name] = valid;
      }
    }
    goodGlobal.set(file, structuredClone(config));
    return { config, available: true, issues };
  } catch (error) {
    const saved = goodGlobal.get(file) ?? lastGoodJson<GlobalConfig>(file);
    let valid: GlobalConfig | undefined;
    try { if (saved) { validateGlobal(saved); valid = saved; } } catch { /* an invalid backup never restores permissions */ }
    return { config: valid ?? { version: 1 }, available: !!valid, issues: [`${file}: ${(error as Error).message}${valid ? " (using last valid configuration)" : ""}`] };
  }
}

/** The machine's config for reading, empty when it cannot be read: a broken file sets nothing and stops nothing. */
export const machineConfig = (): GlobalConfig => globalConfiguration().config;
/** The project's config for reading, likewise. */
export const projectConfig = (paths: Paths): ProjectConfig => {
  try { const config = loadProjectConfig(paths); goodProject.set(paths.config, config); return config; }
  catch { return goodProject.get(paths.config) ?? lastGoodJson<ProjectConfig>(paths.config) ?? { version: CONFIG_VERSION }; }
};

/** Change the machine's config (`updateJson`). */
export const updateGlobalConfig = (change: (config: GlobalConfig) => GlobalConfig): GlobalConfig =>
  updateJsonFile(globalConfigPath(), loadGlobalConfig, change, validateGlobal);
/** Change the project's config (`updateJson`). */
export const updateProjectConfig = (paths: Paths, change: (config: ProjectConfig) => ProjectConfig): ProjectConfig =>
  updateJsonFile(paths.config, () => loadProjectConfig(paths), change, validateProject);

export function loadProjectConfig(paths: Paths): ProjectConfig {
  const config = readJson<ProjectConfig>(paths.config, { version: CONFIG_VERSION });
  validateProject(config);
  return config;
}

/** The project's working language. English until a client has declared one. */
export const projectLanguage = (paths: Paths): Language => {
  const language = projectConfig(paths).language;
  return LANGUAGES.includes(language as Language) ? language! : "en";
};

export function saveProjectConfig(paths: Paths, config: ProjectConfig): void {
  updateProjectConfig(paths, () => config);
}

/** Make a directory a project. Returns whether that also created the machine's config. */
export function initProject(paths: Paths): boolean {
  if (path.resolve(paths.dir) === globalDir()) throw new Error("The global configuration directory must differ from the project data directory");
  fs.mkdirSync(paths.shared, { recursive: true });
  fs.mkdirSync(paths.run, { recursive: true });
  if (!fs.existsSync(paths.config)) saveProjectConfig(paths, { version: CONFIG_VERSION });
  fs.writeFileSync(path.join(paths.dir, ".gitignore"), "run/\n");
  return initGlobalConfig();
}

export const loadGlobalConfig = (): GlobalConfig => {
  const config = readJson<GlobalConfig>(globalConfigPath(), { version: 1 });
  if (config.version !== 1) throw new Error(`Unsupported global configuration version: ${config.version}`);
  return config;
};

export function saveGlobalConfig(config: GlobalConfig): void {
  updateGlobalConfig(() => config);
}

/** Explicit import may replace damaged JSON; ordinary setting edits must never overwrite it. */
export function replaceGlobalConfig(config: GlobalConfig): void {
  validateGlobal(config);
  updateJsonFile(globalConfigPath(), () => config, () => config, validateGlobal);
}

/** Create the global config if there is none. Returns whether it did. */
function initGlobalConfig(): boolean {
  if (fs.existsSync(globalConfigPath())) return false;
  let created = false;
  updateGlobalConfig(config => {
    if (fs.existsSync(globalConfigPath())) return config;
    created = true;
    return { version: 1, backends: {} };
  });
  return created;
}

/** The backends of this machine. Read on every use, so an edit needs no hub restart. */
export function backends(): Record<string, BackendSpec> {
  const table = { ...BUILTIN_BACKENDS, ...machineConfig().backends };
  return Object.fromEntries(Object.entries(table).map(([name, spec]) => [name, { ...spec, command: !path.isAbsolute(spec.command) && /[\\/]/.test(spec.command) ? path.resolve(globalDir(), spec.command) : spec.command }]));
}

/**
 * The backends as a client is told of them: each with whether its command is found on `searchPath`, the PATH the hub
 * starts them with (this process's unless given).
 */
export function describeBackends(searchPath?: string): BackendInfo[] {
  return Object.entries(backends()).map(([name, spec]) => ({
    name,
    command: spec.command,
    args: spec.args ?? [],
    installed: findCommand(spec.command, searchPath) !== null,
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
  if (/[\\/]/.test(command)) return runnable(command) ? path.resolve(command) : null;
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of searchPath.split(path.delimiter)) {
    for (const ext of exts) {
      const file = path.join(dir, command + ext);
      if (dir && runnable(file)) return file;
    }
  }
  return null;
}
