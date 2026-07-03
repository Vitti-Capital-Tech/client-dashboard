"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getActor } from "@/lib/session";
import { ACCOUNT_TYPES } from "@/lib/data/discovery";

/**
 * Account lifecycle actions (Stage 10):
 *  - createAccount        — a client opens a new account (self-service).
 *  - requestAccountMerge  — a client requests merging one account into another.
 *  - decideAccountMerge   — STAFF approve/reject; approval executes the merge.
 */

/** Client opens a new (empty) account. s708 stays null = verification pending. */
export async function createAccount(label: string, accountType: string) {
  const { actor, role, clientId } = await getActor();
  if (!clientId) throw new Error("No active client");
  const trimmed = label.trim();
  if (!trimmed) throw new Error("Account label is required");
  if (!ACCOUNT_TYPES.includes(accountType as (typeof ACCOUNT_TYPES)[number])) {
    throw new Error("Invalid account type");
  }

  const supabase = await createClient();
  const { error } = await supabase.from("accounts").insert({
    client_id: clientId,
    label: trimmed,
    account_type: accountType,
    cash_balance: 0,
    currency: "AUD",
    s708_expiry: null,
    ref: null,
  });
  if (error) throw error;

  await supabase.from("audit_log").insert({
    actor,
    role,
    action: "Created account",
    detail: `${trimmed} (${accountType})`,
    client_id: clientId,
  });

  revalidatePath("/portal", "layout");
}

/** Client requests merging `sourceId` into `targetId` (both must be theirs). */
export async function requestAccountMerge(
  sourceId: string,
  targetId: string,
  note?: string,
) {
  const { actor, role, clientId } = await getActor();
  if (!clientId) throw new Error("No active client");
  if (sourceId === targetId) throw new Error("Pick two different accounts");

  const supabase = await createClient();
  const { data: accounts, error: accErr } = await supabase
    .from("accounts")
    .select("id, label, client_id")
    .in("id", [sourceId, targetId]);
  if (accErr) throw accErr;

  const source = accounts?.find((a) => a.id === sourceId);
  const target = accounts?.find((a) => a.id === targetId);
  if (!source || !target) throw new Error("Account not found");
  if (source.client_id !== clientId || target.client_id !== clientId) {
    throw new Error("You can only merge your own accounts");
  }

  // Block a duplicate pending request for the same pair.
  const { data: existing } = await supabase
    .from("account_merge_requests")
    .select("id")
    .eq("source_account_id", sourceId)
    .eq("target_account_id", targetId)
    .eq("status", "pending")
    .maybeSingle();
  if (existing) throw new Error("A pending request already exists for these accounts");

  const { error } = await supabase.from("account_merge_requests").insert({
    client_id: clientId,
    source_account_id: sourceId,
    target_account_id: targetId,
    source_label: source.label,
    target_label: target.label,
    note: note?.trim() || null,
    status: "pending",
  });
  if (error) throw error;

  await supabase.from("audit_log").insert({
    actor,
    role,
    action: "Requested account merge",
    detail: `${source.label} → ${target.label}`,
    client_id: clientId,
  });

  revalidatePath("/portal", "layout");
}

/**
 * Staff decision on a pending merge request. Reject → mark rejected. Approve →
 * move the source account's holdings/cash/bids into the target, delete the
 * (now-empty) source, then mark approved.
 *
 * NOTE: the merge runs as sequential writes, not one transaction. A production
 * version should move this into a Postgres SECURITY DEFINER RPC for atomicity.
 */
