/**
 * Jobs: the effector that runs the tool calls the kernel made tasks of (`Kernel.createJob`).
 *
 * At most `limits.jobsAtOnce` calls of one tool run at a time; the rest wait here, as `queued`, so that a halt the
 * user calls finds them still waiting, where cancelling one is certain to cost nothing. A job called off
 * (`task.stopping`) is sent MCP's cancellation and given a while to say what became of what it started; what it says
 * is its result.
 */
import { errorMessage, textOf } from "@xsb/protocol";
import type { Task, TaskStatus } from "@xsb/protocol";
import { loadProjectConfig } from "./config.ts";
import type { Hub } from "./hub.ts";
import { mcpRequest } from "./mcp-client.ts";

/** How many calls of one tool run at a time, unless the project says otherwise (`limits.jobsAtOnce`). */
const JOBS_AT_ONCE = 2;
/** How long a cancelled job's tool has to call off what it started and say so, before its server is stopped. */
const JOB_CANCEL_GRACE_MS = 15_000;

const kindOf = (task: Task): string => `${task.tool!.server}/${task.tool!.name}`;

export class Jobs {
  private hub: Hub;
  /** Task id -> how to stop the call that runs for it. */
  private calls = new Map<string, AbortController>();
  /** Jobs that wait for a place, per tool, in the order they were started. */
  private waiting = new Map<string, string[]>();

  constructor(hub: Hub) {
    this.hub = hub;
    const { hooks } = hub.kernel;
    hooks.on("task.created", (task) => {
      if (task.tool) this.start(task);
    });
    hooks.on("task.stopping", (task) => this.calls.get(task.id)?.abort());
    hooks.on("task.ended", ({ ended }) => {
      for (const { task } of ended) {
        if (!task.tool) continue;
        const kind = kindOf(task);
        this.waiting.set(kind, (this.waiting.get(kind) ?? []).filter((id) => id !== task.id));
      }
    });
  }

  private start(task: Task): void {
    task = this.hub.state.tasks.get(task.id)!;
    if (!task || task.status !== "queued" || task.stopping) return;
    const kind = kindOf(task);
    const running = [...this.hub.state.tasks.values()].filter((t) => t.tool && kindOf(t) === kind && t.status === "running").length;
    const allowed = loadProjectConfig(this.hub.paths).limits?.jobsAtOnce ?? JOBS_AT_ONCE;
    if (running >= allowed) this.waiting.set(kind, [...(this.waiting.get(kind) ?? []), task.id]);
    else this.run(task);
  }

  private run(task: Task): void {
    task = this.hub.state.tasks.get(task.id)!;
    if (!task || task.status !== "queued" || task.stopping) return;
    const kind = kindOf(task);
    const agent = this.hub.agent(task.to.agentId);
    const server = this.hub.toolServers(agent).find((t) => t.from === "role" && t.server.name === task.tool!.server)?.server;
    this.hub.kernel.started(task.id);
    const abort = new AbortController();
    this.calls.set(task.id, abort);
    const call = server
      ? mcpRequest(server, "tools/call", { name: task.tool!.name, arguments: task.tool!.arguments }, agent.workspace, abort.signal, JOB_CANCEL_GRACE_MS)
      : Promise.reject(new Error(`the role has no MCP server "${task.tool!.server}" any more`));
    call
      .then(
        // A cancelled call is still answered: what the tool says became of it is the result. One that finished all the same did finish.
        (r): [TaskStatus, string] => {
          const said = textOf(r.content ?? []);
          return abort.signal.aborted && r.isError ? ["cancelled", said] : [r.isError ? "failed" : "completed", said];
        },
        (e): [TaskStatus, string] => (abort.signal.aborted ? ["cancelled", "The tool did not say what became of the call."] : ["failed", errorMessage(e)]),
      )
      .then(([status, result]) => {
        this.calls.delete(task.id);
        if (this.hub.stopping) return;
        this.hub.kernel.jobEnded(task.id, status, result);
        let next: string | undefined;
        while ((next = this.waiting.get(kind)?.shift())) {
          const waiter = this.hub.state.tasks.get(next);
          if (!waiter || waiter.status !== "queued" || waiter.stopping) continue;
          this.run(waiter);
          break;
        }
      });
  }
}
