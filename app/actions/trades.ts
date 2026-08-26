"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getActor } from "@/lib/session";
import { recomputeClient } from "@/lib/pnl/batch";
import { getParentTicker, isOptionCode } from "@/lib/pnl-calculator";
import { savePnlOverride } from "./pnl-overrides";

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
