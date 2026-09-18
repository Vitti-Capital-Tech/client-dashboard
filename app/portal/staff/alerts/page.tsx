import { getAlerts, getClients } from "@/lib/data/queries";
import { StaffAlertsClient } from "./StaffAlertsClient";

// Server Component: adviser-desk alerts console. Fetches all firm-wide + client
// alerts via the DAL, with the DESK's read state (`"staff"`) rather than the
// clients' — the two are separate columns. Interactivity (marking read, the
// custom-alert modal) lives in the island.
export default async function StaffAlertsPage() {
  const [alerts, clients] = await Promise.all([getAlerts(undefined, "staff"), getClients()]);

  return <StaffAlertsClient alerts={alerts} clients={clients} />;
}
