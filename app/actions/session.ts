"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
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

export type CodeRequestResult =
  | { ok: true }
  | { ok: false; error: string; retryAfter?: number };

/**
 * Sign-in is a one-time code emailed to the address — there is no password.
 *
 * ── Why no password ──────────────────────────────────────────────────────────
 * A code emailed ON TOP of a password looks like a second factor and is not one:
 * `signInWithPassword` returns a fully valid session the moment the password is
 * accepted, so anything after it is decoration a caller can skip by using the
 * token from the first step. That is exactly what the old login screen did — it
 * collected six digits and threw them away.
 *
 * Making the code the ONLY credential removes the gap rather than papering over
 * it: Supabase itself refuses to mint a session until `verifyOtp` succeeds, so
 * there is no half-authenticated state to guard and nothing for the proxy or RLS
 * to be taught about.
 *
 * ── `shouldCreateUser: false` is load-bearing ───────────────────────────────
 * By default `signInWithOtp` CREATES an auth user for an address it does not
 * know — and it can only do that if project-level signups are ENABLED, which
 * also leaves `POST /auth/v1/signup` open to anyone holding the (public) anon
 * key, password and all. So the flag stays false and staff self-service is done
 * a different way; see `ensureStaffAccount`.
 */
export async function requestLoginCode(email: string): Promise<CodeRequestResult> {
  const address = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
    return { ok: false, error: "Enter a valid email address." };
  }

  // A staff address that has never signed in is created here, so the code below
  // has somebody to send to. Clients are still provisioned deliberately.
  await ensureStaffAccount(address);

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
 * Anyone with a Vitti address can sign in without being added first.
 *
 * ── Why the domain is enough ────────────────────────────────────────────────
 * The code is emailed, so completing a sign-in requires READING mail at the
 * address. `vitti.capital` mailboxes are the firm's own Microsoft 365 tenant, so
 * only real staff can receive one. An outsider can ask for a code addressed to
 * `ceo@vitti.capital` all day and will never see it. The domain is therefore not
 * a claim the form trusts — it is a claim the mail delivery has to prove.
 *
 * ── Why not `shouldCreateUser: true` ────────────────────────────────────────
 * Same outcome, much wider door. That flag only works when project-level signups
 * are enabled, and that setting also governs `POST /auth/v1/signup`, which is
 * reachable by anyone with the anon key out of the browser bundle. Enabling it
 * to get staff self-service would hand out password-based accounts on any
 * address as a side effect. Creating the row here with the service role keeps
 * signups switched off.
 *
 * ── The staff-domain rule is read from the DATABASE ─────────────────────────
 * `role_from_email_domain` is the same function the `auth.users` trigger uses to
 * stamp the role. Calling it rather than re-testing the suffix here is the point:
 * two copies of "what counts as a Vitti address" would eventually disagree, and
 * the disagreement would be an account this form created and the database then
 * classified as a client. If the call fails we create nothing — an unprovisioned
 * address gets no code, which is the existing behaviour and the safe one.
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
async function ensureStaffAccount(address: string): Promise<void> {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const admin = createAdminClient();

  const { data: role, error: ruleError } = await admin.rpc("role_from_email_domain", {
    addr: address,
  });
  if (ruleError) {
    console.error("login: could not read the staff-domain rule — %s", ruleError.message);
    return;
  }
  if (role !== "admin") return;

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
