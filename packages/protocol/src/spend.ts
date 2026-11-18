/**
 * The spending ledger of a project: `.xsb/spend.jsonl`, written by the generation tools (what each generation cost)
 * and read by the hub. One reading of it, here, for both. It counts; it limits nothing.
 *
 *   { op: "spend", at, agent?, tool, output, model?, usage, amount, basis }
 *                                                one generation; `amount` an estimate in yuan, null when unpriced
 *
 * Records of other kinds (a project's ledger may still have `budget` records from earlier versions) are skipped.
 *
 * Client side, over ACP:
 *   advertise  capabilities._meta["dev.xsb/spend"] = { version: 1 }
 *   request    _dev.xsb/spend/get    {}           -> { spend: Spend }
 *   notify     _dev.xsb/spend/update { spend: Spend }                   whenever the ledger changes
 */
import { NS } from "./ext.ts";

export type SpendRecord = { op: "spend"; at: string; agent?: string; tool: string; output: string; model?: string; usage: string; amount: number | null; basis: string };

/** What generation has cost. `unpriced`: generations whose cost is not known. `dearest`: per tool, the most one generation of it has cost. */
export type Spend = { spent: number; unpriced: number; dearest: Record<string, number> };

export function standing(records: Iterable<unknown>): Spend {
  const spend: Spend = { spent: 0, unpriced: 0, dearest: {} };
  for (const rec of records as Iterable<SpendRecord>) {
    if (rec?.op !== "spend") continue;
    if (typeof rec.amount === "number") {
      spend.spent += rec.amount;
      spend.dearest[rec.tool] = Math.max(spend.dearest[rec.tool] ?? 0, rec.amount);
    } else spend.unpriced++;
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
  update: `_${NS}/spend/update`,
} as const;
