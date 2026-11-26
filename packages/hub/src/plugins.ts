/**
 * Plugins: tool servers (MCP), one folder each, in three places of the same layout:
 *
 *   <app>/plugins/<name>/package.json       shipped with the app (XSB_PLUGINS names the folder)
 *   ~/.xsb2_global/plugins/<name>/package.json      added on this machine
 *   <project>/.xsb2/plugins/<name>/package.json   added for one project
 *
 * A later place replaces a plugin of the same name. Adding one is putting its folder there; every conversation
 * reads the folders when its backend starts, so a restart (or `_dev.xsb/tools/apply`) is all it takes.
 *
 * A plugin is an npm package (it need not be published): its folder's package.json says what it is. `main` is the
 * file the plugin runs, as in npm (index.js when it says none); it must be in the folder. It runs on the Node the
 * app runs on, as an MCP server on stdio. `description` is what conversations are told about it. Its own
 * variables go in `xsb.env`, where `${pluginDir}` is its folder, `${node}` the app's Node and `${env:NAME}` a
 * variable of the hub's environment. The plugin's name is its folder's, not the package's.
 *
 * Settings live in the config files (config.ts): `plugins.<name>.enabled: false` turns one off on this machine or in
 * a project. A project's plugins travel with its folder and may come from someone else: they start once this
 * machine approved them (`approvedPlugins`, fingerprints of what they start).
 *
 * Nothing here throws on what it finds: a missing folder is none, a broken plugin is listed with its problem and
 * left out, an unreadable config file is read as empty. Changing a setting in a config file that cannot be read is
 * refused, so that what the user wrote in it is not overwritten (config.ts, `updateJson`).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@xsb/protocol";
import { globalDir, machineConfig, projectConfig, updateGlobalConfig, updateProjectConfig } from "./config.ts";
import type { Paths } from "./paths.ts";

export const PLUGINS_ENV = "XSB_PLUGINS";
export type PluginScope = "builtin" | "global" | "project";

/** Why a plugin cannot be used; a client words it. */
export type PluginProblem = "no_manifest" | "bad_json" | "bad_name" | "no_main" | "bad_field";

export type PluginView = {
  name: string;
  scope: PluginScope;
  dir: string;
  description?: string;
  /** What it starts: its variables, as written, and its main file. */
  runs?: string;
  problem?: PluginProblem;
  /** Turned off by the setting of its own scope, or of the project for any plugin. */
  enabled: boolean;
  /** Project plugins only. */
  approved?: boolean;
  /** A later place has a plugin of the same name. */
  replaced?: boolean;
  /** Conversations of the project get it. */
  active: boolean;
};

/** What xSB reads of a plugin's package.json. */
type Manifest = { description?: string; main?: string; xsb?: { env?: Record<string, string> } };
/** `entry`: the main file, resolved in the folder. `text`: the package.json as written, for the fingerprint. */
type Found = { name: string; scope: PluginScope; dir: string; manifest?: Manifest; entry?: string; text?: string; problem?: PluginProblem };

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** The hub's own tools go by these names (mcp.ts); a plugin cannot take them. */
const RESERVED = new Set(["workflow", "xsb"]);

/** The folder of each place. */
export function pluginRoot(scope: PluginScope, paths?: Paths): string | undefined {
  if (scope === "builtin") return process.env[PLUGINS_ENV];
  if (scope === "global") return path.join(globalDir(), "plugins");
  return paths && path.join(paths.dir, "plugins");
}

const isMap = (v: unknown) => v === undefined || (!!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string"));

function check(m: unknown): PluginProblem | undefined {
  if (!m || typeof m !== "object" || Array.isArray(m)) return "bad_json";
  const s = m as Manifest;
  if (s.description !== undefined && typeof s.description !== "string") return "bad_field";
  if (s.main !== undefined && (typeof s.main !== "string" || !s.main.trim())) return "no_main";
  if (s.xsb !== undefined && (!s.xsb || typeof s.xsb !== "object" || Array.isArray(s.xsb) || !isMap(s.xsb.env))) return "bad_field";
  return undefined;
}

/** The main file, as npm finds it, if it is a file inside the folder: a link or `..` out of it is none. */
function entryOf(dir: string, main = "index.js"): string | undefined {
  const file = path.resolve(dir, main);
  try {
    const real = fs.realpathSync(file), root = fs.realpathSync(dir);
    const inside = path.relative(root, real);
    return inside && !inside.startsWith("..") && !path.isAbsolute(inside) && fs.statSync(real).isFile() ? file : undefined;
  } catch { return undefined; }
}

/** The plugins of one place, in name order. A folder that is not there is no plugin. */
function scan(scope: PluginScope, paths?: Paths): Found[] {
  const root = pluginRoot(scope, paths);
  let names: string[] = [];
  try { names = root ? fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name).sort() : []; }
  catch { return []; }
  return names.map((name) => {
    const dir = path.join(root!, name);
    if (!NAME.test(name) || RESERVED.has(name)) return { name, scope, dir, problem: "bad_name" as const };
    let text: string;
    try { text = fs.readFileSync(path.join(dir, "package.json"), "utf8"); } catch { return { name, scope, dir, problem: "no_manifest" as const }; }
    let manifest: unknown;
    try { manifest = JSON.parse(text); } catch { return { name, scope, dir, text, problem: "bad_json" as const }; }
    const problem = check(manifest);
    if (problem) return { name, scope, dir, text, problem };
    const entry = entryOf(dir, (manifest as Manifest).main);
    return entry ? { name, scope, dir, text, entry, manifest: manifest as Manifest } : { name, scope, dir, text, problem: "no_main" as const };
  });
}

