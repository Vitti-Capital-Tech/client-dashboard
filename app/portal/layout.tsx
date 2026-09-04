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

  // ── An account-less client belongs on step 3, not in here ────────────────
  // Registration requires linking an account (app/signup/SignUpClient.tsx), but
  // "required" only means something if closing the tab between step 2 and step 3
  // does not get you past it. It would otherwise: step 2 mints a real session,
  // so the portal is reachable from that moment — showing a dashboard with no
  // positions, an empty account switcher, and P&L of nothing, which reads as the
  // product being broken rather than the sign-up being unfinished.
  //
  // A pending claim counts as linked. The account is not theirs until staff
  // approve it, but the number is with the desk and there is nothing further for
  // the client to do; sending them back to ask again would produce a second
  // request for staff to reconcile against the first.
  //
  // Staff are exempt by construction — this whole branch is client-only, and an
  // admin inspecting a client through the view cookie must not be redirected out
  // of the console because the client they are looking at has no accounts yet.
  if (role !== "admin" && accountRows.length === 0) {
    const claims = await getAccountClaims(activeClientId);
    if (!claims.some((c) => c.status === "pending")) redirect("/signup");
  }

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
