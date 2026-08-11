"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  getTradesForMismatch,
  deleteTradeAction,
  deleteAllTradesForTickerAction,
  excludePositionAction,
  type TradeDetail,
} from "@/app/actions/trades";

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink/40 backdrop-blur-xs animate-in fade-in duration-200">
      <div
        className="relative w-full max-w-3xl bg-white border border-line rounded-[16px] shadow-2xl overflow-hidden flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="px-6 py-4.5 bg-paper border-b border-line flex items-center justify-between flex-shrink-0">
          <div className="space-y-1">
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
            <div className="text-xs text-mut">
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
            className="w-8 h-8 rounded-full border border-line flex items-center justify-center text-mut hover:text-ink hover:bg-paper-2 transition-colors cursor-pointer"
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
        <div className="p-6 overflow-y-auto space-y-4 flex-1">
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

          {/* Trades Table */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-wider text-mut">
                Associated Contract Notes ({trades.length})
              </h3>
              {trades.length > 1 && (
                <button
                  type="button"
                  onClick={() => {
                    setConfirmDeleteAll(true);
                    setTradeToConfirm(null);
                    setConfirmExclude(false);
                  }}
                  disabled={actionLoading}
                  className="text-[11px] font-semibold text-loss hover:underline cursor-pointer flex items-center gap-1"
                >
                  Delete All ({trades.length})
                </button>
              )}
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
                <button
                  type="button"
                  onClick={() => setConfirmExclude(true)}
                  disabled={actionLoading}
                  className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[6px] text-xs font-bold bg-paper text-navy border border-navy/30 hover:bg-navy hover:text-white transition-colors cursor-pointer"
                >
                  Dismiss / Exclude Mismatch
                </button>
              </div>
            ) : (
              <div className="border border-line rounded-[10px] overflow-hidden bg-white shadow-xs">
                <table className="w-full text-xs text-left border-collapse">
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
                          <button
                            type="button"
                            onClick={() => {
                              setTradeToConfirm(t);
                              setConfirmDeleteAll(false);
                              setConfirmExclude(false);
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
