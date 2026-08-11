"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getActor, getActiveAccountId } from "@/lib/session";
// `PLACEMENT_TYPES` lives outside this file on purpose: a `"use server"` module
// may only export async functions, so a const exported from here reaches a
// client component as a server reference rather than as an array. See the note
// in that module — it cost a runtime crash to learn.
import type { PromotionTerms } from "@/lib/placements/deal-types";

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

// ---------------------------------------------------------------------------
// Deal-mail candidates → real placements
// ---------------------------------------------------------------------------


/**
 * Turn a deal-mail candidate into a biddable placement.
 *
 * The terms are ARGUMENTS, not defaults, because there is nowhere to read them
 * from: the upstream feed carries a ticker, a subject line and a prose summary,
 * and `placements` needs a price, a raise size and a minimum bid before a bid
 * against it means anything. Defaulting those to zero would put a live deal in
 * front of the desk with a $0 minimum — which does not look wrong, it just
 * accepts the wrong money.
 *
 * The candidate is kept and linked rather than consumed, so the trail from the
 * mail to the deal survives.
 */
export async function promoteCandidate(candidateId: string, terms: PromotionTerms) {
  const supabase = await createClient();
  const { actor, role } = await getActor();
  if (role !== "admin") return { ok: false as const, error: "Staff only." };

  if (!terms.code?.trim()) return { ok: false as const, error: "A code is required." };
  if (!(terms.price > 0)) return { ok: false as const, error: "Price must be above zero." };
  if (!(terms.minBid > 0)) return { ok: false as const, error: "Minimum bid must be above zero." };

  const { data: candidate, error: candErr } = await supabase
    .from("placement_candidates")
    .select("id, ticker, subject, placement_id")
    .eq("id", candidateId)
    .maybeSingle();
  if (candErr) return { ok: false as const, error: candErr.message };
  if (!candidate) return { ok: false as const, error: "That candidate no longer exists." };
  if (candidate.placement_id) {
    // Not an error worth throwing — two people looking at the same queue is
    // normal. Saying so beats creating a second deal for one mail.
    return { ok: false as const, error: "This candidate has already been promoted." };
  }

  const { data: placement, error: insErr } = await supabase
    .from("placements")
    .insert({
      code: terms.code.trim().toUpperCase(),
      name: terms.name.trim() || terms.code.trim().toUpperCase(),
      type: terms.type,
      price: terms.price,
      raise_millions: terms.raiseMillions,
      min_bid: terms.minBid,
      opts: terms.opts?.trim() || null,
      close_date: terms.closeDate || null,
      // Open, not upcoming: the desk promotes a deal when it is ready to take
      // bids, and a deal nobody can bid on is not what this button is for.
      stage: "open",
    })
    .select("id, code")
    .maybeSingle();
  if (insErr) return { ok: false as const, error: insErr.message };
  if (!placement) return { ok: false as const, error: "The placement was not created." };

  const { error: linkErr } = await supabase
    .from("placement_candidates")
    .update({
      placement_id: placement.id,
      promoted_at: new Date().toISOString(),
      promoted_by: actor,
    })
    .eq("id", candidateId);
  if (linkErr) return { ok: false as const, error: linkErr.message };

  await supabase.from("audit_log").insert({
    actor,
    role: "admin",
    action: "Promoted deal from mail",
    detail:
      `${placement.code} · ${terms.type} · $${money(terms.price)}/share · ` +
      `min $${money(terms.minBid)} · from "${candidate.subject || candidate.ticker}"`,
  });

  revalidatePath("/portal", "layout");
  return { ok: true as const, placementId: placement.id };
}

