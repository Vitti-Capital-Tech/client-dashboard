"use client";

import React, { useMemo, useState } from "react";
import { Download, Search } from "lucide-react";
import type { TradeRow } from "@/lib/data/queries";
import { TablePagination } from "@/app/components/TablePagination";
import { buildTradeLedgerXlsx } from "@/app/actions/exports";
import { useToast } from "@/app/components/Toast";

/**
 * Every contract note, as confirmed.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Historical P&L answers "what did I make", and to do that it pools a company's
 * trades and attributes each sale to a parcel — options included, but rolled up
 * under the ORDINARY's code, because a grant over EOS is exposure to EOS. That
 * is the right shape for a P&L and the wrong shape for a tax return: a client
 * looking for the ICGXX sale on their confirmation could not find it, and
 * concluded their options were missing. They were not; they were filed under
 * ICG.
 *
 * So this is the ledger unpooled and unattributed — one row per contract note,
 * the code as it was traded, in the order the confirmations came. Nothing here
 * is derived: every column is a field the broker sent.
 *
 * ── Why gross, net and the fees between them are all shown ─────────────────
 * A tax return needs the consideration and the deductible costs separately, and
 * the brokerage and GST are what sit between them. Showing only the net figure
 * would make somebody open the PDFs again to recover the split, which is the
 * thing this table exists to save them.
 *
 * ── Cancellations and reversals stay ───────────────────────────────────────
 * `status` is shown rather than filtered on. A reversed note is part of the
 * record, and a statement that quietly omits rows is not one anybody can
 * reconcile against their own paperwork.
 */
