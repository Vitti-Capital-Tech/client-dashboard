import { getActiveClientId } from "@/lib/session";
import { getPlacements, getClient } from "@/lib/data/queries";
import { PlacementsClient } from "./PlacementsClient";

// Server Component: resolves the active client from the session, fetches via the
// DAL, then hands data to the interactive client island.
export default async function ClientPlacementsPage() {
  const clientId = await getActiveClientId();

  const [placements, client] = await Promise.all([
    getPlacements(),
    getClient(clientId),
  ]);

  const s708Label = client?.s708Expiry
    ? new Date(client.s708Expiry).toLocaleDateString("en-AU", {
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
