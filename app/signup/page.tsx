import { redirect } from "next/navigation";
import { getSession, getActiveClientId } from "@/lib/session";
import { getAccounts, getAccountClaims } from "@/lib/data/queries";
import { SignUpClient } from "./SignUpClient";

/**
 * Client self-registration.
 *
 * ── Why this page resolves a step before rendering ──────────────────────────
 * Step 2 mints a real session, so from that moment the person is signed in with
 * a `clients` row and no accounts — and linking the first account is required,
 * not optional. A browser closed between steps 2 and 3 would otherwise leave
 * them permanently half-registered: signed in, able to reach the portal, and
 * looking at a dashboard with nothing on it.
 *
 * So the step is derived from what they actually have rather than held in the
 * browser. Coming back to /signup with a session and no accounts resumes at the
 * claim; coming back with either an account or a pending claim means there is
 * nothing left to do here.
 *
 * That is also why the proxy does NOT bounce signed-in users away from /signup
 * the way it does from /login — resuming requires being signed in. The redirects
 * below are what stop it being a page anybody can loiter on.
 */
export default async function SignUpPage() {
  const session = await getSession();

  // Nobody signed in: the ordinary case, start at the top.
  if (!session) return <SignUpClient start="details" />;

  // Staff have accounts in a different sense of the word and no `clients` row to
  // claim against. `startSignUp` refuses their addresses outright; this is the
  // same refusal for one who arrives already signed in.
  if (session.role === "admin") redirect("/portal/staff");

  const clientId = await getActiveClientId();
  const [accounts, claims] = await Promise.all([
    getAccounts(clientId),
    getAccountClaims(clientId),
  ]);

  // A pending claim counts as done: the number is with the desk, and asking for
  // a second one would only give staff two rows to reconcile.
  const settled =
    accounts.length > 0 || claims.some((c) => c.status === "pending");
  if (settled) redirect("/portal/client");

  return <SignUpClient start="account" />;
}
