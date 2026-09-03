import { getActiveClientId, getActiveAccountId } from "@/lib/session";
import {
  getClient,
  getAccount,
  getPositions,
  getClientOptions,
  getPlacements,
} from "@/lib/data/queries";
import { getClientStoredPnl } from "@/lib/data/pnl";
import { getClientPnlOverrides } from "@/lib/data/holdings";
import { clientPortfolio } from "@/lib/pnl/client-portfolio";
import { optionsFromSources } from "@/lib/options/from-stored-pnl";
import { portfolioValue } from "@/lib/data/compute";
import { AskVittiClient } from "./AskVittiClient";

/**
 * Server Component for the client's assistant.
 *
 * ── Every figure it can quote is a real one ─────────────────────────────────
 * This page used to hand the island `dailyPL(positions)` — a day move modelled
 * from fixed per-security factors, because the app has no intraday price
 * history — and look up a hardcoded `MRD` placement. The island then answered
 * questions with invented specifics: "PLS +2.1% and BHP +0.8%", "Year to date
 * you are tracking +6.4%, ahead of the ASX 200 at +5.4%", and a whole deal
 * ("raising $12.0m at $0.50 … our desk rates it a spec buy with a $0.78
 * target"). Under an AI badge, to a client, about their own money.
 *
 * So it is given the same stored figures the rest of the portal reads, the same
 * option register the Options tab renders, and the real placements list. What it
 * cannot answer from those, it now declines to answer.
 */
export default async function AskVittiPage() {
  const [clientId, accountId] = await Promise.all([
    getActiveClientId(),
    getActiveAccountId(),
  ]);

  const [client, account, positions, holdings, placements, storedPnl, overrides] =
    await Promise.all([
      getClient(clientId),
      getAccount(accountId),
      getPositions(accountId),
      clientId ? getClientOptions(clientId) : Promise.resolve([]),
      getPlacements(),
      clientId ? getClientStoredPnl(clientId) : Promise.resolve([]),
      clientId ? getClientPnlOverrides(clientId) : Promise.resolve([]),
    ]);

  return (
    <AskVittiClient
      clientName={client?.name ?? "there"}
      marketValue={portfolioValue(positions, account?.cash ?? 0)}
      portfolio={clientPortfolio(storedPnl, overrides)}
      options={optionsFromSources(storedPnl, holdings)}
      openPlacements={placements.filter((p) => p.stage !== "settled").length}
    />
  );
}
