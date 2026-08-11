import { getClients, getAccounts, getAllOptions } from "@/lib/data/queries";
import { getAllStoredPnl } from "@/lib/data/pnl";
import { getAllPnlOverrides } from "@/lib/data/holdings";
import { StaffOptionsClient } from "./StaffOptionsClient";

export const metadata = {
  title: "Options Register | Vitti Staff Console",
};

/**
 * Server Component: Centralized options tracker displaying all Listed and Unlisted
 * Options across all client accounts.
 */
export default async function StaffOptionsPage() {
  const [storedPnl, optionHoldings, clients, accounts, overrides] = await Promise.all([
    getAllStoredPnl(),
    getAllOptions(),
    getClients(),
    getAccounts(),
    getAllPnlOverrides(),
  ]);

  return (
    <StaffOptionsClient
      storedPnl={storedPnl}
      optionHoldings={optionHoldings}
      clients={clients}
      accounts={accounts}
      overrides={overrides}
    />
  );
}
