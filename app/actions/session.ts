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
 * know, which on a login form means anyone who types an email gets an account —
 * and, with the role trigger, anyone typing `@vitti.capital` gets a staff one.
 * Users here are provisioned deliberately (see scripts/seed-auth-users.mjs);
 * this form must never mint one.
 */
export async function requestLoginCode(email: string): Promise<CodeRequestResult> {
  const address = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
    return { ok: false, error: "Enter a valid email address." };
  }

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
