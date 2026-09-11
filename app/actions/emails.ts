"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createDetachedClient } from "@/lib/supabase/detached";
import type { ActionResult } from "./profile";

/**
 * Additional login addresses for one client.
 *
 * ── What this is for ────────────────────────────────────────────────────────
 * A couple who both want the family portfolio, two SMSF trustees, a principal
 * and their accountant. Before this, all three were answered with "share the
 * password" — the same account with the audit trail removed, and no way to take
 * one person's access away without changing the other's password.
 *
 * ── How it differs from `requestEmailChange` ────────────────────────────────
 * That MOVES the login: one address stops working as the other starts. This
 * ADDS one — both work afterwards, both resolve to the same `clients` row
 * through `client_emails`, and both appear in the audit log under the same
 * client. See 20260911090000_client_emails.sql for the schema half.
 *
 * ── The shape of every function here ────────────────────────────────────────
 * Identity is re-read from `getUser()` on every call, and the client resolved
 * from that address through `client_emails`; nothing trusts a client_id or an
 * address passed in as meaning anything more than "the thing to act on" — see
 * `callingClient` for why that distinction is load-bearing here and not
 * elsewhere. Writes go through the service role
 * because `client_emails` has no write policy, for the reason the table's own
 * comment gives: an INSERT policy would have to say "any authenticated user may
 * attach an address to some client", which is the question rather than an
 * answer to it.
 */

const ADDRESS = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** One login address as the Settings page shows it. */
export type LoginEmail = {
  email: string;
  isPrimary: boolean;
  /** True for the address this browser is actually signed in as. */
  isCurrent: boolean;
};

/**
 * The caller, as a client. Staff get no further: they have no `clients` row, so
 * there is nothing for an address to be added TO, and a vitti.capital address
 * is refused by the database anyway (`block_staff_domain_client_email`).
 *
 * ── Why this does not use `getActiveClientId()` ────────────────────────────
 * Because that function guesses, and here a guess is an account takeover.
 *
 * It falls back to `firstClientId()` for any signed-in address it cannot
 * resolve — a deliberate convenience from Stage 7, when an unresolved session
 * meant a demo that still rendered. RLS keeps such a person from READING
 * anything: `current_client_id()` returns NULL and every policy denies them, so
 * they reach an empty portal and leave.
 *
 * These actions are the case where that stops being harmless, because they
 * write with the service role and RLS is not in the way. An unresolved session
 * is reachable: `startSignUp` registers an `auth.users` row before the flow
 * completes, so anyone who abandons sign-up at the code step can still get in
 * later with a one-time code at /login. Handed `firstClientId()`, they could
 * then add their own address as a login for whichever client sorts first — and
 * on the next sign-in `current_client_id()` would resolve, RLS would open, and
 * the empty portal would be somebody's actual portfolio.
 *
 * So the client is resolved the way the database resolves it and no other way:
 * the caller's own address, in `client_emails`, or nothing. Only somebody who
 * already holds a login for a client may add another to it.
 */
async function callingClient(): Promise<
  | { ok: true; clientId: string; email: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.email) return { ok: false, error: "You are not signed in." };
  if (user.app_metadata?.role === "admin") {
    return { ok: false, error: "Staff logins are managed by the desk." };
  }

  const email = user.email.toLowerCase();

  // Service role: RLS on `client_emails` is itself defined in terms of
  // `current_client_id()`, so a caller who resolves to nothing would read no
  // rows and be indistinguishable from one whose row simply could not be read.
  // The two need different answers.
  const { data, error } = await createAdminClient()
    .from("client_emails")
    .select("client_id")
    .eq("email", email)
    .maybeSingle();

  if (error) {
    console.error("emails: could not resolve the caller %s — %s", email, error.message);
    return { ok: false, error: "Could not read your account just now. Please try again." };
  }
  if (!data) {
    return {
      ok: false,
      error: "Your login is not attached to a client yet. Contact the Vitti desk.",
    };
  }

  return { ok: true, clientId: data.client_id, email };
}

