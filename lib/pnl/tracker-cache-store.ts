import { createHash } from "node:crypto";
import {
  combinePlacementMaps,
  placementArrayToMap,
  type PlacementTickerInfo,
} from "../pnl-calculator.ts";
import type { AdminDb } from "../import/runner.ts";

/**
 * The parsed Placement Trackers, cached in Postgres.
 *
 * ── Why the in-process cache was not enough ──────────────────────────────────
 * Downloading and parsing the workbooks costs ~17s cold — they are 12.5 MB and
 * 9.3 MB across 177 sheets. The calculator page caches that in module memory
 * for 10 minutes, which serves a warm server well and a scheduled job not at
 * all: every cron invocation is a cold function, so every one would pay it
 * again for a workbook nobody had edited.
 *
 * Measured on the first real run: 17s of a 60s budget gone before a single
 * account was recomputed. The parsed output is only ~0.23 MB of JSON, so it is
 * stored instead and the whole cost becomes one row read.
 *
 * ── What this is not ─────────────────────────────────────────────────────────
 * Not a source of truth. The workbooks are; this is a materialisation of them,
 * and a stale one is a real risk — a placement issued this morning is invisible
 * until the cache is refreshed. So its age is always reported, never hidden.
 *
 * No `server-only` and no `@/` aliases, matching lib/import/*: the download it
 * feeds on lives behind a server-only module, but the storage half is plain so
 * anything that can reach the database can read the cache.
 */

/** How old a cached parse may be before the UI starts calling it stale. */
export const TRACKER_CACHE_STALE_MS = 24 * 60 * 60 * 1000;

/**
 * The URL is hashed rather than stored.
 *
 * For an "anyone with the link" sheet the URL *is* the credential, and this
 * table is readable by every staff member. A hash keys the row without keeping
 * the secret in it.
 */
export const trackerUrlHash = (url: string): string =>
  createHash("sha256").update(url.trim()).digest("hex");

export type CachedTracker = {
  urlHash: string;
  label: string;
  tickerCount: number;
  items: PlacementTickerInfo[];
  parsedAt: string;
};

export async function readTrackerCache(db: AdminDb): Promise<CachedTracker[]> {
  const { data, error } = await db
    .from("placement_tracker_cache")
    .select("url_hash, label, ticker_count, items, parsed_at");
  if (error) throw error;

  return ((data ?? []) as unknown as {
    url_hash: string;
    label: string;
    ticker_count: number;
    items: PlacementTickerInfo[] | null;
    parsed_at: string;
  }[]).map((r) => ({
    urlHash: r.url_hash,
    label: r.label,
    tickerCount: r.ticker_count,
    items: r.items ?? [],
    parsedAt: r.parsed_at,
  }));
}

export async function writeTrackerCache(
  db: AdminDb,
  entry: { url: string; label: string; items: PlacementTickerInfo[]; parseMs?: number },
): Promise<void> {
  const { error } = await db.from("placement_tracker_cache").upsert(
    {
      url_hash: trackerUrlHash(entry.url),
      label: entry.label,
      ticker_count: entry.items.length,
      items: entry.items,
      parsed_at: new Date().toISOString(),
      parse_ms: entry.parseMs ?? null,
    },
    { onConflict: "url_hash" },
  );
  if (error) throw error;
}

/**
 * The cached trackers merged into the map the P&L engine consumes, or `null`
 * when the cache is empty.
 *
 * `null` is a meaningful answer and the caller MUST respect it: no placement
 * data means placement buy sides stay as the contract notes recorded them and
 * no free-option rows exist. A recompute that stored figures under those
 * conditions would look complete while silently missing every option line.
 */
export async function cachedPlacementMap(
  db: AdminDb,
): Promise<{ map: Map<string, PlacementTickerInfo>; parsedAt: string; labels: string[] } | null> {
  const cached = await readTrackerCache(db);
  const usable = cached.filter((c) => c.items.length > 0);
  if (usable.length === 0) return null;

  return {
    // The desk keeps one workbook per year; this resolves a ticker appearing in
    // more than one of them the same way the calculator page does, rather than
    // summing the years.
    map: combinePlacementMaps(usable.map((c) => ({ map: placementArrayToMap(c.items) }))),
    // The OLDEST parse, because the merged map is only as fresh as its stalest
    // input — reporting the newest would flatter it.
    parsedAt: usable.reduce((a, c) => (c.parsedAt < a ? c.parsedAt : a), usable[0].parsedAt),
    labels: usable.map((c) => c.label),
  };
}
