"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getActor } from "@/lib/session";
import { recomputeClient } from "@/lib/pnl/batch";
import { getParentTicker, isOptionCode } from "@/lib/pnl-calculator";
import { savePnlOverride } from "./pnl-overrides";
import {
  netPositionEffects,
  type PrivateTxnRow,
} from "@/lib/import/private-rows";

export interface TradeDetail {
  id: string;
  cnote: string;
  accountId: string;
  clientId: string;
  securityCode: string;
  parentCode: string;
  instrument: string | null;
  side: "BUY" | "SELL";
  tradeDate: string;
  units: number;
  avgPrice: number;
  consideration: number;
  brokerage: number;
  gst: number;
  value: number;
  status: string;
}

type Result<T = undefined> =
  | ({ ok: true } & (T extends undefined ? object : { data: T }))
  | { ok: false; error: string };

/**
 * Fetch all trade transactions (contract notes) for a given account and ticker.
 */
export async function getTradesForMismatch(
  accountId: string,
  ticker: string,
): Promise<Result<TradeDetail[]>> {
  const { role } = await getActor();
  if (role !== "admin") return { ok: false, error: "Staff only." };

  try {
    const supabase = await createClient();
    const parent = ticker.replace(/-UO\d*$/i, "").trim().toUpperCase();

    // `raw_security` is in the net because it is the field the P&L engine reads
    // the ticker from (`dbTradesToParsedRows`). A note whose `security_code` was
    // normalised away from it still feeds the row on screen, so it has to be
    // listed here — and re-filed with the rest when the desk reclassifies.
    const { data, error } = await supabase
      .from("trades")
      .select("*")
      .eq("account_id", accountId)
      .neq("status", "CANCELLED")
      .or(
        `security_code.eq.${ticker},parent_code.eq.${parent},security_code.eq.${parent},raw_security.eq.${ticker},raw_security.eq.${parent}`,
      )
      .order("trade_date", { ascending: false })
      .order("cnote", { ascending: false });

    if (error) return { ok: false, error: error.message };

    const trades: TradeDetail[] = (data || []).map((t) => ({
      id: t.id,
      cnote: t.cnote,
      accountId: t.account_id,
      clientId: t.client_id,
      securityCode: t.security_code,
      parentCode: t.parent_code,
      instrument: t.instrument,
      side: t.side,
      tradeDate: t.trade_date,
      units: Number(t.units) || 0,
      avgPrice: Number(t.avg_price) || 0,
      consideration: Number(t.consideration) || 0,
      brokerage: Number(t.brokerage) || 0,
      gst: Number(t.gst) || 0,
      value: Number(t.value ?? t.consideration) || 0,
      status: t.status,
    }));

    return { ok: true, data: trades };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to fetch trades.",
    };
  }
}

/**
 * Permanently delete a single trade from the database, log the audit record,
 * and automatically recompute the client's stored P&L.
 */
export async function deleteTradeAction(
  tradeId: string,
  accountId: string,
  clientId: string,
): Promise<Result<{ deletedCnote: string }>> {
  const { role, actor } = await getActor();
  if (role !== "admin") return { ok: false, error: "Staff only." };

  try {
    const supabase = await createClient();

    // 1. Fetch trade details before deletion for audit record
    const { data: trade, error: fetchErr } = await supabase
      .from("trades")
      .select("*")
      .eq("id", tradeId)
      .single();

    if (fetchErr || !trade) {
      return { ok: false, error: "Trade not found." };
    }

    // 2. Mark the trade as CANCELLED so it never enters P&L and morning cron skips it
    const { error: deleteErr } = await supabase
      .from("trades")
      .update({ status: "CANCELLED" })
      .eq("id", tradeId);

    if (deleteErr) return { ok: false, error: deleteErr.message };

    // 3. Insert audit log
    const side = trade.side || "TRADE";
    const units = Number(trade.units) || 0;
    const price = Number(trade.avg_price) || 0;
    const secCode = trade.security_code;
    const cnote = trade.cnote;

    await supabase.from("audit_log").insert({
      actor,
      role,
      action: "Deleted trade",
      detail: `Deleted ${side} ${units.toLocaleString("en-AU")} ${secCode} @ $${price.toFixed(4)} (CNote #${cnote}) on account ${accountId}`,
      client_id: clientId,
    });

    // 4. Automatically recompute client P&L so summary updates immediately
    await recomputeClient(clientId, { trigger: "manual" });

    // 5. Revalidate cache
    revalidatePath("/portal", "layout");

    return { ok: true, data: { deletedCnote: cnote } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to delete trade.",
    };
  }
}

/**
 * Permanently delete all trades for a ticker on an account, log audit, and recompute P&L.
 */