/**
 * Every address that can sign in as the caller's client.
 *
 * Read through the user's own client (not the service role) so RLS is the thing
 * deciding what comes back — `client_emails_select` returns the caller's rows
 * and nobody else's, which is the same answer this would have to compute by
 * hand and one that cannot be got wrong by passing the wrong id.
 */
export async function listLoginEmails(): Promise<LoginEmail[]> {
  const caller = await callingClient();
  if (!caller.ok) return [];

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("client_emails")
    .select("email, is_primary")
    .order("is_primary", { ascending: false })
    .order("created_at");

  if (error) {
    console.error("emails: could not list logins — %s", error.message);
    return [];
  }

  return data.map((row) => ({
    email: row.email,
    isPrimary: row.is_primary,
    isCurrent: row.email === caller.email,
  }));
}

/**
 * Step 1 — register the address and email a code to it.
 *
 * Nothing is linked here. The `auth.users` row is created without a password,
 * exactly as `startSignUp` does and for the same reason: until the code comes
 * back, all that exists is a registered address nobody can sign in with, so
 * abandoning the flow at this point creates nothing usable. The link into
 * `client_emails` — the part that grants access to a portfolio — happens only
 * in `confirmAddLoginEmail`, after the mailbox has answered.
 */
export async function startAddLoginEmail(email: string): Promise<ActionResult> {
  const caller = await callingClient();
  if (!caller.ok) return caller;

  const address = email.trim().toLowerCase();
  if (!ADDRESS.test(address)) {
    return { ok: false, error: "Enter a valid email address." };
  }
  if (address === caller.email) {
    return { ok: false, error: "You are already signed in with that address." };
  }

  const admin = createAdminClient();

  // The staff-domain rule is read from the DATABASE rather than re-tested
  // against the suffix here, for the reason `startSignUp` gives: two copies of
  // "what counts as a Vitti address" eventually disagree, and the disagreement
  // would be an address this form accepted and the database then refused —
  // after the person had already read a code out of their inbox.
  const { data: role, error: ruleError } = await admin.rpc("role_from_email_domain", {
    addr: address,
  });
  if (ruleError) {
    console.error("emails: could not read the staff-domain rule — %s", ruleError.message);
    return { ok: false, error: "Could not start that just now. Please try again." };
  }
  if (role === "admin") {
    return {
      ok: false,
      error: "A vitti.capital address cannot be added as a client login. Speak to the desk.",
    };
  }

  const problem = ownerProblem(await addressOwner(address, caller.clientId));
  if (problem) return { ok: false, error: problem };

  // Attempted rather than checked first: `listUsers` is paginated, and a
  // duplicate create is one call that answers "already there". An address that
  // already has an auth row but no `client_emails` row is an abandoned sign-up,
  // which is a perfectly good address to adopt — the code below still has to be
  // read out of that mailbox before anything is linked.
  const { error: createError } = await admin.auth.admin.createUser({
    email: address,
    email_confirm: true,
  });
  const already = createError?.code === "email_exists" || createError?.status === 422;
  if (createError && !already) {
    console.error("emails: could not register %s — %s", address, createError.message);
    return { ok: false, error: "Could not start that just now. Please try again." };
  }

  // Detached: `signInWithOtp` on the cookie-bound client is one refactor away
  // from writing a session into this request, and the caller must still be
  // themselves when this returns. See lib/supabase/detached.ts.
  const { error: otpError } = await createDetachedClient().auth.signInWithOtp({
    email: address,
    options: { shouldCreateUser: false },
  });

  if (otpError) {
    if (otpError.status === 429) {
      return { ok: false, error: "Too many requests. Wait a minute and try again." };
    }
    console.error("emails: could not send a code to %s — %s", address, otpError.message);
    return { ok: false, error: "Could not send the code just now. Please try again." };
  }

  return {
    ok: true,
    message: `Code sent to ${address}. Enter it below to finish adding it.`,
  };
}

/**
 * Step 2 — verify the code, then link the address to the caller's client.
 *
 * The order is the security argument, as it is in `completeSignUp`: `verifyOtp`
 * is what proves the mailbox, and the row that grants access to a portfolio is
 * written only after it returns.
 */
