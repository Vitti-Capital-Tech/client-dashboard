"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { passwordProblem } from "@/lib/auth/password";
import {
  VIEW_COOKIE,
  ACCOUNT_COOKIE,
  type Role,
  getActor,
} from "@/lib/session";

const MAX_AGE = 60 * 60 * 24 * 7; // 7 days

export type SignInResult =
  | { ok: true; role: Role }
  | { ok: false; error: string };

/**
 * Which sign-in page is asking.
 *
 * Clients and staff have separate doors — /login and /staff/login — and this is
 * what makes that separation real rather than cosmetic. It is NOT a security
 * boundary and must never be read as one: the role is stamped on `auth.users`
 * from the email domain and enforced by RLS, so a client who finds the staff URL
 * gains nothing by loading it. What the audience buys is that each page refuses
 * the addresses it is not for, instead of quietly sending someone a code and
 * landing them somewhere the page did not describe.
 */
export type Audience = "client" | "staff";

export type CodeRequestResult =
  | { ok: true }
  // `wrongDoor` is set when the address is real but belongs at the other page,
  // so the form can offer the link rather than leaving them to find it. It says
  // nothing a caller did not already know: the rule is the email domain, which
  // they just typed.
  | { ok: false; error: string; retryAfter?: number; wrongDoor?: string };

/**
 * Email a one-time code. One of the two ways in; `signInWithPassword` is the
 * other.
 *
 * ── The code is a credential, never a second factor ─────────────────────────
 * These two are ALTERNATIVES and the distinction is load-bearing. A code emailed
 * ON TOP of a password looks like a second factor and is not one:
 * `signInWithPassword` returns a fully valid session the moment the password is
 * accepted, so anything after it is decoration a caller can skip by using the
 * token from the first step. An earlier version of the login screen did exactly
 * that — collected six digits and threw them away.
 *
 * So each path mints a session on its own and neither pretends to be more than
 * it is. Real second-factor enrolment is Supabase MFA (`auth.mfa`), which gates
 * the session at the token level rather than in front of a form; if the desk
 * wants 2FA, that is the thing to reach for, not a code bolted onto a password.
 *
 * ── Why the code path survived the arrival of passwords ─────────────────────
 * It is what a client with no password uses — every account provisioned by the
 * broker import or by `scripts/link-client-login.mjs` has one and only one way
 * in — and it is the reset path when a password is forgotten (`resetPassword`).
 * Removing it would strand every login that predates the sign-up page.
 *
 * ── `shouldCreateUser: false` is load-bearing ───────────────────────────────
 * By default `signInWithOtp` CREATES an auth user for an address it does not
 * know — and it can only do that if project-level signups are ENABLED, which
 * also leaves `POST /auth/v1/signup` open to anyone holding the (public) anon
 * key, password and all. That endpoint is a staff account for the asking, since
 * the `auth.users` trigger stamps `admin` on any `@vitti.capital` address: see
 * supabase/migrations/20260905090000_password_signup.sql. So the flag stays
 * false, project signups stay off, and both self-service paths — staff on first
 * sign-in (`ensureStaffAccount`) and clients registering (`startSignUp`) —
 * create their row with the service role instead.
 */
