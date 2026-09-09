"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getActor } from "@/lib/session";

/**
 * Watching a security, from wherever it was noticed.
 *
 * ── Why this exists now ────────────────────────────────────────────────────
 * The Watchlist page has had an "add" since it was built, and it never wrote
 * anything: the list was seeded from the database into React state, and
 * everything after that was local (see WatchlistClient — "add/remove were never
 * persisted"). It survived a reload looking like it had worked, because the
 * seed came back. Reading a filing on Market and wanting to follow that company
 * is the first time a client has had a real reason to add one, so this is the
 * first write.
 *
 * The table has been ready the whole time: `watchlist_items` carries
 * `UNIQUE (client_id, security_code)`, and its RLS policy already lets a client
 * insert and delete their own rows. Nothing new is needed underneath.
 */

export type WatchResult =
  | { ok: true; watching: boolean }
  | { ok: false; error: string };

/**
 * Add a security to the signed-in client's watchlist.
 *
 * Idempotent by way of the unique index rather than by checking first: two
 * quick clicks are a race, and the database is the only place that can settle
 * it. A duplicate comes back as success — the client asked to be watching this,
 * and they are.
 */
export async function addToWatchlist(
  code: string,
  displayName: string,
): Promise<WatchResult> {
  const { actor, role, clientId } = await getActor();
  if (!clientId) return { ok: false, error: "No active client" };

  const security = code.trim().toUpperCase();
  if (!security) return { ok: false, error: "No security code" };

  const supabase = await createClient();
  const { error } = await supabase.from("watchlist_items").insert({
    client_id: clientId,
    security_code: security,
    display_name: displayName.trim() || security,
    unlisted: false,
  });

  if (error) {
    // 23505 is the unique index doing its job.
    if (error.code !== "23505") return { ok: false, error: error.message };
    return { ok: true, watching: true };
  }

  await supabase.from("audit_log").insert({
    actor,
    role,
    action: "Added to watchlist",
    detail: security,
    client_id: clientId,
  });

  revalidatePath("/portal/client/watchlist");
  return { ok: true, watching: true };
}

/** Remove it again. Silent when it was not there — the end state is the ask. */
export async function removeFromWatchlist(code: string): Promise<WatchResult> {
  const { actor, role, clientId } = await getActor();
  if (!clientId) return { ok: false, error: "No active client" };

  const security = code.trim().toUpperCase();
  if (!security) return { ok: false, error: "No security code" };

  const supabase = await createClient();
  const { error } = await supabase
    .from("watchlist_items")
    .delete()
    .eq("client_id", clientId)
    .eq("security_code", security);

  if (error) return { ok: false, error: error.message };

  await supabase.from("audit_log").insert({
    actor,
    role,
    action: "Removed from watchlist",
    detail: security,
    client_id: clientId,
  });

  revalidatePath("/portal/client/watchlist");
  return { ok: true, watching: false };
}
