/**
 * Preset teams: sets of roles for a kind of work (software development, film production). They come from two
 * places organised the same way, one directory per language, one per team:
 *
 *   <root>/<language>/<team>/team.json        { title, description, extends?, roles: [{ role, name, requires? }], assets? }
 *   <root>/<language>/<team>/roles/<role>/    a role, laid out as a project has it in .xsb/roles/ (roles.ts)
 *   <root>/<language>/<team>/evals/           scenarios to measure the team by (optional)
 *
 *   builtin   presets/ next to xsb's code (paths.ts, `shipped`), the same in the sources and in the app
 *   user      ~/.xsb/presets/ (`globalDir`), the user's own: copy a team there, or make one that extends another
 *
 * A team that `extends` another is that team with its own on top: a role of the same name in both is the base
 * role with the top one laid over it (`overlay`), and a role only one of them has is that one's. So a team that
 * changes how one role works holds only what differs. A builtin team extends only builtin ones; a user team may
 * extend either. A user team cannot take the id of a builtin one: it would hide the builtin team's updates.
 *
 * Everything is read from disk on every use, so an edit needs no restart; what is wrong in a file is reported as a
 * problem of its team or role, and the rest stays usable. The languages of the builtin teams differ in their
 * words only (the tests hold them to it); a user team may come in one language only, and is then used in the
 * other with its language said.
 *
 * A project uses teams by naming them in its config (`teams`). Nothing is copied: their roles are among the
 * project's (roles.ts) as they are here, until the project makes one its own.
 */
import fs from "node:fs";
import path from "node:path";
import { LANGUAGES } from "@xsb/protocol";
import type { Language } from "@xsb/protocol";
import { globalDir } from "./config.ts";
import { shipped } from "./paths.ts";
import { readRole } from "./roles.ts";
import type { Role } from "./roles.ts";

export type Source = "builtin" | "user";

export type TeamEntry = {
  id: string;
  source: Source;
  /** The team's directory, in the language it was found in. */
  dir: string;
  /** The language its words are in: the project's, or another when the team has none in the project's. */
  language: Language;
  title: string;
  description: string;
  extends?: string;
  roles: { role: string; name: string; requires?: { command: string; install: string }[] }[];
  /** What its asset types are called, its base's included. */
  assets: Record<string, string>;
};

/** Something wrong with a team or one of its files. `error`: what it applies to is left out; `warning`: it is used. */
export type Problem = { source: Source; team?: string; path: string; code: string; detail: string; severity: "error" | "warning" };

export type Catalog = { teams: Map<string, TeamEntry>; problems: Problem[] };

/** Where preset teams are read from, builtin first. */
export const presetRoots = (): { source: Source; dir: string }[] => [
  { source: "builtin", dir: shipped("presets") },
  { source: "user", dir: path.join(globalDir(), "presets") },
];

type Raw = Omit<TeamEntry, "assets"> & { assets: Record<string, string> };

/** The teams of one root, in the language asked for, or another when a team has none in it. */
function readRoot(source: Source, root: string, language: Language, problems: Problem[]): Raw[] {
  const ids = new Set<string>();
  for (const lang of LANGUAGES) {
    const dir = path.join(root, lang);
    if (fs.existsSync(dir)) for (const id of fs.readdirSync(dir)) if (fs.existsSync(path.join(dir, id, "team.json"))) ids.add(id);
  }
  const out: Raw[] = [];
  for (const id of [...ids].sort()) {
    const lang = [language, ...LANGUAGES.filter((l) => l !== language)].find((l) => fs.existsSync(path.join(root, l, id, "team.json")))!;
    const dir = path.join(root, lang, id);
    const file = path.join(dir, "team.json");
    let json: any;
    try {
      json = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
      problems.push({ source, team: id, path: file, code: "team_json_invalid", detail: (e as Error).message, severity: "error" });
      continue;
    }
    if (typeof json?.title !== "string" || !Array.isArray(json.roles ?? [])) {
      problems.push({ source, team: id, path: file, code: "team_json_invalid", detail: "needs a title and a list of roles", severity: "error" });
      continue;
    }
    out.push({
      id,
      source,
      dir,
      language: lang,
      title: json.title,
      description: json.description ?? "",
      ...(typeof json.extends === "string" ? { extends: json.extends } : {}),
      roles: (json.roles ?? []).filter((r: any) => typeof r?.role === "string").map((r: any) => ({ role: r.role, name: r.name ?? r.role, ...(r.requires ? { requires: r.requires } : {}) })),
      assets: json.assets ?? {},
    });
  }
  return out;
}

