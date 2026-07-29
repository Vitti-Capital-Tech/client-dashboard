"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getActor } from "@/lib/session";

/**
 * Desk corrections to a P&L summary row.
 *
 * The row is derived — quantities and cost-of-sold from the `trades` ledger,
 * the held side from the `positions` snapshot — so when a source is incomplete
 * no amount of re-importing fixes it. These actions let staff patch the four
 * INPUTS; P&L itself is never stored, it stays `sell − buy` recomputed from
 * whatever is in force.
 *
 * A null field means "keep the computed value", so clearing one puts it back on
 * the ledger. Clearing all four deletes the row rather than leaving an override
 * that overrides nothing.
 *
 * Staff only, and every change is audited: a figure that disagrees with its
 * source must never be anonymous.
 */

export type OverrideInput = {
  buyQty: number | null;
  sellQty: number | null;
  buyPrice: number | null;
  sellOrCurrent: number | null;
  note: string | null;
};

type Result = { ok: true } | { ok: false; error: string };

/** Reject anything that would put an unusable number into a money column. */
function validate(v: OverrideInput): string | null {
  const fields: [string, number | null][] = [
    ["Buy Qty", v.buyQty],
    ["Sell Qty", v.sellQty],
    ["Buy Price", v.buyPrice],
    ["Sell Price / Current Price", v.sellOrCurrent],
  ];
  for (const [label, n] of fields) {
    if (n === null) continue;
    if (!Number.isFinite(n)) return `${label} must be a number.`;
    if (n < 0) return `${label} cannot be negative.`;
  }
  return null;
}

export async function savePnlOverride(
  accountId: string,
  clientId: string,
  parentCode: string,
  input: OverrideInput,
): Promise<Result> {
  const { role, actor } = await getActor();
  if (role !== "admin") return { ok: false, error: "Staff only." };

  const invalid = validate(input);
  if (invalid) return { ok: false, error: invalid };

  const supabase = await createClient();

  const empty =
    input.buyQty === null &&
    input.sellQty === null &&
    input.buyPrice === null &&
    input.sellOrCurrent === null;

  // Nothing left to override → drop the row entirely, so the summary goes back
  // to tracking its sources instead of carrying a no-op record forever.
  if (empty) {
    const { error } = await supabase
      .from("pnl_overrides")
      .delete()
      .eq("account_id", accountId)
      .eq("parent_code", parentCode);
    if (error) return { ok: false, error: error.message };

    await supabase.from("audit_log").insert({
      actor,
      role,
      action: "Cleared P&L override",
      detail: `${parentCode} — back to computed values`,
      client_id: clientId,
    });
  } else {
    const { error } = await supabase.from("pnl_overrides").upsert(
      {
        account_id: accountId,
        client_id: clientId,
        parent_code: parentCode,
        buy_qty: input.buyQty,
        sell_qty: input.sellQty,
        buy_price: input.buyPrice,
        sell_price: input.sellOrCurrent,
        note: input.note?.trim() || null,
        updated_by: actor,
      },
      { onConflict: "account_id,parent_code" },
    );
    if (error) return { ok: false, error: error.message };

    const changed = [
      input.buyQty !== null && `Buy Qty ${input.buyQty}`,
      input.sellQty !== null && `Sell Qty ${input.sellQty}`,
      input.buyPrice !== null && `Buy Price ${input.buyPrice.toFixed(2)}`,
      input.sellOrCurrent !== null &&
        `Sell/Current ${input.sellOrCurrent.toFixed(2)}`,
    ].filter(Boolean);

    await supabase.from("audit_log").insert({
      actor,
      role,
      action: "Edited P&L row",
      detail:
        `${parentCode} — ${changed.join(", ")}` +
        (input.note?.trim() ? ` · ${input.note.trim()}` : ""),
      client_id: clientId,
    });
  }

  revalidatePath("/portal", "layout");
  return { ok: true };
}
