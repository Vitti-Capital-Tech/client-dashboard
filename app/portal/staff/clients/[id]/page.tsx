import {
  getClient,
  getAccounts,
  getClientPositions,
  getClientOptions,
  getPlacements,
  getAlerts,
  getSignals,
  getClientTrades,
  type PlacementRow,
} from "@/lib/data/queries";
import { getClientRealized, getClientPnlOverrides } from "@/lib/data/holdings";
import { getClientStoredPnl, getClientLatestPnlRuns } from "@/lib/data/pnl";
import { getQueuedAccountIds } from "@/lib/data/ingest";
import { offLedgerBuyLines } from "@/lib/pnl/off-ledger-buys";
import type { LedgerLine } from "@/lib/import/trades";
import { ClientDetailClient } from "./ClientDetailClient";

// Server Component: single client register view. Fetches the client and all of
// their holdings/options/bids/alerts (aggregated across the client's accounts)
// from the DAL; interactivity lives in the client island.
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const client = await getClient(id);
  if (!client) {
    return <div className="text-mut text-center py-10">Client not found on registry.</div>;
  }

  const [
    accounts,
    positions,
    options,
    placements,
    alerts,
    signals,
    trades,
    realized,
    overrides,
    storedPnl,
    pnlRuns,
    queuedAccountIds,
  ] = await Promise.all([
    getAccounts(id),
    getClientPositions(id),
    getClientOptions(id),
    getPlacements(),
    getAlerts(id),
    getSignals(),
    getClientTrades(id),
    getClientRealized(id),
    getClientPnlOverrides(id),
    // The P&L table now renders what the recompute STORED, rather than deriving
    // it here — the full calculation depends on live spot prices and the
    // Placement Trackers, neither of which a page render can reproduce.
    getClientStoredPnl(id),
    getClientLatestPnlRuns(id),
    // Which of this client's accounts a run could not finish. Without it a
    // figure the morning never got to looks identical to one it confirmed —
    // both simply carry an older "Calculated" stamp.
    getQueuedAccountIds(id),
  ]);

  const clientBids: PlacementRow[] = placements.filter((p) =>
    p.bids.some((b) => b.clientId === id),
  );

  const signalsMap = Object.fromEntries(signals.map((s) => [s.code, s]));

  /**
   * The purchases the contract-note ledger never recorded, per account scope.
   *
   * A placement is transacted through the house account and journalled out, so
   * the client ledger shows the sale and no purchase — and the realised-P&L
   * chart, which replays that ledger, drew the whole proceeds as profit. The
   * stored figures know the real cost because the recompute merges the
   * Placement Trackers into them; this recovers it by difference so the chart
   * can use it. See lib/pnl/off-ledger-buys.ts.
   *
   * Built HERE rather than in the island for two reasons. The difference has to
   * be taken against the PRE-override stored rows, and calling it inside the
   * island put React Compiler off optimising the whole component — see the
   * `offLedger` note there.
   */
  const offLedgerByScope: Record<string, LedgerLine[]> = {
    all: offLedgerBuyLines(storedPnl, trades),
  };
  for (const a of accounts) {
    offLedgerByScope[a.id] = offLedgerBuyLines(
      storedPnl.filter((r) => r.accountId === a.id),
      trades.filter((t) => t.accountId === a.id),
    );
  }

  // The detail island filters holdings/bids/cash per account (or aggregates
  // across all of the client's accounts).
  return (
    <ClientDetailClient
      client={client}
      accounts={accounts}
      positions={positions}
      options={options}
      clientBids={clientBids}
      alerts={alerts}
      signalsMap={signalsMap}
      trades={trades}
      realized={realized}
      overrides={overrides}
      storedPnl={storedPnl}
      offLedgerByScope={offLedgerByScope}
      pnlRuns={pnlRuns}
      queuedAccountIds={queuedAccountIds}
    />
  );
}
