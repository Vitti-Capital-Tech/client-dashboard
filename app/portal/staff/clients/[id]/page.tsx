import {
  getClient,
  getPositions,
  getOptions,
  getPlacements,
  getAlerts,
  getSignals,
  type PlacementRow,
} from "@/lib/data/queries";
import { ClientDetailClient } from "./ClientDetailClient";

// Server Component: single client register view. Fetches the client and all of
// their holdings/options/bids/alerts from the DAL; interactivity lives in the
// client island.
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

  const [positions, options, placements, alerts, signals] = await Promise.all([
    getPositions(id),
    getOptions(id),
    getPlacements(),
    getAlerts(id),
    getSignals(),
  ]);

  const clientBids: PlacementRow[] = placements.filter((p) =>
    p.bids.some((b) => b.clientId === id),
  );

  const signalsMap = Object.fromEntries(signals.map((s) => [s.code, s]));

  return (
    <ClientDetailClient
      client={client}
      positions={positions}
      options={options}
      clientBids={clientBids}
      alerts={alerts}
      signalsMap={signalsMap}
    />
  );
}
