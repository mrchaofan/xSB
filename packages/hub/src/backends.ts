/**
 * The backend processes of the hub: at most one per agent, started when a
 * session of that agent first needs it.
 */
import { RpcError, failure } from "@xsb/protocol";
import type { AgentSpec } from "@xsb/protocol";
import type { BackendEvents } from "./backend.ts";
import { Backend } from "./backend.ts";
import { backends, globalConfigPath } from "./config.ts";
import type { BackendSpec } from "./config.ts";

export class BackendPool {
  /** Agent id -> its process, running or still starting. */
  private procs = new Map<string, Promise<Backend>>();
  /** Agent id -> its stopped process, until it has exited. A new one waits: a backend may lock a session it resumes. */
  private stopping = new Map<string, Promise<void>>();
  /** The hub is stopping: no process starts any more (`close`). */
  private closed = false;
  private log: (line: string) => void;
  private events: Pick<BackendEvents, "url" | "urlComplete">;

  constructor(log: (line: string) => void, events: Pick<BackendEvents, "url" | "urlComplete"> = {}) {
    this.log = log;
    this.events = events;
  }

  /** How to start the backend an agent names. Throws `backend_unknown`. */
  spec(agent: AgentSpec): BackendSpec {
    const table = backends();
    const spec = table[agent.backend];
    if (!spec) {
      throw failure("backend_unknown", { agent: agent.id, backend: agent.backend, known: Object.keys(table), config: globalConfigPath() });
    }
    return spec;
  }

  /** The agent's process, started if there is none. */
  for(agent: AgentSpec): Promise<Backend> {
    // A turn that asks now is cut short like any other at the stop: nothing is acknowledged, it runs on the next start.
    if (this.closed) return Promise.reject(RpcError.cancelled());
    const running = this.procs.get(agent.id);
    if (running) return running;
    const forget = (): void => {
      if (this.procs.get(agent.id) === starting) this.procs.delete(agent.id);
    };
    const starting: Promise<Backend> = (async () => {
      await this.stopping.get(agent.id);
      return Backend.start(agent.id, agent.backend, this.spec(agent), agent.workspace, {
        ...this.events,
        onExit: (reason) => {
          this.log(`backend ${agent.id} ${reason}`);
          forget();
        },
        log: (line) => this.log(`[${agent.id}] ${line}`),
      });
    })();
    this.procs.set(agent.id, starting);
    starting.then(
      (b) => this.log(`backend ${agent.id} up: ${b.info}`),
      forget,
    );
    return starting;
  }

  /** Stop an agent's process. Its sessions bind to a new one on their next turn. */
  stop(agentId: string): void {
    const proc = this.procs.get(agentId);
    if (!proc) return;
    this.procs.delete(agentId);
    const previous = this.stopping.get(agentId);
    const ended: Promise<void> = Promise.all([previous, proc.then((b) => b.stop(), () => {})]).then(() => {
      if (this.stopping.get(agentId) === ended) this.stopping.delete(agentId);
    });
    this.stopping.set(agentId, ended);
  }

  async stopAndWait(agentId: string): Promise<void> { this.stop(agentId); await this.stopping.get(agentId); }

  /** Stop every process, start none from now on, and wait for all of them to exit. */
  async close(): Promise<void> {
    this.closed = true;
    await this.stopAll();
  }

  /** Stop every process and wait for all of them to exit. */
  async stopAll(): Promise<void> {
    for (const agentId of [...this.procs.keys()]) this.stop(agentId);
    await Promise.all(this.stopping.values());
  }
}
