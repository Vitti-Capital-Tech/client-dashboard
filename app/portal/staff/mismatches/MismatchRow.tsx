"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import type { PnlSummaryRow } from "@/lib/export/order-history";
import { savePnlOverride } from "@/app/actions/pnl-overrides";

export interface MismatchItem extends PnlSummaryRow {
  accountId: string;
  clientId: string;
  clientName: string;
  clientInitials: string | null;
  accountLabel: string;
  accountExternalRef: string | null;
  discrepancyType: "short_buy" | "buy_unknown" | "short_sell" | "unmatched" | "year_unresolved";
  discrepancyLabel: string;
  discrepancyDiff: number;
}

const money = (n: number) =>
  n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const qty = (n: number) => n.toLocaleString("en-AU");

/** "" → null (fall through to computed). `undefined` signals unparseable. */
function toNum(s: string): number | null | undefined {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

const CELL_INPUT =
  "w-full bg-white border border-line-2 rounded-[6px] px-2 py-1 " +
  "font-mono text-[12px] text-ink text-right placeholder:text-mut-d " +
  "outline-none focus:border-navy transition-all";

export function MismatchRow({
  row,
  editing,
  onEdit,
  onClose,
  money2,
}: {
  row: MismatchItem;
  editing: boolean;
  onEdit: () => void;
  onClose: () => void;
  money2: (n: number) => string;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [buyQty, setBuyQty] = useState(String(row.buyQty));
  const [sellQty, setSellQty] = useState(String(row.sellQty));
  const [buyPrice, setBuyPrice] = useState(row.buyPrice.toFixed(2));
  const [sellPrice, setSellPrice] = useState(row.sellOrCurrent.toFixed(2));
  const [note, setNote] = useState(row.note ?? "");

  const eff = (raw: string, fallback: number) => {
    const n = toNum(raw);
    return n === undefined || n === null ? fallback : n;
  };
  const liveBuy = eff(buyPrice, row.computed.buyPrice);
  const liveSell = eff(sellPrice, row.computed.sellOrCurrent);
  const livePnl = liveSell - liveBuy;

  const save = async () => {
    const parsed = [buyQty, sellQty, buyPrice, sellPrice].map(toNum);
    if (parsed.some((v) => v === undefined)) {
      setError("Please enter valid numbers.");
      return;
    }

    const diff = (v: number | null | undefined, computed: number) =>
      v == null || Math.abs(v - computed) < 0.005 ? null : v;

    setSaving(true);
    setError(null);

    const res = await savePnlOverride(row.accountId, row.clientId, row.ticker, {
      buyQty: diff(parsed[0], row.computed.buyQty),
      sellQty: diff(parsed[1], row.computed.sellQty),
      buyPrice: diff(parsed[2], row.computed.buyPrice),
      sellOrCurrent: diff(parsed[3], row.computed.sellOrCurrent),
      note: note.trim() || null,
    });
    setSaving(false);

    if (!res.ok) return setError(res.error);
    router.refresh();
    onClose();
  };

  const clearOverride = async () => {
    setSaving(true);
    setError(null);
    const res = await savePnlOverride(row.accountId, row.clientId, row.ticker, {
      buyQty: null,
      sellQty: null,
      buyPrice: null,
      sellOrCurrent: null,
      note: null,
    });
    setSaving(false);
    if (!res.ok) return setError(res.error);
    router.refresh();
    onClose();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") void save();
    if (e.key === "Escape") onClose();
  };

  // Mark edited values with dotted underlines
  const mark = (on: boolean, computed: string) =>
    on
      ? {
          className:
            "decoration-dotted decoration-loss underline underline-offset-4 cursor-help font-semibold text-navy",
          title: `Overridden by staff · Computed: ${computed}`,
        }
      : {};

  if (!editing) {
    return (
      <tr className="hover:bg-[#faf9f5] border-t border-line/60 transition-colors">
        {/* Client & Account */}
        <td className="px-4.5 py-3 select-none">
          <div className="flex items-center gap-2">
            <span className="w-6.5 h-6.5 rounded-full bg-paper-2 border border-line flex items-center justify-center font-bold text-[9.5px] text-ink uppercase flex-shrink-0">
              {row.clientInitials || row.clientName.slice(0, 2)}
            </span>
            <div className="min-w-0">
              <button
                type="button"
                onClick={() => router.push(`/portal/staff/clients/${row.clientId}`)}
                className="text-ink font-semibold hover:text-navy hover:underline text-xs truncate block text-left cursor-pointer"
                title="View client profile"
              >
                {row.clientName}
              </button>
              <div className="text-[10px] text-mut font-mono truncate">
                {row.accountExternalRef ? `#${row.accountExternalRef}` : ""} {row.accountLabel}
              </div>
            </div>
          </div>
        </td>

        {/* Ticker & Company */}
        <td className="px-4.5 py-3 whitespace-nowrap">
          <span className="code font-mono px-1.5 py-0.5 rounded-[5px] bg-paper-2 font-bold text-ink whitespace-nowrap inline-block">
            {row.ticker}
          </span>
          <div className="text-[11px] text-mut truncate max-w-[140px]" title={row.name}>
            {row.name}
          </div>
        </td>

        {/* Discrepancy badge */}
        <td className="px-4.5 py-3 whitespace-nowrap">
          <span
            className={`pill text-[10.5px] font-semibold rounded-full px-2.5 py-0.5 whitespace-nowrap inline-flex items-center gap-1 ${
              row.discrepancyType === "buy_unknown"
                ? "bg-loss-bg text-loss-d"
                : row.discrepancyType === "short_buy"
                ? "bg-amber-bg text-amber-d"
                : "bg-paper-2 text-ink border border-line/60"
            }`}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-current opacity-70" />
            {row.discrepancyLabel}
          </span>
        </td>

        {/* Buy Qty */}
        <td className="px-4.5 py-3 text-right font-mono text-ink whitespace-nowrap">
          <span {...mark(row.overridden.buyQty, qty(row.computed.buyQty))}>
            {row.buyQty === 0 ? "0" : qty(row.buyQty)}
          </span>
        </td>

        {/* Sell Qty */}
        <td className="px-4.5 py-3 text-right font-mono text-ink whitespace-nowrap">
          <span {...mark(row.overridden.sellQty, qty(row.computed.sellQty))}>
            {row.sellQty === 0 ? "0" : qty(row.sellQty)}
          </span>
        </td>

        {/* Buy Cost */}
        <td className="px-4.5 py-3 text-right font-mono text-mut whitespace-nowrap">
          <span {...mark(row.overridden.buyPrice, `$${money(row.computed.buyPrice)}`)}>
            ${money2(row.buyPrice)}
          </span>
        </td>

        {/* Sell / Current */}
        <td className="px-4.5 py-3 text-right font-mono font-semibold text-ink whitespace-nowrap">
          <span {...mark(row.overridden.sellOrCurrent, `$${money(row.computed.sellOrCurrent)}`)}>
            ${money2(row.sellOrCurrent)}
          </span>
        </td>

        {/* P&L */}
        <td
          className={`px-4.5 py-3 text-right font-mono font-semibold whitespace-nowrap ${
            row.pnl >= 0 ? "text-gain" : "text-loss-d"
          }`}
        >
          {row.pnl < 0 ? "-" : "+"}${money2(Math.abs(row.pnl))}
        </td>

        {/* Status / Override Note */}
        <td className="px-4.5 py-3 text-xs">
          <div className="flex items-center gap-1.5 flex-wrap">
            {row.edited ? (
              <span className="pill text-[10px] font-semibold rounded-full px-2 py-0.5 bg-blue-50 text-blue-700 border border-blue-200">
                Edited
              </span>
            ) : (
              <span className="pill text-[10px] font-semibold rounded-full px-2 py-0.5 bg-amber-50 text-amber-800 border border-amber-200">
                Pending Fix
              </span>
            )}
            {row.note && (
              <span className="text-[11px] text-mut truncate max-w-[160px]" title={row.note}>
                {row.note}
              </span>
            )}
          </div>
        </td>

        {/* Actions */}
        <td className="px-4.5 py-3 text-right whitespace-nowrap select-none">
          <button
            type="button"
            onClick={onEdit}
            className="btn ghost sm text-[11px] font-semibold px-2.5 py-1 rounded-[6px] border border-line hover:border-navy hover:text-navy transition-colors cursor-pointer"
          >
            {row.edited ? "Edit Fix" : "Fix Qty"}
          </button>
        </td>
      </tr>
    );
  }

  // Inline editing state
  return (
    <tr className="bg-amber-bg/30 border-t border-line-2 shadow-xs transition-colors">
      <td className="px-4.5 py-3" colSpan={3}>
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="code font-mono px-1.5 py-0.5 rounded-[5px] bg-white font-bold text-ink">
              {row.ticker}
            </span>
            <span className="font-semibold text-xs text-ink">{row.clientName}</span>
            <span className="text-[11px] text-mut font-mono">
              ({row.accountExternalRef ? `#${row.accountExternalRef}` : ""} {row.accountLabel})
            </span>
          </div>
          <input
            type="text"
            placeholder="Add note (e.g. Placement allocation confirmed from 2024 sheet)..."
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={onKey}
            className="w-full bg-white border border-line-2 rounded-[6px] px-2.5 py-1 text-xs text-ink placeholder:text-mut focus:border-navy focus:outline-none"
          />
          {error && <div className="text-[11px] text-loss font-semibold">{error}</div>}
        </div>
      </td>

      {/* Buy Qty input */}
      <td className="px-2 py-3">
        <input
          type="text"
          value={buyQty}
          onChange={(e) => setBuyQty(e.target.value)}
          onKeyDown={onKey}
          placeholder={String(row.computed.buyQty)}
          className={CELL_INPUT}
          title="Buy quantity"
        />
      </td>

      {/* Sell Qty input */}
      <td className="px-2 py-3">
        <input
          type="text"
          value={sellQty}
          onChange={(e) => setSellQty(e.target.value)}
          onKeyDown={onKey}
          placeholder={String(row.computed.sellQty)}
          className={CELL_INPUT}
          title="Sell quantity"
        />
      </td>

      {/* Buy Cost input */}
      <td className="px-2 py-3">
        <input
          type="text"
          value={buyPrice}
          onChange={(e) => setBuyPrice(e.target.value)}
          onKeyDown={onKey}
          placeholder={row.computed.buyPrice.toFixed(2)}
          className={CELL_INPUT}
          title="Buy total cost"
        />
      </td>

      {/* Sell / Current input */}
      <td className="px-2 py-3">
        <input
          type="text"
          value={sellPrice}
          onChange={(e) => setSellPrice(e.target.value)}
          onKeyDown={onKey}
          placeholder={row.computed.sellOrCurrent.toFixed(2)}
          className={CELL_INPUT}
          title="Sell / current valuation total"
        />
      </td>

      {/* Live recomputed P&L */}
      <td
        className={`px-4.5 py-3 text-right font-mono font-bold whitespace-nowrap ${
          livePnl >= 0 ? "text-gain" : "text-loss-d"
        }`}
      >
        {livePnl < 0 ? "-" : "+"}${money2(Math.abs(livePnl))}
      </td>

      {/* Action buttons */}
      <td className="px-4.5 py-3 text-right whitespace-nowrap select-none" colSpan={2}>
        <div className="flex items-center justify-end gap-1.5">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="btn sm bg-navy text-white hover:opacity-90 font-semibold px-3 py-1 rounded-[6px] cursor-pointer disabled:opacity-50 text-xs shadow-xs"
          >
            {saving ? "Saving..." : "Save"}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="btn ghost sm border border-line bg-white hover:bg-paper-2 font-semibold px-2.5 py-1 rounded-[6px] cursor-pointer text-xs text-mut hover:text-ink"
          >
            Cancel
          </button>
          {row.edited && (
            <button
              type="button"
              onClick={clearOverride}
              disabled={saving}
              className="text-[11px] text-loss hover:underline cursor-pointer pl-1"
              title="Revert back to computed values"
            >
              Revert
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