export async function deleteAllTradesForTickerAction(
  accountId: string,
  clientId: string,
  ticker: string,
): Promise<Result<{ count: number }>> {
  const { role, actor } = await getActor();
  if (role !== "admin") return { ok: false, error: "Staff only." };

  try {
    const supabase = await createClient();
    const parent = ticker.replace(/-UO\d*$/i, "").trim().toUpperCase();

    // 1. Fetch matching trades for audit count
    const { data: trades, error: fetchErr } = await supabase
      .from("trades")
      .select("id, cnote, units, side, security_code")
      .eq("account_id", accountId)
      .neq("status", "CANCELLED")
      .or(`security_code.eq.${ticker},parent_code.eq.${parent},security_code.eq.${parent}`);

    if (fetchErr) return { ok: false, error: fetchErr.message };
    const count = trades?.length || 0;

    if (count === 0) {
      return { ok: false, error: "No matching trades found to delete." };
    }

    // 2. Mark all matching trades as CANCELLED
    const tradeIds = trades.map((t) => t.id);
    const { error: deleteErr } = await supabase
      .from("trades")
      .update({ status: "CANCELLED" })
      .in("id", tradeIds);

    if (deleteErr) return { ok: false, error: deleteErr.message };

    // 3. Log audit entry
    await supabase.from("audit_log").insert({
      actor,
      role,
      action: "Deleted all trades for ticker",
      detail: `Deleted ${count} contract note(s) for ${ticker} on account ${accountId}`,
      client_id: clientId,
    });

    // 4. Recompute client P&L
    await recomputeClient(clientId, { trigger: "manual" });

    // 5. Revalidate cache
    revalidatePath("/portal", "layout");

    return { ok: true, data: { count } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to delete trades.",
    };
  }
}

/**
 * Make sure `securities` carries a code before a trade points at it.
 *
 * `trades.security_code` and `trades.parent_code` are both FOREIGN KEYS into
 * `securities`, so writing a code the catalogue has never seen fails on the
 * constraint rather than on anything a reader would recognise. That is the
 * normal case here, not an edge one: an option series the broker never booked
 * against — the whole reason the desk is reclassifying or hand-entering — has
 * no catalogue row by definition.
 *
 * Existing rows are LEFT ALONE. The catalogue owns names, prices and sectors,
 * and a placeholder name written over a real one would show up on every screen
 * that renders the security.
 */
async function ensureSecurityExists(
  supabase: Awaited<ReturnType<typeof createClient>>,
  code: string,
  name?: string,
): Promise<string | null> {
  const parent = getParentTicker(code);

  // The parent has to exist first — it is the FK target of the child's own
  // `parent_code`, and an option's ordinary may itself be absent.
  const rows = [
    ...(parent && parent !== code
      ? [{ code: parent, name: parent, parent_code: null, security_class: "Ordinary" }]
      : []),
    {
      code,
      name: name?.trim() || code,
      parent_code: parent && parent !== code ? parent : null,
      security_class: isOptionCode(code) ? "Options" : "Ordinary",
    },
  ];

  for (const row of rows) {
    // `ignoreDuplicates` is what keeps this from overwriting the catalogue.
    const { error } = await supabase
      .from("securities")
      .upsert(row, { onConflict: "code", ignoreDuplicates: true });
    if (error) return `Could not add ${row.code} to the securities catalogue: ${error.message}`;
  }

  return null;
}

/**
 * What a line is: an option series, or fully paid ordinary shares.
 *
 * `FPO` is the broker's own abbreviation for **Fully Paid Ordinary** — plain
 * equity, not a derivative — and it is spelled out here because "OPTION" and
 * "FPO" sitting next to each other in a union invites reading the second as
 * some kind of option too.
 */
export type TradeClass = "OPTION" | "FPO";

/**
 * Re-file a ticker's contract notes as OPTION trades or as ORDINARY shares.
 *
 * The broker's description gets this wrong in both directions and the fix is the
 * same shape each way, so it is one action rather than two that could drift:
 *
 *   → OPTION   Option transactions booked against the ordinary code. `FRS` then
 *              carries a sell side with no buys behind it and reads as a
 *              quantity mismatch forever. It is not one — the trades belong on
 *              their own option line, which the P&L already reports and which
 *              the mismatch page skips entirely.
 *   → FPO      The mirror: ordinary shares wearing an option description, so a
 *              plain equity parcel is reported as a derivative and kept out of
 *              the equity totals it belongs in.
 *
 * **`raw_security` is the field that matters.** The engine reads the ticker from
 * there and nowhere else (`dbTradesToParsedRows`), so updating `security_code`
 * alone would change what the UI lists and leave every figure exactly as it was.
 * All four columns are written so the ledger stays internally consistent:
 * `raw_security` and `security_code` take the target code, `parent_code` its
 * 3-character underlying — `FRSO` stays a derivative OF `FRS`, which keeps the
 * option line beside the ordinary rather than orphaned — and `instrument`
 * replaces the broker's description.
 *
 * Two guards, both about not moving money to the wrong company:
 *
 *   1. The target code must READ as what it is being called. Options need more
 *      than three characters with an `O` in the suffix (`isOptionCode`, the ASX
 *      convention the whole engine keys on); ordinaries must NOT, or the engine
 *      would keep reporting the line as a derivative whatever the description
 *      says. `FRS → FRSX` reclassifies nothing and is refused.
 *   2. Its parent must be the SAME underlying. `FRS → FRSO` is the desk
 *      correcting a description; `FRS → ABCO` is a different company's option,
 *      and would move settled contract notes onto it.
 *
 * `securityName` is optional and updates the CATALOGUE label — the line under
 * the ticker that read "FLYNNGOLD - OPTION 14-…" on a parcel of ordinary
 * shares. Applied only when supplied, because that name is shared by every
 * screen and blanking it to reclassify a ledger line would be a poor trade.
 *
 * Destructive in the sense that it rewrites ledger rows, so it is audited by
 * count and by both codes, and the P&L is recomputed before it returns.
 */
