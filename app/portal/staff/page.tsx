import {
  getClients,
  getPlacements,
  getAlerts,
  getAuditLog,
  getPositions,
} from "@/lib/data/queries";
import { portfolioValue } from "@/lib/data/compute";
import { StaffOverviewClient, type ClientRegisterRow } from "./StaffOverviewClient";

function s708Label(iso: string | null): string {
  if (!iso) return "—";
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-AU", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

// Server Component: consolidated adviser console. Fetches book/deal/alert/audit
// data from the DAL and hands the fully-computed props to the client island.
export default async function StaffOverview() {
  const [clients, placements, alerts, audit] = await Promise.all([
    getClients(),
    getPlacements(),
    getAlerts(),
    getAuditLog(5),
  ]);

  const positionsByClient = await Promise.all(
    clients.map((c) => getPositions(c.id)),
  );

  let totalBookValue = 0;
  clients.forEach((c, idx) => {
    totalBookValue += portfolioValue(positionsByClient[idx], c.cash);
  });

  const registerRows: ClientRegisterRow[] = clients.map((c, idx) => ({
    id: c.id,
    initials: c.initials ?? "",
    name: c.name,
    accountType: c.accountType,
    value: portfolioValue(positionsByClient[idx], c.cash),
    bidCount: placements.filter((p) =>
      p.bids.some((b) => b.clientId === c.id),
    ).length,
    s708: s708Label(c.s708Expiry),
  }));

  return (
    <StaffOverviewClient
      totalBookValue={totalBookValue}
      clientCount={clients.length}
      placements={placements}
      alerts={alerts}
      audit={audit}
      registerRows={registerRows}
    />
  );
}
