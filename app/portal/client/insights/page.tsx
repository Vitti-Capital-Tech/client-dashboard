import { getActiveClientId } from "@/lib/session";
import { getSecurityMap, getWatchlist } from "@/lib/data/queries";
import { getAsxSectors } from "@/lib/asx/directory";
import { getClientStoredPnl } from "@/lib/data/pnl";
import { getClientPnlOverrides } from "@/lib/data/holdings";
import { clientSummary } from "@/lib/pnl/client-portfolio";
import { getAsxMarketSensitive } from "@/lib/asx/news";
import { HoldingsNews, SectorNews } from "./InsightsNews";

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

      {/* ── Your holdings, in today's filings ───────────────────── */}
      <HoldingsNews
        items={mine}
        watchedCodes={[...watching]}
        feedTotal={feed.total}
      />

      {/* ── Elsewhere in your sectors ──────────────────────────────────
          Not a second Market page: only the sectors this client is exposed
          to, only companies they do not hold, two apiece. It earns its place
          on the days the section above is empty, which for a book of seven
          holdings is most of them. */}
      {sectorNews.length > 0 && (
        <SectorNews groups={sectorNews} sectorCount={mySectors.size} />
      )}
    </div>
  );
}