/** Every preset team there is for a project in `language`, and what is wrong among them. */
export function catalog(language: Language): Catalog {
  const problems: Problem[] = [];
  const [builtin, user] = presetRoots().map(({ source, dir }) => readRoot(source, dir, language, problems));
  const teams = new Map<string, Raw>(builtin.map((t) => [t.id, t]));
  for (const t of user) {
    if (teams.has(t.id) && teams.get(t.id)!.source === "builtin") {
      problems.push({ source: "user", team: t.id, path: t.dir, code: "team_shadows_builtin", detail: `a builtin team is called "${t.id}": give this one another id, and to build on that team say "extends": "${t.id}"`, severity: "error" });
    } else teams.set(t.id, t);
  }
  // A team whose base is missing, or that is its own base somewhere up the line, is left out; so is a builtin
  // team that would build on a user's.
  const resolved = new Map<string, TeamEntry>();
  const resolve = (id: string, seen: string[] = []): TeamEntry | undefined => {
    if (resolved.has(id)) return resolved.get(id);
    const team = teams.get(id);
    if (!team) return undefined;
    if (!team.extends) {
      resolved.set(id, team);
      return team;
    }
    const fail = (code: string, detail: string): undefined => {
      if (!problems.some((p) => p.team === id && p.code === code)) problems.push({ source: team.source, team: id, path: path.join(team.dir, "team.json"), code, detail, severity: "error" });
      return undefined;
    };
    if (seen.includes(id)) return fail("team_extends_cycle", `"extends" goes round in a circle: ${[...seen, id].join(" -> ")}`);
    const base = teams.has(team.extends) ? resolve(team.extends, [...seen, id]) : undefined;
    if (!base) return fail("team_extends_missing", `it extends "${team.extends}", which there is no usable team of`);
    if (team.source === "builtin" && base.source === "user") return fail("team_extends_user", "a builtin team builds on builtin teams only");
    const entry: TeamEntry = { ...team, assets: { ...base.assets, ...team.assets } };
    resolved.set(id, entry);
    return entry;
  };
  for (const id of teams.keys()) resolve(id);
  return { teams: resolved, problems };
}

/** A team and the teams it builds on, the team itself first. */
export function lineage(cat: Catalog, id: string): TeamEntry[] {
  const out: TeamEntry[] = [];
  for (let team = cat.teams.get(id); team && !out.includes(team); team = team.extends ? cat.teams.get(team.extends) : undefined) out.push(team);
  return out;
}

/** The roles a team gives, its bases' included: each name once, where it is defined the topmost. */
export function teamRoleNames(cat: Catalog, id: string): string[] {
  const names = lineage(cat, id).flatMap((team) => {
    const dir = path.join(team.dir, "roles");
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => fs.existsSync(path.join(dir, name, "role.json"))) : [];
  });
  return [...new Set(names)];
}

/**
 * A role of a team as it applies: the role of that name in the team's lineage, from the base up, each laid over the
 * one below (`overlay`). Undefined when the team has none of that name.
 */
export function teamRole(cat: Catalog, id: string, name: string): Role | undefined {
  const layers = lineage(cat, id)
    .reverse()
    .map((team) => path.join(team.dir, "roles", name))
    .filter((dir) => fs.existsSync(path.join(dir, "role.json")));
  if (!layers.length) return undefined;
  return layers.map((dir) => readRole(dir, name)).reduce(overlay);
}

/**
 * A role laid over another, by three rules: its `role.json` fields take the place of the base's, `mcpServers` by
 * server name; its instructions follow the base's; its skills join the base's, one of the same name taking the
 * base's place. The result keeps the directories of both (`layers`), which a backend session is given to read.
 */
export function overlay(base: Role, top: Role): Role {
  const servers = { ...base.servers, ...top.servers };
  const skills = new Map(base.skills.map((s) => [s.name, s]));
  for (const skill of top.skills) skills.set(skill.name, skill);
  return {
    ...base,
    name: top.name,
    dir: top.dir,
    layers: [...(base.layers ?? [base.dir]), top.dir],
    avatar: top.avatar ?? base.avatar,
    avatarFile: top.avatar !== undefined ? top.avatarFile : base.avatarFile,
    description: top.description ?? base.description,
    backend: top.backend ?? base.backend,
    workspace: top.workspace ?? base.workspace,
    instructions: [base.instructions.trim(), top.instructions.trim()].filter(Boolean).join("\n\n"),
    servers,
    mcpServers: [...base.mcpServers.filter((s) => !(s.name in top.servers)), ...top.mcpServers],
    skills: [...skills.values()],
  };
}

