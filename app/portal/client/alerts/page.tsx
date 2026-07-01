import { getActiveClientId } from "@/lib/session";
import { getAlerts } from "@/lib/data/queries";
import { AlertsClient } from "./AlertsClient";

// Server Component: resolves the active client from the session, fetches via the
// DAL, then hands data to the interactive client island.
export default async function ClientAlertsPage() {
  const clientId = await getActiveClientId();
  const alerts = await getAlerts(clientId);

  return <AlertsClient alerts={alerts} clientId={clientId} />;
}
