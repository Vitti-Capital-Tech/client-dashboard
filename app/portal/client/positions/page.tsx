import { getActiveAccountId, getActiveClientId } from "@/lib/session";
import {
  getPositions,
  getAccount,
  getSignals,
  getClientOptions,
  getClientTrades,
  getSecurityMap,
  getSecurityCommentary,
  type SignalRow,
} from "@/lib/data/queries";
import { getClientStoredPnl } from "@/lib/data/pnl";
import { getClientPnlOverrides } from "@/lib/data/holdings";
import { clientPortfolio } from "@/lib/pnl/client-portfolio";
import { unlistedValue, attributeSells } from "@/lib/data/compute";
import { PositionsClient } from "./PositionsClient";

/**
 * Server Component: the client's own portfolio.
 *
 * ── Two sources, on purpose, answering different questions ──────────────────
 * `positions` is the current holdings snapshot and answers "what do I hold and
 * what is it worth right now". The stored P&L rows answer "what have these
 * holdings made", including parcels already sold — which mark-to-market on
 * current holdings cannot know about, and which is why the client's own P&L
 * used to be a thinner number than the one their adviser was reading.
 *
 * The figures now come from the same place the staff console reads, through the
 * same rollup and with the same corrections applied, so the two screens agree.
 * See `lib/pnl/client-portfolio.ts` for what is deliberately left behind.
 *
 * ── Client-scoped, and account-scoped, and not the same thing ───────────────
 * Holdings stay ACCOUNT-scoped: a client with several accounts switches between
 * them, and the holdings table is about one of them. The P&L is CLIENT-scoped,
 * matching the staff view, which aggregates a client's accounts — a portfolio
 * return that silently covered one of three accounts would be the wrong number
 * with no way to tell.
 *
 * Either way a client only ever reads their own rows: the getters filter on the
 * id from `getActiveClientId()` (resolved from their verified JWT email, never a
 * cookie), and `pnl_summary` / `pnl_overrides` / `positions` all carry RLS of
 * `is_staff() OR client_id = current_client_id()`.
 */
export default async function ClientPositionsPage() {
  const [accountId, clientId] = await Promise.all([
    getActiveAccountId(),
    getActiveClientId(),
  ]);

  const [
    positions,
    options,
    account,
    signals,
    storedPnl,
    overrides,
    trades,
    securityMap,
    commentaryByCode,
  ] = await Promise.all([
    getPositions(accountId),
    getClientOptions(clientId),
    getAccount(accountId),
    getSignals(),
    clientId ? getClientStoredPnl(clientId) : Promise.resolve([]),
    clientId ? getClientPnlOverrides(clientId) : Promise.resolve([]),
    clientId ? getClientTrades(clientId) : Promise.resolve([]),
    getSecurityMap(),
    getSecurityCommentary(),
  ]);

  const cash = account?.cash ?? 0;
  const unlisted = unlistedValue(options);
  const signalMap: Record<string, SignalRow> = Object.fromEntries(
    signals.map((s) => [s.code, s]),
  );

  /**
   * Dated realised P&L, attributed HERE rather than in the browser.
   *
   * The date picker is interactive, so the island needs the underlying data
   * rather than one pre-computed answer — but it needs the SALES, not the
   * ledger. One tested account holds 1,650 contract notes and the replay that
   * turns them into per-sale results is the same cost-basis walk the importer
   * uses; running it on the server sends the browser only the sales (a few
   * hundred small rows), and keeps one implementation of the arithmetic instead
   * of a second one written for the client.
   */
  const sells = attributeSells(trades);

  const portfolio = clientPortfolio(storedPnl, overrides);

  /**
   * Ticker → sector, for every ticker the sector chart can be asked about.
   *
   * The derivative-to-ordinary rollup is resolved HERE rather than in the
   * browser, the same way `toPosition` does it: an option series has no sector
   * of its own — no data source classifies 'EOSXX' — but the exposure a client
   * has through a grant is exposure to the underlying's sector, which is the
   * question a sector breakdown is asking. `parentTicker` comes off the stored
   * row; where it is absent the code IS the ordinary.
   *
   * Built from the tickers actually in the portfolio rather than from the whole
   * 775-row catalogue, so the payload is the client's own holdings.
   */
  const parentOf = new Map(
    storedPnl.map((r) => [r.ticker, r.parentTicker ?? r.ticker]),
  );
  const sectorByTicker: Record<string, string | null> = {};
  for (const row of portfolio.rows) {
    const parent = parentOf.get(row.ticker) ?? row.ticker;
    sectorByTicker[row.ticker] =
      securityMap.get(row.ticker)?.sector ?? securityMap.get(parent)?.sector ?? null;
  }

  return (
    <PositionsClient
      positions={positions}
      cash={cash}
      unlisted={unlisted}
      signals={signalMap}
      portfolio={portfolio}
      sells={sells}
      sectorByTicker={sectorByTicker}
      commentary={Object.fromEntries(commentaryByCode)}
    />
  );
}