export async function reclassifyTradesAction(
  accountId: string,
  clientId: string,
  ticker: string,
  newCodeInput: string,
  kind: TradeClass,
  securityName?: string,
): Promise<Result<{ count: number; code: string }>> {
  const { role, actor } = await getActor();
  if (role !== "admin") return { ok: false, error: "Staff only." };

  const from = ticker.replace(/-UO\d*$/i, "").trim().toUpperCase();
  const code = String(newCodeInput || "").trim().toUpperCase();
  const wantsOption = kind === "OPTION";

  if (!code) {
    return {
      ok: false,
      error: `Enter the ${wantsOption ? "option" : "ordinary"} code to file these trades under.`,
    };
  }
  if (wantsOption && !isOptionCode(code)) {
    return {
      ok: false,
      error: `"${code}" does not read as an option code. It needs more than three characters with an O in the suffix — ${getParentTicker(from)}O or ${getParentTicker(from)}OE, for example.`,
    };
  }
  if (!wantsOption && isOptionCode(code)) {
    return {
      ok: false,
      error: `"${code}" still reads as an option code, so the engine would keep reporting it as one. Ordinary shares use the plain code — ${getParentTicker(from)}.`,
    };
  }
  if (getParentTicker(code) !== getParentTicker(from)) {
    return {
      ok: false,
      error: `"${code}" belongs to ${getParentTicker(code)}, not ${getParentTicker(from)}. Reclassifying would move these contract notes onto a different company.`,
    };
  }

  try {
    const supabase = await createClient();
    const parent = getParentTicker(code);

    // The same net the mismatch page casts, so what is re-filed is exactly what
    // the row on screen was built from.
    const { data: trades, error: fetchErr } = await supabase
      .from("trades")
      .select("id, cnote, raw_security, security_code, units, side")
      .eq("account_id", accountId)
      .neq("status", "CANCELLED")
      .or(
        `security_code.eq.${from},parent_code.eq.${from},raw_security.eq.${from}`,
      );

    if (fetchErr) return { ok: false, error: fetchErr.message };

    if ((trades ?? []).length === 0) {
      return { ok: false, error: `No contract notes found under ${from} to reclassify.` };
    }

    // A code the desk is moving onto may never have been booked against — the
    // catalogue would then have no row for it and the FK below would fail.
    const catalogueErr = await ensureSecurityExists(supabase, code, securityName);
    if (catalogueErr) return { ok: false, error: catalogueErr };

    // Every matched note is rewritten, including any already sitting on the
    // target code: the description is half the point here, and a line that is
    // ALREADY `FG1` but still labelled "FLYNNGOLD - OPTION 14-…" is exactly the
    // one the desk opened this for.
    const { error: updateErr } = await supabase
      .from("trades")
      .update({
        raw_security: code,
        security_code: code,
        parent_code: parent,
        instrument: kind,
      })
      .in(
        "id",
        (trades ?? []).map((t) => t.id),
      );

    if (updateErr) return { ok: false, error: updateErr.message };

    // The catalogue name is what the client profile and the mismatch page print
    // under the ticker, and it is shared by every screen — so it moves only when
    // the desk actually supplies one.
    if (securityName?.trim()) {
      const { error: nameErr } = await supabase
        .from("securities")
        .update({ name: securityName.trim() })
        .eq("code", code);
      if (nameErr) return { ok: false, error: nameErr.message };
    }

    await supabase.from("audit_log").insert({
      actor,
      role,
      action: kind === "OPTION" ? "Reclassified trades as options" : "Reclassified trades as ordinary",
      detail:
        `Re-filed ${trades!.length} contract note(s) from ${from} to ${code} (parent ${parent}, ${kind}) ` +
        `on account ${accountId}${securityName?.trim() ? `; renamed to "${securityName.trim()}"` : ""}`,
      client_id: clientId,
    });

    // The stored P&L still describes the old shape until this runs — the row
    // would otherwise sit on the mismatch page reading FRS until tomorrow.
    await recomputeClient(clientId, { trigger: "manual" });
    revalidatePath("/portal", "layout");

    return { ok: true, data: { count: trades!.length, code } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to reclassify the trades.",
    };
  }
}

/** What the desk types to add or amend one contract note line. */
export type TradeInput = {
  /** Raw security code — `FRS`, `FRSO`. Drives which P&L row the line lands on. */
  securityCode: string;
  side: "BUY" | "SELL";
  /** `yyyy-mm-dd`. */
  tradeDate: string;
  units: number;
  avgPrice: number;
  /** Gross before fees. Left blank it is taken as `units × avgPrice`. */
  consideration?: number | null;
  brokerage?: number | null;
  otherCharges?: number | null;
  gst?: number | null;
  /** The broker's note number. Blank generates a `MANUAL-…` one. */
  cnote?: string | null;
  /** The description column — `FPO`, `OPTION`. Defaults from the code. */
  instrument?: string | null;
};

/**
 * `value` is the NET cash flow and already carries the fees, which is what lets
 * the P&L math use it alone and stay fee-inclusive:
 *
 *   BUY  → consideration + fees   (cash out)
 *   SELL → consideration − fees   (cash in)
 *
 * Restated from the ledger migration's own comment rather than left to the
 * caller: a hand-entered line that gets this backwards is indistinguishable
 * from a real one and quietly moves the client's P&L by twice the brokerage.
 */
