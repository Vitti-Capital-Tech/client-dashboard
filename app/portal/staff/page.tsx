import {
  getClients,
  getPlacements,
  getAlerts,
  getAuditLog,
  getClientPositions,
  getAccounts,
  type AccountRow,
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

// Across a client's accounts: total cash, an account-type summary, and the
// earliest s708 expiry (the binding compliance date).
function summarise(accounts: AccountRow[]) {
  const cash = accounts.reduce((sum, a) => sum + a.cash, 0);
  const accountType =
    accounts.length === 1 ? accounts[0].accountType : `${accounts.length} accounts`;
  const earliest = accounts
    .map((a) => a.s708Expiry)
    .filter((d): d is string => !!d)
    .sort()[0] ?? null;
  return { cash, accountType, s708: s708Label(earliest) };
}

// Server Component: consolidated adviser console. Fetches book/deal/alert/audit
// data from the DAL and hands the fully-computed props to the client island.
// Portfolio value + book total aggregate across each client's accounts.
export default async function StaffOverview() {
  const [clients, placements, alerts, audit] = await Promise.all([
    getClients(),
    getPlacements(),
    getAlerts(),
    getAuditLog(5),
  ]);

  const [positionsByClient, accountsByClient] = await Promise.all([
    Promise.all(clients.map((c) => getClientPositions(c.id))),
    Promise.all(clients.map((c) => getAccounts(c.id))),
  ]);

  const summaries = accountsByClient.map(summarise);

  let totalBookValue = 0;
  clients.forEach((_, idx) => {
    totalBookValue += portfolioValue(positionsByClient[idx], summaries[idx].cash);
  });

  const registerRows: ClientRegisterRow[] = clients.map((c, idx) => ({
    id: c.id,
    initials: c.initials ?? "",
    name: c.name,
    accountType: summaries[idx].accountType,
    value: portfolioValue(positionsByClient[idx], summaries[idx].cash),
    bidCount: placements.filter((p) =>
      p.bids.some((b) => b.clientId === c.id),
    ).length,
    s708: summaries[idx].s708,
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
