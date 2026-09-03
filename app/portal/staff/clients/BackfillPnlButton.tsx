"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { recalculateAllPnl, refreshPlacementTrackers } from "@/app/actions/pnl";

interface RebuildResult {
  ok: boolean;
  accounts?: number;
  failed?: number;
  unfilledAccounts?: number;
  unfilledRows?: number;
  error?: string;
}

/**
 * Rebuild every account's stored P&L in one go.
 *
 * Needed because the client profile RENDERS what the recompute stored rather
 * than deriving it per request — so an account that has never been recomputed
 * has no rows to show, and says so. After the tables are first created, and
 * after any change to the engine, this is what fills them.
 */
export function BackfillPnlButton() {
  const router = useRouter();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RebuildResult | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && isModalOpen && !running) {
        setIsModalOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isModalOpen, running]);

  const handleStartRebuild = async () => {
    setRunning(true);
    setResult(null);
    try {
      const res = await recalculateAllPnl();
      if (!res.ok) {
        setResult({ ok: false, error: res.error });
      } else {
        setResult({
          ok: true,
          accounts: res.accounts,
          failed: res.failed,
          unfilledAccounts: res.unfilledAccounts,
          unfilledRows: res.unfilledRows,
        });
        router.refresh();
      }
    } catch (err) {
      setResult({
        ok: false,
        error: err instanceof Error ? err.message : "Rebuild failed unexpectedly.",
      });
    } finally {
      setRunning(false);
    }
  };

  const handleRefreshTrackers = async () => {
    setRefreshing(true);
    setNote(null);
    try {
      const res = await refreshPlacementTrackers();
      setNote(
        res.ok
          ? {
              tone: res.failed.length > 0 ? "bad" : "ok",
              text:
                `Cached ${res.refreshed} workbook(s), ${res.tickerCount} ticker(s).` +
                (res.failed.length > 0 ? ` Failed: ${res.failed.join(" ")}` : ""),
            }
          : { tone: "bad", text: res.error },
      );
    } catch (err) {
      setNote({
        tone: "bad",
        text: err instanceof Error ? err.message : "Tracker refresh failed.",
      });
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <>
      <div className="flex items-center gap-2.5">
        <button
          onClick={handleRefreshTrackers}
          disabled={refreshing}
          title="Re-parse the Placement Tracker workbooks into the cache (~17s). Needed after a new placement is issued."
          className="border border-line bg-white rounded-[8px] px-2.5 py-1 text-[11px] font-semibold text-mut hover:text-ink hover:border-line-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer shadow-2xs"
        >
          {refreshing ? "Parsing…" : "Refresh trackers"}
        </button>

        <button
          onClick={() => {
            setResult(null);
            setIsModalOpen(true);
          }}
          disabled={running}
          title="Rebuild stored P&L for every account across the firm"
          className="border border-line bg-white rounded-[8px] px-2.5 py-1 text-[11px] font-semibold text-ink hover:text-navy hover:border-navy/40 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer shadow-2xs inline-flex items-center gap-1.5"
        >
          <span>Rebuild all P&amp;L</span>
        </button>

        {note && (
          <span className={`text-[11px] font-medium ${note.tone === "ok" ? "text-mut" : "text-loss-d"}`}>
            {note.text}
          </span>
        )}
      </div>

      {/* Rebuild All P&L Confirmation & Progress Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink/40 backdrop-blur-xs animate-in fade-in duration-150 overflow-y-auto">
          <div
            className="relative w-full max-w-lg bg-white border border-line rounded-[16px] shadow-2xl overflow-hidden animate-in zoom-in-95 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="px-6 py-4.5 bg-paper border-b border-line flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-navy text-white flex items-center justify-center font-bold text-sm shadow-xs">
                  ⚡
                </div>
                <div>
                  <h3 className="text-base font-bold text-ink">Rebuild Stored P&amp;L</h3>
                  <p className="text-xs text-mut">Firm-wide portfolio recalculation</p>
                </div>
              </div>

              {!running && (
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="w-7 h-7 rounded-full border border-line flex items-center justify-center text-mut hover:text-ink hover:bg-paper-2 transition-colors cursor-pointer text-sm"
                  title="Close (Esc)"
                >
                  &times;
                </button>
              )}
            </div>

            {/* Modal Body */}
            <div className="p-6 space-y-4 text-xs text-ink">
              {!result && !running && (
                <>
                  <p className="text-xs text-mut leading-relaxed">
                    This action performs a complete recalculation of stored P&amp;L across every client account in the firm:
                  </p>

                  <div className="space-y-2 rounded-[10px] bg-paper-2/60 border border-line/70 p-3.5 text-[11.5px]">
                    <div className="flex items-start gap-2">
                      <span className="text-navy font-bold text-xs mt-0.5">✓</span>
                      <span><strong>Trade Ledger &amp; Snapshot:</strong> Re-reads settled contract notes and current position holdings.</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="text-navy font-bold text-xs mt-0.5">✓</span>
                      <span><strong>Placement Trackers:</strong> Re-merges placement allocations and client aliases from cache.</span>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="text-navy font-bold text-xs mt-0.5">✓</span>
                      <span><strong>Option Valuations:</strong> Re-prices listed and unlisted options with live Black-Scholes carry models.</span>
                    </div>
                  </div>

                  <div className="rounded-[8px] bg-amber-50 border border-amber-200/80 p-3 text-[11.5px] text-amber-900 flex items-start gap-2">
                    <span className="text-amber-700 text-sm mt-0.5">⏱️</span>
                    <div>
                      <strong>Processing Time:</strong> This process runs calculations across all accounts and may take <strong>1–2 minutes</strong>. Please keep this tab open while processing.
                    </div>
                  </div>
                </>
              )}

              {/* Running State */}
              {running && (
                <div className="py-8 text-center space-y-3.5">
                  <div className="inline-block w-8 h-8 border-3 border-navy border-t-transparent rounded-full animate-spin" />
                  <div className="space-y-1">
                    <div className="text-sm font-bold text-ink">Rebuilding All Accounts...</div>
                    <div className="text-xs text-mut max-w-xs mx-auto">
                      Processing trade ledgers, placement allocations, and live option models across all accounts.
                    </div>
                  </div>
                </div>
              )}

              {/* Result State */}
              {result && (
                <div className="space-y-3">
                  {result.ok ? (
                    <div className="p-4 rounded-[12px] bg-gain-bg border border-gain/30 space-y-2">
                      <div className="flex items-center gap-2 text-gain font-bold text-sm">
                        <span>✓</span>
                        <span>Rebuild Completed Successfully</span>
                      </div>
                      <p className="text-xs text-ink">
                        Rebuilt stored P&amp;L for <strong>{result.accounts}</strong> account{result.accounts === 1 ? "" : "s"}.
                      </p>

                      {result.failed !== undefined && result.failed > 0 && (
                        <div className="text-xs text-loss-d font-medium">
                          ⚠️ {result.failed} account(s) encountered errors — check server logs.
                        </div>
                      )}

                      {result.unfilledAccounts !== undefined && result.unfilledAccounts > 0 && (
                        <div className="text-[11px] text-mut pt-1 border-t border-gain/20">
                          ℹ️ {result.unfilledRows} placement row(s) across {result.unfilledAccounts} account(s) could not be matched to an account holder.
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="p-4 rounded-[12px] bg-loss-bg border border-loss/30 space-y-1.5">
                      <div className="flex items-center gap-2 text-loss-d font-bold text-sm">
                        <span>✕</span>
                        <span>Rebuild Failed</span>
                      </div>
                      <p className="text-xs text-loss-d font-medium">
                        {result.error || "An unexpected error occurred during backfill."}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-3.5 bg-paper border-t border-line flex items-center justify-end gap-2.5">
              {!result && !running && (
                <>
                  <button
                    type="button"
                    onClick={() => setIsModalOpen(false)}
                    className="px-3.5 py-1.5 rounded-[6px] text-xs font-semibold border border-line bg-white hover:bg-paper-2 text-mut hover:text-ink transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleStartRebuild}
                    className="px-4 py-1.5 rounded-[6px] text-xs font-bold bg-navy text-white hover:opacity-90 transition-opacity cursor-pointer shadow-xs flex items-center gap-1.5"
                  >
                    <span>Start Rebuild</span>
                    <span>&rarr;</span>
                  </button>
                </>
              )}

              {running && (
                <button
                  type="button"
                  disabled
                  className="px-4 py-1.5 rounded-[6px] text-xs font-semibold bg-navy/60 text-white cursor-not-allowed flex items-center gap-2"
                >
                  <span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>Processing...</span>
                </button>
              )}

              {result && (
                <button
                  type="button"
                  onClick={() => {
                    setIsModalOpen(false);
                    setResult(null);
                  }}
                  className="px-4 py-1.5 rounded-[6px] text-xs font-bold bg-navy text-white hover:opacity-90 transition-opacity cursor-pointer shadow-xs"
                >
                  Done
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
