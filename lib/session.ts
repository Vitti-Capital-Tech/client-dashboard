import "server-only";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";

/**
 * Lightweight session bridge (Stage 5). The login flow writes a cookie holding
 * { role, clientId, viewClient }; server components read it here. This is the
 * interim replacement for the client-side Zustand session — real Supabase Auth
 * (auth.uid()) + RLS will later replace the cookie read with `getUser()`.
 */

export type Role = "client" | "admin";
export type Session = { role: Role; clientId: string; viewClient: string };

export const SESSION_COOKIE = "vitti_session";

export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    if (s && typeof s.clientId === "string" && typeof s.role === "string") {
      return s as Session;
    }
  } catch {
    // malformed cookie — treat as no session
  }
  return null;
}

/**
 * The client whose data a client-portal page should show. Falls back to the
 * first seeded client when there is no session (keeps the demo renderable
 * before login and during the incremental migration).
 */
export async function getActiveClientId(): Promise<string> {
  const session = await getSession();
  if (session?.clientId) return session.clientId;

  const supabase = await createClient();
  const { data } = await supabase
    .from("clients")
    .select("id")
    .order("ref")
    .limit(1)
    .maybeSingle();
  return data?.id ?? "";
}
