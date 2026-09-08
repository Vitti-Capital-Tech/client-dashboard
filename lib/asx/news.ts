import "server-only";
import { cache } from "react";

/**
 * Market-sensitive ASX announcements, read from the ASX Intelligence dashboard.
 *
 * Not in `lib/data/queries.ts` because that module's contract is Supabase —
 * this is an HTTP read from a sibling deployment, with a different failure mode
 * and a different caching story, so it lives on its own rather than pretending
 * to be a table.
 *
 * The upstream endpoint is documented in that project's README. The shape is
 * stable and flat by design: `id` is the ASX document id and never changes, so
 * this could later be upserted into Supabase for SQL joins against holdings.
 * It is fetched live for now — the source already keeps every day's history and
 * serves it, so storing a second copy would buy nothing until something here
 * needs to query it in SQL.
 */

export type AsxSentiment = "bullish" | "bearish" | "neutral";

export type AsxAnnouncement = {
  /** ASX document id. Stable, so safe as a React key or an upsert key. */
  id: string;
  /** Trading date, YYYY-MM-DD in Sydney terms. */
  date: string;
  code: string;
  company: string;
  headline: string;
  /** Link to the announcement PDF on the ASX platform. */
  url: string;
  released: string;
  sentiment: AsxSentiment;
  documentType: string;
  tags: string[];
  /** The upstream AI summary — three bullets. */
  summary: string[];
};

type ApiItem = {
  id?: unknown;
  date?: unknown;
  ticker?: unknown;
  company?: unknown;
  headline?: unknown;
  url?: unknown;
  released_at?: unknown;
  sentiment?: unknown;
  document_type?: unknown;
  tags?: unknown;
  summary?: unknown;
};

const SENTIMENTS: readonly AsxSentiment[] = ["bullish", "bearish", "neutral"];

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Narrow one API item, dropping anything without the two fields the UI cannot
 * render without. The payload crosses a deployment boundary, so it is treated as
 * unvalidated input rather than trusted because it comes from us.
 */
function toAnnouncement(raw: ApiItem): AsxAnnouncement | null {
  const headline = str(raw.headline);
  const url = str(raw.url);
  if (!headline || !url) return null;

  // Only ever link out over https. An upstream bug that emitted a
  // `javascript:` or `data:` url would otherwise become an XSS vector the
  // moment this renders as an href.
  let safeUrl: string;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    safeUrl = parsed.toString();
  } catch {
    return null;
  }

  const sentiment = str(raw.sentiment) as AsxSentiment;

  return {
    id: str(raw.id) || safeUrl,
    date: str(raw.date),
    code: str(raw.ticker).toUpperCase(),
    company: str(raw.company),
    headline,
    url: safeUrl,
    released: str(raw.released_at),
    sentiment: SENTIMENTS.includes(sentiment) ? sentiment : "neutral",
    documentType: str(raw.document_type),
    tags: strArray(raw.tags),
    summary: strArray(raw.summary),
  };
}

/**
 * The most recent trading day's market-sensitive announcements, newest first.
 *
 * Returns `[]` rather than throwing when the source is unreachable or slow.
 * This renders inside Insights alongside sector momentum and the research
 * library; a sibling deployment being down should cost the page one section,
 * not the whole route.
 *
 * `cache` dedupes within a render; the fetch's own `revalidate` is what keeps
 * this off the network across requests. Five minutes matches the upstream
 * fetcher, which runs every ~5 minutes through the Sydney morning — polling
 * faster than the source updates only spends requests.
 */
export const getAsxMarketSensitive = cache(
  async (limit = 12): Promise<AsxAnnouncement[]> => {
    const base = process.env.ASX_API_URL?.trim().replace(/\/+$/, "");
    if (!base) return [];

    const key = process.env.ASX_API_KEY?.trim();

    let res: Response;
    try {
      res = await fetch(`${base}/api/market-sensitive?days=1&limit=${limit}`, {
        headers: key ? { "x-api-key": key } : undefined,
        // Next 16 does not cache fetch by default — `force-cache` is what opts
        // in, and `revalidate` alone would silently fetch on every request.
        cache: "force-cache",
        next: { revalidate: 300, tags: ["asx-news"] },
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      console.error("[asx-news] unreachable:", err);
      return [];
    }

    if (!res.ok) {
      console.error(`[asx-news] ${res.status} ${res.statusText}`);
      return [];
    }

    try {
      const body: unknown = await res.json();
      const items = (body as { items?: unknown })?.items;
      if (!Array.isArray(items)) return [];
      return items
        .map((i) => toAnnouncement(i as ApiItem))
        .filter((a): a is AsxAnnouncement => a !== null);
    } catch (err) {
      console.error("[asx-news] unparseable response:", err);
      return [];
    }
  },
);
