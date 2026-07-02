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

/**
 * Real Supabase Auth sign-in (Stage 7). Verifies the password against
 * `auth.users`; on success @supabase/ssr writes the session cookies through the
 * server client's cookie adapter (server actions CAN set cookies). The role is
 * read from the user's `app_metadata.role`.
 */
export async function signInWithPassword(
  email: string,
  password: string,
): Promise<SignInResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password,
  });

  if (error || !data.user) {
    return { ok: false, error: error?.message ?? "Sign-in failed" };
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