export function TransactionsTable({
  trades,
  accountLabel,
}: {
  trades: TradeRow[];
  accountLabel: string;
}) {
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [side, setSide] = useState<"all" | "BUY" | "SELL">("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [downloading, setDownloading] = useState(false);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return trades
      .filter((t) => {
        if (side !== "all" && t.side !== side) return false;
        if (!q) return true;
        return (
          t.code.toLowerCase().includes(q) ||
          t.name.toLowerCase().includes(q) ||
          t.cnote.toLowerCase().includes(q)
        );
      })
      // Newest first: a tax year is read backwards from its end.
      .sort((a, b) => b.tradeDate.localeCompare(a.tradeDate) || b.cnote.localeCompare(a.cnote));
  }, [trades, search, side]);

  const safePage = Math.min(page, Math.max(1, Math.ceil(rows.length / pageSize)));
  const visible = rows.slice((safePage - 1) * pageSize, safePage * pageSize);

  const money = (n: number) =>
    n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const download = async () => {
    setDownloading(true);
    try {
      // The rows on screen, filters and all, so the file matches what was read.
      const base64 = await buildTradeLedgerXlsx(rows, `Transactions — ${accountLabel}`);
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(
        new Blob([bytes], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `vitti-transactions-${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ message: `${rows.length} transactions downloaded.` });
    } catch (err) {
      toast({
        message: `Could not build the file: ${err instanceof Error ? err.message : "unknown error"}`,
        tone: "error",
      });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
      <div className="px-4.5 py-3.5 border-b border-line flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <b className="text-sm font-semibold text-ink block">Transactions</b>
          <p className="text-[11px] text-mut mt-0.5 leading-relaxed">
            Every contract note, as confirmed — options included, under the code
            they were traded as.
          </p>
        </div>
        <button
          type="button"
          onClick={download}
          disabled={downloading || rows.length === 0}
          className="flex-none inline-flex items-center gap-1.5 text-[12px] font-semibold border border-line rounded-[9px] px-3 py-1.5 text-ink hover:border-green hover:text-green-d transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
        >
          <Download className="w-3.5 h-3.5 stroke-[1.8]" aria-hidden />
          {downloading ? "Building…" : "Download .xlsx"}
        </button>
      </div>

      <div className="px-4.5 py-3 border-b border-line flex flex-wrap items-center gap-2">
        {(["all", "BUY", "SELL"] as const).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              setSide(s);
              setPage(1);
            }}
            className={`text-[11.5px] font-semibold rounded-full px-3 py-1 border transition-colors cursor-pointer ${
              side === s
                ? "border-green bg-green-bg text-green-d"
                : "border-line text-mut hover:text-ink"
            }`}
          >
            {s === "all" ? "All" : s === "BUY" ? "Buys" : "Sells"}
            <span className="ml-1.5 font-mono text-[10.5px] opacity-70">
              {s === "all"
                ? trades.length
                : trades.filter((t) => t.side === s).length}
            </span>
          </button>
        ))}

        <label className="relative flex items-center ml-auto min-w-0">
          <Search
            className="w-3.5 h-3.5 stroke-[1.8] text-mut absolute left-2.5 pointer-events-none"
            aria-hidden
          />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Code, company or note №"
            aria-label="Search transactions"
            className="border border-line-2 bg-white rounded-[8px] pl-7.5 pr-2.5 py-1.5 text-[11.5px] w-full sm:w-56 focus:border-green focus:outline-none"
          />
        </label>
      </div>

      {rows.length === 0 ? (
        <div className="px-4.5 py-10 text-center">
          <b className="text-sm font-semibold text-ink block">No transactions</b>
          <p className="text-xs text-mut mt-1.5">
            {trades.length === 0
              ? "No contract notes have been loaded for this account yet."
              : "Nothing matches that filter."}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-line text-mut select-none">
                <th className="px-4 py-2.5 font-semibold text-[10.5px] uppercase tracking-wider">Date</th>
                <th className="px-4 py-2.5 font-semibold text-[10.5px] uppercase tracking-wider">Code</th>
                <th className="px-4 py-2.5 font-semibold text-[10.5px] uppercase tracking-wider hidden md:table-cell">Company</th>
                <th className="px-4 py-2.5 font-semibold text-[10.5px] uppercase tracking-wider">Side</th>
                <th className="px-4 py-2.5 font-semibold text-[10.5px] uppercase tracking-wider text-right">Units</th>
                <th className="px-4 py-2.5 font-semibold text-[10.5px] uppercase tracking-wider text-right">Price</th>
                <th className="px-4 py-2.5 font-semibold text-[10.5px] uppercase tracking-wider text-right hidden sm:table-cell">Consideration</th>
                <th className="px-4 py-2.5 font-semibold text-[10.5px] uppercase tracking-wider text-right hidden lg:table-cell">Fees</th>
                <th className="px-4 py-2.5 font-semibold text-[10.5px] uppercase tracking-wider text-right">Net</th>
                <th className="px-4 py-2.5 font-semibold text-[10.5px] uppercase tracking-wider hidden lg:table-cell">Note №</th>
              </tr>
            </thead>
            <tbody className="font-medium">
              {visible.map((t) => {
                const fees = t.brokerage + t.otherCharges + t.gst;
                const reversed = t.status !== "SETTLED";
                return (
                  <tr
                    key={t.id}
                    className={`border-t border-line/60 ${reversed ? "opacity-60" : ""}`}
                  >
                    <td className="px-4 py-3 font-mono text-mut whitespace-nowrap">
                      {new Date(`${t.tradeDate}T00:00:00Z`).toLocaleDateString("en-AU", {
                        day: "2-digit",
                        month: "short",
                        year: "2-digit",
                        timeZone: "UTC",
                      })}
                    </td>
                    <td className="px-4 py-3">
                      <span className="code font-mono text-[12px] bg-paper-2 rounded-[5px] px-1.5 py-0.5 font-bold text-ink">
                        {t.code}
                      </span>
                      {reversed && (
                        <span className="ml-1.5 text-[9.5px] font-bold uppercase tracking-wider text-loss-d">
                          {t.status}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-mut hidden md:table-cell max-w-64 truncate">
                      {t.name}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`text-[10.5px] font-bold uppercase tracking-wider ${
                          t.side === "SELL" ? "text-loss-d" : "text-green-d"
                        }`}
                      >
                        {t.side}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">
                      {t.units.toLocaleString("en-AU")}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-mut">
                      ${t.avgPrice.toFixed(4)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums hidden sm:table-cell">
                      ${money(t.consideration)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums text-mut hidden lg:table-cell">
                      ${money(fees)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums font-semibold text-ink">
                      ${money(t.value)}
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-mut hidden lg:table-cell">
                      {t.cnote}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <TablePagination
        totalItems={rows.length}
        currentPage={safePage}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        itemLabel="transactions"
      />
    </div>
  );
}
