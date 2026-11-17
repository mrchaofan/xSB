/**
 * Roles: what makes one agent different from another.
 *
 * A role is a directory, the project's own (`.xsb/roles/<role>/`, written by
 * the user) or that of a preset team the project uses (teams.ts):
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
import { teamRoles, teams } from "./teams.ts";

export type Skill = { name: string; description: string; produces?: string; inputs: string[]; dir: string };

/** One thing the team can make: an asset type, the types it is made from, and who makes it. */
export type Contract = { produces: string; inputs: string[]; agents: string[] };

export type Role = {
  name: string;
  dir: string;
  /** The team the project uses that has a role of this name, what it calls it, and whether the project has its own in its place. */
  preset?: { team: string; teamTitle: string; own: boolean; title: string };
  avatar?: string;
  description?: string;
  backend?: string;
  workspace?: Workplace;
  instructions: string;
  /** The servers as `role.json` has them, and as a backend session is given them. */
  servers: Record<string, McpServerSpec>;
  mcpServers: McpServer[];
  skills: Skill[];
};

/** `role.json`. `mcpServers` is in the shape of `.mcp.json`: name -> how to start it. */
type RoleFile = { avatar?: string; description?: string; backend?: string; workspace?: Workplace; mcpServers?: Record<string, McpServerSpec> };

const read = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");

const has = (dir: string, name: string): boolean => fs.existsSync(path.join(dir, name, "role.json"));

/** Where the project's roles are looked for, in order: its own, then the teams it uses. */
function sources(paths: Paths, used = loadProjectConfig(paths).teams ?? []): { dir: string; team?: string }[] {
  const language = projectLanguage(paths);
  return [{ dir: paths.roles }, ...used.map((team) => ({ dir: teamRoles(team, language), team }))];
}

/** The names of the project's roles; with `used`, what they would be if it used those teams. */
export function roleNames(paths: Paths, used?: string[]): string[] {
  const names = sources(paths, used).flatMap(({ dir }) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => has(dir, name)) : []));
  return [...new Set(names)];
}

export function loadRole(paths: Paths, name: string): Role {
  const found = NAME.test(name) ? sources(paths).filter(({ dir }) => has(dir, name)) : [];
  if (!found.length) {
    throw failure("role_unknown", { role: name, known: roleNames(paths), dir: paths.roleDir(name) });
  }
  const team = found.find((source) => source.team)?.team;
  const shipped = team && teams(projectLanguage(paths)).find((t) => t.id === team);
  const preset = shipped && { team: shipped.id, teamTitle: shipped.title, own: !found[0].team, title: shipped.roles.find((entry) => entry.role === name)?.name ?? name };
  return { ...readRole(path.join(found[0].dir, name), name), ...(preset ? { preset } : {}) };
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
  return {
    name,
    dir,
    avatar: json.avatar,
    description: json.description,
    backend: json.backend,
    workspace: json.workspace,
    instructions: read(path.join(dir, "instructions.md")),
    servers: json.mcpServers ?? {},
    mcpServers: Object.entries(json.mcpServers ?? {}).map(([server, spec]) => ({
      name: server,
      command: spec.command,
      args: spec.args ?? [],
      env: Object.entries(spec.env ?? {}).map(([key, value]) => ({ name: key, value })),
    })),
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
  const shipped = sources(paths).find((source) => has(source.dir, input.name));
  if (shipped?.team) fs.cpSync(path.join(shipped.dir, input.name), dir, { recursive: true });
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

/** A role as it crosses the wire, but for who uses it. */
export function describeRole(role: Role): Omit<RoleDetail, "agents"> {
  return {
    name: role.name,
    preset: role.preset,
    avatar: role.avatar,
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
