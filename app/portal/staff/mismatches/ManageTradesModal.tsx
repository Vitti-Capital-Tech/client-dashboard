"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  getTradesForMismatch,
  deleteTradeAction,
  deleteAllTradesForTickerAction,
  excludePositionAction,
  reclassifyTradesAction,
  addTradeAction,
  updateTradeAction,
  type TradeClass,
  type TradeDetail,
  type TradeInput,
} from "@/app/actions/trades";
import { getParentTicker, isOptionCode } from "@/lib/pnl-calculator";
import { TradeForm } from "./TradeForm";

interface ManageTradesModalProps {
  isOpen: boolean;
  onClose: () => void;
  accountId: string;
  clientId: string;
  clientName: string;
  accountLabel: string;
  accountExternalRef: string | null;
  ticker: string;
  companyName: string;
  discrepancyLabel: string;
  discrepancyType: string;
  onSuccess?: () => void;
}

export function ManageTradesModal({
  isOpen,
  onClose,
  accountId,
  clientId,
  clientName,
  accountLabel,
  accountExternalRef,
  ticker,
  companyName,
  discrepancyLabel,
  discrepancyType,
  onSuccess,
}: ManageTradesModalProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [trades, setTrades] = useState<TradeDetail[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [tradeToConfirm, setTradeToConfirm] = useState<TradeDetail | null>(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [confirmExclude, setConfirmExclude] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  /**
   * Re-filing this ticker's contract notes as one thing or the other.
   *
   * `null` = closed. The code pre-fills to the ASX convention for whichever
   * direction was chosen — the ordinary plus `O` for an option, the plain
   * 3-character code for ordinary shares — but stays editable: a company with
   * more than one series in issue uses `FRSOA`, `FRSOB`, and only the desk knows
   * which one these notes belong to.
   */
  const [reclassifyTo, setReclassifyTo] = useState<TradeClass | null>(null);
  const [targetCode, setTargetCode] = useState("");
  /** The label printed under the ticker. Blank leaves the catalogue alone. */
  const [securityName, setSecurityName] = useState("");

  const openReclassify = (kind: TradeClass) => {
    closeOthers();
    setReclassifyTo(kind);
    setTargetCode(
      kind === "OPTION" ? `${getParentTicker(ticker)}O` : getParentTicker(ticker),
    );
    setSecurityName(companyName ?? "");
  };

  /**
   * Hand-entering or amending a line.
   *
   * `null` = closed; `{ mode: "add" }` = a new line; `{ mode: "edit", trade }` =
   * that one. One piece of state so the two forms can never be open at once and
   * leave the desk unsure which they are typing into.
   */
  const [form, setForm] = useState<
    { mode: "add" } | { mode: "edit"; trade: TradeDetail } | null
  >(null);

  const closeOthers = () => {
    setTradeToConfirm(null);
    setConfirmDeleteAll(false);
    setConfirmExclude(false);
    setReclassifyTo(null);
    setForm(null);
  };

  const reloadTrades = useCallback(async () => {
    setLoading(true);
    setError(null);
    const res = await getTradesForMismatch(accountId, ticker);
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
    } else {
      setTrades(res.data);
    }
  }, [accountId, ticker]);

  useEffect(() => {
    if (!isOpen) return;
    let ignore = false;
    getTradesForMismatch(accountId, ticker).then((res) => {
      if (!ignore) {
        setLoading(false);
        if (!res.ok) {
          setError(res.error);
        } else {
          setTrades(res.data);
        }
      }
    });
    return () => {
      ignore = true;
    };
  }, [isOpen, accountId, ticker]);

  // Handle ESC key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isOpen && !actionLoading) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, actionLoading, onClose]);

  if (!isOpen) return null;

  const handleDeleteSingle = async (trade: TradeDetail) => {
    setActionLoading(true);
    setError(null);
    setSuccess(null);

    const res = await deleteTradeAction(trade.id, accountId, clientId);
    setActionLoading(false);
    setTradeToConfirm(null);

    if (!res.ok) {
      setError(res.error);
    } else {
      setSuccess(`Contract Note #${trade.cnote} successfully deleted and P&L recalculated.`);
      router.refresh();
      if (onSuccess) onSuccess();
      void reloadTrades();
    }
  };

  const handleDeleteAll = async () => {
    setActionLoading(true);
    setError(null);
    setSuccess(null);

    const res = await deleteAllTradesForTickerAction(accountId, clientId, ticker);
    setActionLoading(false);
    setConfirmDeleteAll(false);

    if (!res.ok) {
      setError(res.error);
    } else {
      setSuccess(`Deleted ${res.data.count} contract note(s) for ${ticker} and recalculated P&L.`);
      router.refresh();
      if (onSuccess) onSuccess();
      void reloadTrades();
    }
  };

  const handleExcludePosition = async () => {
    setActionLoading(true);
    setError(null);
    setSuccess(null);

    const res = await excludePositionAction(
      accountId,
      clientId,
      ticker,
      "Dismissed / Excluded from Mismatches by desk",
    );
    setActionLoading(false);
    setConfirmExclude(false);

    if (!res.ok) {
      setError(res.error);
    } else {
      setSuccess(`Position ${ticker} has been excluded/dismissed from Mismatches.`);
      router.refresh();
      if (onSuccess) onSuccess();
      setTimeout(() => {
        onClose();
      }, 1200);
    }
  };

  const parent = getParentTicker(ticker);
  const wantedCode = targetCode.trim().toUpperCase();
  // Checked here as well as in the action so a typo is caught before it costs a
  // round trip and a full recompute. The action is still the authority, and the
  // two ladders read the same way in both directions on purpose.
  const codeProblem = !reclassifyTo
    ? null
    : !wantedCode
      ? `Enter the ${reclassifyTo === "OPTION" ? "option" : "ordinary"} code.`
      : reclassifyTo === "OPTION" && !isOptionCode(wantedCode)
        ? `Needs more than three characters with an O in the suffix, e.g. ${parent}O.`
        : reclassifyTo === "FPO" && isOptionCode(wantedCode)
          ? `${wantedCode} still reads as an option code. Ordinary shares use ${parent}.`
          : getParentTicker(wantedCode) !== parent
            ? `${wantedCode} belongs to ${getParentTicker(wantedCode)}, not ${parent}.`
            : null;

  const handleTradeSubmit = async (input: TradeInput) => {
    if (!form) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);

    const res =
      form.mode === "add"
        ? await addTradeAction(accountId, clientId, input)
        : await updateTradeAction(form.trade.id, accountId, clientId, input);

    setActionLoading(false);

    if (!res.ok) {
      setError(res.error);
      return;
    }

    setForm(null);
    setSuccess(
      form.mode === "add"
        ? `Added ${input.side} ${input.units.toLocaleString("en-AU")} ${input.securityCode.toUpperCase()} (CNote #${res.data.cnote}) and recalculated P&L.`
        : `CNote #${res.data.cnote} amended and P&L recalculated.`,
    );
    router.refresh();
    if (onSuccess) onSuccess();
    void reloadTrades();
  };

  const handleReclassify = async () => {
    if (!reclassifyTo) return;
    setActionLoading(true);
    setError(null);
    setSuccess(null);

    const res = await reclassifyTradesAction(
      accountId,
      clientId,
      ticker,
      wantedCode,
      reclassifyTo,
      // Unchanged means "leave the catalogue alone" — that name is shared by
      // every screen, so it moves only when the desk actually retyped it.
      securityName.trim() && securityName.trim() !== (companyName ?? "").trim()
        ? securityName.trim()
        : undefined,
    );
    setActionLoading(false);

    if (!res.ok) {
      setError(res.error);
      return;
    }

    const asOption = reclassifyTo === "OPTION";
    setReclassifyTo(null);
    setSuccess(
      `${res.data.count} contract note(s) re-filed as ${res.data.code} (${reclassifyTo}) and P&L recalculated. ` +
        (asOption
          ? "The row now reports as an option, so it leaves this page."
          : "The row now reports as ordinary shares."),
    );
    router.refresh();
    if (onSuccess) onSuccess();
    // Only the option direction takes the row off this page; an ordinary line
    // stays, so closing the modal on the desk would hide the result.
    if (asOption) setTimeout(() => onClose(), 2200);
    else void reloadTrades();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink/40 backdrop-blur-xs animate-in fade-in duration-200">
      <div
        className="relative w-full max-w-3xl bg-white border border-line rounded-[16px] shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="px-6 py-4.5 bg-paper border-b border-line flex items-start justify-between gap-3 flex-shrink-0">
          {/* `min-w-0` so a long client or account name wraps instead of pushing
              the close button off the edge. */}
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <span className="font-mono font-bold text-sm px-2 py-0.5 rounded-[5px] bg-navy text-white">
                {ticker}
              </span>
              <h2 className="text-base font-bold text-ink truncate max-w-[280px]">
                {companyName || ticker}
              </h2>
              <span
                className={`pill text-[10px] font-semibold rounded-full px-2 py-0.5 inline-flex items-center gap-1 ${
                  discrepancyType === "buy_unknown"
                    ? "bg-loss-bg text-loss-d"
                    : discrepancyType === "short_buy"
                    ? "bg-amber-bg text-amber-d"
                    : "bg-paper-2 text-ink border border-line/60"
                }`}
              >
                {discrepancyLabel}
              </span>
            </div>
            <div className="text-xs text-mut break-words">
              Client: <span className="font-semibold text-ink">{clientName}</span> &middot; Account:{" "}
              <span className="font-mono text-ink">
                {accountExternalRef ? `#${accountExternalRef}` : ""} {accountLabel}
              </span>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            disabled={actionLoading}
            className="w-8 h-8 shrink-0 rounded-full border border-line flex items-center justify-center text-mut hover:text-ink hover:bg-paper-2 transition-colors cursor-pointer"
            title="Close modal (Esc)"
          >
            &times;
          </button>
        </div>

        {/* Alerts / Feedback Banners */}
        {error && (
          <div className="mx-6 mt-4 p-3 rounded-[8px] bg-loss-bg border border-loss/20 text-xs text-loss-d font-medium flex items-center justify-between">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="text-loss-d font-bold ml-2 cursor-pointer"
            >
              &times;
            </button>
          </div>
        )}

        {success && (
          <div className="mx-6 mt-4 p-3 rounded-[8px] bg-gain-bg border border-gain/20 text-xs text-gain font-medium flex items-center justify-between">
            <span>{success}</span>
            <button
              type="button"
              onClick={() => setSuccess(null)}
              className="text-gain font-bold ml-2 cursor-pointer"
            >
              &times;
            </button>
          </div>
        )}

        {/* Modal Body */}
        {/* `overflow-x-hidden` + `min-w-0` keep the WIDE thing — the contract
            note table — scrolling inside its own box instead of dragging the
            whole body sideways and taking the panels and the header with it. */}
        <div className="p-6 overflow-y-auto overflow-x-hidden min-w-0 space-y-4 flex-1">
          {/* Confirmation Prompt for Single Trade Deletion */}
          {tradeToConfirm && (
            <div className="p-4 rounded-[12px] bg-amber-50 border border-amber-200 text-ink space-y-3 animate-in fade-in duration-150">
              <div className="flex items-start gap-2.5">
                <span className="text-amber-700 font-bold text-lg leading-none mt-0.5">⚠️</span>
                <div className="space-y-1">
                  <div className="text-xs font-bold text-amber-900">
                    Confirm Permanent Trade Deletion
                  </div>
                  <p className="text-xs text-amber-800">
                    Are you sure you want to permanently delete Contract Note{" "}
                    <span className="font-mono font-bold">#{tradeToConfirm.cnote}</span> (
                    {tradeToConfirm.side} {tradeToConfirm.units.toLocaleString("en-AU")} units @ $
                    {tradeToConfirm.avgPrice.toFixed(4)} on {tradeToConfirm.tradeDate})?
                  </p>
                  <p className="text-[11px] text-amber-700/80">
                    This will remove the transaction from the ledger, log an audit entry, and
                    automatically recalculate the client&apos;s stored P&amp;L.
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setTradeToConfirm(null)}
                  disabled={actionLoading}
                  className="px-3 py-1.5 rounded-[6px] text-xs font-medium border border-amber-300 text-amber-900 hover:bg-amber-100/60 transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => handleDeleteSingle(tradeToConfirm)}
                  disabled={actionLoading}
                  className="px-3 py-1.5 rounded-[6px] text-xs font-bold bg-loss text-white hover:bg-loss-d transition-colors cursor-pointer flex items-center gap-1.5"
                >
                  {actionLoading ? (
                    <>
                      <span className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      Deleting &amp; Recomputing...
                    </>
                  ) : (
                    "Yes, Delete Trade"
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Confirmation Prompt for Deleting All Trades */}
          {confirmDeleteAll && (
            <div className="p-4 rounded-[12px] bg-loss-bg border border-loss/20 text-ink space-y-3 animate-in fade-in duration-150">
              <div className="flex items-start gap-2.5">
                <span className="text-loss-d font-bold text-lg leading-none mt-0.5">🚨</span>
                <div className="space-y-1">
                  <div className="text-xs font-bold text-loss-d">
                    Delete ALL Transactions for {ticker}
                  </div>
                  <p className="text-xs text-loss-d">
                    Are you sure you want to permanently delete all{" "}
                    <span className="font-bold">{trades.length}</span> contract note(s) for{" "}
                    <span className="font-mono font-bold">{ticker}</span> on this account?
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setConfirmDeleteAll(false)}
                  disabled={actionLoading}
                  className="px-3 py-1.5 rounded-[6px] text-xs font-medium border border-line text-ink hover:bg-paper-2 transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleDeleteAll}
                  disabled={actionLoading}
                  className="px-3 py-1.5 rounded-[6px] text-xs font-bold bg-loss text-white hover:bg-loss-d transition-colors cursor-pointer flex items-center gap-1.5"
                >
                  {actionLoading ? (
                    <>
                      <span className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      Deleting All &amp; Recomputing...
                    </>
                  ) : (
                    "Yes, Delete All Trades"
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Confirmation Prompt for Position Exclusion */}
          {confirmExclude && (
            <div className="p-4 rounded-[12px] bg-blue-50 border border-blue-200 text-ink space-y-3 animate-in fade-in duration-150">
              <div className="flex items-start gap-2.5">
                <span className="text-blue-700 font-bold text-lg leading-none mt-0.5">ℹ️</span>
                <div className="space-y-1">
                  <div className="text-xs font-bold text-blue-950">
                    Exclude / Dismiss Position from Mismatches
                  </div>
                  <p className="text-xs text-blue-900">
                    This will apply a zeroed override with an audit note, removing this position
                    from Mismatches without deleting ledger history.
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setConfirmExclude(false)}
                  disabled={actionLoading}
                  className="px-3 py-1.5 rounded-[6px] text-xs font-medium border border-blue-300 text-blue-900 hover:bg-blue-100/60 transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleExcludePosition}
                  disabled={actionLoading}
                  className="px-3 py-1.5 rounded-[6px] text-xs font-bold bg-navy text-white hover:bg-navy-d transition-colors cursor-pointer flex items-center gap-1.5"
                >
                  {actionLoading ? "Applying..." : "Confirm Dismiss"}
                </button>
              </div>
            </div>
          )}

          {/* Entering or amending a line by hand.
              The pair that splits a misbooked note: the original is amended down
              to the share parcel, the option leg is added beside it under its own
              code. Neither half is expressible as an override — an override
              corrects a row's totals; these are ledger lines. */}
          {form && (
            <TradeForm
              key={form.mode === "edit" ? form.trade.id : "add"}
              mode={form.mode}
              existing={form.mode === "edit" ? form.trade : undefined}
              defaultCode={ticker}
              saving={actionLoading}
              onCancel={() => setForm(null)}
              onSubmit={handleTradeSubmit}
            />
          )}

          {/* Reclassifying, in whichever direction the broker got it wrong.
              → OPTION: option transactions booked against the ordinary code, so
                the row carries a sell side with no buys and reads as a mismatch
                forever when the trades belong on their own option line.
              → FPO:    the mirror. Fully Paid Ordinary — plain equity — wearing
                an option description, so a share parcel is reported as a
                derivative and kept out of the equity totals it belongs in.

              `min-w-0` + `break-words` throughout: the body clips rather than
              scrolls now, so anything that overflowed here would be invisibly
              cut off — a worse failure than the sideways scroll it replaced. */}
          {reclassifyTo && (
            <div className="p-4 rounded-[12px] bg-[#f5f3fa] border border-[#d8d3e5] text-ink space-y-3 min-w-0 animate-in fade-in duration-150">
              <div className="space-y-1 min-w-0">
                <div className="text-xs font-bold text-[#443f5c]">
                  Re-file {trades.length} contract note{trades.length === 1 ? "" : "s"} as{" "}
                  {reclassifyTo === "OPTION" ? "options" : "ordinary shares (FPO)"}
                </div>
                <p className="text-xs text-[#5c5775] leading-relaxed break-words">
                  {reclassifyTo === "OPTION" ? (
                    <>
                      These trades move from{" "}
                      <span className="font-mono font-bold">{ticker}</span> onto their own option
                      line, and stop being reported as a quantity mismatch.
                    </>
                  ) : (
                    <>
                      <span className="font-mono font-bold">FPO</span> is Fully Paid Ordinary —
                      plain equity, not a derivative. These trades stay on{" "}
                      <span className="font-mono font-bold">{parent}</span> and are reported as
                      shares rather than options.
                    </>
                  )}{" "}
                  The underlying stays <span className="font-mono font-bold">{parent}</span> either
                  way, and the P&amp;L is recalculated before this closes.
                </p>
              </div>

              <div className="flex items-end gap-2.5 flex-wrap min-w-0">
                <label className="space-y-1">
                  <span className="block text-[10.5px] font-semibold uppercase tracking-wider text-[#5c5775]">
                    {reclassifyTo === "OPTION" ? "Option code" : "Ordinary code"}
                  </span>
                  <input
                    type="text"
                    value={targetCode}
                    onChange={(e) => setTargetCode(e.target.value.toUpperCase())}
                    disabled={actionLoading}
                    spellCheck={false}
                    className="w-32 bg-white border border-[#d8d3e5] rounded-[6px] px-2.5 py-1.5 font-mono text-[13px] font-bold text-ink outline-none focus:border-navy transition-all"
                  />
                </label>

                {/* The label printed under the ticker — "FLYNNGOLD - OPTION 14-…"
                    on a parcel of ordinary shares is the thing this fixes. */}
                <label className="space-y-1 flex-1 min-w-[180px]">
                  <span className="block text-[10.5px] font-semibold uppercase tracking-wider text-[#5c5775]">
                    Company label
                  </span>
                  <input
                    type="text"
                    value={securityName}
                    onChange={(e) => setSecurityName(e.target.value)}
                    disabled={actionLoading}
                    placeholder="leave as is"
                    className="w-full bg-white border border-[#d8d3e5] rounded-[6px] px-2.5 py-1.5 text-[12px] text-ink outline-none focus:border-navy transition-all"
                  />
                </label>
              </div>

              <div className="text-[11px] text-[#5c5775] min-w-0 break-words">
                {codeProblem ? (
                  <span className="text-loss-d font-semibold">{codeProblem}</span>
                ) : (
                  <span>
                    {ticker} &rarr; <span className="font-mono font-bold">{wantedCode}</span>{" "}
                    &middot; described as{" "}
                    <span className="font-mono font-bold">{reclassifyTo}</span>
                  </span>
                )}
              </div>

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setReclassifyTo(null)}
                  disabled={actionLoading}
                  className="px-3 py-1.5 rounded-[6px] text-xs font-medium border border-[#d8d3e5] text-[#443f5c] hover:bg-white transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleReclassify}
                  disabled={actionLoading || codeProblem !== null}
                  className="px-3 py-1.5 rounded-[6px] text-xs font-bold bg-[#5c5775] text-white hover:bg-[#443f5c] transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {actionLoading ? "Re-filing..." : `Convert to ${wantedCode || reclassifyTo}`}
                </button>
              </div>
            </div>
          )}

          {/* Trades Table */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-wider text-mut">
                Associated Contract Notes ({trades.length})
              </h3>
              <div className="flex items-center gap-3">
                {/* Available even with no notes on file — a leg the ledger never
                    had is exactly the thing that has to be typed in. */}
                <button
                  type="button"
                  onClick={() => {
                    closeOthers();
                    setForm({ mode: "add" });
                  }}
                  disabled={actionLoading}
                  title="Enter a contract note line the broker file did not carry"
                  className="text-[11px] font-semibold text-navy hover:underline cursor-pointer flex items-center gap-1"
                >
                  + Add Transaction
                </button>
                {/* Only with notes to move. Nothing to reclassify on a row that
                    came from a snapshot or a modelled grant. Both directions are
                    offered because the broker's description gets it wrong both
                    ways. */}
                {trades.length > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={() => openReclassify("OPTION")}
                      disabled={actionLoading}
                      title="These are option transactions booked against the ordinary code"
                      className="text-[11px] font-semibold text-[#5c5775] hover:underline cursor-pointer flex items-center gap-1"
                    >
                      Convert to Options
                    </button>
                    <button
                      type="button"
                      onClick={() => openReclassify("FPO")}
                      disabled={actionLoading}
                      title="These are ordinary shares — Fully Paid Ordinary — described as options"
                      className="text-[11px] font-semibold text-[#5c5775] hover:underline cursor-pointer flex items-center gap-1"
                    >
                      Convert to FPO
                    </button>
                  </>
                )}
                {trades.length > 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      closeOthers();
                      setConfirmDeleteAll(true);
                    }}
                    disabled={actionLoading}
                    className="text-[11px] font-semibold text-loss hover:underline cursor-pointer flex items-center gap-1"
                  >
                    Delete All ({trades.length})
                  </button>
                )}
              </div>
            </div>

            {loading ? (
              <div className="py-12 text-center text-xs text-mut space-y-2">
                <span className="inline-block w-5 h-5 border-2 border-navy border-t-transparent rounded-full animate-spin" />
                <div>Fetching ledger contract notes...</div>
              </div>
            ) : trades.length === 0 ? (
              <div className="p-6 rounded-[12px] bg-paper-2 border border-line/80 text-center space-y-2.5">
                <div className="text-sm font-semibold text-ink">No Contract Notes Found</div>
                <p className="text-xs text-mut max-w-md mx-auto">
                  There are no raw broker contract notes in the trade ledger for{" "}
                  <span className="font-mono font-bold text-ink">{ticker}</span>. This mismatch
                  originates from a portfolio snapshot or an unlisted placement grant.
                </p>
                <div className="flex items-center justify-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => {
                      closeOthers();
                      setForm({ mode: "add" });
                    }}
                    disabled={actionLoading}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[6px] text-xs font-bold bg-navy text-white hover:bg-navy-d transition-colors cursor-pointer"
                  >
                    + Add Transaction
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      closeOthers();
                      setConfirmExclude(true);
                    }}
                    disabled={actionLoading}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[6px] text-xs font-bold bg-paper text-navy border border-navy/30 hover:bg-navy hover:text-white transition-colors cursor-pointer"
                  >
                    Dismiss / Exclude Mismatch
                  </button>
                </div>
              </div>
            ) : (
              <div className="border border-line rounded-[10px] overflow-x-auto bg-white shadow-xs">
                <table className="w-full min-w-[620px] text-xs text-left border-collapse">
                  <thead>
                    <tr className="bg-paper text-mut text-[11px] font-semibold uppercase tracking-wider border-b border-line select-none">
                      <th className="px-3.5 py-2.5">Trade Date</th>
                      <th className="px-3.5 py-2.5">CNote #</th>
                      <th className="px-3.5 py-2.5">Type</th>
                      <th className="px-3.5 py-2.5 text-right">Units</th>
                      <th className="px-3.5 py-2.5 text-right">Price</th>
                      <th className="px-3.5 py-2.5 text-right">Value ($)</th>
                      <th className="px-3.5 py-2.5 text-center">Status</th>
                      <th className="px-3.5 py-2.5 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/60">
                    {trades.map((t) => (
                      <tr key={t.id} className="hover:bg-paper/40 transition-colors">
                        <td className="px-3.5 py-2.5 whitespace-nowrap font-mono text-ink">
                          {t.tradeDate}
                        </td>
                        <td className="px-3.5 py-2.5 whitespace-nowrap font-mono text-ink font-semibold">
                          #{t.cnote}
                        </td>
                        <td className="px-3.5 py-2.5 whitespace-nowrap">
                          <span
                            className={`pill text-[10px] font-bold px-2 py-0.5 rounded-full ${
                              t.side === "BUY"
                                ? "bg-gain-bg text-gain"
                                : "bg-loss-bg text-loss-d"
                            }`}
                          >
                            {t.side}
                          </span>
                        </td>
                        <td className="px-3.5 py-2.5 whitespace-nowrap text-right font-mono text-ink">
                          {t.units.toLocaleString("en-AU")}
                        </td>
                        <td className="px-3.5 py-2.5 whitespace-nowrap text-right font-mono text-mut">
                          ${t.avgPrice.toFixed(4)}
                        </td>
                        <td className="px-3.5 py-2.5 whitespace-nowrap text-right font-mono font-semibold text-ink">
                          ${t.value.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </td>
                        <td className="px-3.5 py-2.5 whitespace-nowrap text-center">
                          <span className="text-[10px] text-mut font-mono uppercase">
                            {t.status}
                          </span>
                        </td>
                        <td className="px-3.5 py-2.5 whitespace-nowrap text-right select-none">
                          <div className="inline-flex items-center gap-1">
                            {/* The other half of splitting a misbooked note:
                                reduce this line to the share parcel it really
                                was, then add the option leg beside it. */}
                            <button
                              type="button"
                              onClick={() => {
                                closeOthers();
                                setForm({ mode: "edit", trade: t });
                              }}
                              disabled={actionLoading}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-[5px] text-[11px] font-semibold text-navy hover:bg-paper border border-transparent hover:border-navy/30 transition-all cursor-pointer"
                              title="Amend the units, price or security on this contract note"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                closeOthers();
                                setTradeToConfirm(t);
                              }}
                              disabled={actionLoading}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-[5px] text-[11px] font-semibold text-loss hover:bg-loss-bg border border-transparent hover:border-loss/30 transition-all cursor-pointer"
                              title="Delete this contract note"
                            >
                              <svg
                                className="w-3 h-3"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                              >
                                <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2M10 11v6M14 11v6" />
                              </svg>
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3.5 bg-paper border-t border-line flex items-center justify-between flex-shrink-0 select-none">
          <div>
            {trades.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setConfirmExclude(true);
                  setTradeToConfirm(null);
                  setConfirmDeleteAll(false);
                }}
                disabled={actionLoading}
                className="text-xs font-semibold text-mut hover:text-navy transition-colors cursor-pointer"
              >
                Or Dismiss Position without Deleting Trades &rarr;
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={onClose}
            disabled={actionLoading}
            className="btn ghost sm text-xs font-semibold px-4 py-1.5 rounded-[6px] border border-line hover:bg-paper-2 transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
