import { ArrowUpRight, Lightbulb, Newspaper } from "lucide-react";
import { getActiveClientId } from "@/lib/session";
import { getSecurityCommentary, getWatchlist } from "@/lib/data/queries";
import { getClientStoredPnl } from "@/lib/data/pnl";
import { getClientPnlOverrides } from "@/lib/data/holdings";
import { clientSummary } from "@/lib/pnl/client-portfolio";
import { getAsxMarketSensitive } from "@/lib/asx/news";
import { WatchButton } from "@/app/components/WatchButton";

export const metadata = {
  title: "Insights — Vitti Capital",
};

const money = (n: number) =>
  `${n < 0 ? "−" : "+"}$${Math.abs(Math.round(n)).toLocaleString("en-AU")}`;

const weekLabel = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

/**
 * Insights — the client's own book, explained.
 *
 * ── How this differs from Market ───────────────────────────────────────────
 * Market is the whole exchange: every price-sensitive filing of the day, for
 * 1,800 companies the client mostly does not hold. This page is only about the
 * ones they do hold, and it answers the two questions a client actually arrives
 * with — "has anything happened to my companies" and "why is that number red".
 *
 * Both sections are built from data that already existed and was only ever
 * shown somewhere else: the ASX feed behind Market, and the weekly commentary
 * the portfolio page shows a line of per row. Neither invents anything.
 *
 * ── What it does not do ────────────────────────────────────────────────────
 * It does not tell anybody what to do about it. Every note here is written to
 * explain a move that has already happened, and `lib/commentary/prompt.ts` is
 * explicit that a note saying "nothing specific happened this week" is a
 * correct answer. Advice is a licensed activity and this is not it.
 */
export default async function ClientInsightsPage() {
  const clientId = await getActiveClientId();

  const [storedPnl, overrides, commentary, feed, watchlist] = await Promise.all([
    clientId ? getClientStoredPnl(clientId) : Promise.resolve([]),
    clientId ? getClientPnlOverrides(clientId) : Promise.resolve([]),
    getSecurityCommentary(),
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

  /**
   * Positions with a result and a note to go with it, biggest move first.
   *
   * Sorted by SIZE of the move rather than by direction: the position that has
   * done the most is the one worth reading about, whichever way it went.
   * Rows with no note are left out entirely rather than listed with an empty
   * space where the explanation should be.
   */
  const explained = open
    .map((r) => ({ row: r, note: commentary.get(r.ticker) }))
    .filter((x) => x.note && (x.row.pnl < 0 ? x.note.lossNote : x.note.profitNote))
    .sort((a, b) => Math.abs(b.row.pnl) - Math.abs(a.row.pnl))
    .slice(0, 12);

  return (
    <div className="space-y-5 text-ink font-body">
      <div className="select-none max-w-160">
        <div className="font-mono text-xs tracking-wider uppercase text-mut">
          Your book
        </div>
        <h1 className="font-disp font-medium text-[26px] mt-0.5">Insights</h1>
        <p className="text-xs text-mut mt-1">
          Announcements from the companies you hold, and what has been moving
          your positions. The whole market is under Market.
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
                <div className="flex items-center gap-2 flex-wrap">
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
                  <div className="ml-auto flex items-center gap-2">
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

      {/* ── Why a position reads the way it does ──────────────────────── */}
      <section className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
        <div className="px-4.5 py-3.5 border-b border-line flex items-center gap-2 select-none">
          <Lightbulb className="w-4 h-4 text-mut" aria-hidden />
          <b className="text-sm font-semibold text-ink">
            Why your positions are up or down
          </b>
        </div>

        {explained.length === 0 ? (
          <div className="px-4.5 py-10 text-center">
            <b className="text-sm font-semibold text-ink block">
              No notes yet
            </b>
            <p className="text-xs text-mut mt-1.5 max-w-90 mx-auto leading-relaxed">
              Vitti writes these weekly, one per holding. They appear here once
              the first week has run for the companies you hold.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-line">
            {explained.map(({ row, note }) => {
              const down = row.pnl < 0;
              const text = down ? note!.lossNote : note!.profitNote;
              return (
                <div key={row.ticker} className="px-4.5 py-4">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="code font-mono text-[11px] px-1 rounded-sm font-bold text-ink">
                      {row.ticker}
                    </span>
                    <span className="text-[13px] font-semibold text-ink truncate">
                      {row.name}
                    </span>
                    <span
                      className={`ml-auto font-mono text-[13px] font-bold ${
                        down ? "text-loss-d" : "text-green-d"
                      }`}
                    >
                      {money(row.pnl)}
                    </span>
                  </div>

                  <p className="text-[13px] text-mut leading-relaxed mt-2">{text}</p>

                  <div className="flex items-center gap-2 flex-wrap mt-2">
                    <span className="text-[10.5px] font-mono text-mut-d uppercase tracking-wider">
                      Week of {weekLabel(note!.weekOf)}
                    </span>
                    {/* Where the note came from. A written explanation of
                        somebody's money should be checkable, and these are the
                        pages it was written from. */}
                    {note!.sources.slice(0, 3).map((src) => (
                      <a
                        key={src.url}
                        href={src.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10.5px] font-semibold text-green-d underline underline-offset-2 hover:opacity-80 truncate max-w-50"
                      >
                        {src.title}
                      </a>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="px-4.5 py-3 border-t border-line bg-paper-2/40">
          <p className="text-[11px] text-mut leading-relaxed">
            These notes explain what has already happened. They are not advice
            and not a recommendation to buy, hold or sell.
          </p>
        </div>
      </section>
    </div>
  );
}
