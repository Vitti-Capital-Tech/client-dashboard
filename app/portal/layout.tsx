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
  getMergeRequests,
  getAccountClaims,
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

  // Staff badge: everything on the Account requests page awaiting a decision.
  // Claims and merges share one badge because they share one page — a client
  // waiting on either is waiting on the same queue, and two counters on one nav
  // item would say less, not more.
  let pendingMergeCount = 0;
  if (role === "admin") {
    const [pendingMerges, allClaims] = await Promise.all([
      getMergeRequests("pending"),
      getAccountClaims(),
    ]);
    pendingMergeCount =
      pendingMerges.length +
      allClaims.filter((c) => c.status === "pending").length;
  }

  return (
    <PortalShell
      role={role}
      clientName={client?.name ?? "Client"}
      clientAv={client?.initials ?? "—"}
      alerts={alerts}
      clientLabels={clientLabels}
      pendingAllocCount={pendingAllocCount}
      pendingMergeCount={pendingMergeCount}
      accounts={accounts}
      activeAccountId={activeAccountId}
    >
      {children}
    </PortalShell>
  );
}