/** Plugins turned off in a config, whatever shape a hand edit left it in. */
const offIn = (config: { plugins?: unknown }): Set<string> => {
  const set = config.plugins && typeof config.plugins === "object" ? config.plugins as Record<string, { enabled?: unknown }> : {};
  return new Set(Object.entries(set).filter(([, v]) => v && typeof v === "object" && v.enabled === false).map(([name]) => name));
};
/** The machine's approved fingerprints, whatever shape a hand edit left them in. */
const approvedIn = (config: { approvedPlugins?: unknown }): Set<string> =>
  new Set(Array.isArray(config.approvedPlugins) ? config.approvedPlugins.filter((x): x is string => typeof x === "string") : []);

/**
 * What a project plugin was approved as: its package.json and the main file it runs. A change to either asks again.
 * (Files the main file loads in turn are not in it; the approval says to check the folder.)
 */
const fingerprint = (p: Found, paths: Paths) => {
  const hash = createHash("sha256").update(JSON.stringify([paths.project, p.name, p.text]));
  try { if (p.entry) hash.update(fs.readFileSync(p.entry)); } catch { /* gone since the scan: no match */ }
  return hash.digest("hex");
};

/** Every plugin of every place, each with how it stands. */
function survey(paths?: Paths): { found: Found; view: PluginView }[] {
  const global = machineConfig();
  const offGlobal = offIn(global), offProject = paths ? offIn(projectConfig(paths)) : new Set<string>();
  const approved = approvedIn(global);
  const found = (["builtin", "global", "project"] as const).flatMap((scope) => scan(scope, paths));
  const last = new Map(found.filter((p) => !p.problem).map((p) => [p.name, p]));
  return found.map((p) => {
    const enabled = !(p.scope === "project" ? offProject : offGlobal).has(p.name) && !offProject.has(p.name);
    const ok = p.scope !== "project" || (!!paths && approved.has(fingerprint(p, paths)));
    const m = p.manifest;
    const view: PluginView = {
      name: p.name, scope: p.scope, dir: p.dir, problem: p.problem, description: m?.description,
      runs: m && p.entry && [...Object.entries(m.xsb?.env ?? {}).map(([k, v]) => `${k}=${v}`), "node", path.relative(p.dir, p.entry)].join(" "),
      enabled, ...(p.scope === "project" ? { approved: ok } : {}),
      replaced: !p.problem && last.get(p.name) !== p,
      active: !p.problem && last.get(p.name) === p && enabled && ok,
    };
    return { found: p, view };
  });
}

export const listPlugins = (paths?: Paths): PluginView[] => survey(paths).map((x) => x.view);

/** The plugins a conversation of the project gets, in name order: the same set gives the same prompt. */
export const activePlugins = (paths?: Paths): { server: McpServer; about?: string }[] =>
  survey(paths).filter((x) => x.view.active).sort((a, b) => a.found.name.localeCompare(b.found.name))
    .map(({ found }) => ({ server: serverOf(found), about: found.manifest!.description }));

/** A plugin as the `mcpServers` entry of a backend session: its main file on the app's Node, its variables filled in. */
function serverOf(p: Found): McpServer {
  const fill = (s: string) => s.replace(/\$\{(pluginDir|node|env:([A-Za-z_][A-Za-z0-9_]*))\}/g, (_, key, name) =>
    key === "pluginDir" ? p.dir : key === "node" ? process.execPath : process.env[name] ?? "");
  const env = Object.entries(p.manifest!.xsb?.env ?? {}).map(([name, value]) => ({ name, value: fill(value) }));
  // The app's Node is Electron: told to run as Node, as the hub's own bridge is (mcp.ts).
  return { type: "stdio", name: p.name, command: process.execPath, args: [p.entry!], env: [{ name: "ELECTRON_RUN_AS_NODE", value: "1" }, ...env] };
}

/** Turn a plugin on or off on this machine (`global`) or in the project (`project`). */
export function setPluginEnabled(scope: "global" | "project", name: string, enabled: boolean, paths?: Paths): void {
  const update = <T extends { plugins?: Record<string, { enabled?: boolean }> }>(config: T): T => {
    const { [name]: _old, ...rest } = config.plugins ?? {};
    return { ...config, plugins: enabled ? rest : { ...rest, [name]: { enabled: false } } };
  };
  if (scope === "global") return void updateGlobalConfig(update);
  if (!paths) throw new Error("no project is open");
  updateProjectConfig(paths, update);
}

/** Approve, on this machine, a project plugin as its folder has it now. */
export function approvePlugin(paths: Paths, name: string): void {
  const p = scan("project", paths).find((x) => x.name === name && !x.problem);
  if (!p) throw new Error(`no usable plugin ${name} in this project`);
  updateGlobalConfig((config) => ({ ...config, approvedPlugins: [...approvedIn(config), fingerprint(p, paths)] }));
}

/** The folder of a place, made if it is not there, for the user to put plugins in. */
export function ensurePluginRoot(scope: "global" | "project", paths?: Paths): string {
  const root = pluginRoot(scope, paths);
  if (!root) throw new Error("no project is open");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** Fingerprint of what a set of tool servers starts and tells, without the per-session tokens: equal means no change. */
export const toolsKey = (tools: { server: McpServer; about?: string }[]): string =>
  JSON.stringify(tools.map(({ server, about }) => [server, about]));

