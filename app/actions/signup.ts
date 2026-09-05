"use server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { passwordProblem, confirmationProblem } from "@/lib/auth/password";
import type { Role } from "@/lib/session";
import type { SignInResult, CodeRequestResult } from "./session";

/**
 * Client self-registration, in three steps.
 *
 *   1. `startSignUp`    — name, address, password. Sends a code.
 *   2. `completeSignUp`  — the code. Sets the password, creates the client row.
 *   3. the account claim — `requestAccountClaim` in ./accounts.ts, unchanged.
 *
 * ── Why the service role, and not `supabase.auth.signUp()` ──────────────────
 * `signUp` is a browser-reachable call that requires project-level signups to be
 * ENABLED, and that switch also opens `POST /auth/v1/signup` to anyone holding
 * the anon key. Combined with the `auth.users` trigger that stamps
 * `app_metadata.role = 'admin'` on any `@vitti.capital` address, an open signup
 * endpoint is a staff account for the asking — see
 * supabase/migrations/20260905090000_password_signup.sql for the whole argument.
 *
 * So signups stay off at the project level, the row is created here with the
 * admin API, and this function is the only way in — which is also what makes the
 * staff-address refusal below meaningful rather than advisory.
 *
 * ── Why the code still runs the show ────────────────────────────────────────
 * The password does NOT come into existence at step 1. The user is created
 * without one; `completeSignUp` sets it only after `verifyOtp` succeeds. Until
 * then the address is registered but has no credential, which is exactly the
 * state `ensureStaffAccount` has always left staff in and is safe for the same
 * reason: a session still requires reading mail at that address.
 *
 * That ordering is what stops sign-up being a way to take an address you do not
 * own. Abandon the flow at step 2 and you have created nothing you can use: no
 * password, no `clients` row, no portal.
 */

export type SignUpStartResult = CodeRequestResult;

/**
 * Step 1 — validate, register the address, email a code.
 *
 * Everything is checked again here even though the form checks it too: a server
 * action is a public endpoint, and the form is a convenience for the honest.
 */
export async function startSignUp(input: {
  name: string;
  email: string;
  password: string;
  confirmation: string;
}): Promise<SignUpStartResult> {
  const name = input.name.trim();
  const address = input.email.trim().toLowerCase();

  if (name.length < 2) {
    return { ok: false, error: "Enter your full name." };
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
    return { ok: false, error: "Enter a valid email address." };
  }

  const weak = passwordProblem(input.password);
  if (weak) return { ok: false, error: weak };
  const mismatch = confirmationProblem(input.password, input.confirmation);
  if (mismatch) return { ok: false, error: mismatch };

  const admin = createAdminClient();

  // ── Staff do not register here ──────────────────────────────────────────
  // A Vitti address would be stamped `admin` by the auth.users trigger, so a
  // sign-up completed on one would produce a `clients` row for a staff member —
  // an entity whose `email` then also satisfies `current_client_id()`. The rule
  // is read from the DATABASE rather than re-tested against the suffix here, for
  // the reason `ensureStaffAccount` gives: two copies of "what counts as a Vitti
  // address" eventually disagree, and the disagreement would be an account this
  // form created and the database then classified differently.
  const { data: role, error: ruleError } = await admin.rpc("role_from_email_domain", {
    addr: address,
  });
  if (ruleError) {
    console.error("signup: could not read the staff-domain rule — %s", ruleError.message);
    return { ok: false, error: "Could not start sign-up just now. Please try again." };
  }
  if (role === "admin") {
    // Said plainly, not hidden. This leaks nothing — the rule is the email
    // domain, which the person just typed — and the alternative is a Vitti
    // employee stuck on a form that appears to work and never does.
    return {
      ok: false,
      error:
        "Vitti Capital staff do not register here. Sign in with your work address and we will email you a code.",
    };
  }

  // Created WITHOUT a password (see the header). `email_confirm: true` because
  // the code about to be sent is itself the proof the address is reachable; an
  // unconfirmed row would need a second, differently-typed token to clear and
  // would block the OTP send below.
  //
  // Attempted rather than checked first: `listUsers` is paginated, and a
  // duplicate create is one call that answers "already there".
  const { error: createError } = await admin.auth.admin.createUser({
    email: address,
    email_confirm: true,
    user_metadata: { display_name: name },
  });

  const already =
    createError?.code === "email_exists" || createError?.status === 422;
  if (createError && !already) {
    console.error("signup: could not register %s — %s", address, createError.message);
    return { ok: false, error: "Could not start sign-up just now. Please try again." };
  }

  // An address that is already registered gets the SAME answer as a new one, and
  // a code all the same. Saying "that email already has an account" would turn
  // this form into a test for whether a given person banks here — the enumeration
  // problem `requestLoginCode` is written around. Someone who owns the mailbox
  // completes the flow and effectively resets their own password; someone who
  // does not owns nothing.
  const supabase = await createClient();
  const { error: otpError } = await supabase.auth.signInWithOtp({
    email: address,
    options: { shouldCreateUser: false },
  });

  if (!otpError) return { ok: true };

  if (otpError.status === 429) {
    return {
      ok: false,
      error: "Too many requests. Wait a minute before asking for another code.",
      retryAfter: 60,
    };
  }

  console.error("signup: could not send a code to %s — %s", address, otpError.message);
  return { ok: false, error: "Could not send the code just now. Please try again." };
}

