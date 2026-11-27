/**
 * Plugins: one folder each, in three plugin folders of the same layout:
 *
 *   <app>/plugins/<name>/             shipped with the app: beside the code, wherever the app is
 *   ~/.xsb2_global/plugins/<name>/    added on this machine
 *   <project>/.xsb2/plugins/<name>/   added for one project
 *
 * The three differ in nothing but where the plugin folder is. A later one replaces a plugin of the same name. Adding
 * a plugin is putting its folder there; every conversation reads the folders when its backend starts, so a restart
 * (or `_dev.xsb/tools/apply`) is all it takes.
 *
 * A plugin's folder has the layout agent programs share:
 *
 *   <name>/.mcp.json    its tool servers, as MCP clients write them:
 *                       { "mcpServers": { "<server>": { "command", "args", "env" } | { "type": "http", "url", "headers" } } }
 *   <name>/README.md    for people (not read here)
 *
 * (commands/, agents/, skills/ and hooks/ of that layout are not used yet.) Nothing in a plugin says where it is:
 * a command or argument starting with `./` is a file of its folder, `${CLAUDE_PLUGIN_ROOT}` is the folder, as plugins
 * written for Claude Code say it, and `${NAME}` / `${NAME:-default}` a variable of the hub's environment. The command
 * `node` is the Node the app runs on. What a server tells a model about itself is its own `instructions` (MCP's
 * `initialize`), not a file here.
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
import { globalDir, globalConfiguration, projectConfig, updateGlobalConfig, updateProjectConfig } from "./config.ts";
import { approvedFingerprints, recordPluginApproval } from "./trust.ts";
import { shipped, type Paths } from "./paths.ts";

export type PluginScope = "builtin" | "global" | "project";

/** Why a plugin cannot be used; a client words it. */
export type PluginProblem = "no_manifest" | "bad_json" | "bad_name" | "bad_field";

export type PluginView = {
  name: string;
  scope: PluginScope;
  dir: string;
  /** What it starts, a line for each server: its variables, command and arguments, as written. */
  runs?: string;
  problem?: PluginProblem;
  /** Turned off by the setting of its own scope, or of the project for any plugin. */
  enabled: boolean;
  /** Project plugins only. */
  approved?: boolean;
  approvalFingerprint?: string;
  /** A later place has a plugin of the same name. */
  replaced?: boolean;
  /** Conversations of the project get it. */
  active: boolean;
};

/** A server of `.mcp.json`, as written. */
type Declared = { type?: string; command?: string; args?: string[]; env?: Record<string, string>; url?: string; headers?: Record<string, string> };
/** `servers`: by name, as written. `text`: the `.mcp.json` as written, for the fingerprint. */
type Found = { name: string; scope: PluginScope; dir: string; servers?: Record<string, Declared>; text?: string; problem?: PluginProblem };

export const MANIFEST = ".mcp.json";
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** The hub's own tools go by these names (mcp.ts); neither a plugin nor a server of one can take them. */
const RESERVED = new Set(["workflow", "xsb"]);
const named = (name: string) => NAME.test(name) && !RESERVED.has(name);

/** The plugin folder of each place: all that tells the places apart. */
export function pluginRoot(scope: PluginScope, paths?: Paths): string | undefined {
  if (scope === "builtin") return shipped("plugins");
  if (scope === "global") return path.join(globalDir(), "plugins");
  return paths && path.join(paths.dir, "plugins");
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isMap = (v: unknown) => v === undefined || (isObject(v) && Object.values(v).every((x) => typeof x === "string"));
const isServer = (v: unknown): boolean => isObject(v) && (v.type === "http"
  ? typeof v.url === "string" && isMap(v.headers)
  : (v.type === undefined || v.type === "stdio") && typeof v.command === "string" && !!v.command.trim()
    && (v.args === undefined || (Array.isArray(v.args) && v.args.every((x) => typeof x === "string"))) && isMap(v.env));

/** The servers of a `.mcp.json`: under `mcpServers`, or the file itself as some write it. */
function read(text: string): Record<string, Declared> | PluginProblem {
  let json: unknown;
  try { json = JSON.parse(text); } catch { return "bad_json"; }
  if (!isObject(json)) return "bad_json";
  const servers = "mcpServers" in json ? json.mcpServers : json;
  if (!isObject(servers) || !Object.values(servers).every(isServer)) return "bad_field";
  return Object.keys(servers).every(named) ? servers as Record<string, Declared> : "bad_name";
}

/** The plugins of one place, in name order. A folder that is not there is no plugin. */
function scan(scope: PluginScope, paths?: Paths): Found[] {
  const root = pluginRoot(scope, paths);
  let names: string[] = [];
  try { names = root ? fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name).sort() : []; }
  catch { return []; }
  return names.map((name) => {
    const dir = path.join(root!, name);
    if (!named(name)) return { name, scope, dir, problem: "bad_name" as const };
    let text: string;
    try { text = fs.readFileSync(path.join(dir, MANIFEST), "utf8"); } catch { return { name, scope, dir, problem: "no_manifest" as const }; }
    const servers = read(text);
    return typeof servers === "string" ? { name, scope, dir, text, problem: servers } : { name, scope, dir, text, servers };
  });
}

