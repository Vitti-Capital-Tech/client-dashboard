import { ArrowUpRight, Layers, Newspaper } from "lucide-react";
import { getActiveClientId } from "@/lib/session";
import { getSecurityMap, getWatchlist } from "@/lib/data/queries";
import { getAsxSectors } from "@/lib/asx/directory";
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

  const [storedPnl, overrides, feed, watchlist, asxSectors, securityMap] =
    await Promise.all([
      clientId ? getClientStoredPnl(clientId) : Promise.resolve([]),
      clientId ? getClientPnlOverrides(clientId) : Promise.resolve([]),
      getAsxMarketSensitive(),
      clientId ? getWatchlist(clientId) : Promise.resolve([]),
      // The whole market's sector classification, cached for a day.
      getAsxSectors(),
      getSecurityMap(),
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

  /**
   * The sectors this client is actually exposed to.
   *
   * Read from the register first, which knows the derivative rollup — a grant
   * over EOS is exposure to EOS's sector — and from the ASX directory second,
   * for anything the register has not classified.
   */
  const mySectors = new Set(
    [...heldCodes]
      .map(
        (code) =>
          securityMap.get(code)?.sector ??
          asxSectors.get(code) ??
          null,
      )
      .filter((s): s is string => Boolean(s)),
  );

  /**
   * What is moving in those sectors, from companies the client does NOT hold.
   *
   * The point of the section: on a day when none of their own companies filed
   * anything — which is most days for a book of seven — "nothing happened" is
   * true of the holdings and false of the market they sit in. Their own filings
   * are excluded because they are already listed above, in full.
   *
   * Grouped so the reader sees a sector rather than a list, and capped at two
   * per sector: this is context, not a second Market page.
   */
  const bySector = new Map<string, typeof feed.items>();
  for (const a of feed.items) {
    if (heldCodes.has(a.code)) continue;
    const sector = asxSectors.get(a.code);
    if (!sector || !mySectors.has(sector)) continue;
    const list = bySector.get(sector) ?? [];
    if (list.length >= 2) continue;
    list.push(a);
    bySector.set(sector, list);
  }
  const sectorNews = [...bySector.entries()].sort((a, b) => a[0].localeCompare(b[0]));

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

      {/* ── Elsewhere in your sectors ──────────────────────────────────
          Not a second Market page: only the sectors this client is exposed
          to, only companies they do not hold, two apiece. It earns its place
          on the days the section above is empty, which for a book of seven
          holdings is most of them. */}
      {sectorNews.length > 0 && (
        <section className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
          <div className="px-4.5 py-3.5 border-b border-line flex items-center gap-2 select-none">
            <Layers className="w-4 h-4 text-mut" aria-hidden />
            <b className="text-sm font-semibold text-ink">Elsewhere in your sectors</b>
            <span className="ml-auto text-[11px] font-mono text-mut">
              {mySectors.size} sector{mySectors.size === 1 ? "" : "s"} held
            </span>
          </div>

          <div className="divide-y divide-line">
            {sectorNews.map(([sector, items]) => (
              <div key={sector} className="px-4.5 py-3.5">
                <div className="text-[10.5px] font-semibold uppercase tracking-wider text-mut mb-2">
                  {sector}
                </div>
                <div className="space-y-2.5">
                  {items.map((a) => (
                    <a
                      key={a.id}
                      href={a.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group block"
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="code font-mono text-[11px] px-1 rounded-sm font-bold text-ink">
                          {a.code}
                        </span>
                        <span
                          className={`pill text-[9.5px] font-bold rounded-full px-2 py-0.5 ${
                            a.sentiment === "bullish"
                              ? "bg-green-bg text-green-d"
                              : a.sentiment === "bearish"
                              ? "bg-loss-bg text-loss-d"
                              : "bg-paper-2 text-mut"
                          }`}
                        >
                          {a.sentiment}
                        </span>
                        <span className="font-mono text-[10px] text-mut uppercase tracking-wider truncate">
                          {a.company}
                        </span>
                      </div>
                      <div className="text-[12.5px] font-semibold text-ink leading-snug mt-1 group-hover:underline">
                        {a.headline}
                        <ArrowUpRight
                          aria-hidden
                          className="inline w-3 h-3 ml-1 -mt-0.5 text-mut-d group-hover:text-green-d"
                        />
                      </div>
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="px-4.5 py-3 border-t border-line bg-paper-2/40">
            <p className="text-[11px] text-mut leading-relaxed">
              Companies you do not hold, in the sectors you do. Shown for
              context — not a recommendation.
            </p>
          </div>
        </section>
      )}
    </div>
  );
}
