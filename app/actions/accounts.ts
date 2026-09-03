"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getActor } from "@/lib/session";
import { ACCOUNT_TYPES } from "@/lib/data/discovery";
import {
  normaliseAccountNumber,
  accountNumberProblem,
} from "@/lib/accounts/account-number";

/**
 * Account lifecycle actions (Stage 10):
 *  - createAccount        — a client opens a new account (self-service).
 *  - requestAccountMerge  — a client requests merging one account into another.
 *  - decideAccountMerge   — STAFF approve/reject; approval executes the merge.
 *  - requestAccountClaim  — a client says an EXISTING account number is theirs.
 *  - decideAccountClaim   — STAFF verify; approval re-parents that account.
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

/**
 * A client states that the account with this broker number is also theirs.
 *
 * Records the number and nothing more. It does NOT look the account up, and the
 * caller gets the same answer whether the number matches an account, a
 * different firm's, or nothing at all — otherwise the form is a way to
 * enumerate the firm's account numbers with a login and a loop. Verification is
 * a staff job (`decideAccountClaim`), against the broker record.
 */
export async function requestAccountClaim(accountNumber: string, note?: string) {
  const { actor, role, clientId } = await getActor();
  if (!clientId) throw new Error("No active client");

  const problem = accountNumberProblem(accountNumber);
  if (problem) throw new Error(problem);
  const normalised = normaliseAccountNumber(accountNumber);

  const supabase = await createClient();

  // A number the client already holds is a no-op worth naming, rather than a
  // request for staff to work out and reject.
  const { data: own, error: ownErr } = await supabase
    .from("accounts")
    .select("external_ref")
    .eq("client_id", clientId);
  if (ownErr) throw ownErr;
  if (
    (own ?? []).some(
      (a) => a.external_ref && normaliseAccountNumber(a.external_ref) === normalised,
    )
  ) {
    throw new Error("That account is already on your login.");
  }

  const { error } = await supabase.from("account_claim_requests").insert({
    client_id: clientId,
    account_number: normalised,
    note: note?.trim() || null,
    status: "pending",
  });
  if (error) {
    // The partial unique index on (client_id, account_number) WHERE pending.
    // Reported as the plain-English fact rather than a constraint name.
    if (error.code === "23505") {
      throw new Error("You already have a pending request for that account number.");
    }
    throw error;
  }

  await supabase.from("audit_log").insert({
    actor,
    role,
    action: "Requested account claim",
    detail: `Account number ${normalised}`,
    client_id: clientId,
  });

  revalidatePath("/portal", "layout");
}

/**
 * Staff verify a claim. Approval RE-PARENTS the account.
 *
 * The approval path is a single SECURITY DEFINER RPC and not a sequence of
 * writes from here, because it rewrites `client_id` across eight tables plus
 * the account itself. Done as separate PostgREST calls, a failure partway
 * through would leave the account under one client and its P&L under another —
 * a client reading someone else's figures. The function is one transaction, and
 * it does its own `is_staff()` check, so this action's role guard is
 * defence-in-depth rather than the boundary.
 *
 * Rejection is a plain update: it moves no data, so the `claim_decide` policy
 * is enough.
 */
export async function decideAccountClaim(
  requestId: string,
  approve: boolean,
  decisionNote?: string,
) {
  const { actor, role } = await getActor();
  if (role !== "admin") throw new Error("Only staff can decide account claims");

  const supabase = await createClient();
  const trimmedNote = decisionNote?.trim() || null;

  if (!approve) {
    const { data: req, error: reqErr } = await supabase
      .from("account_claim_requests")
      .select("id, client_id, account_number, status")
      .eq("id", requestId)
      .maybeSingle();
    if (reqErr) throw reqErr;
    if (!req || req.status !== "pending") return; // already decided / missing

    const { error } = await supabase
      .from("account_claim_requests")
      .update({
        status: "rejected",
        decided_by: actor,
        decided_at: new Date().toISOString(),
        decision_note: trimmedNote,
      })
      .eq("id", requestId);
    if (error) throw error;

    await supabase.from("audit_log").insert({
      actor,
      role,
      action: "Rejected account claim",
      detail: `Account number ${req.account_number}`,
      client_id: req.client_id,
    });

    revalidatePath("/portal", "layout");
    return;
  }

  // The RPC raises on every refusal — no such number, an ambiguous number, an
  // account whose current owner can log in — and its messages are written to be
  // read by staff, so they are surfaced as-is rather than replaced.
  const { error } = await supabase.rpc("approve_account_claim", {
    p_request_id: requestId,
    p_actor: actor,
    p_decision_note: trimmedNote,
  });
  if (error) throw new Error(error.message);

  // The RPC writes its own audit row: it is the thing that knows what moved.
  revalidatePath("/portal", "layout");
}
