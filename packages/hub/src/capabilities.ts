/**
 * CapabilityHook: what an agent may do in the work it is doing. There are no static roles of "coordinator" and
 * "worker": the tools a session has are computed from the tasks it has open, every time they are asked for.
 *
 *   upward    every task lets its executor reach its initiator: report its result, ask it a question
 *   dispatch  dispatch tasks (and look at them, stop them, subscribe to them)
 *   message   message other agents
 *   always    escalate to the user; look at, subscribe to and stop what it started itself (its own jobs, the tasks
 *             it dispatched), and its inbox; and the tools that are not collaboration (assets, memory, skills, jobs)
 *
 * `dispatch` and `message` come from a grant, which names its targets or none (any agent). Grants come from:
 *   - the role's team policy (`role.json` `grants`), for every task its agents execute;
 *   - the user asking for it: an agent named in what the user says to an agent is one it may then reach;
 *   - whoever dispatched the task (`dispatch_task` `grants`), out of what it may do itself.
 * A chat message an agent receives lets it answer the sender in the same turn.
 *
 * The grants of a task are settled when it is created (`task.pre_create`), and grow when the user names another
 * agent in it later (`userSaid`). They end with the task: a session whose tasks ended has only what is always there.
 */
import { textOf } from "@xsb/protocol";
import type { ContentBlock, Grant, Task } from "@xsb/protocol";
import type { Hub } from "./hub.ts";
import type { Kernel } from "./kernel.ts";

/** Whom a capability reaches: any agent, or these. */
export type Reach = "any" | Set<string>;
export type Capabilities = { upward: Set<string>; dispatch: Reach; message: Reach };

export const reaches = (reach: Reach, agentId: string): boolean => reach === "any" || reach.has(agentId);
const none = (reach: Reach): boolean => reach !== "any" && reach.size === 0;

/** Which capability each collaboration tool needs. Tools not named here are always there. */
export const NEEDS: Record<string, "upward" | "dispatch" | "message" | "reach"> = {
  report_result: "upward",
  ask: "reach",
  dispatch_task: "dispatch",
  list_agents: "reach",
  send_message: "message",
  broadcast: "message",
  message_status: "message",
};

/** Whether a session with these capabilities has the tool. */
export function has(caps: Capabilities, tool: string): boolean {
  switch (NEEDS[tool]) {
    case undefined:
      return true;
    case "upward":
      return caps.upward.size > 0;
    case "dispatch":
      return !none(caps.dispatch);
    case "message":
      return !none(caps.message);
    case "reach":
      return caps.upward.size > 0 || !none(caps.dispatch) || !none(caps.message);
  }
}

function widen(into: Reach, grant: Grant): Reach {
  if (into === "any" || !grant.to?.length) return "any";
  return new Set([...into, ...grant.to]);
}

/** What a session may do now: from the tasks it has open, and the senders of the chat it is reading. */
export function capabilities(kernel: Kernel, sessionId: string, senders: string[] = []): Capabilities {
  const caps: Capabilities = { upward: new Set(), dispatch: new Set(), message: new Set(senders) };
  for (const task of kernel.openTasks(sessionId)) {
    if (task.initiator.kind === "agent") caps.upward.add(task.initiator.agentId);
    for (const grant of task.grants ?? []) caps[grant.cap] = widen(caps[grant.cap], grant);
  }
  return caps;
}

/** The agents a user's words name: by id, or by name, other than the agent they are said to. */
function named(hub: Hub, said: string, self: string): string[] {
  const words = said.toLowerCase();
  return [...hub.state.agents.values()]
    .filter((a) => a.id !== self)
    .filter((a) => new RegExp(`(^|[^\\w-])@?${a.id.toLowerCase()}($|[^\\w-])`).test(words) || (a.name.trim().length > 1 && words.includes(a.name.trim().toLowerCase())))
    .map((a) => a.id);
}

/** The grants a user's words give: to dispatch to and message the agents they name. */
export function intent(hub: Hub, prompt: ContentBlock[], self: string): Grant[] {
  const to = named(hub, textOf(prompt), self);
  return to.length ? [{ cap: "dispatch", to }, { cap: "message", to }] : [];
}

/** Merge grants, so that each capability is listed once with every target. */
export function merge(grants: Grant[]): Grant[] {
  const out: Grant[] = [];
  for (const cap of ["dispatch", "message"] as const) {
    let reach: Reach = new Set();
    let any = false;
    for (const grant of grants.filter((g) => g.cap === cap)) {
      reach = widen(reach, grant);
      any = true;
    }
    if (any) out.push(reach === "any" ? { cap } : { cap, to: [...reach] });
  }
  return out;
}

/** Register the hook: the grants of every task as it is created. */
export function capabilityHook(hub: Hub): void {
  hub.kernel.hooks.decider("task.pre_create", ({ task }) => {
    if (task.tool) return { task };
    const role = hub.role(hub.agent(task.to.agentId));
    const policy: Grant[] = (role?.grants ?? []).map((cap) => ({ cap }));
    const given = task.from ? allowedGrants(hub.kernel, task.from.sessionId, task.grants ?? []) : intent(hub, [{ type: "text", text: task.instructions }], task.to.agentId);
    const grants = merge([...policy, ...given]);
    return { task: { ...(task as Task), ...(grants.length ? { grants } : { grants: undefined }) } };
  });
}

/** Of the grants a dispatcher asks to pass on, those it holds itself. */
function allowedGrants(kernel: Kernel, sessionId: string, asked: Grant[]): Grant[] {
  const own = capabilities(kernel, sessionId);
  return asked.flatMap((grant): Grant[] => {
    const reach = own[grant.cap];
    if (none(reach)) return [];
    if (reach === "any") return [grant];
    const to = (grant.to ?? [...reach]).filter((id) => reach.has(id));
    return to.length ? [{ cap: grant.cap, to }] : [];
  });
}

/** The user said more on a task of theirs: the agents they name now are reachable too. */
export function userSaid(hub: Hub, task: Task, prompt: ContentBlock[]): void {
  const more = intent(hub, prompt, task.to.agentId);
  if (!more.length) return;
  const grants = merge([...(task.grants ?? []), ...more]);
  if (JSON.stringify(grants) !== JSON.stringify(task.grants ?? [])) hub.kernel.update({ ...task, grants });
}
