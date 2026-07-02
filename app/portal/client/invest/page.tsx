import { getActiveAccountId } from "@/lib/session";
import {
  getInvestmentIdeas,
  getPlacements,
  getPositions,
  getAccount,
} from "@/lib/data/queries";
import { InvestClient } from "./InvestClient";

// Server Component: fetches ideas/placements + the active account's cash &
// holdings, then hands them to the interactive plan-builder client island.
// Goal/theme discovery config is static (lib/data/discovery).
export default async function ClientInvestPage() {
  const accountId = await getActiveAccountId();

  const [ideas, placements, positions, account] = await Promise.all([
    getInvestmentIdeas(),
    getPlacements(),
    getPositions(accountId),
    getAccount(accountId),
  ]);

  return (
    <InvestClient
      ideas={ideas}
      placements={placements}
      positions={positions}
      cash={account?.cash ?? 0}
    />
  );
}
