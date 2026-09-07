"use server";

import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { passwordProblem, confirmationProblem } from "@/lib/auth/password";
import { VIEW_COOKIE, ACCOUNT_COOKIE } from "@/lib/session";
import { authConfirmUrl } from "@/lib/app-origin";

/**
 * What a client can change about their own login: the password, the address, and
 * where they are signed in.
 *
 * Separate from ./session.ts, which is about GETTING a session. These all act on
 * an existing one, and every one of them re-reads who the caller is from
 * `getUser()` rather than trusting anything passed in.
 */

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

/** The signed-in user, or null. Never trusts a caller-supplied identity. */
async function currentUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

/**
 * Change a password the caller already has.
 *
 * ── Why the current password is required ────────────────────────────────────
 * `secure_password_change` is off in this project, so `updateUser({ password })`
 * would accept a new password on the strength of the session alone. That turns
 * an unlocked laptop into permanent access: a session expires, a password does
 * not, and the owner would be locked out of their own login without ever seeing
 * a prompt.
 *
 * Verified by actually signing in with it rather than by a "confirm" flag.
 * `signInWithPassword` on the same user returns a session for that same user, so
 * the caller's own session is replaced by an identical one — no privilege
 * changes hands, and there is no way to pass the check without the password.
 */
export async function changePassword(
  currentPassword: string,
  next: string,
  confirmation: string,
): Promise<ActionResult> {
  const { supabase, user } = await currentUser();
  if (!user?.email) return { ok: false, error: "You are not signed in." };

  const weak = passwordProblem(next);
  if (weak) return { ok: false, error: weak };
  const mismatch = confirmationProblem(next, confirmation);
  if (mismatch) return { ok: false, error: mismatch };
  if (next === currentPassword) {
    return { ok: false, error: "That is already your password." };
  }

  const { error: checkError } = await supabase.auth.signInWithPassword({
    email: user.email,
    password: currentPassword,
  });
  if (checkError) {
    return { ok: false, error: "Your current password is not correct." };
  }

  const { error } = await supabase.auth.updateUser({ password: next });
  if (error) {
    console.error("settings: password change failed for %s — %s", user.email, error.message);
    return { ok: false, error: "Could not save that password. Please try again." };
  }

  return { ok: true, message: "Password updated. Your other sessions stay signed in — use “Sign out everywhere” if you want them ended." };
}

/**
 * Start moving the login to a new address.
 *
 * ── Nothing changes here ────────────────────────────────────────────────────
 * `updateUser({ email })` does not move the address; it sends confirmation mail.
 * With `double_confirm_changes = true` BOTH the old and the new address must
 * confirm, which is the right setting for a credential: somebody who gets at an
 * open session cannot quietly redirect the login to an address they own, because
 * the old mailbox has to agree.
 *
 * The address actually moves when the last link is followed — possibly days
 * later, from a device this app never sees. `clients.email` is therefore kept in
 * step by a trigger on `auth.users` and NOT from here; see
 * 20260907090000_client_settings.sql for why that cannot be done in the action.
 *
 * ── What is refused, and why here as well as in the database ────────────────
 * A staff-domain target is refused by a trigger, because
 * `stamp_role_from_email` would promote the row to `admin`. It is refused here
 * too so the person gets a sentence instead of a constraint violation — the
 * database is the boundary, this is the explanation.
 */
export async function startEmailChange(newEmail: string): Promise<ActionResult> {
  const { supabase, user } = await currentUser();
  if (!user?.email) return { ok: false, error: "You are not signed in." };

  const address = newEmail.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
    return { ok: false, error: "Enter a valid email address." };
  }
  if (address === user.email.toLowerCase()) {
    return { ok: false, error: "That is already your login address." };
  }

  const admin = createAdminClient();
  const { data: role, error: ruleError } = await admin.rpc("role_from_email_domain", {
    addr: address,
  });
  if (ruleError) {
    console.error("settings: could not read the staff-domain rule — %s", ruleError.message);
    return { ok: false, error: "Could not start the change just now. Please try again." };
  }
  if (role === "admin") {
    return {
      ok: false,
      error:
        "A login cannot be moved to a vitti.capital address. Speak to the desk if you have joined Vitti Capital.",
    };
  }

  // `clients.email` is UNIQUE and is what resolves a client row, so an address
  // already spoken for cannot be taken. Checked with the service role because
  // RLS on `clients` shows the caller only their own row — they would see no
  // conflict and hit a constraint on confirmation instead, days later.
  const { data: taken, error: takenError } = await admin
    .from("clients")
    .select("id")
    .eq("email", address)
    .maybeSingle();
  if (takenError) {
    console.error("settings: could not check %s — %s", address, takenError.message);
    return { ok: false, error: "Could not start the change just now. Please try again." };
  }
  if (taken) {
    // Said plainly. This is the caller's own change and they must be told why it
    // cannot proceed; the enumeration concern that shapes the login form does
    // not apply to an address the caller is trying to claim.
    return {
      ok: false,
      error: "That address is already registered here. Use a different one, or call the desk.",
    };
  }

  // ── The link has to come back HERE, not to whatever Site URL says ───────
  // `{{ .SiteURL }}` is one project-level value and this project serves local
  // development and production from the same Supabase instance, so a template
  // built on it mails every client a link to whichever environment was
  // configured last. It mailed `localhost:3000`. Passing the origin per request
  // moves the decision to the deployment that is actually running.
  //
  // Refused rather than sent without it: a confirmation email whose link points
  // at a host we guessed is worse than no email, because the client clicks it
  // and nothing happens — with no error to tell them why.
  const redirectTo = authConfirmUrl();
  if (!redirectTo) {
    console.error(
      "settings: refusing an email change — neither APP_URL nor VERCEL_PROJECT_PRODUCTION_URL is set, so the confirmation link would have no host",
    );
    return {
      ok: false,
      error: "Changing your email is unavailable just now. Please contact the Vitti desk.",
    };
  }

  const { error } = await supabase.auth.updateUser(
    { email: address },
    { emailRedirectTo: redirectTo },
  );
  if (error) {
    if (error.status === 429) {
      return { ok: false, error: "Too many requests. Wait a minute and try again." };
    }
    console.error("settings: email change failed for %s — %s", user.email, error.message);
    return { ok: false, error: "Could not start the change just now. Please try again." };
  }

  return {
    ok: true,
    message: `Confirmation sent to ${address} and to ${user.email}. Both have to be confirmed before your login changes — until then, keep signing in with your current address.`,
  };
}

/**
 * End every session, on every device — including this one.
 *
 * `scope: "global"` revokes all of the user's refresh tokens rather than only
 * the cookie in this browser, which is the point: the case for this button is a
 * device you no longer have. The UI-state cookies are cleared too, the way
 * `signOut` does, so a shared browser does not keep the last client a staff
 * member inspected.
 */
export async function signOutEverywhere(): Promise<ActionResult> {
  const { supabase, user } = await currentUser();
  if (!user) return { ok: false, error: "You are not signed in." };

  const { error } = await supabase.auth.signOut({ scope: "global" });
  if (error) {
    console.error("settings: global sign-out failed — %s", error.message);
    return { ok: false, error: "Could not sign out everywhere. Please try again." };
  }

  const store = await cookies();
  store.delete(VIEW_COOKIE);
  store.delete(ACCOUNT_COOKIE);

  return { ok: true };
}
