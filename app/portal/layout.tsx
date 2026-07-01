import React from "react";
import { getSession, getActiveClientId } from "@/lib/session";
import {
  getClient,
  getClients,
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
  const role = session?.role ?? "client";
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

  return (
    <PortalShell
      role={role}
      clientName={client?.name ?? "Client"}
      clientAv={client?.initials ?? "—"}
      alerts={alerts}
      clientLabels={clientLabels}
      pendingAllocCount={pendingAllocCount}
    >
      {children}
    </PortalShell>
  );
}
