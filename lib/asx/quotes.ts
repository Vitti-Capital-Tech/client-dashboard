import "server-only";
import { cache } from "react";

/**
 * Live quotes for ASX codes — last price and the day's move.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * The watchlist read its price from `securities.last_price`, which is written
 * by the holdings import and therefore only exists for securities somebody
 * already holds: 159 of the 782 rows have one, and a watchlist is by definition
 * a list of things you do NOT hold yet. The one row in the database points at
 * TGM, which has no `securities` row at all — so there was nothing to read, and
 * the column showed a dash.
 *
 * The register is also the wrong source for a watchlist even when it answers.
 * `last_price` is as old as the last import; a watchlist is a thing people open
 * to see where a price is now.
 *
 * ── Why not reuse `fetchSpotPricesAction` ──────────────────────────────────
 * That is a Server Action for the P&L calculator, it falls back through the ASX
 * and then the register, and it returns a price only. This needs the day's
 * change as well, and it is a page read rather than a form submission.
 *
 * Failure is empty rather than fatal. A watchlist with no prices is a worse
 * page; a watchlist that 500s because Yahoo is rate-limited is not a page at
 * all.
 */

export type Quote = {
  code: string;
  last: number | null;
  /** The day's move as a percentage, or null when the feed does not say. */
  changePct: number | null;
};

/**
 * How many symbols go in one request.
 *
 * ── Why this constant exists ────────────────────────────────────────────────
 * The first version sent every code in a single call, with a comment calling it
 * "one batched request". That is fine for the watchlist, which asks about a
 * handful — and it silently failed for the alert tick, which asks about every
 * security every client holds. Yahoo refuses a list that long, the `catch`
 * below swallowed the refusal, and the caller received an empty map: for three
 * days the live tick reported `quoted: 0` on a book of hundreds of positions
 * and looked exactly like a market in which nothing had happened.
 *
 * Forty is comfortably inside what the endpoint accepts and keeps the request
 * count low — a 300-code book is eight calls.
 */
const BATCH = 40;

export const getQuotes = cache(
  async (codes: string[]): Promise<Map<string, Quote>> => {
    const wanted = [
      ...new Set(codes.map((c) => String(c || "").trim().toUpperCase()).filter(Boolean)),
    ];
    const out = new Map<string, Quote>();
    if (wanted.length === 0) return out;

    const { default: YahooFinance } = await import("yahoo-finance2");
    const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

    /**
     * Sequential, and each batch isolated.
     *
     * Sequential because Yahoo is an unofficial endpoint and eight requests at
     * once is the shape of traffic that gets rate-limited; eight in a row costs
     * a couple of seconds inside a 60s budget.
     *
     * Isolated because one bad batch must not discard the good ones. The old
     * single try/catch meant a single unparseable symbol — or one slow
     * response — cost the caller every price it had already fetched.
     */
    for (let i = 0; i < wanted.length; i += BATCH) {
      const batch = wanted.slice(i, i + BATCH);
      try {
        // An unknown symbol is omitted from the response rather than failing
        // it, so a delisted name costs nothing.
        const quotes = await yf.quote(batch.map((t) => `${t}.AX`));
        const list = Array.isArray(quotes) ? quotes : quotes ? [quotes] : [];

        for (const q of list) {
          const code = String(q?.symbol || "")
            .toUpperCase()
            .replace(/\.AX$/, "");
          if (!code) continue;

          const price = Number(q?.regularMarketPrice);
          const change = Number(q?.regularMarketChangePercent);
          out.set(code, {
            code,
            last: Number.isFinite(price) && price > 0 ? price : null,
            changePct: Number.isFinite(change) ? change : null,
          });
        }
      } catch (err) {
        // Named, so the log says WHICH codes went missing rather than only
        // that something did.
        console.error(`[quotes] batch ${i / BATCH + 1} failed (${batch.join(",")}):`, err);
      }
    }

    return out;
  },
);