/** A value of `.mcp.json` where the plugin is now: its folder and the hub's variables filled in, `./` in its folder. */
function fill(p: Found, value: string): string {
  const s = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback) =>
    name === "CLAUDE_PLUGIN_ROOT" ? p.dir : process.env[name] ?? fallback ?? "");
  return s.startsWith("./") ? path.join(p.dir, s) : s;
}

/** A plugin's servers as `mcpServers` entries of a backend session, in name order. */
function serversOf(p: Found): McpServer[] {
  const pairs = (map: Record<string, string> = {}) => Object.entries(map).map(([name, value]) => ({ name, value: fill(p, value) }));
  return Object.entries(p.servers ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, s]): McpServer => {
    if (s.type === "http") return { type: "http", name, url: fill(p, s.url!), headers: pairs(s.headers) };
    const args = (s.args ?? []).map((a) => fill(p, a));
    // `node` is the app's Node, which is Electron: told to run as Node, as the hub's own bridge is (mcp.ts).
    return s.command === "node"
      ? { type: "stdio", name, command: process.execPath, args, env: [{ name: "ELECTRON_RUN_AS_NODE", value: "1" }, ...pairs(s.env)] }
      : { type: "stdio", name, command: fill(p, s.command!), args, env: pairs(s.env) };
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
 * What a project plugin was approved as: its `.mcp.json` and the files of its folder that its servers are started
 * with. A change to either asks again. (Files those load in turn are not in it; the approval says to check the folder.)
 */
const fingerprint = (p: Found, paths?: Paths) => {
  const hash = createHash("sha256").update(JSON.stringify([paths?.project, p.name, p.text]));
  for (const server of serversOf(p)) {
    if (server.type !== "stdio") continue;
    for (const file of [server.command, ...server.args ?? []]) {
      const inside = path.relative(p.dir, file);
      if (!path.isAbsolute(file) || !inside || inside.startsWith("..") || path.isAbsolute(inside)) continue;
      hash.update(inside);
      try {
        if (fs.statSync(file).isFile()) hash.update(fs.readFileSync(file));
      } catch { /* not a file: nothing of it to approve */ }
    }
  }
  return hash.digest("hex");
};

/** Every plugin of every place, each with how it stands. */
function survey(paths?: Paths): { found: Found; view: PluginView }[] {
  const configuration = globalConfiguration(), global = configuration.config;
  const offGlobal = offIn(global), offProject = paths ? offIn(projectConfig(paths)) : new Set<string>();
  const approved = approvedFingerprints(approvedIn(global));
  const found = (["builtin", "global", "project"] as const).flatMap((scope) => scan(scope, paths));
  const last = new Map(found.filter((p) => !p.problem).map((p) => [p.name, p]));
  return found.map((p) => {
    const enabled = configuration.available && !(p.scope === "project" ? offProject : offGlobal).has(p.name) && !offProject.has(p.name);
    const revision = p.scope === "project" && paths ? fingerprint(p, paths) : undefined;
    const ok = p.scope !== "project" || (!!revision && approved.has(revision));
    const view: PluginView = {
      name: p.name, scope: p.scope, dir: p.dir, problem: p.problem,
      runs: p.servers && Object.values(p.servers).map((s) => s.type === "http" ? s.url
        : [...Object.entries(s.env ?? {}).map(([k, v]) => `${k}=${v}`), s.command, ...s.args ?? []].join(" ")).join("\n"),
      enabled, ...(p.scope === "project" ? { approved: ok, ...(ok && revision ? { approvalFingerprint: revision } : {}) } : {}),
      replaced: !p.problem && last.get(p.name) !== p,
      active: !p.problem && last.get(p.name) === p && enabled && ok,
    };
    return { found: p, view };
  });
}

export const listPlugins = (paths?: Paths): PluginView[] => survey(paths).map((x) => x.view);

type PluginServer = { server: McpServer; pluginId: string; revision: string };

/**
 * The servers a conversation of the project gets, in name order: the same set gives the same prompt. Of two servers
 * of one name, the later plugin's is it.
 */
export function activePlugins(paths?: Paths): PluginServer[] {
  const selected = new Map<string, PluginServer>();
  for (const { found, view } of survey(paths)) {
    if (!view.active) continue;
    const revision = found.scope + "/" + (view.approvalFingerprint ?? fingerprint(found, paths));
    for (const server of serversOf(found)) selected.set(server.name, { server, pluginId: found.name, revision });
  }
  return [...selected.values()].sort((a, b) => a.server.name.localeCompare(b.server.name));
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
  recordPluginApproval(paths.project, name, fingerprint(p, paths));
}

/** The folder of a place, made if it is not there, for the user to put plugins in. */
export function ensurePluginRoot(scope: "global" | "project", paths?: Paths): string {
  const root = pluginRoot(scope, paths);
  if (!root) throw new Error("no project is open");
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** Fingerprint of what a set of tool servers starts, without the per-session tokens: equal means no change. */
export const toolsKey = (tools: { server: McpServer; pluginId?: string; revision?: string }[]): string =>
  JSON.stringify(tools.map(({ server, pluginId, revision }) => [server, pluginId, revision]));

