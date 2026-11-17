/**
 * Roles: what makes one agent different from another.
 *
 * A role is a directory, the project's own (`.xsb/roles/<role>/`, written by
 * the user) or that of a preset team the project uses (presets.ts):
 *
 *   role.json                 { description?, backend?, workspace?, mcpServers? }
 *   instructions.md           what the role is and how it works
 *   skills/<name>/SKILL.md    how to do one kind of work; may have files next to it
 *
 * An agent is an instance of a role (`AgentSpec.role`); several agents can
 * share one. `description`, `backend` and `workspace` are the defaults a new
 * agent starts with. Everything else is read whenever it is used, so an edit
 * needs no restart of the hub.
 *
 * What a role can do is what it declares, not what its instructions claim. A
 * skill whose front matter says `produces: <asset type>` is a contract: the
 * role produces that type, from the types its `inputs:` names, by the skill's
 * procedure, with the role's MCP servers. The hub puts the procedure into
 * every task that has to produce the type, and the contracts of all agents
 * together are the team (`Hub.team`). All skills are listed in the role's
 * instructions and can be loaded on request (`load_skill`).
 *
 * A role is looked up by name: among the project's own first, then in the
 * teams it uses. So a team's role is used as it ships until the project
 * changes it; the change is the project's own role of that name, and removing
 * that brings the team's back.
 */
import fs from "node:fs";
import path from "node:path";
import { NAME, failure, RpcError } from "@xsb/protocol";
import type { McpServer, McpServerSpec, RoleDetail, RoleInput, Workplace } from "@xsb/protocol";
import { loadProjectConfig, projectLanguage } from "./config.ts";
import type { Paths } from "./paths.ts";
import { catalog, teamRole, teamRoleNames } from "./presets.ts";

export type Skill = { name: string; description: string; produces?: string; inputs: string[]; dir: string };

/** One thing the team can make: an asset type, the types it is made from, and who makes it. */
export type Contract = { produces: string; inputs: string[]; agents: string[] };

export type Role = {
  name: string;
  /** Its directory; of a team role laid over its base team's, the topmost one. */
  dir: string;
  /** Of a team role laid over its base team's: every directory it is made of, the base's first (presets.ts). */
  layers?: string[];
  /** The team the project uses that has a role of this name, what it calls it, and whether the project has its own in its place. */
  preset?: { team: string; teamTitle: string; own: boolean; title: string };
  avatar?: string;
  /** With `avatar` "role": the role's own picture, `avatar.png` in its directory. */
  avatarFile?: string;
  description?: string;
  backend?: string;
  workspace?: Workplace;
  instructions: string;
  /** The servers as `role.json` has them, and as a backend session is given them. */
  servers: Record<string, McpServerSpec>;
  mcpServers: McpServer[];
  skills: Skill[];
};

/** Servers in the shape of `.mcp.json` (name -> how to start it), as a backend session is given them. */
export const mcpServers = (specs: Record<string, McpServerSpec>): McpServer[] =>
  Object.entries(specs).map(([name, spec]) => ({
    name,
    command: spec.command,
    args: spec.args ?? [],
    env: Object.entries(spec.env ?? {}).map(([key, value]) => ({ name: key, value })),
  }));

/** `role.json`. `mcpServers` is in the shape of `.mcp.json`: name -> how to start it. */
type RoleFile = { avatar?: string; description?: string; backend?: string; workspace?: Workplace; mcpServers?: Record<string, McpServerSpec> };

const read = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");

const has = (dir: string, name: string): boolean => fs.existsSync(path.join(dir, name, "role.json"));

/** The project's own roles, by name. */
const ownNames = (paths: Paths): string[] => (fs.existsSync(paths.roles) ? fs.readdirSync(paths.roles).filter((name) => has(paths.roles, name)) : []);

/** The names of the project's roles; with `used`, what they would be if it used those teams. */
export function roleNames(paths: Paths, used = loadProjectConfig(paths).teams ?? []): string[] {
  const cat = catalog(projectLanguage(paths));
  return [...new Set([...ownNames(paths), ...used.flatMap((team) => teamRoleNames(cat, team))])];
}

/**
 * A role by name: the project's own, or else the first team it uses that gives one (as that team's lineage lays
 * it out, presets.ts). A project's own role of a team role's name stands in its place whole.
 */
export function loadRole(paths: Paths, name: string): Role {
  const used = loadProjectConfig(paths).teams ?? [];
  const cat = catalog(projectLanguage(paths));
  const team = NAME.test(name) ? used.find((id) => teamRoleNames(cat, id).includes(name)) : undefined;
  const entry = team ? cat.teams.get(team) : undefined;
  const own = NAME.test(name) && has(paths.roles, name);
  const preset = entry && { team: entry.id, teamTitle: entry.title, own, title: entry.roles.find((r) => r.role === name)?.name ?? name };
  const role = own ? readRole(paths.roleDir(name), name) : team ? teamRole(cat, team, name) : undefined;
  if (!role) throw failure("role_unknown", { role: name, known: roleNames(paths), dir: paths.roleDir(name) });
  return { ...role, ...(preset ? { preset } : {}) };
}