/** Teams a project could not use together: both give a role of the same name without one building on the other. */
export function clashes(cat: Catalog, ids: string[]): { teams: [string, string]; role: string }[] {
  const out: { teams: [string, string]; role: string }[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const [a, b] = [ids[i], ids[j]];
      const related = lineage(cat, a).some((t) => t.id === b) || lineage(cat, b).some((t) => t.id === a);
      if (related) continue;
      const theirs = new Set(teamRoleNames(cat, b));
      for (const role of teamRoleNames(cat, a)) if (theirs.has(role)) out.push({ teams: [a, b], role });
    }
  }
  return out;
}

/** Past this many characters a role's instructions or a skill is long enough that single rules in it get lost. */
const LONG = 8000;

/**
 * What can be checked of a team without running it: its roles exist and read, its skills say what they are, the
 * asset types they make and use are named and made by someone, nothing is overlong. How well it works is for its
 * scenarios to tell (`evals/`).
 */
export function check(cat: Catalog, id: string): Problem[] {
  const team = cat.teams.get(id);
  if (!team) return [];
  const out: Problem[] = [];
  const at = (where: string, code: string, detail: string, severity: Problem["severity"] = "warning"): void => void out.push({ source: team.source, team: id, path: where, code, detail, severity });
  const names = teamRoleNames(cat, id);
  for (const entry of team.roles) if (!names.includes(entry.role)) at(path.join(team.dir, "team.json"), "role_missing", `team.json lists the role "${entry.role}", which neither this team nor a team it extends has`, "error");
  const roles: Role[] = [];
  for (const name of names) {
    try {
      roles.push(teamRole(cat, id, name)!);
    } catch (e) {
      at(path.join(team.dir, "roles", name), "role_invalid", (e as Error).message, "error");
    }
  }
  const made = new Set(roles.flatMap((r) => r.skills.flatMap((s) => s.produces ?? [])));
  for (const role of roles) {
    if (role.instructions.length > LONG) at(path.join(role.dir, "instructions.md"), "too_long", `${role.instructions.length} characters of instructions: past about ${LONG}, single rules get lost among them`);
    if (role.avatar === "role" && !role.avatarFile) at(path.join(role.dir, "role.json"), "avatar_missing", `the avatar is "role", but there is no avatar.png in the role's directory`);
    for (const skill of role.skills) {
      const file = path.join(skill.dir, "SKILL.md");
      if (!/^---\n[\s\S]*?^description:/m.test(fs.readFileSync(file, "utf8"))) at(file, "skill_no_description", "the front matter says no description: it is what the role's instructions list the skill by");
      if (fs.statSync(file).size > LONG * 3) at(file, "too_long", `the skill is long (${fs.statSync(file).size} bytes): past about ${LONG} characters, single rules get lost`);
      for (const type of [skill.produces, ...skill.inputs].filter((t): t is string => !!t)) {
        if (!team.assets[type]) at(file, "asset_unnamed", `the asset type "${type}" has no name in team.json's "assets"`);
      }
      for (const type of skill.inputs) if (!made.has(type)) at(file, "input_unmade", `no role of the team makes "${type}": the user has to provide it`);
    }
  }
  return out;
}

/**
 * Start a user team that builds on another: `~/.xsb/presets/<language>/<id>/team.json` with `extends`, listing the
 * base's roles. What it is to change goes into its `roles/` afterwards.
 */
export function derive(cat: Catalog, id: string, base: string, language: Language): TeamEntry {
  const from = cat.teams.get(base);
  if (!from) throw new Error(`no team "${base}" to build on`);
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error("a team id is lower-case letters, digits, '-' or '_'");
  if (cat.teams.has(id)) throw new Error(`there is a team "${id}" already`);
  const dir = path.join(presetRoots().find((r) => r.source === "user")!.dir, language, id);
  if (fs.existsSync(dir)) throw new Error(`${dir} exists already`);
  fs.mkdirSync(path.join(dir, "roles"), { recursive: true });
  const json = { title: `${from.title} (${id})`, description: from.description, extends: base, roles: from.roles };
  fs.writeFileSync(path.join(dir, "team.json"), JSON.stringify(json, null, 2) + "\n");
  return { ...json, id, source: "user", dir, language, assets: from.assets };
}
