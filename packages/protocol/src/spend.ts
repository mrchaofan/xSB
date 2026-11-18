/**
 * The spending ledger of a project: `.xsb/spend.jsonl`, shared by the hub (which writes the user's budget) and the
 * generation tools (which write what each generation cost). One reading of it, here, for both.
 *
 *   { op: "budget", at, amount }                 the user's cap on generation costs, in yuan; the latest counts
 *   { op: "spend", at, agent?, tool, output, model?, usage, amount, basis }
 *                                                one generation; `amount` an estimate in yuan, null when unpriced
 *
 * Client side, over ACP:
 *   advertise  capabilities._meta["dev.xsb/spend"] = { version: 1 }
 *   request    _dev.xsb/spend/get    {}           -> { spend: Spend }
 *              _dev.xsb/spend/budget { amount }   -> { spend: Spend }   the user sets the budget (never an agent)
 *   notify     _dev.xsb/spend/update { spend: Spend }                   whenever the ledger changes
 */
import { NS } from "./ext.ts";

export type SpendRecord =
  | { op: "budget"; at: string; amount: number }
  | { op: "spend"; at: string; agent?: string; tool: string; output: string; model?: string; usage: string; amount: number | null; basis: string };

/**
 * Where the budget stands. `unpriced`: generations since the budget was last set whose cost is not known; setting
 * the budget again is the user's word on them. `dearest`: per tool, the most one generation of it has cost.
 */
export type Spend = { budget?: number; spent: number; unpriced: number; dearest: Record<string, number> };

export function standing(records: Iterable<unknown>): Spend {
  const spend: Spend = { spent: 0, unpriced: 0, dearest: {} };
  for (const rec of records as Iterable<SpendRecord>) {
    if (rec?.op === "budget" && typeof rec.amount === "number") {
      spend.budget = rec.amount;
      spend.unpriced = 0;
    } else if (rec?.op === "spend") {
      if (typeof rec.amount === "number") {
        spend.spent += rec.amount;
        spend.dearest[rec.tool] = Math.max(spend.dearest[rec.tool] ?? 0, rec.amount);
      } else spend.unpriced++;
    }
  }
  return spend;
}

/** The records of a ledger file's text; a torn last line is left out. */
export function spendRecords(text: string): unknown[] {
  return text.split("\n").flatMap((line) => {
    try {
      return line ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });
}

export const SpendExt = {
  capability: `${NS}/spend`,
  get: `_${NS}/spend/get`,
  budget: `_${NS}/spend/budget`,
  update: `_${NS}/spend/update`,
} as const;
