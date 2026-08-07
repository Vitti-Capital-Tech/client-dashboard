import "server-only";
import {
  combinePlacementMaps,
  placementArrayToMap,
  type PlacementTickerInfo,
} from "@/lib/pnl-calculator";
import {
  fetchSpotPricesAction,
  loadConfiguredPlacementTrackersAction,
} from "@/app/actions/pnl-calculator";
import type { SpotFetcher, SpotPriceMap } from "./recompute";

/**
 * The two expensive inputs the recompute refuses to fetch for itself.
 *
 * `recomputeAccountPnl` takes both as parameters precisely so a batch resolves
 * them ONCE and reuses them across every account: the Placement Tracker
 * workbooks cost ~48s of CPU-bound parsing on a cold cache, and spot prices are
 * a network round trip per ticker. Doing either per account turns a two-minute
 * morning batch into an overnight one.
 *
 * These are thin adapters over the calculator page's existing server actions —
 * the same links, the same cache, the same ASX/Yahoo/database fallback chain.
 * Nothing about how a price is found is re-decided here.
 */

/**
 * Every Placement Tracker configured in `PLACEMENT_TRACKER_URL`, merged into
 * one map, or `null` if none are configured or none could be read.
 *
 * `null` is a meaningful answer and not a failure to paper over: it means the
 * placement buy sides stay exactly as the contract notes recorded them, and no
 * free-option rows are generated. A recompute that quietly used an empty map
 * would look identical while silently dropping every option line.
 */
export async function loadStandingPlacementMap(): Promise<Map<
  string,
  PlacementTickerInfo
> | null> {
  const res = await loadConfiguredPlacementTrackersAction();
  if (!res.configured) return null;

  const loaded = res.trackers.filter((t) => t.placementItems.length > 0);
  if (loaded.length === 0) {
    console.error(
      "P&L recompute: no Placement Tracker could be read — placement buy sides " +
        "and unlisted option rows will be missing from this run.",
      res.trackers.map((t) => t.error).filter(Boolean).join(" "),
    );
    return null;
  }

  // The desk keeps one workbook per year; `combinePlacementMaps` resolves a
  // ticker that appears in more than one of them the same way the calculator
  // page does, rather than summing the years.
  return combinePlacementMaps(
    loaded.map((t) => ({ map: placementArrayToMap(t.placementItems) })),
  );
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
