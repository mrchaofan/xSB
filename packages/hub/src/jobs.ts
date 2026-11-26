/**
 * Jobs: the effector that runs the tool calls the kernel made tasks of (`Kernel.createJob`).
 *
 * Accepted jobs start without a concurrency queue. A job called off (`task.stopping`) is sent MCP's cancellation
 * and given a while to say what became of what it started; what it says is its result.
 */
import { errorMessage, textOf } from "@xsb/protocol";
import type { Task, TaskStatus } from "@xsb/protocol";
import type { Hub } from "./hub.ts";
import { mcpRequest } from "./mcp-client.ts";

/** How long a cancelled job's tool has to call off what it started and say so, before its server is stopped. */
const JOB_CANCEL_GRACE_MS = 15_000;

export class Jobs {
  private hub: Hub;
  /** Task id -> how to stop the call that runs for it. */
  private calls = new Map<string, AbortController>();

  constructor(hub: Hub) {
    this.hub = hub;
    const { hooks } = hub.kernel;
    hooks.on("task.created", (task) => {
      if (task.tool) this.run(task);
    });
    hooks.on("task.stopping", (task) => this.calls.get(task.id)?.abort());
  }

  close(): void { for (const call of this.calls.values()) call.abort(); }

  private run(task: Task): void {
    if (this.hub.stopping) return;
    task = this.hub.state.tasks.get(task.id)!;
    if (!task || task.status !== "queued" || task.stopping) return;
    const agent = this.hub.agent(task.to.agentId);
    const server = this.hub.toolServers(agent).find((t) => t.server.name === task.tool!.server)?.server;
    this.hub.kernel.started(task.id);
    const step = this.hub.lifecycle.step(task.source ?? { ...task.to, turnId: null }, `job:${task.id}`, { taskId: task.id, tool: task.tool!.name });
    const abort = new AbortController();
    this.calls.set(task.id, abort);
    const call = server
      ? mcpRequest(server, "tools/call", { name: task.tool!.name, arguments: task.tool!.arguments }, agent.workspace, abort.signal, JOB_CANCEL_GRACE_MS)
      : Promise.reject(new Error(`the session has no MCP server "${task.tool!.server}" any more`));
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
        step.end({ status });
        this.calls.delete(task.id);
        if (this.hub.stopping) return;
        this.hub.kernel.jobEnded(task.id, status, result);
      });
  }
}
