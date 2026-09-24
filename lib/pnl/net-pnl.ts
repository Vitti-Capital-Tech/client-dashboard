/**
 * Net P&L — what a client has made in total, from the figures on their own screen.
 *
 *   realised  every sale ever made, costed by the ledger replay — the Historical
 *             P&L tab on All time
 *   holdings  today's value against cost on what is still held, listed and
 *             unlisted — the Holdings tab's footer
 *
 * ── Why this lives in one module ────────────────────────────────────────────
 * Two screens show it: the Portfolio page, which computes in the browser so its
 * account filter can re-scope it, and Home, which computes on the server so it
 * need not ship the whole ledger for one number. Each composing the pieces its
 * own way is how the same client comes to see two different totals on two
 * screens — the exact failure this card was introduced to end (LLD §8.58). So
 * both call these functions, and the equality is structural rather than hoped
 * for.
 *
 * Pure, and free of any server import, for the same reason `lib/data/compute.ts`
 * is: it has to run on both sides.
 */

import type { Position, TradeRow } from "../data/queries";
import { attributeSells, posCost, posValue, realizedBetween } from "../data/compute.ts";
import type { LedgerLine, SellAttribution } from "../import/trades.ts";
import type { PnlSummaryRow } from "../export/order-history.ts";
import {
  isRowUnlistedOption,
  optionSummaryRows,
  type OptionSummaryRow,
} from "./summary-rows.ts";

/** An unlisted option grant, as a holding. */
export type UnlistedGrantHolding = {
  code: string;
  name: string;
  qty: number;
  /** What the whole parcel is carried at — a modelled value, not a quote. */
  value: number;
  cost: number;
  pnl: number;
};

/**
 * The unlisted grants among a scope's option rows.
 *
 * They come from the stored P&L rows because nothing else has them: a free
 * placement grant has no contract note and no line in the broker's snapshot,
 * and `option_holdings` has never held a row. Leaving them out made the
 * Holdings total disagree with the P&L by exactly what the client was granted.
 */
export function unlistedGrantHoldings(optionRows: OptionSummaryRow[]): UnlistedGrantHolding[] {
  return optionRows
    .filter((o) => isRowUnlistedOption(o.row))
    .map((o) => ({
      code: o.row.ticker,
      name: o.row.name,
      qty: o.qty,
      value: o.row.sellOrCurrent,
      cost: o.row.buyPrice,
      pnl: o.row.pnl,
    }));
}

/**
 * Value, cost and UNREALISED P&L on everything still held.
 *
 * Listed positions at last price, unlisted grants at their carried value. Over
 * the whole scope, never a page of it — a total that changed as you paged would
 * be a different number every look.
 */
export function holdingsTotals(
  positions: Position[],
  unlisted: UnlistedGrantHolding[],
): { value: number; cost: number; pnl: number } {
  const value =
    positions.reduce((s, p) => s + posValue(p), 0) + unlisted.reduce((s, o) => s + o.value, 0);
  const cost =
    positions.reduce((s, p) => s + posCost(p), 0) + unlisted.reduce((s, o) => s + o.cost, 0);
  return { value, cost, pnl: value - cost };
}

/**
 * Realised P&L over ALL TIME: first sale on file to the last.
 *
 * Bounded by the sales themselves rather than by today, so the figure is
 * exactly what the Historical tab reads on All time — same replay, same desk
 * corrections spread over the full history.
 */
export function allTimeRealised(
  sells: SellAttribution[],
  deltaByTicker: Map<string, number> = new Map(),
): number {
  if (sells.length === 0) return 0;
  let from = sells[0].tradeDate;
  let to = sells[0].tradeDate;
  for (const s of sells) {
    if (s.tradeDate < from) from = s.tradeDate;
    if (s.tradeDate > to) to = s.tradeDate;
  }
  return realizedBetween(sells, from, to, deltaByTicker).realizedPl;
}

export type NetPnl = {
  realised: number;
  holdings: number;
  net: number;
};

/**
 * The whole figure, from raw inputs, for a screen that has not already built
 * the pieces (Home). The Portfolio page builds the same pieces for its tabs and
 * adds them itself, through the functions above.
 *
 * Every input must be for the SAME scope — one account, or the client's whole
 * book. Realised over one account added to holdings over all of them is a
 * number that describes nothing.
 */
export function netPnlFigures(input: {
  trades: TradeRow[];
  /** Purchases the ledger never recorded (placements), so their sales are costed. */
  offLedger: LedgerLine[];
  /** From `clientSummary(...).overrideDeltas` — the desk's corrections. */
  overrideDeltas: [string, number][];
  positions: Position[];
  /** From `clientSummary(...).rows`, for the unlisted grants. */
  summaryRows: PnlSummaryRow[];
}): NetPnl {
  const sells = attributeSells(input.trades, input.offLedger);
  const realised = allTimeRealised(sells, new Map(input.overrideDeltas));
  const holdings = holdingsTotals(
    input.positions,
    unlistedGrantHoldings(optionSummaryRows(input.summaryRows)),
  ).pnl;
  return { realised, holdings, net: realised + holdings };
}