function tradeMoney(input: TradeInput): {
  consideration: number;
  brokerage: number;
  otherCharges: number;
  gst: number;
  value: number;
} {
  const n = (v: number | null | undefined) =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;

  const consideration =
    typeof input.consideration === "number" && Number.isFinite(input.consideration)
      ? input.consideration
      : input.units * input.avgPrice;

  const brokerage = n(input.brokerage);
  const otherCharges = n(input.otherCharges);
  const gst = n(input.gst);
  const fees = brokerage + otherCharges + gst;

  return {
    consideration: round2(consideration),
    brokerage: round2(brokerage),
    otherCharges: round2(otherCharges),
    gst: round2(gst),
    value: round2(input.side === "BUY" ? consideration + fees : consideration - fees),
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Shared shape checks — the same ones whether a line is new or amended. */
function validateTrade(input: TradeInput): string | null {
  if (!input.securityCode?.trim()) return "Enter the security code.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.tradeDate ?? "")) {
    return "Enter the trade date as yyyy-mm-dd.";
  }
  // The ledger's own constraint: a SETTLED line must carry positive units.
  if (!Number.isFinite(input.units) || input.units <= 0) {
    return "Units must be greater than zero.";
  }
  if (!Number.isFinite(input.avgPrice) || input.avgPrice < 0) {
    return "The price is not a number.";
  }
  if (input.side !== "BUY" && input.side !== "SELL") return "Choose BUY or SELL.";
  return null;
}

/**
 * Add one contract note line to the ledger by hand.
 *
 * The case this exists for: a note the broker booked as a single ORDINARY line
 * that was really two instruments — shares plus the attaching options. The desk
 * amends the original down to the share parcel and enters the option leg here,
 * under its own code, so each lands on the P&L row it belongs to. Neither half
 * can be expressed by an override: an override corrects a row's totals, and this
 * is a line the ledger never had.
 *
 * Written as `SETTLED`, because a line entered by hand is one the desk has a
 * statement for — a pending trade has nothing to type in from yet.
 *
 * Marked in the ledger rather than hidden: `source_file` records who entered it
 * and when, so a hand-keyed line is never mistaken for one the broker sent.
 */
export async function addTradeAction(
  accountId: string,
  clientId: string,
  input: TradeInput,
): Promise<Result<{ cnote: string; code: string }>> {
  const { role, actor } = await getActor();
  if (role !== "admin") return { ok: false, error: "Staff only." };

  const invalid = validateTrade(input);
  if (invalid) return { ok: false, error: invalid };

  const code = input.securityCode.trim().toUpperCase();
  const parent = getParentTicker(code);
  const money = tradeMoney({ ...input, securityCode: code });

  // A note number the desk did not supply still has to be unique on
  // (cnote, raw_security, side), and readable enough to find later.
  const cnote =
    input.cnote?.trim() ||
    `MANUAL-${input.tradeDate.replace(/-/g, "")}-${Math.random().toString(16).slice(2, 6).toUpperCase()}`;

  try {
    const supabase = await createClient();

    const catalogueErr = await ensureSecurityExists(supabase, code);
    if (catalogueErr) return { ok: false, error: catalogueErr };

    const { error } = await supabase.from("trades").insert({
      cnote,
      account_id: accountId,
      client_id: clientId,
      raw_security: code,
      security_code: code,
      parent_code: parent,
      instrument: input.instrument?.trim() || (isOptionCode(code) ? "OPTION" : "FPO"),
      side: input.side,
      trade_date: input.tradeDate,
      units: input.units,
      avg_price: input.avgPrice,
      consideration: money.consideration,
      brokerage: money.brokerage,
      other_charges: money.otherCharges,
      gst: money.gst,
      value: money.value,
      status: "SETTLED",
      source_file: `Manual entry by ${actor}`,
    });

    if (error) {
      // The ledger is keyed on (cnote, raw_security, side) so a re-used note
      // number for the same leg is a duplicate, not a database problem.
      if (error.code === "23505") {
        return {
          ok: false,
          error: `Contract note "${cnote}" already exists for ${code} ${input.side}. Use a different note number.`,
        };
      }
      return { ok: false, error: error.message };
    }

    await supabase.from("audit_log").insert({
      actor,
      role,
      action: "Added trade",
      detail: `Added ${input.side} ${input.units.toLocaleString("en-AU")} ${code} @ $${input.avgPrice.toFixed(4)} (CNote #${cnote}) on account ${accountId}`,
      client_id: clientId,
    });

    await recomputeClient(clientId, { trigger: "manual" });
    revalidatePath("/portal", "layout");

    return { ok: true, data: { cnote, code } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to add the trade.",
    };
  }
}

/**
 * Amend one contract note line.
 *
 * The other half of splitting a misbooked note: the original is reduced to the
 * share parcel it really was, and the option leg is added beside it. Every
 * figure is rewritten from the input rather than patched field by field, so the
 * money stays internally consistent — an amended `units` with a stale `value`
 * is a line whose price no longer divides into its own cash flow.
 */
export async function updateTradeAction(
  tradeId: string,
  accountId: string,
  clientId: string,
  input: TradeInput,
): Promise<Result<{ cnote: string }>> {
  const { role, actor } = await getActor();
  if (role !== "admin") return { ok: false, error: "Staff only." };

  const invalid = validateTrade(input);
  if (invalid) return { ok: false, error: invalid };

  const code = input.securityCode.trim().toUpperCase();
  const parent = getParentTicker(code);
  const money = tradeMoney({ ...input, securityCode: code });

  try {
    const supabase = await createClient();

    const { data: before, error: fetchErr } = await supabase
      .from("trades")
      .select("cnote, raw_security, side, units, avg_price")
      .eq("id", tradeId)
      .single();
    if (fetchErr || !before) return { ok: false, error: "Trade not found." };

    const catalogueErr = await ensureSecurityExists(supabase, code);
    if (catalogueErr) return { ok: false, error: catalogueErr };

    const { error } = await supabase
      .from("trades")
      .update({
        raw_security: code,
        security_code: code,
        parent_code: parent,
        ...(input.instrument?.trim() ? { instrument: input.instrument.trim() } : {}),
        side: input.side,
        trade_date: input.tradeDate,
        units: input.units,
        avg_price: input.avgPrice,
        consideration: money.consideration,
        brokerage: money.brokerage,
        other_charges: money.otherCharges,
        gst: money.gst,
        value: money.value,
      })
      .eq("id", tradeId);

    if (error) {
      if (error.code === "23505") {
        return {
          ok: false,
          error: `Another line already uses note "${before.cnote}" for ${code} ${input.side}.`,
        };
      }
      return { ok: false, error: error.message };
    }

    // Both the before and the after, because "amended CNote #123" on its own
    // does not say what it used to be.
    await supabase.from("audit_log").insert({
      actor,
      role,
      action: "Amended trade",
      detail:
        `Amended CNote #${before.cnote} on account ${accountId}: ` +
        `${before.side} ${Number(before.units).toLocaleString("en-AU")} ${before.raw_security} @ $${Number(before.avg_price).toFixed(4)} → ` +
        `${input.side} ${input.units.toLocaleString("en-AU")} ${code} @ $${input.avgPrice.toFixed(4)}`,
      client_id: clientId,
    });

    await recomputeClient(clientId, { trigger: "manual" });
    revalidatePath("/portal", "layout");

    return { ok: true, data: { cnote: before.cnote } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to amend the trade.",
    };
  }
}

/**
 * Say that a row is a still-HELD position rather than a quantity discrepancy.
 *
 * The shape this exists for: units bought, none sold. That is not an "excess
 * buy" — nothing was sold for the buy side to be in excess OF — it is an open
 * parcel the holdings snapshot did not account for, usually because a placement
 * allocation has not reached the portfolio table yet. The engine already handles
 * the case it CAN see: `mergeDbHoldings` sets both legs from the held quantity
 * and marks the row `isDbOpenValued`. This is the desk saying the same thing
 * about a parcel the snapshot is silent on, and it is a judgement — hence a
 * recorded override with a note, not an automatic rule.
 *
 * Two values are written, and the second matters as much as the first:
 *
 *   sellQty = buyQty   both legs from the held quantity, so the row reconciles
 *                      and stops being reported as a mismatch
 *   sellOrCurrent = buyPrice
 *                      carried at COST. Left at zero the row reads as a total
 *                      loss of its entire cost base — DY6 showed −$2,000.10 on a
 *                      parcel that had lost nothing — which is a fabricated
 *                      number, not a conservative one. At cost it shows zero
 *                      unrealised P&L, which is the honest answer until a real
 *                      mark arrives.
 */
export async function markPositionOpenAction(
  accountId: string,
  clientId: string,
  ticker: string,
  heldQty: number,
  costBase: number,
  note?: string,
): Promise<Result> {
  if (!Number.isFinite(heldQty) || heldQty <= 0) {
    return { ok: false, error: "An open position needs a quantity to hold." };
  }
  if (!Number.isFinite(costBase) || costBase < 0) {
    return { ok: false, error: "The cost base is not a number." };
  }

  const parent = ticker.replace(/-UO\d*$/i, "").trim().toUpperCase();
  return savePnlOverride(accountId, clientId, parent, {
    buyQty: heldQty,
    // Bought and HELD — not sold. Setting both quantities equal is how this
    // used to balance the row, and it balanced it by reporting a disposal that
    // never happened: the position then read `Matched`, a completed round trip
    // on the very parcel the desk had just declared open.
    sellQty: 0,
    heldQty,
    buyPrice: costBase,
    sellOrCurrent: costBase,
    note:
      note?.trim() ||
      `Open position — ${heldQty.toLocaleString("en-AU")} units still held, carried at cost by the desk.`,
  });
}

/**
 * Dismiss or exclude a mismatched position by applying a zeroed override.
 */
export async function excludePositionAction(
  accountId: string,
  clientId: string,
  ticker: string,
  note?: string,
): Promise<Result> {
  const parent = ticker.replace(/-UO\d*$/i, "").trim().toUpperCase();
  return savePnlOverride(accountId, clientId, parent, {
    buyQty: 0,
    sellQty: 0,
    buyPrice: 0,
    sellOrCurrent: 0,
    note: note?.trim() || "Excluded / Dismissed by desk",
  });
}

/* ────────────────────────── private transactions ─────────────────────────── */

/**
 * What the desk types to record something the broker never sees.
 *
 * A superset of `TradeInput`: a private transaction IS a trade — it moves units
 * and cash and belongs in the same ledger, on the same P&L row — plus the two
 * things a broker line never needs. Modelled as an extension rather than a
 * parallel type so a private line cannot quietly diverge from the arithmetic
 * every other line goes through.
 */
export type PrivateTransactionInput = TradeInput & {
  /**
   * The desk's own note on provenance — "Off-market transfer from SMSF",
   * "Series A". Staff-only; the client portal never renders it.
   */
  privateNote?: string | null;
  /**
   * Unit valuation for an asset with no price feed, and the date it is as at.
   *
   * Left blank for an off-market parcel of a LISTED security: the ASX feed
   * already prices that code, and a typed figure would only go stale beside it.
   * Required in practice for anything genuinely unlisted, or the holding is
   * carried at cost and reads as flat forever.
   */
  manualPrice?: number | null;
  /** `yyyy-mm-dd`. Must accompany `manualPrice`; see the migration's CHECK. */
  manualPriceAt?: string | null;
  /** Display name for a code the securities catalogue has never seen. */
  securityName?: string | null;
};

/**
 * ── How to code something that is not an ASX security ───────────────────────
 *
 * `getParentTicker` slices any code of three or more characters down to its
 * first three and calls that the parent — right for `ADNOD` to `ADN`, and
 * nonsense for `ACMEPRIVATE`, which would hang the holding off a phantom `ACM`.
 *
 * The codebase already has the answer and it is not a new rule: a code carrying
 * an exchange suffix (`BRAI:NAS`, and so `ACME:PVT`) is ITS OWN parent, because
 * there is no ASX ordinary underneath it. `getParentTicker`, `getSummaryGroupKey`,
 * `parentCode` and the snapshot matcher all honour that already, so a private
 * asset coded that way survives the whole pipeline whole instead of collapsing
 * into a three-letter group.
 *
 * So there is deliberately no private-only parent rule here. One rule about
 * what a security IS, honoured everywhere — the property the importer's own
 * comment insists on. The form is what tells the desk to use the suffix.
 */

/**
 * Record a transaction the broker does not know about, and the holding it left.
 *
 * ── Why this writes to two tables ───────────────────────────────────────────
 * The ledger row is what the P&L is computed FROM; the position row is what the
 * open side is valued AGAINST. A broker line gets its position for free from
 * the next morning's holdings snapshot — that is the snapshot's whole job. A
 * private line never will, by definition, so if this wrote only the trade the
 * merge would find no holding behind it and mark the row *not held*: a
 * transaction correctly recorded and a holding correctly worth nothing.
 *
 * So a BUY creates or adds to the private position, and a SELL reduces it. Both
 * are the position the desk would otherwise have to remember to maintain by
 * hand beside the ledger it already keyed.
 *
 * ── Why the position is added to rather than replaced ───────────────────────
 * Two off-market buys of the same code are two transactions and one holding.
 * Reading the current row and writing qty + units keeps the weighted average
 * cost meaningful across them; overwriting would make the most recent entry the
 * whole history and silently discard the earlier parcel's cost base.
 */
export async function addPrivateTransactionAction(
  accountId: string,
  clientId: string,
  input: PrivateTransactionInput,
): Promise<Result<{ cnote: string; code: string }>> {
  const { role, actor } = await getActor();
  if (role !== "admin") return { ok: false, error: "Staff only." };

  const invalid = validateTrade(input);
  if (invalid) return { ok: false, error: invalid };

  // The migration's CHECK enforces this too, but a constraint violation reaches
  // the desk as a Postgres error string. This is the same rule, said in English.
  const hasPrice = typeof input.manualPrice === "number" && Number.isFinite(input.manualPrice);
  const hasDate = !!input.manualPriceAt?.trim();
  if (hasPrice !== hasDate) {
    return {
      ok: false,
      error: hasPrice
        ? "Give the date the valuation is as at — an undated valuation gets read as today's."
        : "Enter the valuation the date applies to, or clear the date.",
    };
  }
  if (hasPrice && (input.manualPrice as number) < 0) {
    return { ok: false, error: "A valuation cannot be negative." };
  }
  if (hasDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.manualPriceAt!.trim())) {
    return { ok: false, error: "Enter the valuation date as yyyy-mm-dd." };
  }

  const code = input.securityCode.trim().toUpperCase();
  const parent = getParentTicker(code);
  const money = tradeMoney({ ...input, securityCode: code });

  const cnote =
    input.cnote?.trim() ||
    `PRIVATE-${input.tradeDate.replace(/-/g, "")}-${Math.random().toString(16).slice(2, 6).toUpperCase()}`;

  try {
    const supabase = await createClient();

    const catalogueErr = await ensureSecurityExists(supabase, code, input.securityName ?? undefined);
    if (catalogueErr) return { ok: false, error: catalogueErr };

    const { error } = await supabase.from("trades").insert({
      cnote,
      account_id: accountId,
      client_id: clientId,
      raw_security: code,
      security_code: code,
      parent_code: parent,
      instrument: input.instrument?.trim() || (isOptionCode(code) ? "OPTION" : "FPO"),
      side: input.side,
      trade_date: input.tradeDate,
      units: input.units,
      avg_price: input.avgPrice,
      consideration: money.consideration,
      brokerage: money.brokerage,
      other_charges: money.otherCharges,
      gst: money.gst,
      value: money.value,
      // Same reasoning as a manual repair line: the desk has a statement in
      // hand, or it would have nothing to type in from.
      status: "SETTLED",
      is_private: true,
      private_note: input.privateNote?.trim() || null,
      source_file: `Private transaction entered by ${actor}`,
    });

    if (error) {
      if (error.code === "23505") {
        return {
          ok: false,
          error: `Reference "${cnote}" already exists for ${code} ${input.side}. Use a different reference.`,
        };
      }
      return { ok: false, error: error.message };
    }

    const posErr = await applyPrivatePosition(supabase, accountId, clientId, code, input);
    if (posErr) return { ok: false, error: posErr };

    await supabase.from("audit_log").insert({
      actor,
      role,
      action: "Added private transaction",
      detail: `Private ${input.side} ${input.units.toLocaleString("en-AU")} ${code} @ $${input.avgPrice.toFixed(4)} (ref ${cnote}) on account ${accountId}`,
      client_id: clientId,
    });

    await recomputeClient(clientId, { trigger: "manual" });
    revalidatePath("/portal", "layout");

    return { ok: true, data: { cnote, code } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to record the private transaction.",
    };
  }
}

