import { getActiveClientId } from "@/lib/session";
import {
  getClient,
  getPositions,
  getOptions,
  getPlacements,
} from "@/lib/data/queries";
import { portfolioValue, dailyPL } from "@/lib/data/compute";
import { AskVittiClient } from "./AskVittiClient";

// Server Component: resolves the active client from the session, fetches via the
// DAL, then hands data to the interactive chat island.
export default async function AskVittiPage() {
  const clientId = await getActiveClientId();

  const [client, positions, options, placements] = await Promise.all([
    getClient(clientId),
    getPositions(clientId),
    getOptions(clientId),
    getPlacements(),
  ]);

  const pv = portfolioValue(positions, client?.cash ?? 0);
  const dpl = dailyPL(positions);

  const mrdBid =
    placements
      .find(p => p.code === "MRD")
      ?.bids.find(b => b.clientId === clientId)?.amount ?? null;

  return (
    <AskVittiClient
      clientName={client?.name ?? "there"}
      pv={pv}
      dpl={dpl}
      options={options}
      mrdBid={mrdBid}
    />
  );
}
