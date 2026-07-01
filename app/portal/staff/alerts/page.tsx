import { getAlerts, getClients } from "@/lib/data/queries";
import { StaffAlertsClient } from "./StaffAlertsClient";

// Server Component: adviser-desk alerts console. Fetches all firm-wide + client
// alerts via the DAL; interactivity (ack, custom-alert modal) lives in the island.
export default async function StaffAlertsPage() {
  const [alerts, clients] = await Promise.all([getAlerts(), getClients()]);

  return <StaffAlertsClient alerts={alerts} clients={clients} />;
}
