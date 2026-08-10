import "server-only";
import { fetchSpotPricesAction } from "@/app/actions/pnl-calculator";
import type { PlacementTickerInfo } from "@/lib/pnl-calculator";
import type { AdminDb } from "@/lib/import/runner";
import { cachedPlacementMap } from "./tracker-cache-store";
import type { SpotFetcher, SpotPriceMap } from "./recompute";

/**
 * The two inputs the recompute refuses to fetch for itself.
 *
 * `recomputeAccountPnl` takes both as parameters precisely so a batch resolves
 * them ONCE and reuses them across every account. Doing either per account
 * turns a two-minute batch into an overnight one — and, for the quotes, values
 * two clients' identical holdings at two slightly different prices.
 */

export type PlacementSource = {
  map: Map<string, PlacementTickerInfo>;
  /** When the underlying workbooks were last parsed — always surfaced. */
  parsedAt: string;
  labels: string[];
};

/**
 * The Placement Trackers, READ from the database cache rather than parsed.
 *
 * Parsing costs ~17s cold, which a scheduled job should not spend: every cron
 * invocation is a cold function, so an in-process cache never hits and every
 * run would pay it again for a workbook nobody had edited. Measured on the
 * first real run — a third of the request budget gone before a single account
 * was recomputed. `lib/pnl/tracker-cache.ts` owns the refresh; this only reads.
 *
 * `null` is a meaningful answer and the caller MUST respect it: it means
 * placement buy sides stay exactly as the contract notes recorded them and no
 * free-option rows exist. A recompute that quietly used an empty map would look
 * identical while silently dropping every option line.
 */
export async function loadCachedPlacements(db: AdminDb): Promise<PlacementSource | null> {
  const cached = await cachedPlacementMap(db);
  if (!cached) {
    console.error(
      "P&L recompute: the Placement Tracker cache is empty. Run the staff " +
        "'Refresh trackers' action — until then placement buy sides and " +
        "unlisted option rows cannot be computed.",
    );
    return null;
  }
  return cached;
}

/**
 * Live spot prices for the tickers that need one, as the recompute's injected
 * fetcher.
 *
 * Never throws. A recompute that fails outright because one quote was
 * unavailable is worse than one that reports the gap: `buildUnlistedOptionRows`
 * already values an unpriced option at $0 and names it, and the run's
 * `warnings` carry that to the desk.
 */
export const fetchSpots: SpotFetcher = async (tickers) => {
  const map: SpotPriceMap = new Map();
  if (tickers.length === 0) return map;

  try {
    const res = await fetchSpotPricesAction(tickers);
    for (const p of res.prices) {
      map.set(p.ticker, { price: p.price, source: p.source });
    }
  } catch (err) {
    console.error("P&L recompute: spot price lookup failed entirely.", err);
  }

  return map;
};
