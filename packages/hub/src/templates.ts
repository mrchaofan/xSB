/** Project copies of templates. Sources stay read-only; only explicit synchronization replaces copies. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { NAME, RpcError } from "@xsb/protocol";
import type { TeamSyncPlan } from "@xsb/protocol";
import { loadProjectConfig, projectLanguage } from "./config.ts";
import type { Paths } from "./paths.ts";
import { catalog, check, clashes, lineage, teamRole, teamRoleNames } from "./presets.ts";
import type { Catalog, TeamEntry } from "./presets.ts";
import { materialize } from "./roles.ts";

const snapshotDir = (paths: Paths, id: string): string => {
  if (!NAME.test(id)) throw RpcError.invalidParams("invalid team id");
  return path.join(paths.templates, id);
};

/** Saved manifests include source identity; the source directory itself is never used for project roles. */
export function snapshot(paths: Paths, id: string): TeamEntry | undefined {
  const dir = snapshotDir(paths, id);
  const file = path.join(dir, "team.json");
  if (!fs.existsSync(dir)) return undefined;
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  if (json.id !== id || !["builtin", "user"].includes(json.source) || !Array.isArray(json.roles) || json.roles.some((r: any) => !NAME.test(r?.role ?? ""))) throw new Error(`invalid template snapshot: ${file}`);
  return { ...json, dir, snapshot: true };
}

/** Source catalog plus frozen project copies. A broken copy reports an error instead of reverting to live data. */
export function projectCatalog(paths: Paths, source = catalog(projectLanguage(paths)), used = loadProjectConfig(paths).teams ?? []): Catalog {
  const cat: Catalog = { teams: new Map(source.teams), problems: [...source.problems] };
  for (const id of used) {
    try {
      const copy = snapshot(paths, id);
      if (copy) cat.teams.set(id, copy);
    } catch (e) {
      cat.teams.delete(id);
      cat.problems.push({ source: "user", team: id, path: path.join(paths.templates, id), code: "template_snapshot_invalid", detail: (e as Error).message, severity: "error" });
    }
  }
  return cat;
}

/** Build a complete copy, including inherited roles, before touching project files. */
function prepare(paths: Paths, cat: Catalog, entry: TeamEntry, id: string): { staged: string; copy: TeamEntry } {
  const errors = [...cat.problems.filter((p) => p.team === entry.id && p.source === entry.source), ...check(cat, entry.id)].filter((p) => p.severity === "error");
  if (errors.length) throw new Error(errors.map((p) => `${p.detail} (${p.path})`).join("\n"));
  fs.mkdirSync(paths.templates, { recursive: true });
  const staged = fs.mkdtempSync(path.join(paths.templates, ".staged-"));
  try {
    const metadata = new Map(lineage(cat, entry.id).reverse().flatMap((team) => team.roles.map((role) => [role.role, role] as const)));
    const roles = teamRoleNames(cat, entry.id).map((role) => metadata.get(role) ?? { role, name: role });
    for (const role of roles) materialize(teamRole(cat, entry.id, role.role)!, path.join(staged, "roles", role.role));
    for (const layer of lineage(cat, entry.id).reverse()) {
      const evals = path.join(layer.dir, "evals");
      if (fs.existsSync(evals)) fs.cpSync(evals, path.join(staged, "evals"), { recursive: true, dereference: true });
    }
    const { dir: _dir, snapshot: _snapshot, ...manifest } = entry;
    const copy = { ...manifest, id, roles, dir: snapshotDir(paths, id), snapshot: true };
    fs.writeFileSync(path.join(staged, "team.json"), JSON.stringify({ ...manifest, id, roles }, null, 2) + "\n");
    return { staged, copy };
  } catch (e) {
    fs.rmSync(staged, { recursive: true, force: true });
    throw e;
  }
}

/** Move complete directories and roll back on failure. Overrides are discarded only for matched role codes. */
function install(paths: Paths, id: string, staged: string, overrides: string[]): void {
  const target = snapshotDir(paths, id);
  const rollback = fs.mkdtempSync(path.join(paths.templates, ".rollback-"));
  let saved = false, installed = false, cleanRollback = true;
  const moved: string[] = [];
  try {
    if (fs.existsSync(target)) { fs.renameSync(target, path.join(rollback, "template")); saved = true; }
    for (const role of overrides) {
      fs.renameSync(paths.roleDir(role), path.join(rollback, role));
      moved.push(role);
    }
    fs.renameSync(staged, target);
    installed = true;
  } catch (e) {
    cleanRollback = false;
    if (installed) fs.rmSync(target, { recursive: true, force: true });
    if (saved) fs.renameSync(path.join(rollback, "template"), target);
    for (const role of moved) fs.renameSync(path.join(rollback, role), paths.roleDir(role));
    cleanRollback = true;
    throw e;
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
    if (cleanRollback) fs.rmSync(rollback, { recursive: true, force: true });
  }
}

