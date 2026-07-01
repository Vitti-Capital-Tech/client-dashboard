import { getClients, getPlacements, getPositions } from "@/lib/data/queries";
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

// Server Component: client registry with portfolio value + active bid counts
// computed from the DAL; row navigation handled by the client island.
export default async function StaffClientsPage() {
  const [clients, placements] = await Promise.all([
    getClients(),
    getPlacements(),
  ]);
  const positionsByClient = await Promise.all(
    clients.map((c) => getPositions(c.id)),
  );

  const rows: ClientRegistryRow[] = clients.map((c, idx) => ({
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
