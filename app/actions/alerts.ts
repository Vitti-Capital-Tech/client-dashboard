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

/** Acknowledge an alert (client or staff). */
export async function ackAlert(alertId: string) {
  const supabase = await createClient();
  const { actor } = await getActor();

  const { error } = await supabase
    .from("alerts")
    .update({
      acknowledged: true,
      acknowledged_at: new Date().toISOString(),
      acknowledged_by: actor,
    })
    .eq("id", alertId);
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
