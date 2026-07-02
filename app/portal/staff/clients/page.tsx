import {
  getClients,
  getPlacements,
  getClientPositions,
  getAccounts,
  type AccountRow,
} from "@/lib/data/queries";
import { portfolioValue } from "@/lib/data/compute";
import { ClientsTable, type ClientRegistryRow } from "./ClientsTable";

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

// Server Component: client registry with portfolio value + active bid counts
// computed from the DAL (aggregated across each client's accounts); row
// navigation handled by the client island.
export default async function StaffClientsPage() {
  const [clients, placements] = await Promise.all([
    getClients(),
    getPlacements(),
  ]);
  const [positionsByClient, accountsByClient] = await Promise.all([
    Promise.all(clients.map((c) => getClientPositions(c.id))),
    Promise.all(clients.map((c) => getAccounts(c.id))),
  ]);

  const rows: ClientRegistryRow[] = clients.map((c, idx) => {
    const { cash, accountType, s708 } = summarise(accountsByClient[idx]);
    return {
      id: c.id,
      initials: c.initials ?? "",
      name: c.name,
      accountType,
      value: portfolioValue(positionsByClient[idx], cash),
      bidCount: placements.filter((p) =>
        p.bids.some((b) => b.clientId === c.id),
      ).length,
      s708,
    };
  });

  return (
    <div className="space-y-4 text-ink font-body select-none">
      {/* Page Header */}
      <div>
        <div className="font-mono text-xs tracking-wider uppercase text-mut">Verified advisers register</div>
        <h1 className="font-disp font-medium text-[26px] mt-0.5">Wholesale clients register</h1>
        <p className="text-xs text-mut mt-1">
          Full register of wholesale clients with verified s708 certificates, portfolio values, and active bids.
        </p>
      </div>

      <ClientsTable rows={rows} />
    </div>
  );
}
