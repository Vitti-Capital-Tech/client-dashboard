import { ArrowUpRight, Newspaper } from "lucide-react";
import { getActiveClientId } from "@/lib/session";
import { getWatchlist } from "@/lib/data/queries";
import { getClientStoredPnl } from "@/lib/data/pnl";
import { getClientPnlOverrides } from "@/lib/data/holdings";
import { clientSummary } from "@/lib/pnl/client-portfolio";
import { getAsxMarketSensitive } from "@/lib/asx/news";
import { WatchButton } from "@/app/components/WatchButton";

export const metadata = {
  title: "Insights — Vitti Capital",
};

/**
 * Insights — the client's own book, explained.
 *
 * ── How this differs from Market ───────────────────────────────────────────
 * Market is the whole exchange: every price-sensitive filing of the day, across
 * 1,800 companies the client mostly does not hold. This page is only the ones
 * they do, and answers the question a client actually arrives with — has
 * anything happened to my companies.
 *
 * It is built from data that already existed and was only ever shown somewhere
 * else: the same ASX feed behind Market, narrowed to the book. Nothing here is
 * invented, and nothing here is advice.
 */
export default async function ClientInsightsPage() {
  const clientId = await getActiveClientId();

  const [storedPnl, overrides, feed, watchlist] = await Promise.all([
    clientId ? getClientStoredPnl(clientId) : Promise.resolve([]),
    clientId ? getClientPnlOverrides(clientId) : Promise.resolve([]),
    getAsxMarketSensitive(),
    clientId ? getWatchlist(clientId) : Promise.resolve([]),
  ]);

  const summary = clientSummary(storedPnl, overrides);

  /**
   * What the client holds NOW, keyed by the ordinary's code.
   *
   * Open positions only. A parcel sold two years ago has a P&L worth reading on
   * the portfolio page, but today's announcement from that company is somebody
   * else's news.
   */
  const open = summary.rows.filter((r) => r.openPosition || (r.heldQty ?? 0) > 0);
  const heldCodes = new Set(open.map((r) => r.ticker));

  const watching = new Set(
    watchlist.map((w) => w.code).filter((c): c is string => Boolean(c)),
  );

  // Today's filings, narrowed to the client's own companies.
  const mine = feed.items.filter((a) => heldCodes.has(a.code));

  return (
    <div className="space-y-5 text-ink font-body">
      <div className="select-none max-w-160">
        <div className="font-mono text-xs tracking-wider uppercase text-mut">
          Your book
        </div>
        <h1 className="font-disp font-medium text-[26px] mt-0.5">Insights</h1>
        <p className="text-xs text-mut mt-1">
          Price-sensitive announcements from the companies you hold. The whole
          market is under Market.
        </p>
      </div>

      {/* ── Your holdings, in today's filings ─────────────────────────── */}
      <section className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
        <div className="px-4.5 py-3.5 border-b border-line flex items-center gap-2 select-none">
          <Newspaper className="w-4 h-4 text-mut" aria-hidden />
          <b className="text-sm font-semibold text-ink">Your holdings in the news</b>
          {mine.length > 0 && (
            <span className="ml-auto text-[11px] font-mono text-mut">
              {mine.length} of {feed.total} price-sensitive filings today
            </span>
          )}
        </div>

        {mine.length === 0 ? (
          <div className="px-4.5 py-10 text-center">
            <b className="text-sm font-semibold text-ink block">
              Nothing from your companies today
            </b>
            <p className="text-xs text-mut mt-1.5 max-w-90 mx-auto leading-relaxed">
              {feed.total > 0
                ? `${feed.total} price-sensitive filings were lodged with the ASX today, none of them by a company you hold. They are all under Market.`
                : "No price-sensitive filings have come through yet today."}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-line">
            {mine.map((a) => (
              <div key={a.id} className="px-4.5 py-3.5">
                <div className="flex items-start gap-2">
                  <div className="flex items-center gap-2 flex-wrap min-w-0 flex-1">
                  <span className="code font-mono text-[11px] px-1 rounded-sm font-bold text-green-d">
                    {a.code}
                  </span>
                  <span
                    className={`pill text-[10px] font-bold rounded-full px-2 py-0.5 ${
                      a.sentiment === "bullish"
                        ? "bg-green-bg text-green-d"
                        : a.sentiment === "bearish"
                        ? "bg-loss-bg text-loss-d"
                        : "bg-paper-2 text-mut"
                    }`}
                  >
                    {a.sentiment}
                  </span>
                  <span className="font-mono text-[10px] text-mut uppercase tracking-wider">
                    {a.company}
                  </span>
                  </div>
                  <div className="flex items-center gap-2 flex-none">
                    <WatchButton
                      code={a.code}
                      name={a.company || a.code}
                      initiallyWatching={watching.has(a.code)}
                    />
                  </div>
                </div>

                <a
                  href={a.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group block mt-1.5"
                >
                  <span className="font-semibold text-[13.5px] leading-snug group-hover:underline">
                    {a.headline}
                  </span>
                  <ArrowUpRight
                    aria-hidden
                    className="inline w-3.5 h-3.5 ml-1 -mt-0.5 text-mut-d transition-transform group-hover:-translate-y-px group-hover:text-green-d"
                  />
                </a>

                {/* The upstream summary, in full rather than clipped: on Market
                    it is one line among 59 filings and a teaser is right; here
                    there are a handful and they are the client's own. */}
                {a.summary.length > 0 && (
                  <ul className="mt-1.5 space-y-1">
                    {a.summary.map((line, i) => (
                      <li
                        key={i}
                        className="text-xs text-mut leading-relaxed pl-3 relative before:content-[''] before:absolute before:left-0 before:top-[0.55em] before:w-1 before:h-1 before:rounded-full before:bg-mut-d"
                      >
                        {line}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
