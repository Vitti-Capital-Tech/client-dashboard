import { getActiveAccountId, getActiveClientId } from "@/lib/session";
import {
  getPositions,
  getWatchlist,
} from "@/lib/data/queries";
import { getAsxMarketSensitive } from "@/lib/asx/news";
import { AsxNewsClient } from "./AsxNewsClient";
import { GlossaryStrip } from "@/app/components/GlossaryStrip";

// Server Component: the day's price-sensitive ASX filings, with the client's
// holdings highlighted.
export default async function ClientMarketPage() {
  const [accountId, clientId] = await Promise.all([
    getActiveAccountId(),
    getActiveClientId(),
  ]);
  const [positions, asxFeed, watchlist] = await Promise.all([
    getPositions(accountId),
    getAsxMarketSensitive(),
    // For the star on each filing: which of these companies is already
    // followed. The list is the client's own and short.
    clientId ? getWatchlist(clientId) : Promise.resolve([]),
  ]);

  const holdings = positions.map((p) => p.code);
  const watchedCodes = watchlist
    .map((w) => w.code)
    .filter((c): c is string => Boolean(c));

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
  const { total: asxTotal, bySentiment, topTags, sourceGeneratedAt } = asxFeed;

  // When the ASX data was last collected, not when this page rendered. A filing
  // waits on a 5-minute cron and a rebuild upstream before it can appear here,
  // so "as at" is the difference between a quiet feed and a stale one.
  const asAt = sourceGeneratedAt
    ? new Date(sourceGeneratedAt)
        .toLocaleTimeString("en-AU", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
          timeZone: "Australia/Sydney",
        })
        .replace(/\s/g, "")
        .toLowerCase()
    : null;

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

  // Nothing from the ASX feed — say so rather than leave the page looking broken.
  const nothingToShow = asxTotal === 0;

  return (
    <div className="space-y-4 text-ink font-body select-none">
      {/* Page Header */}
      <div>
        <div className="font-mono text-xs tracking-wider uppercase text-mut">Intelligence &middot; {today}</div>
        <h1 className="font-disp font-medium text-[26px] mt-0.5">Market</h1>
        <p className="text-xs text-mut mt-1">
          Where the money is moving, what’s driving it, and how it reads across your book.
        </p>
      </div>

      <GlossaryStrip />

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

      {/* The day's price-sensitive filings. Rendered by a client component
          because filtering and paging are interactions; the fetch and the day's
          figures stay here. Hidden when the upstream returned nothing — an
          empty filter bar over an empty list says less than no section. */}
      {asxNews.length > 0 && (
        <AsxNewsClient
          items={asxNews}
          heldCodes={holdings}
          watchedCodes={watchedCodes}
          total={asxTotal}
          asAt={asAt}
        />
      )}

      {nothingToShow && (
        <div className="card bg-white border border-line rounded-[14px] p-8 shadow-shadow text-center">
          <b className="text-sm font-semibold text-ink block">Nothing to show yet</b>
          <p className="text-xs text-mut mt-1.5 max-w-sm mx-auto leading-relaxed">
            Market intelligence appears here once the day&rsquo;s ASX filings are in.
          </p>
        </div>
      )}
    </div>
  );
}
