import { getActiveClientId } from "@/lib/session";
import { getAccounts, getMergeRequests } from "@/lib/data/queries";
import { AccountsClient } from "./AccountsClient";

// Server Component: the client's accounts + their merge requests (RLS-scoped),
// handed to the interactive island (create / request merge).
export default async function ClientAccountsPage() {
  const clientId = await getActiveClientId();
  const [accounts, requests] = await Promise.all([
    getAccounts(clientId),
    getMergeRequests(),
  ]);

  return <AccountsClient accounts={accounts} requests={requests} />;
}
