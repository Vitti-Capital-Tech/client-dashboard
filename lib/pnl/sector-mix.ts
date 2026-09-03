import type { ClientPortfolioRow } from "./client-portfolio.ts";

/**
 * Sector breakdown of a client's holdings — the ones they hold now, and the
 * ones they used to.
 *
 * ── Why "past holdings" needs a different measure ───────────────────────────
 * The existing sector chart sized its slices by MARKET VALUE, which is the
 * right measure for "what am I exposed to today" and is undefined for a parcel
 * that was sold years ago: it is worth nothing now, and a zero slice is not the
 * same statement as "a third of everything you ever put in went here".
 *
 * So the two scopes are measured differently and each says which it is:
 *
 *   • `held`    → market value of what is held right now.
 *   • `alltime` → COST BASE, i.e. what was actually invested in that sector,
 *                 whether or not the parcel is still open.
 *
 * Mixing them — market value for open rows plus proceeds for closed ones —
 * would produce a single number that is a valuation for some slices and a cash
 * receipt for others, and no caption can make that mean anything.
 *
 * ── P&L rides along with every slice ────────────────────────────────────────
 * The point of the chart is not just how the money is split but how each split
 * did, so each bucket carries its own P&L. That figure comes from the stored
 * rows the rest of the portal reads, so a sector's result and the sum of its
 * lines in the P&L table are the same arithmetic.
 */

/** One sector's share, and how it did. */
export type SectorBucket = {
  /** The sector name, or `Other` where nothing classifies the holding. */
  label: string;
  /** Slice size: market value (`held`) or cost base (`alltime`). */
  value: number;
  pnl: number;
  /** Cost base, always — the denominator for a return. */
  cost: number;
  /** How many holdings are in this slice. */
  holdings: number;
  /** Tickers in this slice, alphabetical — for the hover detail. */
  tickers: string[];
  /** Return on cost, or null where there is no cost to divide by. */
  returnPct: number | null;
};

export type SectorScope = "held" | "alltime";

export type SectorMix = {
  scope: SectorScope;
  buckets: SectorBucket[];
  total: number;
  totalPnl: number;
  /**
   * Nothing in view carries a sector classification.
   *
   * `securities.sector` was NULL on all 775 rows until `npm run
   * backfill:sectors` was written to fill it from Yahoo, and any name Yahoo
   * cannot classify stays NULL by design. Where NOTHING is classified the chart
   * is one slice reading "Other 100%", which looks broken rather than empty —
   * so the caller is told which it is instead of drawing that.
   */
  unclassified: boolean;
};

/**
 * Bucket a client's P&L rows by sector.
 *
 * `sectorOf` is passed in rather than looked up, because resolving a ticker to
 * a sector needs `securities` — which is server-only — and this has to run in
 * the browser as the scope toggles. The caller resolves the derivative-to-
 * ordinary rollup on its way in, so an option grant counts as exposure to the
 * underlying's sector, which is the question a sector chart is asking.
 *
 * `marketValueOf` supplies today's value for a still-held row, for the `held`
 * scope only. It returns null where the row has no current valuation, and such
 * rows are left out of that scope rather than counted at zero.
 */
export function sectorMix(
  rows: ClientPortfolioRow[],
  scope: SectorScope,
  sectorOf: (ticker: string) => string | null,
  marketValueOf: (ticker: string) => number | null,
): SectorMix {
  const byLabel = new Map<string, SectorBucket>();

  for (const r of rows) {
    // An option grant is exposure to its underlying and belongs in the mix, but
    // a row for a parcel that was never bought and never sold is not a holding
    // at all — it is a stored line with nothing in it.
    if (scope === "held" && !r.openPosition && r.heldQty <= 0) continue;

    const value =
      scope === "held" ? marketValueOf(r.ticker) ?? r.sellOrCurrent : r.buyPrice;

    // Zero-size slices are invisible in the pie and a 0% line in the legend.
    // Negative cost is not a thing; a zero cost base is (free placement
    // options), and those are kept because their P&L is real.
    if (value <= 0 && r.pnl === 0) continue;

    const label = sectorOf(r.ticker) ?? "Other";
    let bucket = byLabel.get(label);
    if (!bucket) {
      bucket = {
        label,
        value: 0,
        pnl: 0,
        cost: 0,
        holdings: 0,
        tickers: [],
        returnPct: null,
      };
      byLabel.set(label, bucket);
    }

    bucket.value += Math.max(0, value);
    bucket.pnl += r.pnl;
    bucket.cost += r.buyPrice;
    bucket.holdings += 1;
    // Options are folded into the underlying's sector, which is why one label's
    // ticker list can hold both 'EOS' and 'EOSXX'.
    if (!bucket.tickers.includes(r.ticker)) bucket.tickers.push(r.ticker);
  }

  const buckets = [...byLabel.values()]
    .map((b) => ({
      ...b,
      // Free grants have a cost base of zero, so `pnl / cost` is Infinity and
      // `0 / 0` is NaN. Both used to reach the screen elsewhere in this app as
      // '+Infinity%' and '+NaN%'.
      returnPct:
        b.cost > 0 && Number.isFinite(b.pnl / b.cost) ? (b.pnl / b.cost) * 100 : null,
      tickers: b.tickers.slice().sort(),
    }))
    .sort((a, b) => b.value - a.value);

  return {
    scope,
    buckets,
    total: buckets.reduce((n, b) => n + b.value, 0),
    totalPnl: buckets.reduce((n, b) => n + b.pnl, 0),
    unclassified: buckets.length > 0 && buckets.every((b) => b.label === "Other"),
  };
}
