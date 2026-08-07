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
  ]);

  const clientBids: PlacementRow[] = placements.filter((p) =>
    p.bids.some((b) => b.clientId === id),
  );

  const signalsMap = Object.fromEntries(signals.map((s) => [s.code, s]));

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
      pnlRuns={pnlRuns}
    />
  );
}