export async function requestLoginCode(
  email: string,
  audience: Audience = "client",
): Promise<CodeRequestResult> {
  const address = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
    return { ok: false, error: "Enter a valid email address." };
  }

  // ── Which door this address belongs at ──────────────────────────────────
  // `null` means the rule could not be read. The gate is then SKIPPED rather
  // than failing closed: a hiccup reading one function should not take sign-in
  // down for everybody, and the wrong-door case degrades to what the page did
  // before there were two doors — the code still works, and the role decides
  // where they land. Provisioning is skipped in that case, as it always was.
  const staff = await isStaffAddress(address);

  if (staff === true && audience === "client") {
    return {
      ok: false,
      error:
        "That is a Vitti Capital address. Staff sign in through the desk console.",
      wrongDoor: "/staff/login",
    };
  }
  if (staff === false && audience === "staff") {
    return {
      ok: false,
      error: "This console is for Vitti Capital staff. Clients sign in here.",
      wrongDoor: "/login",
    };
  }

  // A staff address that has never signed in is created here, so the code below
  // has somebody to send to. Clients are never provisioned this way: they arrive
  // from the broker import, from `scripts/link-client-login.mjs`, or by
  // registering at /signup.
  if (staff === true) await provisionStaffAccount(address);

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: address,
    options: { shouldCreateUser: false },
  });

  if (!error) return { ok: true };

  // Asking too often is about the CALLER's own request, so saying so leaks
  // nothing and is the one message that actually helps.
  if (error.status === 429) {
    return {
      ok: false,
      error: "Too many requests. Wait a minute before asking for another code.",
      retryAfter: 60,
    };
  }

  // An address we do not hold answers `otp_disabled` — and that answer must NOT
  // reach the browser. Which of a wealth manager's clients has a login is itself
  // client information, and a login form that distinguishes "no such user" from
  // "code sent" hands over the list an address at a time. So it reports success
  // and says nothing.
  if (error.code === "otp_disabled" || error.status === 422) {
    console.warn("login: no code sent to %s — %s", address, error.message);
    return { ok: true };
  }

  // Anything else is our side failing — most likely the mail provider. Reported,
  // because letting someone wait for a code that was never sent is worse than
  // telling them to try again.
  console.error("login: could not send a code to %s — %s", address, error.message);
  return { ok: false, error: "Could not send the code just now. Please try again." };
}

/**
 * Is this a Vitti address? Answered by the DATABASE, not by a suffix test here.
 *
 * `role_from_email_domain` is the same function the `auth.users` trigger uses to
 * stamp the role, and calling it rather than re-testing `@vitti.capital` in
 * TypeScript is the point: two copies of "what counts as a Vitti address" would
 * eventually disagree, and the disagreement would be somebody routed to one door
 * by the app and classified the other way by the database.
 *
 * Returns `null` when the rule could not be read at all — distinct from `false`,
 * because "not staff" and "we do not know" want different handling and a boolean
 * would collapse them into the more dangerous one.
 */
async function isStaffAddress(address: string): Promise<boolean | null> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();

  const { data: role, error } = await admin.rpc("role_from_email_domain", {
    addr: address,
  });
  if (error) {
    console.error("login: could not read the staff-domain rule — %s", error.message);
    return null;
  }
  return role === "admin";
}

/**
 * Anyone with a Vitti address can sign in without being added first.
 *
 * ── Why the domain is enough ────────────────────────────────────────────────
 * The code is emailed, so completing a sign-in requires READING mail at the
 * address. `vitti.capital` mailboxes are the firm's own Microsoft 365 tenant, so
 * only real staff can receive one. An outsider can ask for a code addressed to
 * `ceo@vitti.capital` all day and will never see it. The domain is therefore not
 * a claim the form trusts — it is a claim the mail delivery has to prove.
 *
 * That sentence is the whole reason staff have no passwords. A password is a
 * credential that works WITHOUT the mailbox, so the moment a `@vitti.capital`
 * account has one, self-provisioning from the domain stops being backed by
 * anything. Hence `signInWithPassword` and `requestPasswordResetCode` both
 * refuse staff addresses, and 20260905090000_password_signup.sql refuses to let
 * one be created with a password at all.
 *
 * ── Why not `shouldCreateUser: true` ────────────────────────────────────────
 * Same outcome, much wider door. That flag only works when project-level signups
 * are enabled, and that setting also governs `POST /auth/v1/signup`, which is
 * reachable by anyone with the anon key out of the browser bundle. Enabling it
 * to get staff self-service would hand out password-based accounts on any
 * address as a side effect. Creating the row here with the service role keeps
 * signups switched off.
 *
 * ── What it costs when abused ───────────────────────────────────────────────
 * Someone can make this create rows for addresses that do not exist
 * (`a@vitti.capital`, `b@…`). None of them can ever sign in, but each sends mail
 * that bounces, and bounces are what damage a sending domain's reputation. The
 * project's own email rate limit is what bounds this; if it ever becomes real
 * abuse, the next step is checking the address against the tenant's directory
 * (Graph `User.Read.All`, which the app registration does not hold today) before
 * creating anything.
 */