/** The role a directory holds, wherever the directory is: a project's own, or a team's. */
export function readRole(dir: string, name: string): Role {
  const file = path.join(dir, "role.json");
  let json: RoleFile;
  try {
    json = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw failure("invalid_json", { file, detail: (e as Error).message });
  }
  const skillsDir = path.join(dir, "skills");
  const skills = (fs.existsSync(skillsDir) ? fs.readdirSync(skillsDir) : [])
    .filter((skill) => fs.existsSync(path.join(skillsDir, skill, "SKILL.md")))
    .map((skill) => {
      const skillDir = path.join(skillsDir, skill);
      return { name: skill, ...skillHeader(read(path.join(skillDir, "SKILL.md"))), dir: skillDir };
    });
  const avatarFile = json.avatar === "role" && fs.existsSync(path.join(dir, "avatar.png")) ? path.join(dir, "avatar.png") : undefined;
  return {
    name,
    dir,
    avatar: json.avatar,
    ...(avatarFile ? { avatarFile } : {}),
    description: json.description,
    backend: json.backend,
    workspace: json.workspace,
    instructions: read(path.join(dir, "instructions.md")),
    servers: json.mcpServers ?? {},
    mcpServers: mcpServers(json.mcpServers ?? {}),
    skills,
  };
}

/**
 * Create a role or change one. See `Roles.put` in @xsb/protocol for what a field left out means.
 * The change is always to the project's own role: a team's role is first copied to become one.
 */
export function saveRole(paths: Paths, input: RoleInput): void {
  if (!NAME.test(input.name ?? "")) throw failure("role_name_invalid");
  if (input.avatar !== undefined && (typeof input.avatar !== "string" || (input.avatar !== "" && !/^[a-z][a-z0-9-]{0,63}$/.test(input.avatar)))) throw RpcError.invalidParams("avatar must be a bundled avatar ID or empty");
  for (const [server, spec] of Object.entries(input.mcpServers ?? {})) {
    if (!NAME.test(server) || typeof spec?.command !== "string" || !spec.command) throw failure("server_invalid", { server });
  }
  if (input.workspace && input.workspace !== "project" && input.workspace !== "own") throw RpcError.invalidParams(`workspace must be "project" or "own"`);
  for (const skill of input.skills ?? []) if (!NAME.test(skill.name ?? "")) throw failure("skill_name_invalid", { skill: skill.name });

  const dir = paths.roleDir(input.name);
  const file = path.join(dir, "role.json");
  // A team's role becomes the project's own as it applies, laid over its base team's if it is: written out whole.
  if (!has(paths.roles, input.name) && roleNames(paths).includes(input.name)) materialize(loadRole(paths, input.name), dir);
  fs.mkdirSync(dir, { recursive: true });
  const prior: RoleFile = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const { avatar = prior.avatar, description = prior.description, backend = prior.backend, workspace = prior.workspace, mcpServers = prior.mcpServers } = input;
  fs.writeFileSync(file, JSON.stringify({ avatar, description, backend, workspace, mcpServers } satisfies RoleFile, null, 2) + "\n");
  if (input.instructions !== undefined) fs.writeFileSync(path.join(dir, "instructions.md"), input.instructions);
  if (!input.skills) return;
  const skillsDir = path.join(dir, "skills");
  fs.mkdirSync(skillsDir, { recursive: true });
  for (const skill of input.skills) {
    fs.mkdirSync(path.join(skillsDir, skill.name), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, skill.name, "SKILL.md"), skill.content);
  }
  const kept = new Set(input.skills.map((s) => s.name));
  for (const name of fs.readdirSync(skillsDir)) if (!kept.has(name)) fs.rmSync(path.join(skillsDir, name), { recursive: true });
}

/** Write a role out as a directory of its own: one role.json, one instructions.md, and every skill with its files. */
function materialize(role: Role, dir: string): void {
  fs.mkdirSync(path.join(dir, "skills"), { recursive: true });
  const json: RoleFile = { avatar: role.avatarFile ? "role" : role.avatar, description: role.description, backend: role.backend, workspace: role.workspace, mcpServers: role.servers };
  fs.writeFileSync(path.join(dir, "role.json"), JSON.stringify(json, null, 2) + "\n");
  fs.writeFileSync(path.join(dir, "instructions.md"), role.instructions);
  if (role.avatarFile) fs.copyFileSync(role.avatarFile, path.join(dir, "avatar.png"));
  for (const skill of role.skills) fs.cpSync(skill.dir, path.join(dir, "skills", skill.name), { recursive: true });
}

/** A role as it crosses the wire, but for who uses it. */
export function describeRole(role: Role): Omit<RoleDetail, "agents"> {
  return {
    name: role.name,
    preset: role.preset,
    avatar: role.avatar,
    ...(role.avatarFile ? { avatarFile: role.avatarFile } : {}),
    description: role.description,
    backend: role.backend,
    workspace: role.workspace,
    instructions: role.instructions,
    mcpServers: role.servers,
    skills: role.skills.map((skill) => ({ ...skill, content: skillBody(skill) })),
  };
}

export const skillBody = (skill: Pick<Skill, "dir">): string => read(path.join(skill.dir, "SKILL.md"));

/** What a SKILL.md says about itself in its front matter. Without a `description:` the first line of text is one. */
function skillHeader(body: string): Pick<Skill, "description" | "produces" | "inputs"> {
  const frontMatter = /^---\n([\s\S]*?)\n---/.exec(body);
  const field = (key: string): string | undefined => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(frontMatter?.[1] ?? "")?.[1].trim();
  const firstLine = body.slice(frontMatter?.[0].length ?? 0).split("\n").find((line) => line.trim());
  const inputs = (field("inputs") ?? "").split(",").map((type) => type.trim()).filter(Boolean);
  return { description: field("description") ?? firstLine?.replace(/^#+\s*/, "").trim() ?? "", produces: field("produces"), inputs };
}
