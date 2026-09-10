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

/**
 * What the price was doing going into the filing, measured upstream from bars
 * that closed before it. Taken as given rather than recomputed here: fetching
 * prices on this side would produce slightly different numbers from the ones
 * the ASX dashboard shows for the same announcement, and two surfaces
 * disagreeing about a figure is worse than one surface not having it.
 */
export type AsxPriceContext = {
  /** Date of the last bar used. These are pre-announcement figures. */
  asOf: string;
  /** Observations only, authored upstream so phrasing cannot drift. */
  notes: string[];
  /**
   * Why the observations may be worth little, or null. Not one of the notes:
   * it qualifies them, and rendering it as a chip put a two-line sentence in a
   * pill and pushed the real signals out.
   */
  caveat: string | null;
  /** False when turnover is too small for the ratios to mean anything. */
  liquid: boolean;
  turnoverAud: number | null;
  volumeTrendRatio: number | null;
  brokeOut: boolean;
  atHigh: boolean;
  atLow: boolean;
};

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
  /** Null when the upstream had no price history for it. */
  context: AsxPriceContext | null;
};

/** What the page needs: the list, plus figures describing the whole day. */
export type AsxFeed = {
  items: AsxAnnouncement[];
  /**
   * Price-sensitive filings that day, before any page limit. Distinct from
   * `items.length` — a summary built on the array length reports its own page
   * size as the size of the day, which is exactly the bug this replaced: it
   * said "12 filings" on a day with 59.
   */
  total: number;
  /** Split across the whole day, so it sums to `total`. */
  bySentiment: { bullish: number; bearish: number; neutral: number };
  /** The day's heaviest tags, most filings first. */
  topTags: string[];
  /**
   * When the upstream collector last wrote this day, ISO, or null if unknown.
   * Deliberately the collector's clock and not ours: a client asking "how
   * fresh is this" means the ASX data, not when this page rendered.
   */
  sourceGeneratedAt: string | null;
};

const EMPTY: AsxFeed = {
  items: [],
  total: 0,
  bySentiment: { bullish: 0, bearish: 0, neutral: 0 },
  topTags: [],
  sourceGeneratedAt: null,
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
  market_context?: unknown;
};

const SENTIMENTS: readonly AsxSentiment[] = ["bullish", "bearish", "neutral"];

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Narrow the upstream context, or null. Absent is a supported state. */
function toContext(v: unknown): AsxPriceContext | null {
  if (!v || typeof v !== "object") return null;
  const c = v as Record<string, unknown>;
  const notes = strArray(c.notes);
  if (!notes.length) return null; // nothing worth showing
  return {
    asOf: str(c.as_of),
    notes,
    liquid: c.liquid === true,
    caveat: typeof c.caveat === "string" && c.caveat ? c.caveat : null,
    turnoverAud: num(c.avg_turnover_aud),
    volumeTrendRatio: num(c.volume_trend_ratio),
    brokeOut: c.broke_out === true,
    atHigh: c.at_3m_high === true || c.at_52w_high === true,
    atLow: c.at_3m_low === true || c.at_52w_low === true,
  };
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
    context: toContext(raw.market_context),
  };
}

/**
 * The most recent trading day's market-sensitive announcements, newest first,
 * with day-level figures alongside them.
 *
 * Returns `[]` rather than throwing when the source is unreachable or slow.
 * This renders inside Market alongside sector momentum and the research
 * library; a sibling deployment being down should cost the page one section,
 * not the whole route.
 *
 * `cache` dedupes within a render; the fetch's own `revalidate` is what keeps
 * this off the network across requests.
 *
 * Sixty seconds, not five minutes. The upstream fetcher only runs every ~5
 * minutes, so most of these revalidations find nothing new — but the endpoint
 * serves an ETag, so an unchanged feed answers with a bodyless 304 and the
 * extra checks cost a conditional request rather than a payload. Since a new
 * filing already waits on that cron and a Vercel rebuild, this is the one part
 * of the delay worth not adding to.
 */
export const getAsxMarketSensitive = cache(
  async (limit = 250): Promise<AsxFeed> => {
    const base = process.env.ASX_API_URL?.trim().replace(/\/+$/, "");
    if (!base) return EMPTY;

    const key = process.env.ASX_API_KEY?.trim();

    let res: Response;
    try {
      res = await fetch(`${base}/api/market-sensitive?days=1&limit=${limit}`, {
        headers: key ? { "x-api-key": key } : undefined,
        // Next 16 does not cache fetch by default — `force-cache` is what opts
        // in, and `revalidate` alone would silently fetch on every request.
        cache: "force-cache",
        next: { revalidate: 60, tags: ["asx-news"] },
        signal: AbortSignal.timeout(8000),
      });
    } catch (err) {
      console.error("[asx-news] unreachable:", err);
      return EMPTY;
    }

    if (!res.ok) {
      console.error(`[asx-news] ${res.status} ${res.statusText}`);
      return EMPTY;
    }

    try {
      const body = (await res.json()) as {
        items?: unknown;
        total?: unknown;
        by_sentiment?: Partial<Record<"bullish" | "bearish" | "neutral", unknown>>;
        top_tags?: unknown;
        source_generated_at?: unknown;
      };
      if (!Array.isArray(body.items)) return EMPTY;

      const items = body.items
        .map((i) => toAnnouncement(i as ApiItem))
        .filter((a): a is AsxAnnouncement => a !== null);

      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      const split = {
        bullish: n(body.by_sentiment?.bullish),
        bearish: n(body.by_sentiment?.bearish),
        neutral: n(body.by_sentiment?.neutral),
      };

      return {
        items,
        // Never claim fewer than were actually rendered, in case an older
        // upstream has no `total` to report.
        total: Math.max(n(body.total), items.length),
        bySentiment: split,
        topTags: Array.isArray(body.top_tags)
          ? body.top_tags
              .map((t) => (t as { tag?: unknown })?.tag)
              .filter((t): t is string => typeof t === "string")
          : [],
        sourceGeneratedAt:
          typeof body.source_generated_at === "string" ? body.source_generated_at : null,
      };
    } catch (err) {
      console.error("[asx-news] unparseable response:", err);
      return EMPTY;
    }
  },
);
