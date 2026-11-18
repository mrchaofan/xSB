/**
 * The project's ledger of what generation cost: `.xsb/spend.jsonl` of an xsb project, given to this server as
 * `XSB_SPEND` by the hub. Without it (the server run on its own) nothing is counted.
 *
 * Its records and how they add up are in @xsb/protocol (spend.ts): this server writes one record per generation.
 * It counts; it holds nothing back. A cost that is not known is written down as such, not taken for zero.
 */
import fs from "node:fs";
import { spendRecords, standing } from "@xsb/protocol";

export type Cost = {
  /** Yuan, estimated; null when no price was found. */
  amount: number | null;
  model?: string;
  /** What was used, in the provider's units ("48437 tokens", "1 image"). */
  usage: string;
  /** How the amount was arrived at, for whoever checks it. */
  basis: string;
};

export class Ledger {
  private readonly file: string;
  /** Whose generations these are (`XSB_AGENT`). */
  private readonly agent: string | undefined;

  constructor(file: string, agent: string | undefined) {
    this.file = file;
    this.agent = agent;
  }

  /** Write down one generation, and say what has been spent now. */
  record(tool: string, output: string, cost: Cost): string {
    const rec = { op: "spend", at: new Date().toISOString(), agent: this.agent, tool, output, model: cost.model, usage: cost.usage, amount: cost.amount, basis: cost.basis };
    fs.appendFileSync(this.file, JSON.stringify(rec) + "\n");
    const { spent, unpriced } = standing(spendRecords(fs.readFileSync(this.file, "utf8")));
    const amount = cost.amount === null ? "unknown (no price found)" : `about ${yuan(cost.amount)}`;
    return `Cost: ${amount}; ${cost.usage}${cost.model ? ` of ${cost.model}` : ""}; ${cost.basis}. Spent so far: about ${yuan(spent)}${unpriced ? ` and ${unpriced} not priced` : ""} (estimates; the provider's bill is what counts).`;
  }
}

const yuan = (amount: number): string => `${amount.toFixed(2)} yuan`;
