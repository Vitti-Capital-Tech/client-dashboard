import "server-only";
import type { AdminDb } from "@/lib/import/runner";
import { writeTrackerCache } from "./tracker-cache-store";

/**
 * The server-side half of the Placement Tracker cache: the refresh.
 *
 * Everything else — reading the cache, hashing the URL, merging the workbooks
 * into the engine's map — lives in `./tracker-cache-store.ts`, which carries no
 * `server-only` marker so anything that can reach the database can read it.
 *
 * The split exists because this file reaches into a `"use server"` module for
 * the download-and-parse.
 */

export {
  TRACKER_CACHE_STALE_MS,
  cachedPlacementMap,
  readTrackerCache,
  writeTrackerCache,
  trackerUrlHash,
  type CachedTracker,
} from "./tracker-cache-store";

/**
 * Re-parse every configured tracker link and store the result.
 *
 * The ~17s download-and-parse lives here and nowhere else. Called by the staff
 * Refresh action on a warm request, and deliberately NOT by the scheduled
 * ingest, which would pay it daily for an answer that rarely changes — and, on
 * the first real run, spent a third of its budget doing exactly that.
 */
export async function refreshTrackerCache(
  db: AdminDb,
): Promise<{ refreshed: number; failed: string[]; tickerCount: number }> {
  const { loadConfiguredPlacementTrackersAction } = await import(
    "@/app/actions/pnl-calculator"
  );

  const res = await loadConfiguredPlacementTrackersAction();
  if (!res.configured) {
    return {
      refreshed: 0,
      failed: ["PLACEMENT_TRACKER_URL is not configured."],
      tickerCount: 0,
    };
  }

  const failed: string[] = [];
  let refreshed = 0;
  let tickerCount = 0;

  for (const tracker of res.trackers) {
    if (tracker.placementItems.length === 0) {
      failed.push(`${tracker.name}: ${tracker.error ?? "parsed 0 tickers"}`);
      continue;
    }

    // Keyed by the tracker's NAME rather than its URL: the action deliberately
    // never returns the URL (for a link-shared sheet it is the credential), and
    // the workbook's filename is stable per workbook.
    await writeTrackerCache(db, {
      url: tracker.name,
      label: tracker.name,
      items: tracker.placementItems,
    });
    refreshed++;
    tickerCount += tracker.placementItems.length;
  }

  return { refreshed, failed, tickerCount };
}
