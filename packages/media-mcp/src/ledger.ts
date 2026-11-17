/**
 * The project's ledger of what generation cost: `.xsb/spend.jsonl` of an xsb project, given to this server as
 * `XSB_SPEND` by the hub. Without it (the server run on its own) nothing is counted or held back.
 *
 * Its records and how they add up are in @xsb/protocol (spend.ts): the hub writes the user's budget, this server
 * one record per generation.
 *
 * Before every generation the ledger is read again, so a budget the user changes holds at once. The cap is hard:
 * no budget, a budget reached, or a spend that could not be priced since the budget was last set, and nothing more
 * is generated until the user says so. A cost that is not known is not taken for zero.
 */
import fs from "node:fs";
import { spendRecords, standing } from "@xsb/protocol";
import type { Spend } from "@xsb/protocol";

export type Cost = {
  /** Yuan, estimated; null when no price was found. */
  amount: number | null;
  model?: string;
  /** What was used, in the provider's units ("48437 tokens", "1 image"). */
  usage: string;
  /** How the amount was arrived at, for whoever checks it. */
  basis: string;
};

/** `dearest`: per tool, the most one generation of it has cost: what the next one is expected to cost at most. */
export class Ledger {
  private readonly file: string;
  /** Whose generations these are (`XSB_AGENT`). */
  private readonly agent: string | undefined;

  constructor(file: string, agent: string | undefined) {
    this.file = file;
    this.agent = agent;
  }

  private read(): Spend {
    return standing(fs.existsSync(this.file) ? spendRecords(fs.readFileSync(this.file, "utf8")) : []);
  }

  /**
   * Refuse, in words an agent passes on to the user, when nothing more may be generated: also when the next one is
   * likely to go over, judged by the most a generation of the same tool has cost so far.
   */
  check(tool: string): void {
    const { budget, spent, unpriced, dearest } = this.read();
    const ask = "Generate nothing more; tell the user, who sets the budget in the xsb settings.";
    if (budget === undefined) throw new Error(`No budget for generation is set for this project. ${ask}`);
    const next = dearest[tool] ?? 0;
    if (spent + next > budget) throw new Error(`The budget for generation is used up: about ${yuan(spent)} of ${yuan(budget)} spent${next ? `, and one more is likely to cost up to ${yuan(next)}` : ""}. ${ask}`);
    if (unpriced) throw new Error(`${unpriced} generation(s) since the budget was set could not be priced, so what is left of the budget is not known. ${ask}`);
  }

  /** Write down one generation, and say where the budget stands now. */
  record(tool: string, output: string, cost: Cost): string {
    const rec = { op: "spend", at: new Date().toISOString(), agent: this.agent, tool, output, model: cost.model, usage: cost.usage, amount: cost.amount, basis: cost.basis };
    fs.appendFileSync(this.file, JSON.stringify(rec) + "\n");
    const { budget, spent, unpriced } = this.read();
    const amount = cost.amount === null ? "unknown (no price found)" : `about ${yuan(cost.amount)}`;
    return `Cost: ${amount}; ${cost.usage}${cost.model ? ` of ${cost.model}` : ""}; ${cost.basis}. Spent so far: about ${yuan(spent)}${unpriced ? ` and ${unpriced} not priced` : ""}${budget !== undefined ? ` of the budget of ${yuan(budget)}` : ""} (estimates; the provider's bill is what counts).`;
  }
}

export const yuan = (amount: number): string => `${amount.toFixed(2)} yuan`;