/**
 * Move the private holding by what the transaction did, keeping WAC intact.
 *
 * Returns an error string rather than throwing, matching the action's own
 * contract. A BUY that leaves the ledger correct and the position unwritten is
 * the failure mode worth being loud about: the transaction would be recorded
 * and the client would still not see the holding.
 */
async function applyPrivatePosition(
  supabase: Awaited<ReturnType<typeof createClient>>,
  accountId: string,
  clientId: string,
  code: string,
  input: PrivateTransactionInput,
): Promise<string | null> {
  const { data: existing, error: readErr } = await supabase
    .from("positions")
    .select("qty, avg_cost, is_private")
    .eq("account_id", accountId)
    .eq("security_code", code)
    .maybeSingle();
  if (readErr) return `Could not read the existing holding: ${readErr.message}`;

  const prevQty = Number(existing?.qty) || 0;
  const prevCost = Number(existing?.avg_cost) || 0;
  const delta = input.side === "BUY" ? input.units : -input.units;
  const nextQty = Math.max(0, prevQty + delta);

  /**
   * Weighted average cost, and only a BUY may move it.
   *
   * A sale removes units at the average the parcel already carries — it is not
   * new information about what the holding cost. Letting a SELL price into this
   * would rewrite the cost base to the exit price and report the position as
   * having no gain, which is the opposite of what just happened.
   */
  const nextCost =
    input.side === "BUY" && nextQty > 0
      ? (prevQty * prevCost + input.units * input.avgPrice) / nextQty
      : prevCost;

  const hasValuation =
    typeof input.manualPrice === "number" && Number.isFinite(input.manualPrice);

  // Omitted entirely when not supplied, so re-entering a transaction without a
  // valuation does not wipe one the desk set earlier. The pair moves together
  // or not at all — the table's CHECK insists, and so does the form.
  const valuation = hasValuation
    ? {
        manual_price: input.manualPrice as number,
        manual_price_at: input.manualPriceAt as string,
      }
    : {};

  // A holding the broker already custodies must not be quietly reclassified as
  // private by an off-market top-up: the snapshot would go on overwriting it
  // and the badge would be a lie about most of the parcel.
  const claimsPrivate = !existing || existing.is_private === true ? { is_private: true } : {};

  const { error: writeErr } = await supabase.from("positions").upsert(
    {
      account_id: accountId,
      client_id: clientId,
      security_code: code,
      qty: nextQty,
      avg_cost: Math.round(nextCost * 1e6) / 1e6,
      ...claimsPrivate,
      ...valuation,
    },
    { onConflict: "account_id,security_code" },
  );
  if (writeErr) return `The transaction was saved but the holding was not: ${writeErr.message}`;

  return null;
}

