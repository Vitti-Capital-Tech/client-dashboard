"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getActor } from "@/lib/session";

/**
 * Removing an unlisted option grant from the register.
 *
 * ── Why a delete needs a table behind it ────────────────────────────────────
 * The register is derived, and its two sources are not equally permanent:
 *
 *   `option_holdings`  a real row somebody (or a settlement) inserted. Deleting
 *                      it deletes the thing, and nothing puts it back.
 *   `pnl_summary`      a SYNTHETIC `<PARENT>-UO` row, rebuilt from the
 *                      Placement Tracker on every recompute. Deleting it clears
 *                      the screen and the next morning's ingest writes it
 *                      straight back — the tracker still describes the grant.
 *
 * So the second case records the deletion in `deleted_unlisted_options` as well,
 * which is the table the engine consults when it rebuilds those rows. See the
 * migration for why the exclusion is keyed at (account, ticker).
 *
 * ── Unlisted only ──────────────────────────────────────────────────────────
 * A listed series is quoted and traded on its own market: its presence on the
 * register is a fact about the broker feed, not a desk judgement, and deleting
 * it would hide a real position the client can see in their own holdings. The
 * staff table only offers the button on unlisted rows and this refuses the rest,
 * because a Server Function is reachable by POST whatever the UI renders.
 */

type Result = { ok: true; ticker: string } | { ok: false; error: string };

/** How the register composes its row ids — see lib/options/from-stored-pnl.ts. */
const PNL_PREFIX = "pnl-";
const HOLDING_PREFIX = "opt-";

/**
 * Delete one unlisted option grant, by the id its register row carries.
 *
 * `registerId` is `OptionTableItem.id`, which is `pnl-<accountId>:<ticker>` for
 * a modelled grant and `opt-<uuid>` for an `option_holdings` row. It is parsed
 * here rather than having the caller pass the parts, so the account and client a
 * write lands on come from the database row rather than from the browser.
 */
export async function deleteUnlistedOption(
  registerId: string,
  reason?: string | null,
): Promise<Result> {
  const { role, actor } = await getActor();
  if (role !== "admin") return { ok: false, error: "Staff only." };

  const id = (registerId ?? "").trim();
  const note = reason?.trim() || null;

  if (id.startsWith(HOLDING_PREFIX)) {
    return deleteHoldingRow(id.slice(HOLDING_PREFIX.length), actor, note);
  }
  if (id.startsWith(PNL_PREFIX)) {
    // `<accountId>:<ticker>` — split at the FIRST colon. A uuid contains none
    // and a ticker contains none, so the first is the only one.
    const rest = id.slice(PNL_PREFIX.length);
    const sep = rest.indexOf(":");
    if (sep <= 0 || sep === rest.length - 1) {
      return { ok: false, error: "That option row could not be identified." };
    }
    return deleteModelledRow(rest.slice(0, sep), rest.slice(sep + 1), actor, note);
  }

  return { ok: false, error: "That option row could not be identified." };
}

/**
 * A modelled grant: record the exclusion, then drop the stored row.
 *
 * In that order, and it matters. Recording first and failing to delete leaves a
 * row on screen that the next recompute takes away — visibly wrong, and it
 * self-corrects. Deleting first and failing to record clears the screen and puts
 * the grant back overnight, with nothing anywhere saying it was ever deleted.
 */
async function deleteModelledRow(
  accountId: string,
  ticker: string,
  actor: string,
  reason: string | null,
): Promise<Result> {
  const supabase = await createClient();

  const { data: row, error: readErr } = await supabase
    .from("pnl_summary")
    .select("account_id, client_id, ticker, company, is_unlisted_option")
    .eq("account_id", accountId)
    .eq("ticker", ticker)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!row) {
    // Two people on the same register is normal; saying so beats a raw error.
    return { ok: false, error: "That option is no longer on the register." };
  }
  if (!row.is_unlisted_option && !row.ticker.endsWith("-UO")) {
    return {
      ok: false,
      error: "Only unlisted option grants can be deleted from the register.",
    };
  }

  const { error: recErr } = await supabase.from("deleted_unlisted_options").upsert(
    {
      account_id: row.account_id,
      client_id: row.client_id,
      ticker: row.ticker,
      // Stored as it reads today — ratio, strike and expiry included. The row it
      // describes is about to stop existing, so there is nothing left to join to.
      company: row.company || null,
      reason,
      deleted_by: actor,
    },
    { onConflict: "account_id,ticker" },
  );
  if (recErr) return { ok: false, error: recErr.message };

  const { error: delErr } = await supabase
    .from("pnl_summary")
    .delete()
    .eq("account_id", accountId)
    .eq("ticker", ticker);
  if (delErr) return { ok: false, error: delErr.message };

  await supabase.from("audit_log").insert({
    actor,
    role: "admin",
    action: "Deleted unlisted option",
    detail:
      `${row.ticker}${row.company ? ` — ${row.company}` : ""} removed from the ` +
      `options register${reason ? ` · ${reason}` : ""}`,
    client_id: row.client_id,
  });

  revalidatePath("/portal", "layout");
  return { ok: true, ticker: row.ticker };
}

/**
 * An `option_holdings` grant: a real row, so a real delete.
 *
 * No exclusion is recorded, because nothing regenerates these — they are
 * inserted by settlement and by the seed, never rebuilt. An entry in
 * `deleted_unlisted_options` for a row that cannot come back would be a
 * permanent block on a ticker the desk may legitimately re-register later.
 */
async function deleteHoldingRow(
  holdingId: string,
  actor: string,
  reason: string | null,
): Promise<Result> {
  const supabase = await createClient();

  const { data: row, error: readErr } = await supabase
    .from("option_holdings")
    .select("id, account_id, client_id, code, name, listed")
    .eq("id", holdingId)
    .maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!row) return { ok: false, error: "That option is no longer on the register." };
  if (row.listed) {
    return {
      ok: false,
      error: "Only unlisted option grants can be deleted from the register.",
    };
  }

  const { error: delErr } = await supabase
    .from("option_holdings")
    .delete()
    .eq("id", holdingId);
  if (delErr) return { ok: false, error: delErr.message };

  await supabase.from("audit_log").insert({
    actor,
    role: "admin",
    action: "Deleted unlisted option",
    detail:
      `${row.code}${row.name ? ` — ${row.name}` : ""} removed from the options ` +
      `register${reason ? ` · ${reason}` : ""}`,
    client_id: row.client_id,
  });

  revalidatePath("/portal", "layout");
  return { ok: true, ticker: row.code };
}