export async function confirmAddLoginEmail(
  email: string,
  code: string,
): Promise<ActionResult> {
  const caller = await callingClient();
  if (!caller.ok) return caller;

  const address = email.trim().toLowerCase();
  const token = code.trim();
  if (!ADDRESS.test(address)) {
    return { ok: false, error: "Enter a valid email address." };
  }
  if (!/^\d{6}$/.test(token)) {
    return { ok: false, error: "Enter the 6-digit code from the email." };
  }

  // Checked again: `startAddLoginEmail` ran minutes ago and this is a public
  // endpoint of its own. Somebody else completing their own sign-up on this
  // address in between is unlikely and would otherwise be resolved by a unique
  // violation with no useful message.
  const problem = ownerProblem(await addressOwner(address, caller.clientId));
  if (problem) return { ok: false, error: problem };

  const { error } = await createDetachedClient().auth.verifyOtp({
    email: address,
    token,
    type: "email",
  });
  if (error) {
    if (error.status === 429) {
      return { ok: false, error: "Too many attempts. Wait a minute and try again." };
    }
    // Wrong and expired are one message, as everywhere else here.
    return { ok: false, error: "That code is not valid or has expired." };
  }

  // `is_primary` stays false: adding a way in must never quietly change which
  // address the firm regards as the client's own, and `clients.email` mirrors
  // the primary. Promotion is a separate, deliberate act.
  const { error: linkError } = await createAdminClient()
    .from("client_emails")
    .insert({ client_id: caller.clientId, email: address, is_primary: false });

  if (linkError) {
    console.error("emails: could not link %s — %s", address, linkError.message);
    return {
      ok: false,
      error:
        "That address is verified but could not be added to your account. Contact the Vitti desk.",
    };
  }

  revalidatePath("/portal", "layout");
  return { ok: true, message: `${address} can now sign in to this account.` };
}

/**
 * Remove a login.
 *
 * ── Why the `auth.users` row goes too ───────────────────────────────────────
 * Deleting only the link would leave a credential that still authenticates and
 * resolves to no client — someone who can sign in and reach a portal with
 * nothing in it, whose access the client believes they have revoked. "Remove
 * this login" has to mean the login stops existing.
 *
 * That is safe to do here precisely because of what was checked on the way in:
 * the address is one of this client's own, and an address can only have become
 * one by being verified through `confirmAddLoginEmail`, which refuses any
 * address already spoken for. So the auth row being deleted is never somebody
 * else's account that happens to share a name.
 *
 * ── Two refusals ───────────────────────────────────────────────────────────
 * The primary address, and the address this request is signed in as.
 *
 * The primary is where this is deliberately STRICTER than the database. The
 * trigger refuses only a primary that has other addresses behind it, because
 * deleting a client's last login is a real operation the unlink script needs.
 * Offered on a Settings page, though, it is a client emptying their own account
 * of every way back into it — so here it is always a promotion first, and the
 * only thing that can strand a client is a staff member who meant to.
 *
 * The second is not a safety rule so much as an honesty one: it would succeed,
 * and the caller would discover it by being signed out mid-page with their own
 * login gone.
 */
export async function removeLoginEmail(email: string): Promise<ActionResult> {
  const caller = await callingClient();
  if (!caller.ok) return caller;

  const address = email.trim().toLowerCase();
  if (address === caller.email) {
    return {
      ok: false,
      error: "That is the address you are signed in with. Sign in as another one to remove it.",
    };
  }

  const admin = createAdminClient();
  const { data: row, error: readError } = await admin
    .from("client_emails")
    .select("id, client_id, is_primary")
    .eq("email", address)
    .maybeSingle();

  if (readError) {
    console.error("emails: could not read %s — %s", address, readError.message);
    return { ok: false, error: "Could not remove that just now. Please try again." };
  }
  // One message for "no such address" and "somebody else's", matching
  // `set_primary_client_email`: the caller may only ever name their own.
  if (!row || row.client_id !== caller.clientId) {
    return { ok: false, error: "That address is not one of your logins." };
  }
  if (row.is_primary) {
    return {
      ok: false,
      error: "That is your primary address. Make another one primary before removing it.",
    };
  }

  const { error: unlinkError } = await admin
    .from("client_emails")
    .delete()
    .eq("id", row.id);
  if (unlinkError) {
    console.error("emails: could not unlink %s — %s", address, unlinkError.message);
    return { ok: false, error: "Could not remove that just now. Please try again." };
  }

  // Best effort, and deliberately not fatal: the link is gone, which is the
  // part that grants access to this client's data. A surviving auth row is a
  // credential that reaches an empty portal, which is worth logging loudly and
  // is not worth telling the client their removal failed when it did not.
  const authUserId = await authUserIdFor(address);
  if (authUserId) {
    const { error: deleteError } = await admin.auth.admin.deleteUser(authUserId);
    if (deleteError) {
      console.error(
        "emails: unlinked %s but could not delete its auth user — %s",
        address,
        deleteError.message,
      );
    }
  }

  revalidatePath("/portal", "layout");
  return { ok: true, message: `${address} can no longer sign in.` };
}