/**
 * Import a file of private transactions onto one account.
 *
 * ── Why the rows arrive parsed ──────────────────────────────────────────────
 * The browser reads the .csv/.xlsx with `parsePnlFileBuffer` and sends rows,
 * not bytes. Two reasons, both learned elsewhere in this codebase: a server
 * action carries a body limit that a real workbook exceeds, and ExcelJS parsing
 * is CPU-bound in the single Node process — §8.21 measured a tracker parse
 * starving every other server action for ~48s. The desk also sees exactly what
 * will be written, and can abandon the upload, before anything is.
 *
 * ── Why this is not addPrivateTransactionAction in a loop ───────────────────
 * That would recompute the client's whole P&L once per row — forty recomputes
 * for a forty-line file, each one reading the same trackers and quoting the
 * same tickers. It would also get the weighted average cost WRONG: each call
 * re-reads a position the previous call moved, so a SELL halfway down the file
 * would be applied against a cost base that the BUYs below it had not yet
 * contributed to. The batch nets each code's effect first (`netPositionEffects`)
 * and recomputes exactly once, at the end.
 *
 * ── Partial success is a real outcome and is reported as one ────────────────
 * A duplicate reference is not a reason to refuse the other thirty-nine rows,
 * so the ledger insert reports what it skipped rather than throwing. What must
 * never happen is a position moved by a trade that was not written, so the
 * holdings are computed from the rows that actually landed.
 */
