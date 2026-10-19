import { getActiveAccountId } from "@/lib/session";
import {
  getPlacements,
  getPositions,
  getAccount,
} from "@/lib/data/queries";
import { InvestClient } from "./InvestClient";

// Server Component: fetches placements + the active account's cash & holdings,
// then hands them to the interactive plan-builder client island. Goal/theme
// discovery config is static (lib/data/discovery).
//
// No ideas yet: the demo `investment_ideas` table was dropped on 19 October
// 2026 because nothing real ever wrote it. The island already renders without
// ideas, which is what it always showed live; a real source plugs in here.
export default async function ClientInvestPage() {
  const accountId = await getActiveAccountId();

  const [placements, positions, account] = await Promise.all([
    getPlacements(),
    getPositions(accountId),
    getAccount(accountId),
  ]);

  return (
    <InvestClient
      ideas={[]}
      placements={placements}
      positions={positions}
      cash={account?.cash ?? 0}
    />
  );
}
