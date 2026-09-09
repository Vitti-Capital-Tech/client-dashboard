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

export const getQuotes = cache(
  async (codes: string[]): Promise<Map<string, Quote>> => {
    const wanted = [
      ...new Set(codes.map((c) => String(c || "").trim().toUpperCase()).filter(Boolean)),
    ];
    const out = new Map<string, Quote>();
    if (wanted.length === 0) return out;

    try {
      const { default: YahooFinance } = await import("yahoo-finance2");
      const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

      // One batched request. An unknown symbol is omitted from the response
      // rather than failing it, so a delisted name costs nothing.
      const quotes = await yf.quote(wanted.map((t) => `${t}.AX`));
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
      console.error("[quotes] lookup failed:", err);
    }

    return out;
  },
);
