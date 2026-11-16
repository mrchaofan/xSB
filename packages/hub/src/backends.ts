/**
 * The backend processes of the hub: at most one per agent, started when a
 * session of that agent first needs it.
 */
import { failure } from "@xsb/protocol";
import type { AgentSpec } from "@xsb/protocol";
import { Backend } from "./backend.ts";
import { backends, globalConfigPath } from "./config.ts";
import type { BackendSpec } from "./config.ts";

export class BackendPool {
  /** Agent id -> its process, running or still starting. */
  private procs = new Map<string, Promise<Backend>>();
  private log: (line: string) => void;

  constructor(log: (line: string) => void) {
    this.log = log;
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
    const running = this.procs.get(agent.id);
    if (running) return running;
    const forget = (): void => {
      if (this.procs.get(agent.id) === starting) this.procs.delete(agent.id);
    };
    const starting: Promise<Backend> = (async () =>
      Backend.start(agent.id, agent.backend, this.spec(agent), agent.workspace, {
        onExit: (reason) => {
          this.log(`backend ${agent.id} ${reason}`);
          forget();
        },
        log: (line) => this.log(`[${agent.id}] ${line}`),
      }))();
    this.procs.set(agent.id, starting);
    starting.then(
      (b) => this.log(`backend ${agent.id} up: ${b.info}, steering ${b.caps.steering ? "native" : "by interrupt"}`),
      forget,
    );
    return starting;
  }

  /** Stop an agent's process. Its sessions bind to a new one on their next turn. */
  stop(agentId: string): void {
    const proc = this.procs.get(agentId);
    this.procs.delete(agentId);
    void proc?.then(
      (b) => b.stop(),
      () => {},
    );
  }

  async stopAll(): Promise<void> {
    const procs = [...this.procs.values()];
    this.procs.clear();
    for (const proc of procs) (await proc.catch(() => undefined))?.stop();
  }
}
