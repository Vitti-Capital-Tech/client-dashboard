import { getActiveClientId, getActiveAccountId } from "@/lib/session";
import { getClientStoredPnl } from "@/lib/data/pnl";
import { getClientPnlOverrides } from "@/lib/data/holdings";
import { clientPortfolio } from "@/lib/pnl/client-portfolio";
import {
  getClient,
  getAccount,
  getPositions,
  getOptions,
  getMarketIndices,
  getPlacements,
  getResearchNotes,
  getAlerts,
  getSignals,
  type SignalRow,
} from "@/lib/data/queries";
import { getAsxMarketSensitive } from "@/lib/asx/news";
import { getSecurityMap } from "@/lib/data/queries";
import { unlistedValue } from "@/lib/data/compute";
import { DashboardClient } from "./DashboardClient";

// Server Component: resolves the active client + account from the session,
// fetches via the DAL, then hands raw data to the interactive client island.
// Holdings are account-scoped; alerts/bids stay person-scoped.
export default async function ClientDashboardPage() {
  const clientId = await getActiveClientId();
  const accountId = await getActiveAccountId();

  const [
    client,
    account,
    positions,
    options,
    indices,
    placements,
    notes,
    alerts,
    signals,
    asxFeed,
  ] = await Promise.all([
    getClient(clientId),
    getAccount(accountId),
    getPositions(accountId),
    getOptions(accountId),
    getMarketIndices(),
    getPlacements(),
    getResearchNotes(),
    getAlerts(clientId),
    getSignals(),
    // Cached upstream for five minutes and shared with Market and Insights,
    // so this is a map lookup on most requests rather than a fetch.
    getAsxMarketSensitive(),
  ]);

  // The desk's own stored figures, so the headline numbers here, on the
  // portfolio page and on the adviser's screen are one number rather than three
  // computed three ways. See lib/pnl/client-portfolio.ts.
  const [storedPnl, overrides] = await Promise.all([
    clientId ? getClientStoredPnl(clientId) : Promise.resolve([]),
    clientId ? getClientPnlOverrides(clientId) : Promise.resolve([]),
  ]);

  const cash = account?.cash ?? 0;
  const portfolio = clientPortfolio(storedPnl, overrides);

  /**
   * Ticker → sector, for the sector chart that now lives on this page.
   *
   * The derivative-to-ordinary rollup is resolved HERE rather than in the
   * browser, the same way `toPosition` does it: an option series has no sector
   * of its own — no data source classifies 'EOSXX' — but the exposure a client
   * has through a grant is exposure to the underlying's sector, which is the
   * question a sector breakdown is asking. Built from the tickers actually in
   * the portfolio rather than from the whole catalogue, so the payload is the
   * client's own holdings.
   */
  const securityMap = await getSecurityMap();
  const parentOf = new Map(storedPnl.map((r) => [r.ticker, r.parentTicker ?? r.ticker]));
  const sectorByTicker: Record<string, string | null> = {};
  for (const row of portfolio.rows) {
    const parent = parentOf.get(row.ticker) ?? row.ticker;
    sectorByTicker[row.ticker] =
      securityMap.get(row.ticker)?.sector ?? securityMap.get(parent)?.sector ?? null;
  }

  /**
   * Carry on unlisted grants — neither a listed position nor cash.
   *
   * Two terms, and the second is the one that ever has a value: `option_holdings`
   * has never held a row, so the allocation slice read $0 for every client
   * including those holding grants the recompute had priced. The grants
   * themselves live in the stored P&L rows, which is where the second term
   * reads them from.
   */
  const unlisted =
    unlistedValue(options) +
    portfolio.rows
      .filter((r) => r.type.toLowerCase().includes("unlisted option"))
      .reduce((sum, r) => sum + r.sellOrCurrent, 0);

  const signalMap: Record<string, SignalRow> = Object.fromEntries(
    signals.map((s) => [s.code, s]),
  );

  // Morning-note time: derive from the latest research note's published ISO
  // stamp, formatted like the markets page (en-AU, Sydney, lowercased, no
  // spaces). Falls back gracefully when no note exists.
  const note = notes[0];
  const noteTime = note
    ? new Date(note.published)
        .toLocaleTimeString("en-AU", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
          timeZone: "Australia/Sydney",
        })
        .replace(/\s/g, "")
        .toLowerCase()
    : "—";

  return (
    <DashboardClient
      clientId={clientId}
      clientName={client?.name ?? ""}
      cash={cash}
      positions={positions}
      options={options}
      indices={indices}
      placements={placements}
      alerts={alerts}
      signals={signalMap}
      noteTime={noteTime}
      sectorByTicker={sectorByTicker}
      unlisted={unlisted}
      filings={asxFeed.items.filter((a) => positions.some((p) => p.parent === a.code || p.code === a.code))}
      portfolio={portfolio}
    />
  );
}
