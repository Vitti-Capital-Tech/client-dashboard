import { getActiveClientId, getActiveAccountId } from "@/lib/session";
import {
  getClient,
  getAccount,
  getPositions,
  getOptions,
  getPlacements,
} from "@/lib/data/queries";
import { portfolioValue, dailyPL } from "@/lib/data/compute";
import { AskVittiClient } from "./AskVittiClient";

// Server Component: resolves the active client + account, fetches via the DAL,
// then hands data to the interactive chat island. Holdings/cash are
// account-scoped; the person's name and deal bids stay client-scoped.
export default async function AskVittiPage() {
  const clientId = await getActiveClientId();
  const accountId = await getActiveAccountId();

  const [client, account, positions, options, placements] = await Promise.all([
    getClient(clientId),
    getAccount(accountId),
    getPositions(accountId),
    getOptions(accountId),
    getPlacements(),
  ]);

  const pv = portfolioValue(positions, account?.cash ?? 0);
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