export async function decideAccountMerge(requestId: string, approve: boolean) {
  const { actor, role } = await getActor();
  if (role !== "admin") throw new Error("Only staff can decide merge requests");

  const supabase = await createClient();
  const { data: req, error: reqErr } = await supabase
    .from("account_merge_requests")
    .select("*")
    .eq("id", requestId)
    .maybeSingle();
  if (reqErr) throw reqErr;
  if (!req || req.status !== "pending") return; // already decided / missing

  const decidedAt = new Date().toISOString();

  if (!approve) {
    const { error } = await supabase
      .from("account_merge_requests")
      .update({ status: "rejected", decided_by: actor, decided_at: decidedAt })
      .eq("id", requestId);
    if (error) throw error;
    await supabase.from("audit_log").insert({
      actor,
      role,
      action: "Rejected account merge",
      detail: `${req.source_label} → ${req.target_label}`,
      client_id: req.client_id,
    });
    revalidatePath("/portal", "layout");
    return;
  }

  // --- Approve: execute the merge (source → target) ---
  const sourceId = req.source_account_id;
  const targetId = req.target_account_id;
  if (!sourceId || !targetId) throw new Error("Merge accounts no longer exist");

  const [{ data: source }, { data: target }] = await Promise.all([
    supabase.from("accounts").select("*").eq("id", sourceId).maybeSingle(),
    supabase.from("accounts").select("*").eq("id", targetId).maybeSingle(),
  ]);
  if (!source || !target) throw new Error("Merge accounts no longer exist");

  // 1. Cash.
  const { error: cashErr } = await supabase
    .from("accounts")
    .update({ cash_balance: target.cash_balance + source.cash_balance })
    .eq("id", targetId);
  if (cashErr) throw cashErr;

  // 2. Positions — combine shared securities (weighted-average cost), else move.
  const [{ data: srcPos }, { data: tgtPos }] = await Promise.all([
    supabase.from("positions").select("*").eq("account_id", sourceId),
    supabase.from("positions").select("*").eq("account_id", targetId),
  ]);
  const tgtByCode = new Map((tgtPos ?? []).map((p) => [p.security_code, p]));
  for (const sp of srcPos ?? []) {
    const tp = tgtByCode.get(sp.security_code);
    if (tp) {
      const qty = tp.qty + sp.qty;
      const avgCost =
        qty !== 0
          ? (tp.qty * tp.avg_cost + sp.qty * sp.avg_cost) / qty
          : tp.avg_cost;
      const { error } = await supabase
        .from("positions")
        .update({ qty, avg_cost: avgCost })
        .eq("id", tp.id);
      if (error) throw error;
      const { error: delErr } = await supabase
        .from("positions")
        .delete()
        .eq("id", sp.id);
      if (delErr) throw delErr;
    } else {
      const { error } = await supabase
        .from("positions")
        .update({ account_id: targetId })
        .eq("id", sp.id);
      if (error) throw error;
    }
  }

  // 3. Options — series are distinct; just reassign to the target.
  const { error: optErr } = await supabase
    .from("option_holdings")
    .update({ account_id: targetId })
    .eq("account_id", sourceId);
  if (optErr) throw optErr;

  // 4. Bids — combine bids on the same placement (unique per placement+account).
  const [{ data: srcBids }, { data: tgtBids }] = await Promise.all([
    supabase.from("bids").select("*").eq("account_id", sourceId),
    supabase.from("bids").select("*").eq("account_id", targetId),
  ]);
  const tgtByPlacement = new Map((tgtBids ?? []).map((b) => [b.placement_id, b]));
  for (const sb of srcBids ?? []) {
    const tb = tgtByPlacement.get(sb.placement_id);
    if (tb) {
      const alloc =
        tb.alloc === null && sb.alloc === null
          ? null
          : (tb.alloc ?? 0) + (sb.alloc ?? 0);
      const { error } = await supabase
        .from("bids")
        .update({ amount: tb.amount + sb.amount, alloc, paid: tb.paid || sb.paid })
        .eq("id", tb.id);
      if (error) throw error;
      const { error: delErr } = await supabase.from("bids").delete().eq("id", sb.id);
      if (delErr) throw delErr;
    } else {
      const { error } = await supabase
        .from("bids")
        .update({ account_id: targetId })
        .eq("id", sb.id);
      if (error) throw error;
    }
  }

  // 5. Delete the (now-empty) source account.
  const { error: accDelErr } = await supabase
    .from("accounts")
    .delete()
    .eq("id", sourceId);
  if (accDelErr) throw accDelErr;

  // 6. Mark the request approved.
  const { error: updErr } = await supabase
    .from("account_merge_requests")
    .update({ status: "approved", decided_by: actor, decided_at: decidedAt })
    .eq("id", requestId);
  if (updErr) throw updErr;

  await supabase.from("audit_log").insert({
    actor,
    role,
    action: "Approved account merge",
    detail: `${req.source_label} → ${req.target_label}`,
    client_id: req.client_id,
  });

  revalidatePath("/portal", "layout");
}
