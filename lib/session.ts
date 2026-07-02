import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";

/**
 * Session bridge — now backed by REAL Supabase Auth (Stage 7).
 *
 * `role` and identity come from `supabase.auth.getUser()` (a verified token,
 * refreshed by the root proxy), NOT from a user-writable cookie. The client's
 * `role` lives in `app_metadata.role` ('admin' | 'client'), stamped when the
 * auth user is created (see scripts/seed-auth-users.mjs).
 *
 * `clientId` is resolved by matching the authenticated email to `clients.email`.
 * The only thing still stored in a cookie is `viewClient` — which client a staff
 * member is currently inspecting — since that is UI state, not identity.
 *
 * NOTE (deferred): route protection (redirect unauthenticated → /login) and
 * Postgres RLS are the next steps; until then an unauthenticated request still
 * falls back to the first seeded client so the demo stays renderable.
 */

export type Role = "client" | "admin";
export type Session = { role: Role; clientId: string; viewClient: string };

/** Cookie holding the client a staff member is inspecting (UI state only). */
export const VIEW_COOKIE = "vitti_view";

/** Cookie holding the account a client is currently viewing (UI state only). */
export const ACCOUNT_COOKIE = "vitti_account";

/** Read the verified auth user + derived role once per request. */
const getAuth = cache(
  async (): Promise<{ email: string | null; role: Role }> => {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { email: null, role: "client" };
    const role: Role =
      user.app_metadata?.role === "admin" ? "admin" : "client";
    return { email: user.email ?? null, role };
  },
);

/** id of the first seeded client — pre-login / staff-default fallback. */
const firstClientId = cache(async (): Promise<string> => {
  const supabase = await createClient();
  const { data } = await supabase
    .from("clients")
    .select("id")
    .order("ref")
    .limit(1)
    .maybeSingle();
  return data?.id ?? "";
});

async function clientIdByEmail(email: string): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("clients")
    .select("id")
    .eq("email", email.toLowerCase())
    .maybeSingle();
  return data?.id ?? null;
}

async function viewCookie(): Promise<string | null> {
  const store = await cookies();
  return store.get(VIEW_COOKIE)?.value ?? null;
}

/**
 * The client whose data the current request should show:
 *  - staff → the client they are inspecting (viewClient cookie), else the first;
 *  - client → their own row (email match), else the first seeded client.
 */
export async function getActiveClientId(): Promise<string> {
  const { email, role } = await getAuth();

  if (role === "admin") {
    return (await viewCookie()) ?? (await firstClientId());
  }

  if (email) {
    const id = await clientIdByEmail(email);
    if (id) return id;
  }
  return firstClientId();
}

/**
 * The account whose holdings the current request should show. Resolves the
 * active client, then honours the `vitti_account` cookie *only if that account
 * belongs to the client* (else falls back to their first account by ref). A
 * client with a single account never needs the cookie. Returns "" if the client
 * has no accounts.
 */
export async function getActiveAccountId(): Promise<string> {
  const clientId = await getActiveClientId();
  if (!clientId) return "";

  const supabase = await createClient();
  const { data } = await supabase
    .from("accounts")
    .select("id")
    .eq("client_id", clientId)
    .order("ref");
  const accounts = data ?? [];
  if (accounts.length === 0) return "";

  const cookieId = (await cookies()).get(ACCOUNT_COOKIE)?.value;
  if (cookieId && accounts.some((a) => a.id === cookieId)) return cookieId;
  return accounts[0].id;
}

/** Back-compat shape for callers that read the whole session (e.g. the layout). */
export async function getSession(): Promise<Session | null> {
  const { email, role } = await getAuth();
  if (!email) return null;
  const clientId = await getActiveClientId();
  const viewClient = (await viewCookie()) ?? clientId;
  return { role, clientId, viewClient };
}

/**
 * Resolves the acting user for audit-log writes in server actions. Staff act as
 * the desk ("S. Goyal (staff)"); a client acts under their `display_name`.
 */
export async function getActor(): Promise<{
  role: Role;
  clientId: string;
  actor: string;
}> {
  const { email, role } = await getAuth();
  const clientId = await getActiveClientId();

  if (role === "admin") {
    return { role, clientId, actor: "S. Goyal (staff)" };
  }

  const supabase = await createClient();
  const { data } = email
    ? await supabase
        .from("clients")
        .select("display_name")
        .eq("email", email.toLowerCase())
        .maybeSingle()
    : { data: null };
  return { role, clientId, actor: data?.display_name ?? "Client" };
}
