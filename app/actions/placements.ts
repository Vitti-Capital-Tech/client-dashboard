"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getActor, getActiveAccountId } from "@/lib/session";

/**
 * Placement mutations (Stage 6). These replace the legacy Zustand mutators
 * (mutatePlaceBid / mutateWithdrawBid / mutateScaleBids / mutateUpdatePlacementStage
 * / mutateClientBpayPayment) with real Supabase writes. Every mutation records an
 * audit_log entry and revalidates the portal so the UI reflects the new state.
 *
 * Auth note: the interim cookie session identifies the actor. Real Supabase Auth
 * + RLS will later enforce that a client can only mutate their own bids.
 */

const DAY_MS = 86_400_000;

function money(n: number): string {
  return n.toLocaleString("en-AU");
}

async function placementCode(
  supabase: Awaited<ReturnType<typeof createClient>>,
  placementId: string,
): Promise<string> {
  const { data } = await supabase
    .from("placements")
    .select("code")
    .eq("id", placementId)
    .maybeSingle();
  return data?.code ?? "";
}

/** Client places (or amends) a bid on a placement. */
export async function placeBid(placementId: string, amount: number) {
  const supabase = await createClient();
  const { actor, role, clientId } = await getActor();
  if (!clientId) throw new Error("No active client for bid");
  const accountId = await getActiveAccountId();
  if (!accountId) throw new Error("No active account for bid");

  // A bid is per account (one client can bid from several accounts on one deal).
  const { data: existing } = await supabase
    .from("bids")
    .select("id")
    .eq("placement_id", placementId)
    .eq("account_id", accountId)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from("bids")
      .update({ amount })
      .eq("id", existing.id);
    if (error) throw error;
  } else {
    const { error } = await supabase.from("bids").insert({
      placement_id: placementId,
      account_id: accountId,
      client_id: clientId,
      amount,
      alloc: null,
      paid: false,
    });
    if (error) throw error;
  }

  const code = await placementCode(supabase, placementId);
  await supabase.from("audit_log").insert({
    actor,
    role,
    action: "Placed bid",
    detail: `${code} · $${money(amount)} (${role === "admin" ? "adviser bid" : "client portal"})`,
    client_id: clientId,
  });

  revalidatePath("/portal", "layout");
}

/** Client withdraws their bid from a placement. */
export async function withdrawBid(placementId: string) {
  const supabase = await createClient();
  const { actor, role, clientId } = await getActor();
  if (!clientId) throw new Error("No active client for withdrawal");
  const accountId = await getActiveAccountId();

  const { error } = await supabase
    .from("bids")
    .delete()
    .eq("placement_id", placementId)
    .eq("account_id", accountId);
  if (error) throw error;

  const code = await placementCode(supabase, placementId);
  await supabase.from("audit_log").insert({
    actor,
    role,
    action: "Withdrew bid",
    detail: `${code} (${role === "admin" ? "adviser withdraw" : "client portal"})`,
    client_id: clientId,
  });

  revalidatePath("/portal", "layout");
}

/** Staff publishes allocations for a placement (clientId -> allotted amount). */
export async function scaleBids(
  placementId: string,
  allocations: Record<string, number>,
) {
  const supabase = await createClient();
  const { actor } = await getActor();

  for (const [clientId, alloc] of Object.entries(allocations)) {
    const { error } = await supabase
      .from("bids")
      .update({ alloc })
      .eq("placement_id", placementId)
      .eq("client_id", clientId);
    if (error) throw error;
  }

  const code = await placementCode(supabase, placementId);
  await supabase.from("audit_log").insert({
    actor,
    role: "admin",
    action: "Updated allocations",
    detail: `Allocated raises for ${code}`,
  });

  revalidatePath("/portal", "layout");
}

/**
 * Staff settles a placement: transitions it to "settled" and issues the
 * allotted shares (plus any attaching options) into each client's portfolio.
 * Mirrors the legacy mutateUpdatePlacementStage settlement branch.
 */
export async function settlePlacement(placementId: string) {
  const supabase = await createClient();
  const { actor } = await getActor();

  const { data: placement, error: pErr } = await supabase
    .from("placements")
    .select("*")
    .eq("id", placementId)
    .maybeSingle();
  if (pErr) throw pErr;
  if (!placement || placement.stage === "settled") return;

  const { data: bids, error: bErr } = await supabase
    .from("bids")
    .select("*")
    .eq("placement_id", placementId);
  if (bErr) throw bErr;

  const lastPrice = placement.last ?? placement.price;

  // The placement code becomes a tradable security on settlement; ensure it
  // exists so the positions / option_holdings FKs resolve.
  await supabase
    .from("securities")
    .upsert(
      {
        code: placement.code,
        name: placement.name,
        listed: true,
        sector: "Materials",
        last_price: lastPrice,
      },
      { onConflict: "code", ignoreDuplicates: true },
    );

  const opts = placement.opts ?? "None";
  let ratio = 0.5;
  if (opts.includes("(1:1)")) ratio = 1;
  else if (opts.includes("(1:3)")) ratio = 1 / 3;

  const expiry = new Date(Date.now() + 365 * DAY_MS)
    .toISOString()
    .slice(0, 10);

  for (const b of bids ?? []) {
    const allocated = b.alloc ?? 0;
    if (allocated <= 0) continue;

    const qty = Math.round(allocated / placement.price);
    const { error: posErr } = await supabase.from("positions").insert({
      account_id: b.account_id,
      client_id: b.client_id,
      security_code: placement.code,
      qty,
      avg_cost: placement.price,
    });
    if (posErr) throw posErr;

    if (opts !== "None") {
      const { error: optErr } = await supabase.from("option_holdings").insert({
        account_id: b.account_id,
        client_id: b.client_id,
        code: `${placement.code}O`,
        name: `${placement.name} options`,
        listed: placement.code !== "MRD",
        option_type: "Call",
        qty: Math.round(qty * ratio),
        strike: placement.price * 1.5,
        underlying_code: placement.code,
        expiry_date: expiry,
        source: "Placement attaching",
        status: "open",
      });
      if (optErr) throw optErr;
    }
  }

  const { error: stageErr } = await supabase
    .from("placements")
    .update({ stage: "settled" })
    .eq("id", placementId);
  if (stageErr) throw stageErr;

  await supabase.from("audit_log").insert({
    actor,
    role: "admin",
    action: "Change deal stage",
    detail: `${placement.code} stage changed to settled`,
  });

  revalidatePath("/portal", "layout");
}

/** Client notifies the desk that they have paid their allocation via BPAY. */
export async function notifyBpayPayment(placementId: string) {
  const supabase = await createClient();
  const { actor, role, clientId } = await getActor();
  if (!clientId) throw new Error("No active client for payment");
  const accountId = await getActiveAccountId();

  const { data: bid } = await supabase
    .from("bids")
    .select("id, alloc")
    .eq("placement_id", placementId)
    .eq("account_id", accountId)
    .maybeSingle();
  if (!bid) return;

  const { error } = await supabase
    .from("bids")
    .update({ paid: true })
    .eq("id", bid.id);
  if (error) throw error;

  const code = await placementCode(supabase, placementId);
  await supabase.from("audit_log").insert({
    actor,
    role,
    action: "Notified payment",
    detail: `${code} · $${money(bid.alloc ?? 0)} via BPAY`,
    client_id: clientId,
  });

  revalidatePath("/portal", "layout");
}
