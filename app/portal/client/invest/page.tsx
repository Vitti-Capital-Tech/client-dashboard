import { getActiveClientId } from "@/lib/session";
import {
  getInvestmentIdeas,
  getPlacements,
  getPositions,
  getClient,
} from "@/lib/data/queries";
import { InvestClient } from "./InvestClient";

// Server Component: fetches ideas/placements + the client's cash & holdings,
// then hands them to the interactive plan-builder client island. Goal/theme
// discovery config is static (lib/data/discovery).
export default async function ClientInvestPage() {
  const clientId = await getActiveClientId();

  const [ideas, placements, positions, client] = await Promise.all([
    getInvestmentIdeas(),
    getPlacements(),
    getPositions(clientId),
    getClient(clientId),
  ]);

  return (
    <InvestClient
      ideas={ideas}
      placements={placements}
      positions={positions}
      cash={client?.cash ?? 0}
    />
  );
}
