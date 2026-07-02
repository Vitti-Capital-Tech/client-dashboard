import { getActiveClientId, getActiveAccountId } from "@/lib/session";
import { getPlacements, getAccount } from "@/lib/data/queries";
import { PlacementsClient } from "./PlacementsClient";

// Server Component: resolves the active client + account, fetches via the DAL,
// then hands data to the interactive client island. The s708 certificate is an
// account attribute; bids are shown per person (clientId).
export default async function ClientPlacementsPage() {
  const clientId = await getActiveClientId();
  const accountId = await getActiveAccountId();

  const [placements, account] = await Promise.all([
    getPlacements(),
    getAccount(accountId),
  ]);

  const s708Label = account?.s708Expiry
    ? new Date(account.s708Expiry).toLocaleDateString("en-AU", {
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      })
    : "—";

  return (
    <PlacementsClient
      placements={placements}
      clientId={clientId}
      s708={s708Label}
    />
  );
}
