"use server";

import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { SESSION_COOKIE, type Role, getSession } from "@/lib/session";

const MAX_AGE = 60 * 60 * 24 * 7; // 7 days

async function writeSession(role: Role, clientId: string, viewClient: string) {
  const store = await cookies();
  store.set(SESSION_COOKIE, JSON.stringify({ role, clientId, viewClient }), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE,
  });
}

/**
 * Called from the login flow after 2FA. A client is resolved by the email they
 * signed in with; staff (or an unrecognised email) fall back to the first
 * seeded client as their initial view context. Returns the resolved client
 * `ref` so the caller can keep the legacy store in sync during the migration.
 */
export async function signIn(
  role: Role,
  email?: string,
): Promise<string | null> {
  const supabase = await createClient();

  let row: { id: string; ref: string | null } | null = null;
  if (role === "client" && email) {
    const { data } = await supabase
      .from("clients")
      .select("id, ref")
      .eq("email", email.trim().toLowerCase())
      .maybeSingle();
    row = data;
  }
  if (!row) {
    const { data } = await supabase
      .from("clients")
      .select("id, ref")
      .order("ref")
      .limit(1)
      .maybeSingle();
    row = data;
  }

  const clientId = row?.id ?? "";
  await writeSession(role, clientId, clientId);
  return row?.ref ?? null;
}

/** Staff: switch which client they are inspecting. */
export async function setViewClient(clientId: string) {
  const session = await getSession();
  if (!session) return;
  await writeSession(session.role, session.clientId, clientId);
}

export async function signOut() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
