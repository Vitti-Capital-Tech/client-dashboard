import { getActiveClientId } from "@/lib/session";
import {
  getAccounts,
  getMergeRequests,
  getAccountClaims,
} from "@/lib/data/queries";
import { AccountsClient } from "./AccountsClient";

/**
 * Server Component: the client's accounts, their merge requests and their
 * account claims (all RLS-scoped), handed to the interactive island.
 *
 * Claims are fetched scoped to the client explicitly rather than leaning on RLS
 * alone, so that a staff member inspecting a client through the client view sees
 * that client's claims rather than every claim at the firm.
 */
export default async function ClientAccountsPage() {
  const clientId = await getActiveClientId();
  const [accounts, requests, claims] = await Promise.all([
    getAccounts(clientId),
    getMergeRequests(),
    getAccountClaims(clientId),
  ]);

  return (
    <AccountsClient accounts={accounts} requests={requests} claims={claims} />
  );
}
