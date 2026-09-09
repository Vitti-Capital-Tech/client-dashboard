import "server-only";
import { cache } from "react";
import { canonicalSector } from "@/lib/pnl/sector-labels";

/**
 * Every ASX-listed code, and the GICS sector it belongs to.
 *
 * ── Why not read `securities.sector` ───────────────────────────────────────
 * That table is the firm's register — 782 rows, the securities somebody has
 * held or traded. It answers for the client's own holdings and for almost
 * nothing else, and the question here is about the OTHER companies in their
 * sectors, which by definition are the ones they do not hold.
 *
 * The ASX publishes the classification for the whole market as one CSV — the
 * same file `scripts/backfill-sectors.mjs` fills the register from. One request
 * covers all ~1,800 listed companies, so a sector lookup for an arbitrary
 * ticker in the news feed becomes a map lookup.
 *
 * ── Caching ────────────────────────────────────────────────────────────────
 * A day, because that is how often it changes: a listing or a reclassification,
 * not a price. `cache` dedupes within a render; `revalidate` is what keeps it
 * off the network between them.
 *
 * Failure is an empty map, never an exception. This backs one section of one
 * page; the ASX being slow should cost that section, not the route.
 */

const DIRECTORY_URL =
  "https://asx.api.markitdigital.com/asx-research/1.0/companies/directory/file" +
  "?access_token=83ff96335c2d45a094df02a206a39ff4";

export const getAsxSectors = cache(async (): Promise<Map<string, string>> => {
  const out = new Map<string, string>();

  try {
    const res = await fetch(DIRECTORY_URL, {
      headers: { accept: "text/csv" },
      cache: "force-cache",
      next: { revalidate: 86_400, tags: ["asx-directory"] },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error(`[asx-directory] ${res.status} ${res.statusText}`);
      return out;
    }

    // Company names carry commas but never quotes, and every text field is
    // quoted, so the first three fields come off unambiguously.
    for (const line of (await res.text()).split(/\r?\n/).slice(1)) {
      const f = line.match(/^"([^"]*)","([^"]*)","([^"]*)"/);
      if (!f) continue;
      const sector = canonicalSector(f[3]);
      if (sector) out.set(f[1].toUpperCase(), sector);
    }
  } catch (err) {
    console.error("[asx-directory] unreachable:", err);
  }

  return out;
});
