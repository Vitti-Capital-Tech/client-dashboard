"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { importPrivateTransactionsAction } from "@/app/actions/trades";
import { parsePnlFileBuffer } from "@/lib/pnl-calculator";
import {
  toPrivateTransactions,
  type PrivateRowError,
  type PrivateTxnRow,
} from "@/lib/import/private-rows";
import type { PrivateTxnAccount } from "./PrivateTransactionModal";

/**
 * Import a file of private transactions onto one client's account.
 *
 * ── Why the file is read in the browser ─────────────────────────────────────
 * The rows go to the server, not the bytes. A server action carries a body
 * limit a real workbook exceeds, and ExcelJS parsing is CPU-bound in the single
 * Node process — §8.21 measured a tracker parse starving every other server
 * action for ~48s. The same arrangement the P&L Calculator already uses.
 *
 * ── Why nothing is written until the desk has seen it ───────────────────────
 * A spreadsheet of off-market parcels is typed by a person, and the columns it
 * is read through are fuzzy-matched. Writing straight from a file picker would
 * mean the first sight of a misread date column is a client's portfolio with
 * forty parcels in the wrong year. So the upload PARSES, shows exactly what
 * will be written and every row that will not be, and waits.
 */

export function ImportPrivateModal({
  isOpen,
  onClose,
  clientId,
  clientName,
  accounts,
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
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<PrivateTxnRow[]>([]);
  const [rowErrors, setRowErrors] = useState<PrivateRowError[]>([]);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ imported: number; skipped: number; notes: string[] } | null>(
    null,
  );

  if (!isOpen) return null;

  const reset = () => {
    setFileName(null);
    setRows([]);
    setRowErrors([]);
    setError(null);
    setDone(null);
  };

  const onPick = async (file: File | undefined) => {
    if (!file) return;
    reset();
    setFileName(file.name);
    setParsing(true);
    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      const parsed = await parsePnlFileBuffer(buffer, file.name);
      const { rows: mapped, errors } = toPrivateTransactions(parsed.rawTrades);
      setRows(mapped);
      setRowErrors(errors);
      if (mapped.length === 0 && errors.length === 0) {
        setError(`No transactions were found in "${file.name}".`);
      }
    } catch (err) {
      setError(
        err instanceof Error ? `Could not read that file: ${err.message}` : "Could not read that file.",
      );
    } finally {
      setParsing(false);
    }
  };

  const submit = async () => {
    setError(null);
    if (!accountId) return setError("Choose the account these belong to.");
    if (rows.length === 0) return setError("There is nothing to import.");

    setSaving(true);
    const res = await importPrivateTransactionsAction(accountId, clientId, rows);
    setSaving(false);

    if (!res.ok) return setError(res.error);

    setDone({ imported: res.data.imported, skipped: res.data.skipped, notes: res.data.notes });
    setRows([]);
    router.refresh();
  };

  const totalValue = rows.reduce((sum, r) => sum + r.units * r.avgPrice, 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`Import private transactions for ${clientName}`}
    >
      <div className="w-full max-w-[760px] max-h-[90vh] overflow-y-auto bg-white rounded-[14px] border border-line shadow-shadow">
        <div className="px-5 py-4 border-b border-line">
          <b className="text-sm font-semibold text-ink">Import private transactions</b>
          <p className="mt-1 text-[11.5px] text-mut leading-relaxed">
            A <b>.xlsx</b> or <b>.csv</b> in the same shape as the historical trades file — code,
            side, date, units, price. Everything imported is marked <b>Private</b> on{" "}
            {clientName}&apos;s portfolio and is never touched by the morning import. The file&apos;s
            Account column is ignored; the account below is the one they land on.
          </p>
        </div>

        <div className="px-5 py-4 space-y-3.5">
          {accounts.length > 1 && (
            <div>
              <label
                className="block text-[10.5px] font-semibold uppercase tracking-wider text-mut mb-1"
                htmlFor="imp-account"
              >
                Account
              </label>
              <select
                id="imp-account"
                className="w-full bg-white border border-line-2 rounded-[6px] px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none focus:border-navy"
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
            <label
              className="block text-[10.5px] font-semibold uppercase tracking-wider text-mut mb-1"
              htmlFor="imp-file"
            >
              File
            </label>
            <input
              id="imp-file"
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={(e) => onPick(e.target.files?.[0])}
              className="w-full text-[11.5px] text-ink file:mr-3 file:px-3 file:py-1.5 file:rounded-[7px] file:border file:border-line-2 file:bg-paper-2 file:text-ink file:text-[11px] file:font-semibold file:cursor-pointer"
            />
            {parsing && <p className="mt-2 text-[11.5px] text-mut">Reading {fileName}…</p>}
          </div>

          {/* What WILL be written. Shown before anything is. */}
          {rows.length > 0 && (
            <div className="border border-line rounded-[10px] overflow-hidden">
              <div className="px-3.5 py-2 bg-paper-2 border-b border-line flex items-center justify-between">
                <b className="text-[11.5px] font-semibold text-ink">
                  {rows.length} transaction{rows.length === 1 ? "" : "s"} to import
                </b>
                <span className="text-[11px] text-mut font-mono">
                  ${Math.round(totalValue).toLocaleString("en-AU")} total
                </span>
              </div>
              <div className="max-h-[220px] overflow-y-auto">
                <table className="w-full border-collapse text-left text-[11px]">
                  <thead>
                    <tr className="border-b border-line text-mut">
                      <th className="px-3.5 py-1.5">Code</th>
                      <th className="px-3.5 py-1.5">Side</th>
                      <th className="px-3.5 py-1.5">Date</th>
                      <th className="px-3.5 py-1.5 text-right">Units</th>
                      <th className="px-3.5 py-1.5 text-right">Price</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#f0ede5]">
                    {rows.slice(0, 50).map((r, i) => (
                      <tr key={`${r.securityCode}-${r.tradeDate}-${i}`}>
                        <td className="px-3.5 py-1.5 font-mono font-bold text-ink">
                          {r.securityCode}
                        </td>
                        <td className="px-3.5 py-1.5">{r.side}</td>
                        <td className="px-3.5 py-1.5 font-mono">{r.tradeDate}</td>
                        <td className="px-3.5 py-1.5 text-right font-mono">
                          {r.units.toLocaleString("en-AU")}
                        </td>
                        <td className="px-3.5 py-1.5 text-right font-mono">{r.avgPrice}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.length > 50 && (
                  <p className="px-3.5 py-2 text-[11px] text-mut">
                    …and {rows.length - 50} more. All of them will be imported.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* What will NOT be written, and why. Never a silent skip. */}
          {rowErrors.length > 0 && (
            <div className="border border-amber/30 bg-amber/5 rounded-[10px] overflow-hidden">
              <div className="px-3.5 py-2 border-b border-amber/20">
                <b className="text-[11.5px] font-semibold text-ink">
                  {rowErrors.length} row{rowErrors.length === 1 ? "" : "s"} will be skipped
                </b>
              </div>
              <ul className="max-h-[140px] overflow-y-auto px-3.5 py-2 space-y-1">
                {rowErrors.slice(0, 25).map((e, i) => (
                  <li key={i} className="text-[11px] text-ink">
                    <span className="font-mono font-semibold">Row {e.line}</span>
                    {e.code !== "—" ? ` (${e.code})` : ""} — {e.reason}
                  </li>
                ))}
                {rowErrors.length > 25 && (
                  <li className="text-[11px] text-mut">…and {rowErrors.length - 25} more.</li>
                )}
              </ul>
            </div>
          )}

          {done && (
            <div
              role="status"
              className="text-[11.5px] text-ink bg-green/5 border border-green/25 rounded-[6px] px-3 py-2 space-y-1"
            >
              <div>
                <b>
                  Imported {done.imported} transaction{done.imported === 1 ? "" : "s"}.
                </b>{" "}
                {clientName}&apos;s P&amp;L has been recomputed.
              </div>
              {done.notes.map((n, i) => (
                <div key={i} className="text-mut">
                  {n}
                </div>
              ))}
            </div>
          )}

          {error && (
            <div
              role="alert"
              className="text-[11.5px] text-red bg-red/5 border border-red/20 rounded-[6px] px-3 py-2"
            >
              {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3.5 border-t border-line flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              reset();
              onClose();
            }}
            disabled={saving}
            className="text-xs font-semibold px-3.5 py-1.5 rounded-[7px] border border-line-2 text-mut hover:text-ink transition-colors disabled:opacity-50"
          >
            {done ? "Close" : "Cancel"}
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving || parsing || rows.length === 0}
            className="text-xs font-semibold px-3.5 py-1.5 rounded-[7px] bg-navy text-white hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            {saving ? "Importing…" : `Import ${rows.length || ""}`.trim()}
          </button>
        </div>
      </div>
    </div>
  );
}
