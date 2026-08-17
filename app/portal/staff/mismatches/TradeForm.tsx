"use client";

import React, { useState } from "react";
import type { TradeDetail, TradeInput } from "@/app/actions/trades";

/**
 * One contract note line, being entered or amended.
 *
 * The same form both ways on purpose. Splitting a misbooked note is one job in
 * two halves — reduce the original to the share parcel, add the option leg
 * beside it — and two forms that disagreed about how `value` is derived would
 * put the two halves on different footings.
 *
 * `Consideration` is left BLANK by default and computed as `units × price` when
 * it stays blank. A broker's note rarely divides exactly (partial fills average
 * out), so the box is there to be overridden — but nobody should have to do the
 * multiplication to enter an ordinary trade.
 */

const FIELD =
  "w-full bg-white border border-line-2 rounded-[6px] px-2.5 py-1.5 " +
  "font-mono text-[12px] text-ink outline-none focus:border-navy transition-all";

const LABEL = "block text-[10.5px] font-semibold uppercase tracking-wider text-mut mb-1";

/** "" → null (fall through to the default). `undefined` signals unparseable. */
function toNum(s: string): number | null | undefined {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

export function TradeForm({
  mode,
  existing,
  defaultCode,
  saving,
  onCancel,
  onSubmit,
}: {
  mode: "add" | "edit";
  /** Pre-fills every field when amending. */
  existing?: TradeDetail;
  /** What a new line defaults to — usually the row's own ticker. */
  defaultCode: string;
  saving: boolean;
  onCancel: () => void;
  onSubmit: (input: TradeInput) => void;
}) {
  const [code, setCode] = useState(existing?.securityCode ?? defaultCode);
  const [side, setSide] = useState<"BUY" | "SELL">(existing?.side ?? "BUY");
  const [tradeDate, setTradeDate] = useState(
    existing?.tradeDate ?? new Date().toISOString().slice(0, 10),
  );
  const [units, setUnits] = useState(existing ? String(existing.units) : "");
  const [price, setPrice] = useState(existing ? String(existing.avgPrice) : "");
  const [consideration, setConsideration] = useState(
    existing ? String(existing.consideration) : "",
  );
  const [brokerage, setBrokerage] = useState(existing ? String(existing.brokerage) : "");
  const [gst, setGst] = useState(existing ? String(existing.gst) : "");
  const [cnote, setCnote] = useState(existing?.cnote ?? "");
  const [instrument, setInstrument] = useState(existing?.instrument ?? "");
  const [problem, setProblem] = useState<string | null>(null);

  const parsedUnits = toNum(units);
  const parsedPrice = toNum(price);
  const parsedCons = toNum(consideration);

  // Shown live, because the fee direction is the thing most easily got wrong and
  // the number the P&L actually uses.
  const fees = (toNum(brokerage) ?? 0) + (toNum(gst) ?? 0);
  const grossPreview =
    parsedCons ?? (parsedUnits != null && parsedPrice != null ? parsedUnits * parsedPrice : null);
  const netPreview =
    typeof grossPreview === "number"
      ? side === "BUY"
        ? grossPreview + fees
        : grossPreview - fees
      : null;

  const submit = () => {
    if (parsedUnits === undefined || parsedPrice === undefined || parsedCons === undefined) {
      return setProblem("Units, price and consideration must be numbers.");
    }
    if (parsedUnits == null || parsedUnits <= 0) {
      return setProblem("Units must be greater than zero.");
    }
    if (parsedPrice == null || parsedPrice < 0) {
      return setProblem("Enter a price.");
    }
    setProblem(null);

    onSubmit({
      securityCode: code,
      side,
      tradeDate,
      units: parsedUnits,
      avgPrice: parsedPrice,
      consideration: parsedCons,
      brokerage: toNum(brokerage) ?? 0,
      gst: toNum(gst) ?? 0,
      cnote: cnote.trim() || null,
      instrument: instrument.trim() || null,
    });
  };

  return (
    <div className="p-4 rounded-[12px] bg-paper border border-line text-ink space-y-3 animate-in fade-in duration-150">
      <div className="text-xs font-bold text-ink">
        {mode === "add" ? "Add a contract note line" : `Amend CNote #${existing?.cnote}`}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <label>
          <span className={LABEL}>Security</span>
          <input
            className={`${FIELD} font-bold`}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            spellCheck={false}
          />
        </label>

        <label>
          <span className={LABEL}>Side</span>
          <select
            className={FIELD}
            value={side}
            onChange={(e) => setSide(e.target.value as "BUY" | "SELL")}
          >
            <option value="BUY">BUY</option>
            <option value="SELL">SELL</option>
          </select>
        </label>

        <label>
          <span className={LABEL}>Trade date</span>
          <input
            type="date"
            className={FIELD}
            value={tradeDate}
            onChange={(e) => setTradeDate(e.target.value)}
          />
        </label>

        <label>
          <span className={LABEL}>CNote</span>
          <input
            className={FIELD}
            value={cnote}
            onChange={(e) => setCnote(e.target.value)}
            placeholder={mode === "add" ? "auto" : ""}
            spellCheck={false}
          />
        </label>

        <label>
          <span className={LABEL}>Units</span>
          <input
            className={`${FIELD} text-right`}
            value={units}
            onChange={(e) => setUnits(e.target.value)}
            inputMode="decimal"
          />
        </label>

        <label>
          <span className={LABEL}>Price</span>
          <input
            className={`${FIELD} text-right`}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            inputMode="decimal"
          />
        </label>

        <label>
          <span className={LABEL}>Consideration</span>
          <input
            className={`${FIELD} text-right`}
            value={consideration}
            onChange={(e) => setConsideration(e.target.value)}
            placeholder={
              parsedUnits != null && parsedPrice != null
                ? (parsedUnits * parsedPrice).toFixed(2)
                : "units × price"
            }
            inputMode="decimal"
          />
        </label>

        <label>
          <span className={LABEL}>Description</span>
          <input
            className={FIELD}
            value={instrument}
            onChange={(e) => setInstrument(e.target.value)}
            placeholder="auto"
            spellCheck={false}
          />
        </label>

        <label>
          <span className={LABEL}>Brokerage</span>
          <input
            className={`${FIELD} text-right`}
            value={brokerage}
            onChange={(e) => setBrokerage(e.target.value)}
            placeholder="0.00"
            inputMode="decimal"
          />
        </label>

        <label>
          <span className={LABEL}>GST</span>
          <input
            className={`${FIELD} text-right`}
            value={gst}
            onChange={(e) => setGst(e.target.value)}
            placeholder="0.00"
            inputMode="decimal"
          />
        </label>

        {/* The figure the P&L actually uses. Fees go ON to a buy and OFF a sale,
            which is the easiest thing here to get backwards. */}
        <div className="col-span-2 flex items-end">
          <div className="text-[11px] text-mut leading-snug">
            <span className={LABEL}>Net cash flow</span>
            {netPreview == null ? (
              <span className="font-mono">—</span>
            ) : (
              <span className="font-mono font-bold text-ink">
                ${netPreview.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                <span className="font-normal text-mut ml-1.5">
                  {side === "BUY" ? "paid (fees added)" : "received (fees deducted)"}
                </span>
              </span>
            )}
          </div>
        </div>
      </div>

      {problem && <div className="text-[11px] font-semibold text-loss-d">{problem}</div>}

      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="px-3 py-1.5 rounded-[6px] text-xs font-medium border border-line text-mut hover:text-ink hover:bg-white transition-colors cursor-pointer"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={saving}
          className="px-3 py-1.5 rounded-[6px] text-xs font-bold bg-navy text-white hover:bg-navy-d transition-colors cursor-pointer disabled:opacity-50"
        >
          {saving ? "Saving..." : mode === "add" ? "Add Transaction" : "Save Changes"}
        </button>
      </div>
    </div>
  );
}
