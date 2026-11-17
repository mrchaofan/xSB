/**
 * What a generation through Ark cost, from Ark's own price list for the signed-in account:
 *
 *   arkcli pricing models --modality ComputerVision --page-all
 *     -> { items: [{ FoundationModelName, ChargeItems: [{ Type, Price, OriginalPrice, UnitCode }] }] }
 *
 * `Price` is the account's price after its discounts (arkcli's pricing skill: "Price = 含当前账号折扣的最终单价").
 * Video is priced per thousand tokens (UnitCode "千tokens"), images per image ("张"). Which charge item applies to a
 * video depends on things arkcli does not report back (whether video went in, say: V2V and NV2V), so the highest
 * price of the model's items for the clip's resolution is taken: an estimate errs on the side of more. A model
 * whose name is not in the list (an endpoint id) is priced at the highest price of its kind, for the same reason.
 * The list is read at most twice a day, kept in `cache`.
 */
import fs from "node:fs";
import path from "node:path";
import { arkcli } from "./arkcli.ts";
import type { Cost } from "./ledger.ts";
import type { Usage } from "./provider.ts";

type Item = { Type: string; Price: number; UnitCode: string };
type Catalog = { name: string; items: Item[] }[];

const FRESH_MS = 12 * 60 * 60 * 1000;

async function catalog(cache: string | undefined): Promise<Catalog | undefined> {
  if (cache && fs.existsSync(cache) && Date.now() - fs.statSync(cache).mtimeMs < FRESH_MS) {
    try {
      return JSON.parse(fs.readFileSync(cache, "utf8"));
    } catch {
      /* read it again */
    }
  }
  const answer = await arkcli(["pricing", "models", "--modality", "ComputerVision", "--page-all"]).catch(() => undefined);
  const list: Catalog | undefined = answer?.items?.map((m: any) => ({ name: String(m.FoundationModelName ?? ""), items: (m.ChargeItems ?? []).filter((c: any) => typeof c.Price === "number") }));
  if (list && cache) {
    fs.mkdirSync(path.dirname(cache), { recursive: true });
    fs.writeFileSync(cache, JSON.stringify(list));
  }
  return list;
}

/** A model as Ark names it in results ("doubao-seedance-2-5-flash-261115") and in the price list ("doubao-seedance-2-5-flash"). */
const family = (model: string): string => model.replace(/-\d{6}$/, "");

const VIDEO = /^(?:N?V2V|T2V|I2V)(1080|4K)?Completion$/;
const IMAGE = /^(?:T2I|I2I)Completion$/;
const tier = (resolution: string | undefined): string => (/1080/.test(resolution ?? "") ? "1080" : /4k|2160/i.test(resolution ?? "") ? "4K" : "");

/** The price that applies, and what it was taken from. */
function pick(list: Catalog, usage: Usage): { price: number; from: string } | undefined {
  const video = usage.unit === "tokens";
  const fits = (item: Item): boolean =>
    video ? VIDEO.test(item.Type) && item.UnitCode === "千tokens" && (VIDEO.exec(item.Type)![1] ?? "") === tier(usage.resolution) : IMAGE.test(item.Type) && item.UnitCode === "张";
  const own = usage.model ? list.find((m) => m.name === family(usage.model!)) : undefined;
  const kind = video ? "doubao-seedance" : "doubao-seedream";
  const models = own ? [own] : list.filter((m) => m.name.startsWith(kind));
  const prices = models.flatMap((m) => m.items.filter(fits).map((item) => item.Price));
  if (!prices.length) return undefined;
  const price = Math.max(...prices);
  return { price, from: own ? `the highest of ${own.name}'s applicable prices` : `the highest price of any ${kind} model (the model is not in the price list)` };
}

export async function arkCost(usage: Usage, cache: string | undefined): Promise<Cost> {
  const amountOf = usage.unit === "tokens" ? `${usage.units} tokens` : `${usage.units} image${usage.units === 1 ? "" : "s"}`;
  const list = await catalog(cache);
  const found = list && pick(list, usage);
  if (!found) return { amount: null, model: usage.model, usage: amountOf, basis: list ? "no price for it in Ark's price list" : "Ark's price list could not be read" };
  const amount = usage.unit === "tokens" ? (usage.units / 1000) * found.price : usage.units * found.price;
  const unit = usage.unit === "tokens" ? "yuan per thousand tokens" : "yuan per image";
  return { amount, model: usage.model, usage: amountOf, basis: `${found.price} ${unit}, ${found.from}` };
}
