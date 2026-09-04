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
  type ClaimRequestRow,
} from "@/lib/data/queries";
import { PortalShell } from "./PortalShell";
import { AwaitingAccount } from "./AwaitingAccount";

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

  // ── A client with no accounts ────────────────────────────────────────────
  // Registration requires linking an account (app/signup/SignUpClient.tsx), but
  // "required" only means something if closing the tab between step 2 and step 3
  // does not get you past it. It would otherwise: step 2 mints a real session, so
  // the portal is reachable from that moment. Two different states end up here
  // and they need opposite answers:
  //
  //   • no claim yet  → the sign-up is genuinely unfinished. Back to step 3.
  //   • claim pending → the sign-up is DONE and the client is waiting on us.
  //     Sending them back would ask for a number they already gave and hand the
  //     desk a second request to reconcile against the first.
  //
  // The second case is why `children` is replaced rather than rendered. The whole
  // portal is account-scoped — `getActiveAccountId()` returns "" here, and six
  // client pages pass that to the DAL — so this is the one place that has to know
  // about the state. It is also the honest answer: a dashboard of zeros tells a
  // client their portfolio is worth nothing, which is a claim about their money
  // rather than about our data.
  //
  // Staff are exempt by construction: an admin inspecting a client through the
  // view cookie must not be thrown out of the console because that client has no
  // accounts yet.
  let awaitingClaim: ClaimRequestRow | null = null;
  if (role !== "admin" && accountRows.length === 0) {
    const claims = await getAccountClaims(activeClientId);
    awaitingClaim = claims.find((c) => c.status === "pending") ?? null;
    if (!awaitingClaim) redirect("/signup");
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
      {awaitingClaim ? <AwaitingAccount claim={awaitingClaim} /> : children}
    </PortalShell>
  );
}