async function provisionStaffAccount(address: string): Promise<void> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();

  // Attempted rather than checked first: `listUsers` is paginated and this runs
  // on every code request, while a duplicate create is one call that answers
  // "already there". The role is NOT passed — the trigger owns it.
  const { error } = await admin.auth.admin.createUser({
    email: address,
    // Confirmed, because the code about to be emailed is itself the proof that
    // the address is real and reachable. An unconfirmed row would need a second,
    // differently-typed token to clear and buys nothing.
    email_confirm: true,
  });

  if (!error) {
    console.info("login: provisioned staff account %s on first sign-in", address);
    return;
  }

  // Already registered is the normal case — every sign-in after the first.
  if (error.code === "email_exists" || error.status === 422) return;

  console.error("login: could not provision %s — %s", address, error.message);
}

/**
 * Exchange the emailed code for a session.
 *
 * `type: "email"` is the one `signInWithOtp` issues. On success @supabase/ssr
 * writes the session cookies through the server client's cookie adapter — server
 * actions can set cookies, which is the whole reason sign-in lives here rather
 * than in the browser. The role is read from `app_metadata.role`, stamped from
 * the address's domain by a trigger on `auth.users`.
 */
export async function verifyLoginCode(
  email: string,
  code: string,
): Promise<SignInResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.verifyOtp({
    email: email.trim().toLowerCase(),
    token: code.trim(),
    type: "email",
  });

  if (error || !data.user) {
    // Wrong and expired are deliberately one message: a form that tells them
    // apart says "that code was real, just late", which is a hint worth having
    // if you are guessing.
    return { ok: false, error: "That code is not valid or has expired." };
  }

  const role: Role =
    data.user.app_metadata?.role === "admin" ? "admin" : "client";
  return { ok: true, role };
}

/**
 * Sign in with a password. The other way in; see `requestLoginCode`.
 *
 * ── One message for every failure ───────────────────────────────────────────
 * Wrong password, no such address, and "this account has never had a password"
 * all answer the same thing. The third is the one worth dwelling on: every login
 * that predates the sign-up page — the seeded clients, anything from
 * `scripts/link-client-login.mjs`, every staff account — has an `auth.users` row
 * with no `encrypted_password`. Reporting that distinctly would say "this address
 * is registered here, it simply has no password yet", which is the client list
 * leaking one address at a time, the exact problem `requestLoginCode` is written
 * around. It would also be an invitation: a stranger who learns an address is
 * password-less knows the reset flow is the way in.
 *
 * The hint that this account might want the code instead belongs on the form,
 * offered to everyone, not in an error that fires only for real addresses.
 */
export async function signInWithPassword(
  email: string,
  password: string,
): Promise<SignInResult> {
  const address = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address) || !password) {
    return { ok: false, error: "Enter your email and password." };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: address,
    password,
  });

  if (error || !data.user) {
    if (error?.status === 429) {
      return {
        ok: false,
        error: "Too many attempts. Wait a minute and try again.",
      };
    }
    return {
      ok: false,
      error: "That email and password do not match. Try a one-time code instead.",
    };
  }

  const role: Role =
    data.user.app_metadata?.role === "admin" ? "admin" : "client";

  // ── Staff do not sign in with a password ────────────────────────────────
  // Nothing is supposed to give a `@vitti.capital` account one: the sign-up page
  // refuses those addresses, the reset flow refuses them, and an INSERT carrying
  // a password is refused by the database. This is what happens if one exists
  // anyway — set before those rules landed, or by a route nobody remembered.
  //
  // Checked on the ROLE the session actually carries rather than on the address,
  // because that is the value RLS will use; and the session is thrown away
  // rather than merely redirected, since a valid staff session obtained without
  // the mailbox is the exact thing this design does not allow to exist.
  if (role === "admin") {
    await supabase.auth.signOut();
    return {
      ok: false,
      error:
        "Vitti Capital staff sign in with a one-time code, not a password. Use the desk console.",
    };
  }

  return { ok: true, role };
}

/**
 * Send the code that authorises a password change.
 *
 * Separate from `requestLoginCode` for one reason: it refuses staff. Setting a
 * password is the one thing a Vitti address must never end up doing, since a
 * password works without the mailbox and the mailbox is the entire basis on
 * which staff accounts provision themselves — see `provisionStaffAccount`.
 *
 * The refusal happens HERE, before the mail goes out, rather than in
 * `resetPassword` after the code is verified. Refusing later would spend a code
 * and make somebody read an email to be told no.
 */
