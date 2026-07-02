import React from "react";
import { redirect } from "next/navigation";
import {
  getSession,
  getActiveClientId,
  getActiveAccountId,
} from "@/lib/session";
import {
  getClient,
  getClients,
  getAccounts,
  getAlerts,
  getPlacements,
} from "@/lib/data/queries";
import { PortalShell } from "./PortalShell";

// Server Component: resolves the session + badge data from the DAL, then hands
// the interactive shell (nav, alerts drawer, sign-out) its props.
export default async function PortalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  // Defense-in-depth alongside the proxy: no session → back to login.
  if (!session) redirect("/login");
  const role = session.role;
  const activeClientId = await getActiveClientId();

  const [client, clients, alerts, placements] = await Promise.all([
    getClient(activeClientId),
    getClients(),
    // Admin sees firm-wide alerts; a client sees only their own.
    getAlerts(role === "admin" ? undefined : activeClientId),
    getPlacements(),
  ]);

  const clientLabels: Record<string, string> = Object.fromEntries(
    clients.map((c) => [c.id, c.ref ?? c.initials ?? ""]),
  );

  const pendingAllocCount = placements.reduce(
    (sum, p) =>
      p.stage === "closed"
        ? sum + p.bids.filter((b) => b.alloc === null).length
        : sum,
    0,
  );

  // Client account switcher (admins use the client-view flow, not this).
  const [activeAccountId, accountRows] =
    role === "admin"
      ? ["", []]
      : await Promise.all([getActiveAccountId(), getAccounts(activeClientId)]);
  const accounts = accountRows.map((a) => ({
    id: a.id,
    label: a.label,
    accountType: a.accountType,
  }));

  return (
    <PortalShell
      role={role}
      clientName={client?.name ?? "Client"}
      clientAv={client?.initials ?? "—"}
      alerts={alerts}
      clientLabels={clientLabels}
      pendingAllocCount={pendingAllocCount}
      accounts={accounts}
      activeAccountId={activeAccountId}
    >
      {children}
    </PortalShell>
  );
}
