import { getClients, getAccounts } from "@/lib/data/queries";
import { getAllStoredPnl } from "@/lib/data/pnl";
import { getAllPnlOverrides } from "@/lib/data/holdings";
import { StaffMismatchesClient } from "./StaffMismatchesClient";

export const metadata = {
  title: "Mismatched Qty in P&L | Vitti Staff Portal",
};

/**
 * Server Component: Centralized reconciliation dashboard for all quantity mismatches,
 * short buys, and missing trade legs across all client accounts.
 */
export default async function Page() {
  const [storedPnl, overrides, clients, accounts] = await Promise.all([
    getAllStoredPnl(),
    getAllPnlOverrides(),
    getClients(),
    getAccounts(),
  ]);

  return (
    <StaffMismatchesClient
      storedPnl={storedPnl}
      overrides={overrides}
      clients={clients}
      accounts={accounts}
    />
  );
}