export async function importPrivateTransactionsAction(
  accountId: string,
  clientId: string,
  rows: PrivateTxnRow[],
): Promise<
  Result<{ imported: number; skipped: number; codes: string[]; notes: string[] }>
> {
  const { role, actor } = await getActor();
  if (role !== "admin") return { ok: false, error: "Staff only." };

  if (!accountId) return { ok: false, error: "Choose the account these belong to." };
  if (rows.length === 0) return { ok: false, error: "There is nothing to import." };
  // A guard, not a judgement about what is reasonable: this runs inside one
  // request and writes a position per code afterwards. A file bigger than this
  // is a data migration and wants the CLI importers, not a browser upload.
  if (rows.length > 500) {
    return {
      ok: false,
      error: `That file has ${rows.length} rows. Import up to 500 at a time.`,
    };
  }

  const notes: string[] = [];

  try {
    const supabase = await createClient();

    // Catalogue first, and once per distinct code rather than once per row:
    // every trade row carries an FK to `securities`, so a missing code fails
    // the whole insert.
    const byCode = netPositionEffects(rows);
    for (const [code, effect] of byCode) {
      const catalogueErr = await ensureSecurityExists(supabase, code, effect.name ?? undefined);
      if (catalogueErr) return { ok: false, error: catalogueErr };
    }

    const payload = rows.map((r) => {
      const money = tradeMoney({
        securityCode: r.securityCode,
        side: r.side,
        tradeDate: r.tradeDate,
        units: r.units,
        avgPrice: r.avgPrice,
        consideration: r.consideration,
      });

      return {
        cnote:
          r.cnote ||
          `PRIVATE-${r.tradeDate.replace(/-/g, "")}-${Math.random().toString(16).slice(2, 6).toUpperCase()}`,
        account_id: accountId,
        client_id: clientId,
        raw_security: r.securityCode,
        security_code: r.securityCode,
        parent_code: getParentTicker(r.securityCode),
        instrument: isOptionCode(r.securityCode) ? "OPTION" : "FPO",
        side: r.side,
        trade_date: r.tradeDate,
        units: r.units,
        avg_price: r.avgPrice,
        consideration: money.consideration,
        brokerage: money.brokerage,
        other_charges: money.otherCharges,
        gst: money.gst,
        value: money.value,
        status: "SETTLED",
        is_private: true,
        source_file: `Private import by ${actor}`,
      };
    });

    /**
     * `ignoreDuplicates` rather than a merge, and `.select()` to learn what
     * landed.
     *
     * The ledger is keyed on (cnote, raw_security, side). Re-uploading a file
     * the desk already imported must be a no-op, not a second copy of every
     * parcel — and overwriting instead would silently rewrite figures a person
     * may have corrected by hand since. Skipped rows are counted and said out
     * loud, because "40 rows, 12 imported" is the one number that tells the
     * desk the file had already been through.
     */
    const { data: inserted, error } = await supabase
      .from("trades")
      .upsert(payload, { onConflict: "cnote,raw_security,side", ignoreDuplicates: true })
      .select("raw_security, side, units, avg_price, trade_date");

    if (error) return { ok: false, error: error.message };

    const landed = inserted ?? [];
    const skipped = rows.length - landed.length;
    if (skipped > 0) {
      notes.push(
        `${skipped} row${skipped === 1 ? "" : "s"} already in the ledger under the same reference — not imported again.`,
      );
    }

    if (landed.length === 0) {
      return {
        ok: true,
        data: { imported: 0, skipped, codes: [], notes },
      };
    }

    /**
     * Positions are moved by what ACTUALLY landed, never by what was offered.
     *
     * A holding advanced by a duplicate row the ledger refused would be a
     * quantity backed by no transaction — and it would compound on every
     * re-upload of the same file, which is precisely the mistake the ledger's
     * own idempotency exists to prevent.
     */
    const landedRows: PrivateTxnRow[] = landed.map((t) => ({
      securityCode: String(t.raw_security),
      securityName: null,
      side: t.side as "BUY" | "SELL",
      tradeDate: String(t.trade_date),
      units: Number(t.units) || 0,
      avgPrice: Number(t.avg_price) || 0,
      consideration: null,
      cnote: null,
    }));

    const effects = netPositionEffects(landedRows);
    for (const [code, effect] of effects) {
      const posErr = await applyPrivateBatchToPosition(
        supabase,
        accountId,
        clientId,
        code,
        effect,
      );
      if (posErr) notes.push(posErr);
    }

    await supabase.from("audit_log").insert({
      actor,
      role,
      action: "Imported private transactions",
      detail: `Imported ${landed.length} private transaction${landed.length === 1 ? "" : "s"} across ${effects.size} code${effects.size === 1 ? "" : "s"} onto account ${accountId}${skipped > 0 ? ` (${skipped} duplicate rows skipped)` : ""}`,
      client_id: clientId,
    });

    // Once, at the end. See this function's header.
    await recomputeClient(clientId, { trigger: "manual" });
    revalidatePath("/portal", "layout");

    return {
      ok: true,
      data: { imported: landed.length, skipped, codes: [...effects.keys()], notes },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to import the transactions.",
    };
  }
}