/** Not every deal in the mail is one this desk will offer. */
export async function dismissCandidate(candidateId: string, reason: string) {
  const supabase = await createClient();
  const { actor, role } = await getActor();
  if (role !== "admin") return { ok: false as const, error: "Staff only." };

  const { data: candidate } = await supabase
    .from("placement_candidates")
    .select("ticker")
    .eq("id", candidateId)
    .maybeSingle();

  // Recorded, never deleted — the next sync would otherwise hand the same
  // summary back as new work.
  const { error } = await supabase
    .from("placement_candidates")
    .update({
      dismissed_at: new Date().toISOString(),
      dismissed_by: actor,
      dismiss_reason: reason?.trim() || null,
    })
    .eq("id", candidateId);
  if (error) return { ok: false as const, error: error.message };

  await supabase.from("audit_log").insert({
    actor,
    role: "admin",
    action: "Dismissed deal from mail",
    detail: `${candidate?.ticker ?? candidateId}${reason?.trim() ? ` · ${reason.trim()}` : ""}`,
  });

  revalidatePath("/portal", "layout");
  return { ok: true as const };
}

/**
 * Staff books a bid for one of a client's accounts, in SHARES.
 *
 * Separate from `placeBid` for two reasons, and both matter:
 *
 *  1. **The account is chosen, not inherited.** `placeBid` reads the active
 *     client and account from the session, which is right when someone is
 *     acting as themselves. Booking on behalf from the deal book means naming
 *     the account explicitly — a client can hold several, and a bid landing on
 *     whichever one happened to be active last is not something the register
 *     could later explain.
 *  2. **The desk instructs in shares.** `amount` stays the money truth because
 *     scaling, allocation and BPAY are all measured in dollars, but it is
 *     DERIVED here (`qty × price`) and the quantity is stored alongside it. Only
 *     keeping dollars would round 3,000 shares to $483.29 and read back as
 *     3,000.03 — close enough to display, and no longer the instruction that was
 *     given.
 */
export async function bookBidForAccount(
  placementId: string,
  accountId: string,
  qty: number,
) {
  const supabase = await createClient();
  const { actor, role } = await getActor();
  if (role !== "admin") return { ok: false as const, error: "Staff only." };
  if (!(qty > 0)) return { ok: false as const, error: "Quantity must be above zero." };

  const { data: placement } = await supabase
    .from("placements")
    .select("code, price, min_bid, stage")
    .eq("id", placementId)
    .maybeSingle();
  if (!placement) return { ok: false as const, error: "That placement no longer exists." };
  if (!(Number(placement.price) > 0)) {
    return { ok: false as const, error: "This placement has no price, so a quantity cannot be costed." };
  }

  const { data: account } = await supabase
    .from("accounts")
    .select("id, label, client_id")
    .eq("id", accountId)
    .maybeSingle();
  if (!account) return { ok: false as const, error: "That account no longer exists." };

  const amount = Math.round(qty * Number(placement.price) * 100) / 100;

  // The minimum is a term of the deal, so it is enforced rather than displayed
  // and hoped for. Reported back with both figures, since the operator entered
  // neither of them directly.
  if (amount < Number(placement.min_bid)) {
    return {
      ok: false as const,
      error:
        `${qty.toLocaleString("en-AU")} shares is $${money(amount)}, below the ` +
        `$${money(Number(placement.min_bid))} minimum for ${placement.code}.`,
    };
  }

  const { data: existing } = await supabase
    .from("bids")
    .select("id")
    .eq("placement_id", placementId)
    .eq("account_id", accountId)
    .maybeSingle();

  // Same escape as above, and the same reason: `bids.qty` is added by the
  // migration that introduced this action, so the checked-in types do not carry
  // it yet.
  if (existing) {
    const { error } = await supabase
      .from("bids")
      .update({ amount, qty })
      .eq("id", existing.id);
    if (error) return { ok: false as const, error: error.message };
  } else {
    const { error } = await supabase.from("bids").insert({
      placement_id: placementId,
      account_id: accountId,
      client_id: account.client_id,
      amount,
      qty,
      alloc: null,
      paid: false,
    });
    if (error) return { ok: false as const, error: error.message };
  }

  await supabase.from("audit_log").insert({
    actor,
    role: "admin",
    action: existing ? "Amended bid on behalf" : "Booked bid on behalf",
    detail:
      `${placement.code} · ${qty.toLocaleString("en-AU")} shares @ $${placement.price} ` +
      `= $${money(amount)} · ${account.label ?? accountId} (adviser booking)`,
    client_id: account.client_id,
  });

  revalidatePath("/portal", "layout");
  return { ok: true as const, amount };
}
