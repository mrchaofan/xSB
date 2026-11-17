/** A role between its two shapes: the hub's (files and maps) and the editor's (see RoleView). */
import type { RoleDetail, RoleInput } from "@xsb/protocol";
import type { RoleView } from "./bridge.ts";

const FRONT_MATTER = /^---\n[\s\S]*?\n---\n?/;

export function roleView(role: Omit<RoleDetail, "agents">): RoleView {
  return {
    name: role.name,
    avatar: role.avatar ?? "",
    preset: role.preset ?? null,
    description: role.description ?? "",
    backend: role.backend ?? "",
    workspace: role.workspace ?? "own",
    instructions: role.instructions,
    mcpServers: Object.entries(role.mcpServers).map(([name, spec]) => ({
      name,
      command: spec.command,
      args: spec.args ?? [],
      env: Object.entries(spec.env ?? {}).map(([key, value]) => ({ name: key, value })),
    })),
    skills: role.skills.map((s) => ({ name: s.name, description: s.description, produces: s.produces ?? null, inputs: s.inputs.join(", "), body: s.content.replace(FRONT_MATTER, "") })),
  };
}

export function roleInput(view: RoleView): RoleInput {
  return {
    name: view.name,
    avatar: view.avatar,
    description: view.description,
    // The hub keeps a field that is left out; a default backend, once set, cannot be unset from here.
    backend: view.backend || undefined,
    workspace: view.workspace,
    instructions: view.instructions,
    mcpServers: Object.fromEntries(
      view.mcpServers.map((s) => [s.name, { command: s.command, args: s.args, env: Object.fromEntries(s.env.map((e) => [e.name, e.value])) }]),
    ),
    skills: view.skills.map((s) => {
      // What the skill says about itself is the front matter of its SKILL.md.
      const header = [s.description && `description: ${s.description}`, s.produces && `produces: ${s.produces}`, s.produces && s.inputs.trim() && `inputs: ${s.inputs.trim()}`]
        .filter(Boolean)
        .join("\n");
      return { name: s.name, content: `${header ? `---\n${header}\n---\n` : ""}${s.body}` };
    }),
  };
}