/**
 * Apply one code's netted effect to its private position.
 *
 * Returns a note rather than throwing: by the time this runs the ledger rows
 * are written, and unwinding them to report a position failure would discard
 * good data to tidy up a worse problem. The trades are the source of truth; a
 * position that did not move is visible and fixable, and the note says so.
 */
async function applyPrivateBatchToPosition(
  supabase: Awaited<ReturnType<typeof createClient>>,
  accountId: string,
  clientId: string,
  code: string,
  effect: { deltaUnits: number; buyUnits: number; buyCost: number },
): Promise<string | null> {
  const { data: existing, error: readErr } = await supabase
    .from("positions")
    .select("qty, avg_cost, is_private")
    .eq("account_id", accountId)
    .eq("security_code", code)
    .maybeSingle();
  if (readErr) return `${code}: could not read the existing holding (${readErr.message}).`;

  const prevQty = Number(existing?.qty) || 0;
  const prevCost = Number(existing?.avg_cost) || 0;
  const nextQty = Math.max(0, prevQty + effect.deltaUnits);

  // The whole file's buys enter the average together, which is what makes the
  // result independent of the order the rows happen to sit in.
  const nextCost =
    effect.buyUnits > 0 && nextQty > 0
      ? (prevQty * prevCost + effect.buyCost) / (prevQty + effect.buyUnits)
      : prevCost;

  const claimsPrivate = !existing || existing.is_private === true ? { is_private: true } : {};

  const { error: writeErr } = await supabase.from("positions").upsert(
    {
      account_id: accountId,
      client_id: clientId,
      security_code: code,
      qty: nextQty,
      avg_cost: Math.round(nextCost * 1e6) / 1e6,
      ...claimsPrivate,
    },
    { onConflict: "account_id,security_code" },
  );
  if (writeErr) return `${code}: the transactions were saved but the holding was not.`;

  return null;
}
