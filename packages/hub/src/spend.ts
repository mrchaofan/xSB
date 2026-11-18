/**
 * The project's spending on generation, as the hub keeps it in view: the ledger (`.xsb/spend.jsonl`, `Spend` in
 * @xsb/protocol) is written by the generation tools, one record per generation, and by the hub for the user's budget.
 * The hub gives the tools the ledger's path and the agent's id (`XSB_SPEND`, `XSB_AGENT`); the tools hold
 * generation to the budget themselves, before every call, so the cap holds for jobs and direct calls alike.
 */
import fs from "node:fs";
import { spendRecords, standing } from "@xsb/protocol";
import type { McpServer, Spend } from "@xsb/protocol";
import type { Paths } from "./paths.ts";

export const SPEND_ENV = "XSB_SPEND";
export const AGENT_ENV = "XSB_AGENT";

export class Spending {
  private readonly file: string;

  constructor(paths: Paths) {
    this.file = paths.spend;
  }

  read(): Spend {
    return standing(fs.existsSync(this.file) ? spendRecords(fs.readFileSync(this.file, "utf8")) : []);
  }

  /** The user's cap on generation costs, in yuan. Only a client of the user's sets it, never an agent. */
  setBudget(amount: number): Spend {
    if (!Number.isFinite(amount) || amount < 0) throw new Error("the budget is an amount of yuan, 0 or more");
    fs.appendFileSync(this.file, JSON.stringify({ op: "budget", at: new Date().toISOString(), amount }) + "\n");
    return this.read();
  }

  /** A role's server, told where the ledger is and whom it works for. */
  withLedger(server: McpServer, agentId: string): McpServer {
    if (server.type !== "stdio") return server;
    const env = (server.env ?? []).filter((e) => e.name !== SPEND_ENV && e.name !== AGENT_ENV);
    return { ...server, env: [...env, { name: SPEND_ENV, value: this.file }, { name: AGENT_ENV, value: agentId }] };
  }

  /** What an agent is told of it, in front of a turn; nothing while there is neither budget nor spending. */
  line(): string | undefined {
    const { budget, spent, unpriced, dearest } = this.read();
    if (budget === undefined && spent === 0 && unpriced === 0) return undefined;
    const of = budget === undefined ? "; no budget is set" : ` of the budget of ${budget.toFixed(2)} yuan`;
    // What one call of each tool has cost at most: enough to estimate what more of it would cost without asking.
    const each = Object.entries(dearest).map(([tool, amount]) => `${tool} up to about ${amount.toFixed(2)} yuan a call`);
    return `[xsb] Spent on generation in this project so far: about ${spent.toFixed(2)} yuan${unpriced ? `, and ${unpriced} generation(s) not priced` : ""}${of} (estimates).${each.length ? ` So far ${each.join(", ")}.` : ""}`;
  }

  /** Call `changed` when the ledger changes, whoever wrote it. */
  watch(changed: (spend: Spend) => void): () => void {
    const listener = (): void => changed(this.read());
    fs.watchFile(this.file, { interval: 1000 }, listener);
    return () => fs.unwatchFile(this.file, listener);
  }
}
