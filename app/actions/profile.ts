"use server";

import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { passwordProblem, confirmationProblem } from "@/lib/auth/password";
import { VIEW_COOKIE, ACCOUNT_COOKIE } from "@/lib/session";

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
 * Step 1 of moving the login: send a code to the new address.
 *
 * ── Nothing changes here ────────────────────────────────────────────────────
 * `updateUser({ email })` does not move the address; it sends mail. The address
 * moves when `confirmEmailChange` verifies the code below.
 *
 * ── One mailbox, on the desk's instruction ─────────────────────────────────
 * `double_confirm_changes` is OFF, so only the NEW address is sent anything.
 * What that gives up is worth stating where the code lives: the old mailbox no
 * longer has to agree, so somebody who reaches an open session can point the
 * login at an address they own and the real owner is never told. The second
 * confirmation was the only thing preventing that. Accepted deliberately — see
 * LLD §8.39 and the note in supabase/config.toml.
 *
 * There is no `emailRedirectTo` any more, and nothing here depends on
 * `authConfirmUrl()`, the dashboard's Redirect URLs, or `SiteURL`: the mail
 * carries a six-digit code rather than a link, so there is no host to get wrong.
 * The old template, built on `SiteURL`, mailed clients `localhost:3000`.
 *
 * The `client_emails` row is still moved by the trigger on `auth.users` rather
 * than from here — see 20260907090000_client_settings.sql. The trigger observes
 * the actual change, which is the only thing that cannot disagree with it.
 *
 * ── This still MOVES one address; it does not add one ──────────────────────
 * A client may hold several logins now (20260911090000_client_emails.sql), and
 * this changes the one the caller is signed in as, leaving their others alone.
 * Adding a second address is `./emails.ts`, which is a different act with a
 * different outcome: after this, the old address stops working.
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

  // `client_emails.email` is UNIQUE and is what resolves a client row, so an
  // address already spoken for cannot be taken. Checked there rather than
  // against `clients.email`, which since 20260911090000_client_emails.sql only
  // mirrors each client's PRIMARY address — an address that is somebody's
  // second login would not appear in it, and this check would wave through a
  // change that the unique index then refuses on confirmation.
  //
  // With the service role because RLS shows the caller only their own rows:
  // they would see no conflict and hit a constraint days later.
  const { data: taken, error: takenError } = await admin
    .from("client_emails")
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

  // No `emailRedirectTo`: the mail carries a code, not a link, so there is no
  // origin to resolve and nothing to keep in step per environment.
  const { error } = await supabase.auth.updateUser({ email: address });
  if (error) {
    if (error.status === 429) {
      return { ok: false, error: "Too many requests. Wait a minute and try again." };
    }
    console.error("settings: email change failed for %s — %s", user.email, error.message);
    return { ok: false, error: "Could not start the change just now. Please try again." };
  }

  return {
    ok: true,
    message: `Code sent to ${address}. Enter it below to finish the change — until then, keep signing in with your current address.`,
  };
}

/**
 * Step 2: verify the code and move the login.
 *
 * ── Why the NEW address is the one passed to `verifyOtp` ────────────────────
 * That is where the code was sent. With `double_confirm_changes` off there is
 * exactly one token in play and one mailbox holding it, so there is no ambiguity
 * about which address the caller is proving control of — which is the whole
 * reason this flow can be a code at all. Under double confirmation there were
 * two tokens and the last one might be confirmed from a device with no session,
 * and that is why it used to be a link.
 *
 * ── The address is re-derived, not trusted from the form ───────────────────
 * `auth.users.email_change` already holds the pending target, put there by
 * `startEmailChange` after the staff-domain and uniqueness checks. Reading it
 * back means the code is verified against the address those checks passed on,
 * not against whatever the browser sends in this second call. A caller who
 * posted a different address here would otherwise be verifying a token for an
 * address nothing had validated.
 *
 * ── `client_emails` is still not touched here ─────────────────────────────
 * `sync_client_email_from_auth` observes the change inside the auth transaction
 * (20260907090000_client_settings.sql). Doing it here as well would be a second
 * writer to the same fact, and the trigger is the one that cannot be skipped.
 * It moves the row for the OLD address, so a client who changes a secondary
 * login keeps their primary where it was.
 */
export async function confirmEmailChange(code: string): Promise<ActionResult> {
  const { supabase, user } = await currentUser();
  if (!user?.email) return { ok: false, error: "You are not signed in." };

  const token = code.trim();
  if (!/^\d{6}$/.test(token)) {
    return { ok: false, error: "Enter the 6-digit code from the email." };
  }

  // `email_change` is the pending target; it is empty once there is nothing in
  // flight, which is a clearer thing to say than letting `verifyOtp` fail.
  const pending = (user.new_email ?? "").trim().toLowerCase();
  if (!pending) {
    return {
      ok: false,
      error: "There is no email change waiting. Enter your new address above to start one.",
    };
  }

  const { error } = await supabase.auth.verifyOtp({
    email: pending,
    token,
    type: "email_change",
  });
  if (error) {
    if (error.status === 429) {
      return { ok: false, error: "Too many attempts. Wait a minute and try again." };
    }
    // Wrong and expired are one message, as everywhere else here: telling them
    // apart says "that code was real, just late", which is a hint worth having
    // if you are guessing.
    return { ok: false, error: "That code is not valid or has expired." };
  }

  return {
    ok: true,
    message: `Your login is now ${pending}. Use it next time you sign in.`,
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
