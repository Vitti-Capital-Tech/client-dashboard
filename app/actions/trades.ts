"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getActor } from "@/lib/session";
import { recomputeClient } from "@/lib/pnl/batch";
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

    const { data, error } = await supabase
      .from("trades")
      .select("*")
      .eq("account_id", accountId)
      .neq("status", "CANCELLED")
      .or(`security_code.eq.${ticker},parent_code.eq.${parent},security_code.eq.${parent}`)
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