/**
 * Make one of the caller's addresses the primary one.
 *
 * The whole operation is `set_primary_client_email`, which demotes and promotes
 * in one transaction and does its own authorisation. Doing it as two updates
 * from here would leave a window with no primary at all, and `clients.email` —
 * which mirrors it — momentarily NULL, which the claim rail reads as "this
 * client has no login".
 */
export async function setPrimaryLoginEmail(email: string): Promise<ActionResult> {
  const caller = await callingClient();
  if (!caller.ok) return caller;

  const address = email.trim().toLowerCase();
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_primary_client_email", { p_email: address });

  if (error) {
    // The function's refusals are written to be read, so they are surfaced
    // as-is; anything else is a fault rather than a decision.
    if (error.code === "42501") return { ok: false, error: error.message };
    console.error("emails: could not promote %s — %s", address, error.message);
    return { ok: false, error: "Could not change your primary address. Please try again." };
  }

  revalidatePath("/portal", "layout");
  return { ok: true, message: `${address} is now your primary address.` };
}

/**
 * Who an address already belongs to.
 *
 * Service role on purpose: RLS shows the caller only their OWN rows, so a check
 * run as the user would report "free" for every address that belongs to someone
 * else — the exact case this is asked to catch. Which client it is never
 * reaches the caller; only the three-way distinction does.
 *
 * "unreadable" is failing closed. It costs a person one retry; failing open
 * would attach an address that may already be another client's login.
 */
type AddressOwner =
  | { state: "free" }
  | { state: "mine" }
  | { state: "taken" }
  | { state: "unreadable" };

async function addressOwner(address: string, clientId: string): Promise<AddressOwner> {
  const { data, error } = await createAdminClient()
    .from("client_emails")
    .select("client_id")
    .eq("email", address)
    .maybeSingle();

  if (error) {
    console.error("emails: could not check %s — %s", address, error.message);
    return { state: "unreadable" };
  }
  if (!data) return { state: "free" };
  return { state: data.client_id === clientId ? "mine" : "taken" };
}

/** The refusal for each non-free answer, or null to carry on. */
function ownerProblem(owner: AddressOwner): string | null {
  switch (owner.state) {
    case "free":
      return null;
    case "mine":
      return "That address is already one of your logins.";
    case "taken":
      // Said plainly, as in `requestEmailChange`. The enumeration concern that
      // shapes the LOGIN form does not apply to an address the caller is trying
      // to claim: they must be told why it cannot proceed, and the alternative
      // is a code that arrives and then refuses to work.
      return "That address is already registered here. Use a different one, or call the desk.";
    case "unreadable":
      return "Could not check that address just now. Please try again.";
  }
}

/**
 * The `auth.users` id behind an address, or null.
 *
 * `listUsers` is paginated and there is no admin "get by email", so this asks
 * the database through an RPC rather than walking pages of users to find one.
 */
async function authUserIdFor(address: string): Promise<string | null> {
  const { data, error } = await createAdminClient().rpc("auth_user_id_for_email", {
    addr: address,
  });
  if (error) {
    console.error("emails: could not resolve an auth user for %s — %s", address, error.message);
    return null;
  }
  return (data as string | null) ?? null;
}