/** First use is a copy. Repeated use is idempotent and retains edits. */
export function copyTemplate(paths: Paths, cat: Catalog, id: string): void {
  if (snapshot(paths, id)) return;
  const entry = cat.teams.get(id);
  if (!entry) throw new Error(`no template "${id}"`);
  const { staged } = prepare(paths, cat, entry, id);
  install(paths, id, staged, []);
}

/** Hash files, including skill resources, to bind confirmation to the exact source and project contents. */
function fingerprint(dir: string): string {
  const hash = createHash("sha256");
  const visit = (where: string, relative: string): void => {
    for (const name of fs.readdirSync(where).sort()) {
      const file = path.join(where, name), key = path.join(relative, name);
      hash.update(key + "\0");
      if (fs.statSync(file).isDirectory()) visit(file, key);
      else hash.update(fs.readFileSync(file));
      hash.update("\0");
    }
  };
  if (fs.existsSync(dir)) visit(dir, "");
  return hash.digest("hex");
}

export function planSync(paths: Paths, id: string, cat = catalog(projectLanguage(paths))): TeamSyncPlan {
  if (!(loadProjectConfig(paths).teams ?? []).includes(id)) throw new Error(`project is not using team "${id}"`);
  const prior = snapshot(paths, id);
  // Legacy projects have no manifest yet: their existing team id identifies the initial source.
  const entry = cat.teams.get(id);
  if (!entry || (prior && entry.source !== prior.source)) throw new Error(`source template is unavailable for "${id}"`);
  const errors = [...cat.problems.filter((p) => p.team === id && p.source === entry.source), ...check(cat, id)].filter((p) => p.severity === "error");
  if (errors.length) throw new Error(errors.map((p) => p.detail).join("\n"));
  const updated = projectCatalog(paths, cat);
  updated.teams.set(id, entry);
  const conflict = clashes(updated, loadProjectConfig(paths).teams ?? []).find((c) => c.teams.includes(id));
  if (conflict) throw RpcError.invalidParams(`synchronization would duplicate role "${conflict.role}" between ${conflict.teams.join(" and ")}`);
  const roles = teamRoleNames(cat, entry.id).sort();
  const previous = prior ? fs.readdirSync(path.join(prior.dir, "roles")) : roles;
  const overwritten = previous.filter((name) => {
    if (!roles.includes(name)) return false;
    const file = path.join(paths.roleDir(name), ".template-origin.json");
    if (!fs.existsSync(file)) return false;
    const origin = JSON.parse(fs.readFileSync(file, "utf8"));
    return origin.source === entry.source && origin.team === id && origin.role === name;
  }).sort();
  const removed = previous.filter((name) => !roles.includes(name)).sort();
  const revision = createHash("sha256").update(JSON.stringify({ id, source: entry.source, roles, overwritten, removed,
    templates: lineage(cat, entry.id).map((team) => fingerprint(team.dir)),
    project: fingerprint(snapshotDir(paths, id)), overrides: overwritten.map((role) => fingerprint(paths.roleDir(role))) })).digest("hex");
  return { id, roles, overwritten, removed, revision };
}

/** Confirmation is mandatory on the wire as well as in the UI. Stale previews require a fresh confirmation. */
export function syncTemplate(paths: Paths, id: string, revision: string, confirm: boolean, cat = catalog(projectLanguage(paths))): TeamSyncPlan {
  if (confirm !== true) throw RpcError.invalidParams("synchronization overwrites custom role changes; explicit confirmation is required");
  const plan = planSync(paths, id, cat);
  if (revision !== plan.revision) throw RpcError.invalidParams("template or project changed since preview; preview and confirm again");
  const entry = cat.teams.get(id)!;
  const { staged } = prepare(paths, cat, entry, id);
  // Reading or copying may have encountered a concurrently edited source; never commit a different result.
  try {
    if (planSync(paths, id, cat).revision !== revision) throw RpcError.invalidParams("template or project changed while preparing synchronization");
    install(paths, id, staged, plan.overwritten);
  } finally {
    fs.rmSync(staged, { recursive: true, force: true });
  }
  return plan;
}
