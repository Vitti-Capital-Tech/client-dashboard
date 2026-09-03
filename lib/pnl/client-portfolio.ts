import { storedToSummaryRows } from "../export/stored-pnl.ts";
import { grandTotal } from "../export/order-history.ts";
import type { PnlOverrideRow } from "../data/holdings.ts";
import type { StoredPnlRow } from "../data/pnl.ts";

/**
 * The client's own portfolio, as the desk sees it.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The client portal used to compute its own P&L from the current holdings
 * snapshot — `posCost` / `posValue` against a last price — while the staff
 * console showed the STORED figures from `lib/pnl/recompute.ts`. Two methods,
 * two answers, and the client's was the thinner one: mark-to-market on what is
 * held right now knows nothing about parcels already sold, so realised profit
 * simply did not appear on their own screen.
 *
 * A client and their adviser reading different numbers for the same holding is
 * not a display bug, it is a conversation nobody can win. So this returns the
 * stored rows, through the same rollup the staff page uses, with the same
 * overrides applied.
 *
 * ── What is deliberately NOT carried across ─────────────────────────────────
 * `PnlSummaryRow` also holds the desk's working notes — `flagged` (this row
 * needs a human), `edited` / `overridden` (a figure was corrected by hand),
 * `note` — and those are how the firm works, not facts about the client's
 * money. A client seeing "corrected by hand" against their own position learns
 * nothing they can act on and quite a lot about internal process.
 *
 * The one operational field whose EFFECT must survive is `excludedFromTotal`:
 * it is set when a row's cost is genuinely unknown, and summing such a row
 * would report the whole sale proceeds as profit. So the total is taken with
 * `grandTotal` BEFORE the flags are stripped — the client sees the same total
 * as the desk, and simply is not told which row was left out of it.
 *
 * ── Scoping is the caller's job ─────────────────────────────────────────────
 * Pure, and it formats exactly the rows it is handed. Restriction to one
 * client's rows comes from the client-scoped getters plus the `pnl_summary` and
 * `pnl_overrides` RLS policies (`is_staff() OR client_id = current_client_id()`).
 */

/** One holding, as a client sees it: the figures, and nothing about the desk. */
export type ClientPortfolioRow = {
  ticker: string;
  name: string;
  /** Units bought, per the ledger. */
  buyQty: number;
  /** Units sold. Never the parcel still held — that is `heldQty`. */
  sellQty: number;
  /** Units still held, per the latest holdings snapshot. */
  heldQty: number;
  /** Cost of the parcel. */
  buyPrice: number;
  /** Proceeds where sold, current value where held. */
  sellOrCurrent: number;
  pnl: number;
  openPosition: boolean;
  /** `Equity`, `Option`, `Unlisted Option` — the rollup's own wording. */
  type: string;
};

export type ClientPortfolio = {
  rows: ClientPortfolioRow[];
  /** Identical to the desk's Grand Total for the same client. */
  total: { buyPrice: number; sellOrCurrent: number; pnl: number };
  /**
   * Rows whose cost could not be established, so they sit outside the total.
   *
   * A count, not the rows: the client is owed the fact that the total does not
   * cover everything — a figure that quietly omits a holding is worse than one
   * that says so — without being handed the desk's unresolved work.
   */
  outsideTotal: number;
};

export function clientPortfolio(
  stored: StoredPnlRow[],
  overrides: PnlOverrideRow[] = [],
): ClientPortfolio {
  // Keyed by `parent` exactly as the staff page keys it, so a correction lands
  // on the same row for both of them.
  const overrideMap = new Map(overrides.map((o) => [o.parent, { ...o, parent: o.parent }]));

  const summary = storedToSummaryRows(stored, overrideMap);

  // Taken while the rows still carry `excludedFromTotal`.
  const total = grandTotal(summary);
  const outsideTotal = summary.filter((r) => r.excludedFromTotal).length;

  const rows: ClientPortfolioRow[] = summary.map((r) => ({
    ticker: r.ticker,
    name: r.name,
    buyQty: r.buyQty,
    sellQty: r.sellQty,
    heldQty: r.heldQty ?? 0,
    buyPrice: r.buyPrice,
    sellOrCurrent: r.sellOrCurrent,
    pnl: r.pnl,
    openPosition: r.openPosition,
    type: r.type,
  }));

  return { rows, total, outsideTotal };
}

/** Is this row an option of either kind? The rollup says so in `type`. */
export function isOptionRow(r: ClientPortfolioRow): boolean {
  return r.type.toLowerCase().includes("option");
}
