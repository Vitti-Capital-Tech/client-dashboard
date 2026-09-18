"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getActor } from "@/lib/session";
import type { Database } from "@/lib/supabase/database.types";

type AlertDirection = Database["public"]["Enums"]["alert_direction"];

/**
 * Alert mutations (Stage 6). Replace the legacy Zustand mutators
 * (mutateAckAlert / mutateAddCustomAlert) with Supabase writes.
 */

/**
 * Mark every alert the caller can see, up to and including `upToIso`, as read.
 *
 * ── Why there is no per-alert version of this ───────────────────────────────
 * There used to be: `ackAlert(id)`, behind an "Ack" button on every row. It
 * asked the reader to do the bookkeeping — a notification bell that makes you
 * confirm you read each notification is a bell with a chore attached, and the
 * predictable result was 141 unread alerts on the staff console and a badge
 * nobody could clear without 141 clicks. Reading is what marks things read.
 *
 * ── Why a timestamp and not a list of ids ───────────────────────────────────
 * `.in("id", [...])` with a backlog that size builds a 5KB query string, which
 * is a length limit waiting to be hit. A cutoff is also the more accurate
 * statement: what the reader saw is "everything up to here", and an alert that
 * arrives after the last render is genuinely NOT one of them. Passing the
 * newest rendered `ts` leaves that one unread, where a blanket "mark all" would
 * have swallowed it silently.
 *
 * ── Why an RPC and not an update ────────────────────────────────────────────
 * Which column gets written depends on who is asking, and that decision cannot
 * live here: `alerts_update` lets a client write any column on their own rows,
 * so a client could clear `staff_read_at` and empty the desk's queue straight
 * from the PostgREST endpoint. `mark_alerts_read` reads the audience off the
 * JWT instead, and UPDATE on the table is revoked from `authenticated`. See
 * supabase/migrations/…_alert_read_state.sql.
 */
export async function markAlertsRead(upToIso: string) {
  const supabase = await createClient();

  const { error } = await supabase.rpc("mark_alerts_read", { up_to: upToIso });
  if (error) throw error;

  revalidatePath("/portal", "layout");
}

/**
 * Create a custom price alert for a client. Upserts the watchlist row's
 * threshold, records a triggered alert, and writes an audit entry — mirroring
 * the legacy mutateAddCustomAlert.
 */
export async function addCustomAlert(
  clientId: string,
  code: string,
  threshold: number,
  direction: AlertDirection,
) {
  const supabase = await createClient();
  const { actor } = await getActor();

  // Resolve a display name for the (possibly new) watchlist row.
  const { data: security } = await supabase
    .from("securities")
    .select("name")
    .eq("code", code)
    .maybeSingle();
  const displayName = security?.name ?? code;

  const { data: existing } = await supabase
    .from("watchlist_items")
    .select("id")
    .eq("client_id", clientId)
    .eq("security_code", code)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from("watchlist_items")
      .update({ alert_threshold: threshold, alert_direction: direction })
      .eq("id", existing.id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from("watchlist_items").insert({
      client_id: clientId,
      security_code: code,
      display_name: displayName,
      alert_threshold: threshold,
      alert_direction: direction,
      unlisted: false,
    });
    if (error) throw error;
  }

  const { error: alertErr } = await supabase.from("alerts").insert({
    client_id: clientId,
    kind: "price",
    severity: "amber",
    title: `${code} custom alert created`,
    subtitle: `Notify when ${code} goes ${direction} $${threshold.toFixed(2)}`,
    acknowledged: false,
  });
  if (alertErr) throw alertErr;

  await supabase.from("audit_log").insert({
    actor,
    role: "client",
    action: "Created alert",
    detail: `Custom price alert: ${code} ${direction} $${threshold.toFixed(2)}`,
    client_id: clientId,
  });

  revalidatePath("/portal", "layout");
}
