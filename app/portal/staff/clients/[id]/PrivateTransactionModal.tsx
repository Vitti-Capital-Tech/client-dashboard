"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { addPrivateTransactionAction } from "@/app/actions/trades";
import type { PrivateTransactionInput } from "@/app/actions/trades";

/**
 * Record something the client holds via us that the broker never sees.
 *
 * ── Why this is its own form and not the mismatches one ─────────────────────
 * `TradeForm` exists to split a misbooked contract note, and every default in
 * it assumes a broker statement sitting on the desk. This form is opened with
 * no statement at all: the desk is stating a fact the broker has no record of,
 * which is a different act and carries two fields the other form has no use for
 * — a valuation for an asset with no market, and a provenance note.
 *
 * Sharing one form would mean a valuation box on the repair path (where it is
 * meaningless, because a listed parcel prices itself) and a set of broker
 * defaults here (where there is no broker). Two small forms, each honest about
 * what it is for.
 *
 * ── The one thing the desk has to get right ─────────────────────────────────
 * The code. Everything downstream slices a plain code to its first three
 * characters to find the ASX ordinary underneath it, so `ACMEPRIVATE` files
 * itself under `ACM` beside a company it has nothing to do with. An exchange
 * suffix (`ACME:PVT`) is already the codebase's way of saying "this instrument
 * is its own parent", so the field says so rather than leaving it to be
 * discovered from a wrong-looking portfolio.
 *
 * ── The two kinds of thing entered here ─────────────────────────────────────
 * An off-market parcel of a LISTED security needs no valuation: the ASX feed
 * already carries the code and prices it like any other line. A genuinely
 * unlisted asset — private company shares, a convertible note — has no feed and
 * never will, so without a stated valuation it is carried at cost and reads as
 * flat forever. The form says so rather than leaving the desk to infer it.
 */

const FIELD =
  "w-full bg-white border border-line-2 rounded-[6px] px-2.5 py-1.5 " +
  "font-mono text-[12px] text-ink outline-none focus:border-navy transition-all";

const LABEL = "block text-[10.5px] font-semibold uppercase tracking-wider text-mut mb-1";