/**
 * Step 2 — verify the code, then set the password and create the client row.
 *
 * The order matters and is the whole security argument: `verifyOtp` is what
 * proves the mailbox, so nothing that grants access happens before it returns.
 * After it returns there IS a session, which is why `updateUser` can set the
 * password as the user rather than through the admin API.
 */
export async function completeSignUp(input: {
  name: string;
  email: string;
  code: string;
  password: string;
}): Promise<SignInResult> {
  const name = input.name.trim();
  const address = input.email.trim().toLowerCase();

  const weak = passwordProblem(input.password);
  if (weak) return { ok: false, error: weak };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.verifyOtp({
    email: address,
    token: input.code.trim(),
    type: "email",
  });

  if (error || !data.user) {
    // Wrong and expired are one message, as on the login page: telling them
    // apart says "that code was real, just late", which is a hint worth having
    // if you are guessing.
    return { ok: false, error: "That code is not valid or has expired." };
  }

  // Now signed in. A weak password is refused by GoTrue here, which is why
  // `passwordProblem` ran first — this point is past the code being consumed.
  const { error: passwordError } = await supabase.auth.updateUser({
    password: input.password,
  });
  if (passwordError) {
    console.error("signup: could not set a password for %s — %s", address, passwordError.message);
    return {
      ok: false,
      error:
        "Your email is verified, but the password could not be saved. Sign in with a one-time code and try again.",
    };
  }

  const role: Role = data.user.app_metadata?.role === "admin" ? "admin" : "client";

  const clientError = await ensureClientRow(address, name);
  if (clientError) {
    return { ok: false, error: clientError };
  }

  return { ok: true, role };
}

/**
 * The `clients` row behind the login.
 *
 * ── Why the service role ────────────────────────────────────────────────────
 * `clients` has a SELECT policy and no INSERT policy at all
 * (20260702090000_enable_rls.sql says "No app writes"), because until now every
 * client row arrived from the broker import or a seed script. Self-registration
 * is the first case where a signed-in user's own action has to create one. The
 * alternative — an INSERT policy on `clients` — would have to be written as
 * "any authenticated user may insert a row", since the row does not exist yet to
 * be matched against `current_client_id()`. That is a wider grant than doing it
 * here with the service role on a single, fully-specified row.
 *
 * ── Why it is idempotent ────────────────────────────────────────────────────
 * `clients.email` is UNIQUE and an existing client can legitimately reach this
 * point (see the enumeration note in `startSignUp`). Inserting unconditionally
 * would fail on the constraint and strand somebody who already had an account
 * mid-flow. Their existing row — and every account hanging off it — is left
 * exactly as it is.
 */
async function ensureClientRow(address: string, name: string): Promise<string | null> {
  const admin = createAdminClient();

  const { data: existing, error: lookupError } = await admin
    .from("clients")
    .select("id")
    .eq("email", address)
    .maybeSingle();

  if (lookupError) {
    console.error("signup: could not read clients for %s — %s", address, lookupError.message);
    return "Your account was created but the profile could not be read. Contact the Vitti desk.";
  }
  if (existing) return null;

  const { error } = await admin.from("clients").insert({
    email: address,
    display_name: name,
    initials: initialsFrom(name),
  });

  if (error) {
    console.error("signup: could not create a client row for %s — %s", address, error.message);
    return "Your email is verified but your profile could not be created. Contact the Vitti desk.";
  }

  return null;
}

/**
 * Avatar initials from a display name — 'James Halloran' → 'JH'.
 *
 * First and LAST word rather than the first two, so 'Margaret van der Berg'
 * gives 'MB' and not 'MV'. A single word gives one letter; the column is
 * nullable and the UI falls back on its own, so there is nothing to invent.
 */
function initialsFrom(name: string): string | null {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const first = words[0][0];
  const last = words.length > 1 ? words[words.length - 1][0] : "";
  return (first + last).toUpperCase();
}
