/**
 * Permissions: whom an agent may give tasks to (`dispatch`) and message (`message`), by role (docs/KERNEL.md 8).
 *
 * The unit is the role: what one agent of a role may, every agent of it may. An agent without a role is a role of
 * its own, by the key `agent:<id>`, separate from role type names. A role may reach another when:
 *   - its definition says so: `role.json` `grants` (a preset's are its defaults; "dispatch" reaches everyone);
 *   - the project's config says so: `.xsb/config.json` `permissions`, which grows when the user, asked at run time,
 *     allows it always.
 * Whatever else an agent tries is put to the user, and the call waits for the answer (tools.ts, `authorize`).
 *
 * Two things need no permission, for they come with the work: reaching whoever gave the agent a task it has open
 * (report_result, ask), and answering the agents whose messages it is reading in its running turn.
 *
 * What the model sees of the team's tools does not depend on any of this: every session is listed every tool, and
 * a call that is not allowed is put to the user, or refused saying why (mcp.ts).
 */
import type { AgentSpec, Grant } from "@xsb/protocol";
import { loadProjectConfig, saveProjectConfig } from "./config.ts";
import type { Hub } from "./hub.ts";
import { roleNames } from "./roles.ts";

/** Whom a capability reaches: any agent, or these. */
export type Reach = "any" | Set<string>;
export type Capabilities = { upward: Set<string>; dispatch: Reach; message: Reach };
type Cap = Grant["cap"];

export const reaches = (reach: Reach, agentId: string): boolean => reach === "any" || reach.has(agentId);

/** The role an agent's permissions are kept under: its role, or, without one, itself. */
export const roleKey = (agent: AgentSpec): string => agent.role ?? `agent:${agent.id}`;

/** Old roleless IDs shared the type namespace. Move unambiguous instance entries on startup. */
export function migratePermissions(hub: Hub): void {
  const config = loadProjectConfig(hub.paths);
  if (!config.permissions) return;
  const roles = new Set(roleNames(hub.paths));
  const key = (name: string): string => !roles.has(name) && hub.state.agents.get(name)?.role === undefined && hub.state.agents.has(name) ? `agent:${name}` : name;
  const permissions: NonNullable<typeof config.permissions> = {};
  for (const [source, policy] of Object.entries(config.permissions)) {
    const target = permissions[key(source)] ??= {};
    for (const cap of ["dispatch", "message"] as const) {
      if (policy[cap]) target[cap] = [...new Set([...(target[cap] ?? []), ...policy[cap].map(key)])];
    }
  }
  if (JSON.stringify(permissions) !== JSON.stringify(config.permissions)) saveProjectConfig(hub.paths, { ...config, permissions });
}

/** Role keys a caller may reach, including roles with no instances yet. */
export function roleReach(hub: Hub, agent: AgentSpec, cap: Cap): Reach {
  if (hub.role(agent)?.grants?.includes(cap)) return "any";
  const listed = loadProjectConfig(hub.paths).permissions?.[roleKey(agent)]?.[cap] ?? [];
  if (listed.includes("*")) return "any";
  return new Set(listed);
}

/** Resolve type policy to today's instances only when delivering work. */
function allowed(hub: Hub, agent: AgentSpec, cap: Cap): Reach {
  const roles = roleReach(hub, agent, cap);
  return roles === "any" ? "any" : new Set([...hub.state.agents.values()].filter((a) => roles.has(roleKey(a))).map((a) => a.id));
}

/** What an agent may do in its session now, without asking the user. */
export function capabilities(hub: Hub, agentId: string, sessionId: string, senders: string[] = []): Capabilities {
  const agent = hub.agent(agentId);
  const upward = new Set<string>();
  for (const task of hub.kernel.openTasks(sessionId)) if (task.initiator.kind === "agent") upward.add(task.initiator.agentId);
  const message = allowed(hub, agent, "message");
  return {
    upward,
    dispatch: allowed(hub, agent, "dispatch"),
    message: message === "any" ? "any" : new Set([...message, ...senders]),
  };
}

/** The user allowed it always: the agent's role may reach these agents' roles with `cap` from now on. */
export function allowAlways(hub: Hub, agentId: string, cap: Cap, to: string[]): void {
  allowRoles(hub, roleKey(hub.agent(agentId)), cap, to.map((id) => roleKey(hub.agent(id))));
}

/** Add a type-to-type edge without requiring either type to have an instance. */
export function allowRoles(hub: Hub, key: string, cap: Cap, to: string[]): void {
  const config = loadProjectConfig(hub.paths);
  const role = { ...config.permissions?.[key] };
  role[cap] = [...new Set([...(role[cap] ?? []), ...to])];
  saveProjectConfig(hub.paths, { ...config, permissions: { ...config.permissions, [key]: role } });
}