export async function requestPasswordResetCode(
  email: string,
): Promise<CodeRequestResult> {
  const address = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
    return { ok: false, error: "Enter a valid email address." };
  }

  if ((await isStaffAddress(address)) === true) {
    return {
      ok: false,
      error:
        "Vitti Capital staff do not have passwords. Sign in with a one-time code.",
      wrongDoor: "/staff/login",
    };
  }

  return requestLoginCode(address, "client");
}

/**
 * Set a new password after proving the mailbox with an emailed code.
 *
 * ── Why a code and not a reset LINK ─────────────────────────────────────────
 * `resetPasswordForEmail` is the conventional call and it sends a link, which
 * would mean a second email template, a callback route to exchange the token,
 * and a second kind of credential in the system — all to prove the same fact the
 * six-digit code already proves. The code path is here, it works, and this
 * screen is the one already built to consume it.
 *
 * The security property is identical either way: possession of the mailbox is
 * what authorises the change. A reset link is a bearer token in a URL; a code is
 * a bearer token in a body. Neither is stronger, and the code does not end up in
 * browser history or a referrer header.
 *
 * ── Why `verifyOtp` comes first ─────────────────────────────────────────────
 * `updateUser({ password })` changes the password of whoever the CURRENT session
 * belongs to. Calling it without verifying first would either fail (no session)
 * or, worse, silently change the password of someone already signed in on that
 * browser. Verifying establishes the session as the person who owns the address,
 * and only then is there anything to update.
 *
 * A caller who reaches this while already signed in as somebody else is fine:
 * `verifyOtp` replaces the session with the verified one before `updateUser`
 * reads it.
 */
export async function resetPassword(
  email: string,
  code: string,
  password: string,
): Promise<SignInResult> {
  const weak = passwordProblem(password);
  if (weak) return { ok: false, error: weak };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.verifyOtp({
    email: email.trim().toLowerCase(),
    token: code.trim(),
    type: "email",
  });

  if (error || !data.user) {
    return { ok: false, error: "That code is not valid or has expired." };
  }

  // Defence in depth behind `requestPasswordResetCode`, which refuses staff
  // before any mail is sent. Read off the verified session rather than the
  // address, so it holds even if the domain rule changed between the two calls.
  if (data.user.app_metadata?.role === "admin") {
    await supabase.auth.signOut();
    return {
      ok: false,
      error:
        "Vitti Capital staff do not have passwords. Sign in with a one-time code.",
    };
  }

  const { error: updateError } = await supabase.auth.updateUser({ password });
  if (updateError) {
    console.error("reset: could not set a password — %s", updateError.message);
    // The code is spent by now, so "try again" means asking for a new one. Said
    // explicitly rather than leaving them clicking a dead button.
    return {
      ok: false,
      error: "Could not save that password. Request a new code and try again.",
    };
  }

  const role: Role =
    data.user.app_metadata?.role === "admin" ? "admin" : "client";
  return { ok: true, role };
}

/** Staff: switch which client they are inspecting (UI state cookie). */
export async function setViewClient(clientId: string) {
  const { role } = await getActor();
  if (role !== "admin") return; // only staff may inspect other clients
  const store = await cookies();
  store.set(VIEW_COOKIE, clientId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
  });
}

/**
 * Client: switch which of their accounts is active (UI state cookie). Verifies
 * the account belongs to the caller before setting it — a client can only view
 * their own accounts. (Staff switch clients via setViewClient, not this.)
 */
export async function setActiveAccount(accountId: string) {
  const { clientId } = await getActor();
  const supabase = await createClient();
  const { data } = await supabase
    .from("accounts")
    .select("id")
    .eq("id", accountId)
    .eq("client_id", clientId)
    .maybeSingle();
  if (!data) return; // not the caller's account — ignore

  const store = await cookies();
  store.set(ACCOUNT_COOKIE, accountId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
  });
  revalidatePath("/portal", "layout");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  const store = await cookies();
  store.delete(VIEW_COOKIE);
  store.delete(ACCOUNT_COOKIE);
}
