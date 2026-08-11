"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import type { PnlSummaryRow } from "@/lib/export/order-history";
import { savePnlOverride } from "@/app/actions/pnl-overrides";
import { ManageTradesModal } from "@/app/portal/staff/mismatches/ManageTradesModal";

/**
 * One row of the P&L-by-company table, in either display or edit mode.
 *
 * Editing happens **in place**: the four input cells become fields, everything
 * else stays put, and the row keeps its position and colour. Nothing expands,
 * so the reader never loses their place in the table.
 *
 * P&L is not editable — it recomputes as `sell − buy` while you type, so a
 * hand-edited row can never display a total its own columns contradict. A blank
 * field means "use the computed value", which is also how a correction is
 * undone; the placeholder always shows what the sources say, so you can see the
 * baseline you are overriding.
 */

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
  "w-full bg-white border border-line-2 rounded-[6px] px-1.5 py-1 " +
  "font-mono text-[12px] text-ink text-right placeholder:text-mut-d " +
  "outline-none focus:border-navy";

export function PnlRow({
  row,
  editing,
  onEdit,
  onClose,
  accountId,
  clientId,
  money2,
}: {
  row: PnlSummaryRow;
  editing: boolean;
  onEdit: () => void;
  onClose: () => void;
  accountId: string | null;
  clientId: string;
  money2: (n: number) => string;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showManageModal, setShowManageModal] = useState(false);

  // Every field starts filled with the value currently in force (0 when there
  // is nothing), so the desk edits real numbers rather than typing into empty
  // boxes. Untouched fields are then dropped on save — see `diff` below — so
  // pre-filling costs nothing: only what actually changed becomes an override.
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
    if (!accountId) {
      setError("Pick one account first — an override is stored per account.");
      return;
    }
    const parsed = [buyQty, sellQty, buyPrice, sellPrice].map(toNum);
    if (parsed.some((v) => v === undefined)) {
      setError("Not a number.");
      return;
    }

    /**
     * Store only what the desk actually changed. A field left at the computed
     * value — or cleared — goes back as null, which means "keep tracking the
     * ledger". Without this, pre-filling would silently detach every column of
     * the row from its source the first time anyone opened the editor.
     */
    const diff = (v: number | null | undefined, computed: number) =>
      v == null || Math.abs(v - computed) < 0.005 ? null : v;

    setSaving(true);
    setError(null);
    const res = await savePnlOverride(accountId, clientId, row.ticker, {
      buyQty: diff(parsed[0], row.computed.buyQty),
      sellQty: diff(parsed[1], row.computed.sellQty),
      buyPrice: diff(parsed[2], row.computed.buyPrice),
      sellOrCurrent: diff(parsed[3], row.computed.sellOrCurrent),
      note,
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

  // Amber = still open, green = fully exited — the same rule as the .xlsx.
  const fill = row.openPosition ? "bg-amber-bg/45" : "bg-green-bg/45";

  // A dotted underline marks a value set by hand, with the computed figure in
  // the tooltip so the change stays inspectable without opening the editor.
  const mark = (on: boolean, computed: string) =>
    on
      ? {
          className:
            "decoration-dotted decoration-loss underline underline-offset-4 cursor-help",
          title: `Edited by the desk · computed ${computed}`,
        }
      : {};

  if (!editing) {
    return (
      <tr className={`border-t border-[#f0ede5] ${fill}`}>
        <td className="px-4.5 py-3">
          <span
            className={`code font-mono px-1.5 py-0.5 rounded-[5px] bg-white/70 font-bold ${row.flagged ? "text-loss-d" : "text-ink"}`}
          >
            {row.ticker}
          </span>
        </td>
        <td className={`px-4.5 py-3 ${row.flagged ? "text-loss-d font-semibold" : "text-mut"}`}>
          {row.name}
        </td>
        <td className="px-4.5 py-3 text-right font-mono">
          <span {...mark(row.overridden.buyQty, qty(row.computed.buyQty))}>
            {row.buyQty === 0 ? "—" : qty(row.buyQty)}
          </span>
        </td>
        <td className="px-4.5 py-3 text-right font-mono">
          <span {...mark(row.overridden.sellQty, qty(row.computed.sellQty))}>
            {row.sellQty === 0 ? "—" : qty(row.sellQty)}
          </span>
        </td>
        <td className="px-4.5 py-3 text-right font-mono">
          <span {...mark(row.overridden.buyPrice, `$${money(row.computed.buyPrice)}`)}>
            ${money2(row.buyPrice)}
          </span>
        </td>
        <td className="px-4.5 py-3 text-right font-mono">
          <span
            {...mark(row.overridden.sellOrCurrent, `$${money(row.computed.sellOrCurrent)}`)}
          >
            ${money2(row.sellOrCurrent)}
          </span>
        </td>
        <td
          className={`px-4.5 py-3 text-right font-mono font-semibold ${row.pnl >= 0 ? "text-gain" : "text-loss-d"}`}
        >
          {row.pnl < 0 ? "-" : ""}${money2(Math.abs(row.pnl))}
        </td>
        <td className="px-4.5 py-3 text-center">
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${row.openPosition ? "bg-amber-bg text-amber-d" : "bg-green-bg text-green-d"}`}
          >
            {row.openPosition ? "Yes" : "No"}
          </span>
        </td>
        <td className={`px-4.5 py-3 text-[11px] ${row.flagged ? "text-loss-d font-semibold" : "text-mut"}`}>
          {row.type}
          {row.note && (
            <div className="text-[10px] text-mut-d italic mt-0.5">{row.note}</div>
          )}
        </td>
        <td className="px-4.5 py-3 text-right select-none">
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={onEdit}
              className="text-[11px] font-semibold text-mut hover:text-ink underline underline-offset-2 cursor-pointer"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={() => setShowManageModal(true)}
              className="p-1 rounded-[5px] text-mut hover:text-loss hover:bg-loss-bg border border-transparent hover:border-loss/30 transition-all cursor-pointer inline-flex items-center justify-center"
              title="Manage & Delete Transactions"
            >
              <svg
                className="w-3.5 h-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2M10 11v6M14 11v6" />
              </svg>
            </button>
          </div>

          <ManageTradesModal
            isOpen={showManageModal}
            onClose={() => setShowManageModal(false)}
            accountId={accountId || ""}
            clientId={clientId}
            clientName={row.name}
            accountLabel="Account"
            accountExternalRef={null}
            ticker={row.ticker}
            companyName={row.name}
            discrepancyLabel={row.type}
            discrepancyType={row.buyQty === 0 && row.sellQty > 0 ? "buy_unknown" : "unmatched"}
          />
        </td>
      </tr>
    );
  }

  // ── Edit mode: same row, same colour, cells swapped for fields ────────────
  return (
    <tr className={`border-t border-line-2 ${fill} ring-1 ring-inset ring-navy/25`}>
      <td className="px-4.5 py-2">
        <span className="code font-mono px-1.5 py-0.5 rounded-[5px] bg-white/70 font-bold text-ink">
          {row.ticker}
        </span>
      </td>
      <td className="px-4.5 py-2 text-mut">{row.name}</td>

      <td className="px-2 py-2">
        <input
          autoFocus
          value={buyQty}
          onChange={(e) => setBuyQty(e.target.value)}
          onKeyDown={onKey}
          inputMode="decimal"
          placeholder={qty(row.computed.buyQty)}
          className={CELL_INPUT}
        />
      </td>
      <td className="px-2 py-2">
        <input
          value={sellQty}
          onChange={(e) => setSellQty(e.target.value)}
          onKeyDown={onKey}
          inputMode="decimal"
          placeholder={qty(row.computed.sellQty)}
          className={CELL_INPUT}
        />
      </td>
      <td className="px-2 py-2">
        <input
          value={buyPrice}
          onChange={(e) => setBuyPrice(e.target.value)}
          onKeyDown={onKey}
          inputMode="decimal"
          placeholder={money(row.computed.buyPrice)}
          className={CELL_INPUT}
        />
      </td>
      <td className="px-2 py-2">
        <input
          value={sellPrice}
          onChange={(e) => setSellPrice(e.target.value)}
          onKeyDown={onKey}
          inputMode="decimal"
          placeholder={money(row.computed.sellOrCurrent)}
          className={CELL_INPUT}
        />
      </td>

      {/* Derived, never typed — it moves as you edit the two price cells. */}
      <td
        className={`px-4.5 py-2 text-right font-mono font-semibold ${livePnl >= 0 ? "text-gain" : "text-loss-d"}`}
      >
        {livePnl < 0 ? "-" : ""}${money(Math.abs(livePnl))}
        {Math.abs(livePnl - row.computed.pnl) > 0.005 && (
          <div className="text-[9.5px] font-normal text-mut-d">
            was {row.computed.pnl < 0 ? "-" : ""}${money(Math.abs(row.computed.pnl))}
          </div>
        )}
      </td>

      <td className="px-4.5 py-2 text-center">
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${row.openPosition ? "bg-amber-bg text-amber-d" : "bg-green-bg text-green-d"}`}
        >
          {row.openPosition ? "Yes" : "No"}
        </span>
      </td>

      {/* The reason lives here while editing — it goes onto the audit trail, so
          a figure that disagrees with its source is never anonymous. */}
      <td className="px-2 py-2">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={onKey}
          placeholder="why? (kept on the audit trail)"
          className={`${CELL_INPUT} text-left`}
        />
        {error && (
          <div className="text-[10px] text-loss-d font-semibold mt-1">{error}</div>
        )}
      </td>

      <td className="px-3 py-2">
        <div className="flex items-center justify-end gap-1.5">
          <button
            onClick={onClose}
            disabled={saving}
            title="Escape"
            className="text-[11px] font-semibold text-mut hover:text-ink transition-colors cursor-pointer disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving}
            title="Enter"
            className="bg-navy text-white rounded-[6px] px-2.5 py-1 text-[11px] font-semibold hover:bg-navy-2 transition-colors cursor-pointer disabled:opacity-40"
          >
            {saving ? "…" : "Save"}
          </button>
        </div>
      </td>
    </tr>
  );
}
