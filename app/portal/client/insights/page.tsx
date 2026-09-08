import { getActiveAccountId } from "@/lib/session";
import {
  getPositions,
  getSectors,
  getNews,
  getResearchReports,
} from "@/lib/data/queries";
import { getAsxMarketSensitive } from "@/lib/asx/news";
import { ArrowUpRight } from "lucide-react";

function newsTime(iso: string): string {
  return new Date(iso).toLocaleString("en-AU", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Australia/Sydney",
  });
}

function annTime(iso: string): string {
  if (!iso) return "";
  return new Date(iso)
    .toLocaleTimeString("en-AU", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "Australia/Sydney",
    })
    .replace(/\s/g, "")
    .toLowerCase();
}

const SENTIMENT_PILL: Record<string, string> = {
  bullish: "bg-green-bg text-green-d",
  bearish: "bg-loss-bg text-loss-d",
  neutral: "bg-paper-2 text-mut",
};

// Server Component: sector momentum, news, and research from the DAL, with the
// client's holdings highlighted.
export default async function ClientInsightsPage() {
  const accountId = await getActiveAccountId();
  const [positions, sectors, news, reports, asxFeed] = await Promise.all([
    getPositions(accountId),
    getSectors(),
    getNews(),
    getResearchReports(),
    getAsxMarketSensitive(),
  ]);

  const holdings = positions.map((p) => p.code);
  const maxMom = Math.max(1, ...sectors.map((s) => Math.abs(s.momentum)));

  // Anything the client actually owns comes first. The upstream feed is already
  // newest-first, and a stable sort keeps that order inside each group — so this
  // reads as "your names, then the rest of the day" rather than reshuffling it.
  const held = new Set(holdings);
  const asxNews = [...asxFeed.items].sort(
    (a, b) => Number(held.has(b.code)) - Number(held.has(a.code)),
  );
  const heldCount = asxNews.filter((a) => held.has(a.code)).length;

  // Straight off the API, which counts these over the whole day rather than
  // over the page it returned. Counting them here instead is what made the
  // strip claim "12 price-sensitive filings" on a day that had 59 — it was
  // describing its own fetch limit.
  const { total: asxTotal, bySentiment, topTags } = asxFeed;

  // "Other" is the upstream tagger's fallback bucket and ranks high on volume
  // alone. "Mostly mining, other and results" says less than naming two real
  // themes, so it is dropped before the top three are taken.
  const themes = topTags.filter((t) => t.toLowerCase() !== "other").slice(0, 3);

  // The date the page is actually about. It read "Friday 12 Jun" hardcoded,
  // which is the DAL's demo anchor — fine next to demo rows, actively wrong
  // above ASX filings released this morning.
  const today = new Date().toLocaleDateString("en-AU", {
    weekday: "long",
    day: "numeric",
    month: "short",
    timeZone: "Australia/Sydney",
  });

  // Each block below renders only when it has something to say. The Supabase
  // reference tables (sectors, news, research_reports) are seed data and are
  // empty in an unseeded environment — an empty bordered card is worse than no
  // card, and this way they reappear on their own once seeded.
  const nothingToShow =
    asxTotal === 0 && sectors.length === 0 && news.length === 0 && reports.length === 0;

  return (
    <div className="space-y-4 text-ink font-body select-none">
      {/* Page Header */}
      <div>
        <div className="font-mono text-xs tracking-wider uppercase text-mut">Market intelligence &middot; {today}</div>
        <h1 className="font-disp font-medium text-[26px] mt-0.5">Insights</h1>
        <p className="text-xs text-mut mt-1">
          Where the money is moving, what’s driving it, and how it reads across your book.
        </p>
      </div>

      {/* Today, in four numbers. Everything here is counted off the live ASX
          feed further down the page, so the summary can never disagree with
          the list it summarises. */}
      {asxNews.length > 0 && (
        <div className="card bg-white border border-line rounded-[14px] p-5 shadow-shadow space-y-4">
          <div className="flex flex-wrap items-baseline gap-x-8 gap-y-3">
            <div>
              <div className="font-mono text-2xl font-bold text-ink leading-none">{asxTotal}</div>
              <div className="text-[11px] text-mut mt-1">price-sensitive filings</div>
            </div>
            <div>
              <div className="font-mono text-2xl font-bold text-gain leading-none">{bySentiment.bullish}</div>
              <div className="text-[11px] text-mut mt-1">read bullish</div>
            </div>
            <div>
              <div className="font-mono text-2xl font-bold text-loss-d leading-none">{bySentiment.bearish}</div>
              <div className="text-[11px] text-mut mt-1">read bearish</div>
            </div>
            <div>
              <div
                className={`font-mono text-2xl font-bold leading-none ${heldCount > 0 ? "text-green-d" : "text-mut-d"}`}
              >
                {heldCount}
              </div>
              <div className="text-[11px] text-mut mt-1">in your book</div>
            </div>
          </div>

          {/* Part-to-whole, so it earns a bar. Each segment is already
              direct-labelled by the numbers above — green and red are close
              enough under colour blindness that the bar alone would not do. */}
          <div className="flex gap-[2px] h-1.5" aria-hidden>
            {bySentiment.bullish > 0 && (
              <div className="bg-green rounded-full"
                style={{ width: `${(bySentiment.bullish / asxTotal) * 100}%` }} />
            )}
            {bySentiment.bearish > 0 && (
              <div className="bg-loss rounded-full"
                style={{ width: `${(bySentiment.bearish / asxTotal) * 100}%` }} />
            )}
            {bySentiment.neutral > 0 && (
              <div className="bg-line-2 rounded-full"
                style={{ width: `${(bySentiment.neutral / asxTotal) * 100}%` }} />
            )}
          </div>

          {themes.length > 0 && (
            <div className="text-xs text-mut">
              Mostly{" "}
              {themes.map((t, i) => (
                <span key={t}>
                  {i > 0 && (i === themes.length - 1 ? " and " : ", ")}
                  <b className="text-ink font-semibold">{t.toLowerCase()}</b>
                </span>
              ))}
              {heldCount > 0 && (
                <>
                  {" "}&middot; <b className="text-green-d font-semibold">{heldCount}</b>{" "}
                  {heldCount === 1 ? "touches a name" : "touch names"} you hold
                </>
              )}
              .
            </div>
          )}
        </div>
      )}

      {sectors.length > 0 && (
      <div className="space-y-2">
        <div className="font-mono text-[11px] tracking-wider uppercase text-mut">Sector momentum</div>

        <div className="card bg-white border border-line rounded-[14px] p-5 shadow-shadow space-y-4">
          {sectors.map((s, idx) => {
            const hasStock = s.beneficiaries.filter(code => holdings.includes(code));
            const momPercent = Math.max(5, Math.round((Math.abs(s.momentum) / maxMom) * 100));
            const isNegative = s.momentum < 0;

            return (
              <div key={s.name} className={`${idx > 0 ? "border-t border-line pt-3.5" : ""} space-y-1.5`}>
                <div className="flex justify-between items-center text-xs">
                  <b className="text-sm font-semibold text-ink leading-tight">{s.name}</b>
                  <div className="flex items-center gap-2 font-mono font-bold text-xs select-none">
                    {/* Momentum Bar */}
                    <div className="w-20 h-1.5 bg-paper-2 rounded-full overflow-hidden flex justify-end">
                      <div
                        style={{ width: `${momPercent}%` }}
                        className={`h-full rounded-full ${isNegative ? "bg-loss" : "bg-green"}`}
                      />
                    </div>
                    <span className={isNegative ? "text-loss-d" : "text-gain"}>
                      {s.momentum >= 0 ? "+" : ""}{s.momentum.toFixed(1)}%
                    </span>
                  </div>
                </div>

                <div className="text-[12.5px] text-mut leading-relaxed">{s.drivers}</div>

                <div className="text-[11px] flex gap-2 items-center flex-wrap">
                  {s.beneficiaries.length > 0 ? (
                    <span className="text-mut flex gap-2">
                      Names:{" "}
                      {s.beneficiaries.map(code => (
                        <span
                          key={code}
                          className={`code font-mono px-1 rounded-sm ${holdings.includes(code) ? "text-green-d font-bold" : ""}`}
                        >
                          {code} {holdings.includes(code) && "●"}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="text-mut">No direct names on platform</span>
                  )}

                  {hasStock.length > 0 ? (
                    <span className="pill bg-green-bg text-green-d text-[10px] font-bold px-2 py-0.5 rounded-full ml-auto">
                      You hold {hasStock.length}
                    </span>
                  ) : s.beneficiaries.length > 0 && s.momentum > 2 ? (
                    <span className="pill bg-amber-bg text-amber-d text-[10px] font-bold px-2 py-0.5 rounded-full ml-auto">
                      Not in your book
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      )}

      {/* ASX market-sensitive announcements. Rendered only when the upstream
          feed answered — an empty section says nothing useful, and the source
          being briefly unreachable should not leave a hole on the page. */}
      {asxNews.length > 0 && (
        <div className="space-y-2">
          <div className="font-mono text-[11px] tracking-wider uppercase text-mut">
            ASX market-sensitive announcements
          </div>

          <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
            <div className="flex justify-between items-center px-4.5 py-3.5 border-b border-line bg-white select-none">
              <b className="text-sm font-semibold text-ink">Price-sensitive filings today</b>
              {heldCount > 0 ? (
                <span className="pill bg-green-bg text-green-d text-[10px] font-bold px-2 py-0.5 rounded-full">
                  {heldCount} in your book
                </span>
              ) : (
                <span className="text-mut text-xs font-semibold">
                  {asxNews.length < asxTotal
                    ? `${asxNews.length} of ${asxTotal}`
                    : `${asxTotal} flagged`}
                </span>
              )}
            </div>

            <div className="divide-y divide-line">
              {asxNews.map((a) => {
                const owned = held.has(a.code);
                return (
                  <a
                    key={a.id}
                    href={a.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block px-4.5 py-3.5 hover:bg-paper transition-colors group"
                  >
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={`code font-mono text-[11px] px-1 rounded-sm font-bold ${owned ? "text-green-d" : "text-ink"}`}
                      >
                        {a.code} {owned && "●"}
                      </span>
                      <span
                        className={`pill text-[10px] font-bold rounded-full px-2 py-0.5 ${SENTIMENT_PILL[a.sentiment]}`}
                      >
                        {a.sentiment}
                      </span>
                      <span className="font-mono text-[10px] text-mut uppercase tracking-wider">
                        {a.company} &middot; {annTime(a.released)}
                      </span>
                      {/* An icon rather than a text label that appears on
                          hover. The label was doing two jobs badly: it told you
                          the row was a link only once you had already guessed
                          and pointed at it, and it popped in at the end of a
                          row of pills, which reads as the row changing shape.
                          This is always there, quiet, and only warms up. */}
                      <ArrowUpRight
                        aria-hidden
                        className="ml-auto w-3.5 h-3.5 shrink-0 text-mut-d transition-all
                                   group-hover:text-green-d group-hover:-translate-y-px"
                      />
                    </div>

                    <div className="font-semibold text-[13.5px] leading-snug mt-1.5 group-hover:underline">
                      {a.headline}
                    </div>

                    {a.summary[0] && (
                      <p className="text-xs text-mut leading-relaxed mt-1 line-clamp-2">
                        {a.summary[0]}
                      </p>
                    )}
                  </a>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Grid: News & research. Each card is gated on having rows, and the grid
          collapses to one column when only one of them does — a lone card in a
          two-column grid reads as a card with something missing beside it.

          The "This week's theme" card that used to sit here has gone. It was
          hardcoded prose naming a preferred exposure ("PLS is our key
          exposure") shown to every client regardless of their book. The same
          repo already runs a validation gate that rejects generated commentary
          which states a figure or reads as advice; a hand-written version of
          exactly that, permanently on the page, should not outlive it. Worth
          rebuilding on real data if the desk wants a house view here. */}
      {(news.length > 0 || reports.length > 0) && (
        <div className={`grid gap-4 ${news.length > 0 && reports.length > 0 ? "md:grid-cols-2" : ""}`}>
          {news.length > 0 && (
            <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
              <div className="flex justify-between items-center px-4.5 py-3.5 border-b border-line bg-white select-none">
                <b className="text-sm font-semibold text-ink">Global news &amp; impact</b>
                <span className="text-mut text-xs font-semibold">live wire</span>
              </div>

              <div className="p-4.5 space-y-4">
                {news.map((nw, idx) => (
                  <div key={nw.id} className={`${idx > 0 ? "border-t border-line pt-4" : ""} space-y-2`}>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`pill text-[10px] font-bold rounded-full px-2 py-0.5 ${nw.direction === "up" ? "bg-green-bg text-green-d" : "bg-loss-bg text-loss-d"}`}>
                        {nw.impact}
                      </span>
                      <span className="font-mono text-[10px] text-mut uppercase tracking-wider">
                        {nw.source} &middot; {newsTime(nw.ts)}
                      </span>
                    </div>
                    <div className="font-semibold text-[13.5px] leading-snug">{nw.headline}</div>
                    <p className="text-xs text-mut leading-relaxed">
                      <b className="text-green-d">How to use it:</b> {nw.use}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {reports.length > 0 && (
            <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow space-y-3">
              <b className="text-sm font-semibold text-ink block">Research library</b>
              <div className="divide-y divide-line text-xs font-medium">
                {reports.map((rp) => (
                  <div key={rp.id} className="py-2.5 space-y-0.5">
                    <div className="font-semibold text-ink">{rp.title}</div>
                    <div className="text-mut text-[10.5px]">
                      {rp.kind} &middot; {new Date(rp.published).toLocaleDateString("en-AU", { day: "numeric", month: "short" })} &middot; {rp.pages} pp
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Every source empty at once — an unseeded database and no reachable ASX
          feed. Better to say so than to leave the page looking broken. */}
      {nothingToShow && (
        <div className="card bg-white border border-line rounded-[14px] p-8 shadow-shadow text-center">
          <b className="text-sm font-semibold text-ink block">Nothing to show yet</b>
          <p className="text-xs text-mut mt-1.5 max-w-sm mx-auto leading-relaxed">
            Market intelligence appears here once the day&rsquo;s ASX filings are in. If this
            persists, the reference data may not be loaded for this environment.
          </p>
        </div>
      )}
    </div>
  );
}