/** `""` → null (fall through to the server's default). `undefined` = unparseable. */
function toNum(s: string): number | null | undefined {
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

export type PrivateTxnAccount = { id: string; label: string };

export function PrivateTransactionModal({
  isOpen,
  onClose,
  clientId,
  clientName,
  accounts,
  /** The account the page is scoped to, or null when it is showing all of them. */
  defaultAccountId,
}: {
  isOpen: boolean;
  onClose: () => void;
  clientId: string;
  clientName: string;
  accounts: PrivateTxnAccount[];
  defaultAccountId: string | null;
}) {
  const router = useRouter();

  const [accountId, setAccountId] = useState(defaultAccountId ?? accounts[0]?.id ?? "");
  const [code, setCode] = useState("");
  const [securityName, setSecurityName] = useState("");
  const [side, setSide] = useState<"BUY" | "SELL">("BUY");
  const [tradeDate, setTradeDate] = useState(new Date().toISOString().slice(0, 10));
  const [units, setUnits] = useState("");
  const [price, setPrice] = useState("");
  const [consideration, setConsideration] = useState("");
  const [brokerage, setBrokerage] = useState("");
  const [manualPrice, setManualPrice] = useState("");
  const [manualPriceAt, setManualPriceAt] = useState("");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const reset = () => {
    setCode("");
    setSecurityName("");
    setSide("BUY");
    setTradeDate(new Date().toISOString().slice(0, 10));
    setUnits("");
    setPrice("");
    setConsideration("");
    setBrokerage("");
    setManualPrice("");
    setManualPriceAt("");
    setReference("");
    setNote("");
    setError(null);
  };

  const submit = async () => {
    setError(null);

    const nUnits = toNum(units);
    const nPrice = toNum(price);
    const nConsideration = toNum(consideration);
    const nBrokerage = toNum(brokerage);
    const nValuation = toNum(manualPrice);

    // Caught here rather than sent as NaN: a number the server cannot read comes
    // back as "is not a number", which does not say WHICH box.
    if (nUnits === undefined || nUnits === null) return setError("Enter the number of units.");
    if (nPrice === undefined || nPrice === null) return setError("Enter the price per unit.");
    if (nConsideration === undefined) return setError("The consideration is not a number.");
    if (nBrokerage === undefined) return setError("The brokerage is not a number.");
    if (nValuation === undefined) return setError("The valuation is not a number.");
    if (!accountId) return setError("Choose the account this belongs to.");

    const input: PrivateTransactionInput = {
      securityCode: code,
      securityName: securityName.trim() || null,
      side,
      tradeDate,
      units: nUnits,
      avgPrice: nPrice,
      consideration: nConsideration,
      brokerage: nBrokerage,
      cnote: reference.trim() || null,
      privateNote: note.trim() || null,
      manualPrice: nValuation,
      manualPriceAt: manualPriceAt.trim() || null,
    };

    setSaving(true);
    const res = await addPrivateTransactionAction(accountId, clientId, input);
    setSaving(false);

    if (!res.ok) {
      setError(res.error);
      return;
    }

    reset();
    // The P&L was recomputed server-side before this returned, so a refresh is
    // enough — the holding, the portfolio row and the badge all arrive together.
    router.refresh();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Add a private transaction for ${clientName}`}
    >
      <div className="w-full max-w-[640px] max-h-[90vh] overflow-y-auto bg-white rounded-[14px] border border-line shadow-shadow">
        <div className="px-5 py-4 border-b border-line">
          <b className="text-sm font-semibold text-ink">Add private transaction</b>
          <p className="mt-1 text-[11.5px] text-mut leading-relaxed">
            Something {clientName} holds via us that the broker does not custody — an off-market
            parcel, a transfer, or an unlisted asset. It joins the ledger, shows on their portfolio
            marked <b>Private</b>, and is not touched by the morning import.
          </p>
        </div>

        <div className="px-5 py-4 grid grid-cols-2 gap-3.5">
          {accounts.length > 1 && (
            <div className="col-span-2">
              <label className={LABEL} htmlFor="ptx-account">
                Account
              </label>
              <select
                id="ptx-account"
                className={FIELD}
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className={LABEL} htmlFor="ptx-code">
              Code
            </label>
            <input
              id="ptx-code"
              className={FIELD}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="LDX or ACME:PVT"
            />
            <p className="mt-1 text-[10.5px] text-mut leading-snug">
              ASX code if listed. If it is not an ASX security, add an exchange
              suffix — <span className="font-mono">ACME:PVT</span> — or the code is
              read as a three-letter ASX ticker and filed under{" "}
              <span className="font-mono">ACM</span>.
            </p>
          </div>

          <div>
            <label className={LABEL} htmlFor="ptx-name">
              Name
            </label>
            <input
              id="ptx-name"
              className={FIELD}
              value={securityName}
              onChange={(e) => setSecurityName(e.target.value)}
              placeholder="Acme Holdings Pty Ltd"
            />
          </div>

          <div>
            <label className={LABEL} htmlFor="ptx-side">
              Side
            </label>
            <select
              id="ptx-side"
              className={FIELD}
              value={side}
              onChange={(e) => setSide(e.target.value as "BUY" | "SELL")}
            >
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
            </select>
          </div>

          <div>
            <label className={LABEL} htmlFor="ptx-date">
              Transaction date
            </label>
            <input
              id="ptx-date"
              type="date"
              className={FIELD}
              value={tradeDate}
              onChange={(e) => setTradeDate(e.target.value)}
            />
          </div>

          <div>
            <label className={LABEL} htmlFor="ptx-units">
              Units
            </label>
            <input
              id="ptx-units"
              className={FIELD}
              value={units}
              onChange={(e) => setUnits(e.target.value)}
              placeholder="10,000"
            />
          </div>

          <div>
            <label className={LABEL} htmlFor="ptx-price">
              Price per unit
            </label>
            <input
              id="ptx-price"
              className={FIELD}
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="1.25"
            />
          </div>

          <div>
            <label className={LABEL} htmlFor="ptx-consideration">
              Consideration
            </label>
            <input
              id="ptx-consideration"
              className={FIELD}
              value={consideration}
              onChange={(e) => setConsideration(e.target.value)}
              placeholder="units × price"
            />
          </div>

          <div>
            <label className={LABEL} htmlFor="ptx-brokerage">
              Fees
            </label>
            <input
              id="ptx-brokerage"
              className={FIELD}
              value={brokerage}
              onChange={(e) => setBrokerage(e.target.value)}
              placeholder="0.00"
            />
          </div>

          <div className="col-span-2 mt-1 pt-3.5 border-t border-line">
            <p className="text-[11px] text-mut leading-relaxed mb-3">
              <b className="text-ink">Valuation</b> — only for an asset with no price feed. A
              listed code is priced off the ASX feed and should be left blank here; anything
              unlisted is carried at cost until a figure is entered, which reads as no gain or
              loss.
            </p>
          </div>

          <div>
            <label className={LABEL} htmlFor="ptx-valuation">
              Value per unit
            </label>
            <input
              id="ptx-valuation"
              className={FIELD}
              value={manualPrice}
              onChange={(e) => setManualPrice(e.target.value)}
              placeholder="leave blank if listed"
            />
          </div>

          <div>
            <label className={LABEL} htmlFor="ptx-valuation-at">
              Valued as at
            </label>
            <input
              id="ptx-valuation-at"
              type="date"
              className={FIELD}
              value={manualPriceAt}
              onChange={(e) => setManualPriceAt(e.target.value)}
            />
          </div>

          <div>
            <label className={LABEL} htmlFor="ptx-ref">
              Reference
            </label>
            <input
              id="ptx-ref"
              className={FIELD}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="auto"
            />
          </div>

          <div>
            <label className={LABEL} htmlFor="ptx-note">
              Note (staff only)
            </label>
            <input
              id="ptx-note"
              className={FIELD}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Off-market transfer from SMSF"
            />
          </div>

          {error && (
            <div
              role="alert"
              className="col-span-2 text-[11.5px] text-red bg-red/5 border border-red/20 rounded-[6px] px-3 py-2"
            >
              {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3.5 border-t border-line flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="text-xs font-semibold px-3.5 py-1.5 rounded-[7px] border border-line-2 text-mut hover:text-ink transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving}
            className="text-xs font-semibold px-3.5 py-1.5 rounded-[7px] bg-navy text-white hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {saving ? "Saving…" : "Add transaction"}
          </button>
        </div>
      </div>
    </div>
  );
}
