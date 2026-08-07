"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import type {
  ClientRow,
  AccountRow,
  Position,
  OptionRow,
  PlacementRow,
  AlertRow,
  SignalRow,
  TradeRow,
} from "@/lib/data/queries";
import type { PnlOverrideRow } from "@/lib/data/holdings";
import {
  rollUpRealized,
  attributeSells,
  realizedByMonth,
  type RealizedRow,
} from "@/lib/data/compute";
import {
  buildPnlSummaryCsv,
  grandTotal,
  pnlSummaryFilename,
  SUMMARY_HEADERS,
  type PnlOverride,
} from "@/lib/export/order-history";
import { storedToSummaryRows } from "@/lib/export/stored-pnl";
import type { StoredPnlRow, PnlRunRow } from "@/lib/data/pnl";
import { buildPnlSummaryXlsx } from "@/app/actions/exports";
import { recalculateClientPnl, previewClientPnlCsv } from "@/app/actions/pnl";
import { PnlRow } from "./PnlRow";
import { RealizedPnlChart } from "./RealizedPnlChart";
import { posValue, posCost, posPL, unlistedValue, isITM } from "@/lib/data/compute";

/**
 * Money to the cent, thousands-separated. These are settled cash amounts from
 * contract notes, so cents are never rounded away — a $3,634.80 sale must not
 * read as $3,635.
 */
const money2 = (n: number): string =>
  n.toLocaleString("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/**
 * `2026-08-07T22:14:03Z` → `7 Aug 2026, 8:14 am`, in the reader's own timezone.
 *
 * Local time on purpose: this says how stale a figure is, and "is that before or
 * after this morning's import?" is a question people answer in the time on their
 * own wall, not in UTC.
 */
const stamp = (iso: string): string =>
  new Date(iso).toLocaleString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

function s708Label(iso: string | null): string {
  if (!iso) return "—";
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-AU", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

// Expiry Rail Component
const ExpiryRail = ({ dte }: { dte: number }) => {
  const thresholds = [30, 14, 7, 3, 1];
  const isDanger = dte <= 3 && dte >= 0;
  const isWarn = dte <= 14 && dte > 3;
  const cls = isDanger ? "danger" : isWarn ? "warn" : "";

  const segs = thresholds.map((t, idx) => {
    const lit = dte <= t && dte >= 0;
    const colorClass = lit ? (dte <= 3 ? "lit-red" : "lit-amber") : "";
    return (
      <div key={idx} className={`seg ${colorClass}`}>
        <span className="tk" />
      </div>
    );
  });

  return (
    <div className={`rail ${cls} select-none`}>
      <div className="dleft">{dte < 0 ? "expired" : `${dte}d`}</div>
      <div className="ticks">{segs}</div>
    </div>
  );
};

// Moneyness Bar Component
const MoneynessBar = ({ strike, under, type }: { strike: number; under: number; type: "Call" | "Put" }) => {
  let m = under - strike;
  if (type === "Put") m = -m;
  const span = strike * 0.5 || 0.5;
  const frac = Math.max(-1, Math.min(1, m / span));
  const w = Math.abs(frac) * 27;
  const col = m > 0 ? "var(--color-green)" : "var(--color-loss)";

  return (
    <span className="mbar select-none">
      <i />
      <b
        style={{
          backgroundColor: col,
          width: `${w}px`,
          left: m > 0 ? "50%" : "auto",
          right: m > 0 ? "auto" : "50%"
        }}
      />
    </span>
  );
};

export function ClientDetailClient({
  client,
  accounts,
  positions,
  options,
  clientBids,
  alerts,
  signalsMap,
  trades,
  realized,
  overrides,
  storedPnl,
  pnlRuns,
}: {
  client: ClientRow;
  accounts: AccountRow[];
  positions: Position[];
  options: OptionRow[];
  clientBids: PlacementRow[];
  alerts: AlertRow[];
  signalsMap: Record<string, SignalRow>;
  trades: TradeRow[];
  realized: RealizedRow[];
  overrides: PnlOverrideRow[];
  storedPnl: StoredPnlRow[];
  pnlRuns: PnlRunRow[];
}) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<
    "holdings" | "order history" | "options" | "bids" | "alerts"
  >("holdings");
  // Account filter: "all" aggregates across the client's accounts, else scope
  // to one account. Holdings/options/bids/cash follow this; alerts stay
  // person-level.
  const [acctFilter, setAcctFilter] = useState<string>("all");
  // Which summary row has its inline editor open, by ticker.
  const [editing, setEditing] = useState<string | null>(null);

  const cid = client.id;
  const inAcct = (accountId: string | null) =>
    acctFilter === "all" || accountId === acctFilter;

  const visiblePositions = positions.filter((p) => inAcct(p.accountId));
  const visibleOptions = options.filter((o) => inAcct(o.accountId));

  // Order history follows the same account filter. Already newest-first from
  // the DAL, so no re-sort here.
  const visibleTrades = trades.filter((t) => inAcct(t.accountId));
  // Realised P&L arrives at account grain so it honours the same filter as the
  // table above it — otherwise the chart and the rows would disagree.
  const realizedMap = rollUpRealized(realized.filter((r) => inAcct(r.accountId)));

  // Settled trades are the only ones that moved money; the rest are shown for
  // completeness but excluded from every total below.
  const settledTrades = visibleTrades.filter((t) => t.status === "SETTLED");
  const boughtTotal = settledTrades
    .filter((t) => t.side === "BUY")
    .reduce((s, t) => s + t.value, 0);
  const soldTotal = settledTrades
    .filter((t) => t.side === "SELL")
    .reduce((s, t) => s + t.value, 0);
  const feesTotal = settledTrades.reduce(
    (s, t) => s + t.brokerage + t.otherCharges + t.gst,
    0,
  );
  const realizedTotal = [...realizedMap.values()].reduce(
    (s, r) => s + r.realizedPl,
    0,
  );

  // ONE array drives the table, the CSV and the .xlsx. That is what makes the
  // three impossible to disagree — they are renderings of the same rows, not
  // three separate assemblies of the same idea.
  //
  // Those rows are now READ, not derived here. The full calculation values open
  // positions off the holdings snapshot, fills placement buy sides from the
  // Placement Tracker workbooks (~48s to parse) and prices free unlisted options
  // with Black-Scholes off a live spot — none of which a page render can
  // reproduce, and all of which have to be reproducible later if a client was
  // ever shown the number. So lib/pnl/recompute.ts computes and stores it, and
  // this page displays what it stored.
  //
  // Overrides are still applied HERE rather than baked in, so correcting a row
  // keeps tracking the sources underneath it.
  const overrideMap = new Map<string, PnlOverride>(
    overrides
      .filter((o) => inAcct(o.accountId))
      .map((o) => [o.parent, { ...o, parent: o.parent }]),
  );
  const visibleStoredPnl = storedPnl.filter((r) => inAcct(r.accountId));
  const summaryRows = storedToSummaryRows(visibleStoredPnl, overrideMap);

  const summaryTotal = grandTotal(summaryRows);

  /**
   * When these figures were produced, and anything the desk should read before
   * trusting them.
   *
   * Shown rather than hidden because a stored number is only as good as its
   * age: a P&L computed before this morning's contract notes landed is not
   * wrong, but it is not today's either.
   */
  const visibleRuns = pnlRuns.filter((r) => inAcct(r.accountId));
  const lastComputedAt = visibleRuns.reduce<string | null>(
    (latest, r) => (!latest || r.computedAt > latest ? r.computedAt : latest),
    null,
  );
  const runWarnings = [...new Set(visibleRuns.flatMap((r) => r.warnings))];

  // The chart needs realised P&L WITH dates on it, which the per-ticker rollup
  // cannot supply. Replaying the visible ledger through the same cost-basis
  // walk the importer uses gives per-sale attribution, which then buckets by
  // month — so the chart and the table are two views of one number.
  //
  // Desk edits carry no date of their own, so each corrected company's delta is
  // handed to the bucketer to spread across that company's sale months. Without
  // it an edited row would move the table's total and leave the chart behind.
  const chartDeltas = new Map(
    summaryRows
      .filter((r) => r.edited && Math.abs(r.pnl - r.computed.pnl) > 0.005)
      .map((r) => [r.ticker, r.pnl - r.computed.pnl]),
  );
  const chartPeriods = realizedByMonth(attributeSells(visibleTrades), chartDeltas);

  /** Export honours the account filter, so the file always matches the screen. */
  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const download = (contents: string, filename: string, mime: string) =>
    // The BOM makes Excel read the text as UTF-8 rather than the local
    // codepage, which otherwise mangles non-ASCII company names.
    downloadBlob(new Blob(["﻿", contents], { type: `${mime};charset=utf-8` }), filename);

  const exportName = (ext: "csv" | "xlsx") =>
    pnlSummaryFilename(
      client.name,
      acctFilter === "all"
        ? null
        : (accounts.find((a) => a.id === acctFilter)?.label ?? null),
      new Date().toISOString().slice(0, 10),
      ext,
    );

  const exportCsv = () =>
    download(buildPnlSummaryCsv(summaryRows), exportName("csv"), "text/csv");

  /**
   * Rebuild the stored figures now.
   *
   * Needed because the inputs move underneath a stored number: a spot price
   * changes by the minute, and a Placement Tracker can be amended at any time.
   * The morning ingest does this unattended; this is the desk's way of asking
   * for today's marks without waiting for tomorrow.
   */
  const [recalculating, setRecalculating] = useState(false);
  const [recalcNote, setRecalcNote] = useState<{
    tone: "ok" | "bad";
    text: string;
  } | null>(null);

  const recalculate = async () => {
    setRecalculating(true);
    setRecalcNote(null);
    try {
      const res = await recalculateClientPnl(cid);
      if (!res.ok) {
        setRecalcNote({ tone: "bad", text: res.error });
        return;
      }
      setRecalcNote({
        tone: res.warnings.length > 0 ? "bad" : "ok",
        text:
          `Recalculated ${res.accounts} account${res.accounts === 1 ? "" : "s"}.` +
          (res.warnings.length > 0 ? ` ${res.warnings.join(" ")}` : ""),
      });
      // The rows are Server Component props, so the page has to re-fetch them.
      router.refresh();
    } finally {
      setRecalculating(false);
    }
  };

  /**
   * Compute without storing, and download the result in the **P&L Calculator's**
   * CSV format so the two can be diffed directly.
   *
   * The stored figures are left exactly as they were, which is the point: this
   * is how the engine gets checked against the reference implementation before
   * anyone trusts it with the numbers on the page.
   */
  const [previewing, setPreviewing] = useState(false);
  const previewCsv = async () => {
    setPreviewing(true);
    setRecalcNote(null);
    try {
      const res = await previewClientPnlCsv(cid);
      if (!res.ok) {
        setRecalcNote({ tone: "bad", text: res.error });
        return;
      }
      download(res.csv, res.filename, "text/csv");
      setRecalcNote({
        tone: res.warnings.length > 0 ? "bad" : "ok",
        text:
          `Preview of ${res.rows} row(s) downloaded — nothing was stored. ` +
          `Diff it against the P&L Calculator's export for the same client.` +
          (res.warnings.length > 0 ? ` ${res.warnings.join(" ")}` : ""),
      });
    } finally {
      setPreviewing(false);
    }
  };

  // The workbook is built by a server action (ExcelJS stays out of the client
  // bundle), so this one is async and the button reflects that.
  const [exporting, setExporting] = useState(false);
  const exportExcel = async () => {
    setExporting(true);
    try {
      const base64 = await buildPnlSummaryXlsx(
        summaryRows,
        `${client.name} — P&L summary`,
      );
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      downloadBlob(
        new Blob([bytes], {
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
        exportName("xlsx"),
      );
    } finally {
      setExporting(false);
    }
  };

  // Flatten the client's bids (one row per bid — a client may bid from several
  // accounts on one deal), then scope to the selected account.
  const bidRows = clientBids
    .flatMap((p) =>
      p.bids
        .filter((b) => b.clientId === cid)
        .map((b) => ({ placement: p, bid: b })),
    )
    .filter((r) => inAcct(r.bid.accountId));

  const cash =
    acctFilter === "all"
      ? accounts.reduce((sum, a) => sum + a.cash, 0)
      : (accounts.find((a) => a.id === acctFilter)?.cash ?? 0);

  const selected = accounts.find((a) => a.id === acctFilter);
  const headerType =
    acctFilter === "all"
      ? accounts.length === 1
        ? accounts[0]?.accountType ?? "—"
        : `${accounts.length} accounts`
      : (selected?.accountType ?? "—");
  const headerS708 =
    acctFilter === "all"
      ? (accounts
          .map((a) => a.s708Expiry)
          .filter((d): d is string => !!d)
          .sort()[0] ?? null)
      : (selected?.s708Expiry ?? null);

  const unlisted = unlistedValue(visibleOptions);

  let tv = 0;
  let tc = 0;
  visiblePositions.forEach(p => {
    tv += posValue(p);
    tc += posCost(p);
  });

  const tpl = tv - tc;
  const tplp = tc > 0 ? (tpl / tc) * 100 : 0;
  const totalAssets = tv + cash + unlisted;

  const getActionPill = (action: string) => {
    const maps: Record<string, string> = {
      Add: "bg-green-bg text-green-d",
      Hold: "bg-paper-2 text-mut",
      Trim: "bg-amber-bg text-amber-d",
      "Take profit": "bg-amber-bg text-amber-d",
      Watch: "bg-[#ece9f3] text-[#5c5775]"
    };
    return (
      <span className={`pill px-2 py-0.5 rounded-full text-[10.5px] font-semibold ${maps[action] || "bg-paper-2 text-mut"}`}>
        {action}
      </span>
    );
  };

  return (
    <div className="space-y-4 text-ink font-body">
      {/* Back to registry */}
      <div className="select-none">
        <button
          onClick={() => router.push("/portal/staff")}
          className="text-green-d font-semibold text-xs underline underline-offset-2 cursor-pointer hover:opacity-85"
        >
          &larr; Client Register
        </button>
      </div>

      {/* Header Info */}
      <div className="flex gap-4 items-center justify-between flex-wrap select-none border-b border-line pb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-navy text-green flex items-center justify-center font-bold text-sm flex-none">
            {client.initials}
          </div>
          <div>
            <h1 className="font-disp font-medium text-2xl leading-none">{client.name}</h1>
            <div className="text-xs text-mut mt-1">
              Structure: {headerType} &middot; s708 certificate expires {s708Label(headerS708)}
            </div>
          </div>
        </div>

        {/* Tab Selection */}
        <div className="inline-flex bg-paper-2 rounded-[9px] p-0.75">
          {(["holdings", "order history", "options", "bids", "alerts"] as const).map(t => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              className={`text-xs font-semibold px-3.5 py-1.5 rounded-[7px] cursor-pointer capitalize transition-colors ${activeTab === t ? "bg-white text-ink shadow-shadow" : "text-mut hover:text-ink"}`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Account filter (only when the client holds more than one account) */}
      {accounts.length > 1 && (
        <div className="flex items-center gap-2 flex-wrap select-none">
          <span className="text-[11px] tracking-wider uppercase text-mut font-semibold mr-1">Account</span>
          {[{ id: "all", label: "All accounts" }, ...accounts].map((a) => (
            <button
              key={a.id}
              onClick={() => setAcctFilter(a.id)}
              className={`text-xs font-semibold px-3 py-1.5 rounded-full border cursor-pointer transition-colors ${
                acctFilter === a.id
                  ? "bg-navy text-white border-navy"
                  : "bg-white text-mut border-line hover:border-navy hover:text-ink"
              }`}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-3 gap-4 select-none">
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Asset value</div>
          <div className="font-disp font-medium text-2xl mt-1 text-ink">${money2(totalAssets)}</div>
          <div className="text-xs text-mut mt-1">Positions + cash + unlisted carry</div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Cost invested</div>
          <div className="font-disp font-medium text-2xl mt-1 text-ink">${money2(tc)}</div>
          <div className="text-xs text-mut mt-1">net cost base</div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Client P&amp;L</div>
          <div className={`font-disp font-medium text-2xl mt-1 ${tpl >= 0 ? "text-gain" : "text-loss-d"}`}>
            {tpl >= 0 ? "+" : ""}${money2(tpl)}
          </div>
          <div className={`text-xs mt-1 font-mono ${tpl >= 0 ? "text-gain" : "text-loss-d"}`}>
            {tpl >= 0 ? "+" : ""}{tplp.toFixed(1)}%
          </div>
        </div>
      </div>

      {/* Detailed views rendered based on tab */}
      {activeTab === "holdings" && (
        <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
          <div className="px-4.5 py-3.5 border-b border-line bg-white select-none">
            <b className="text-sm font-semibold text-ink">Equities portfolio</b>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs font-medium">
              <thead>
                <tr className="border-b border-line text-mut select-none">
                  <th className="px-4.5 py-2.5">Code</th>
                  <th className="px-4.5 py-2.5">Stock</th>
                  <th className="px-4.5 py-2.5 text-right">Qty</th>
                  <th className="px-4.5 py-2.5 text-right">Cost price</th>
                  <th className="px-4.5 py-2.5 text-right">Last close</th>
                  <th className="px-4.5 py-2.5 text-right">Market value</th>
                  <th className="px-4.5 py-2.5 text-right">Unreal. P&amp;L</th>
                  <th className="px-4.5 py-2.5 text-center">Desk view</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f0ede5]">
                {visiblePositions.map(p => {
                  const pl = posPL(p);
                  const cost = posCost(p);
                  // Free-carried options (placement attachers) have a zero cost
                  // base, so a percentage return is undefined — not infinite.
                  const plp = cost === 0 ? null : (pl / cost) * 100;
                  const isUp = pl >= 0;
                  const sg = signalsMap[p.code];
                  return (
                    <tr key={p.code} className="hover:bg-[#faf9f5]">
                      <td className="px-4.5 py-3"><span className="code font-mono px-1.5 py-0.5 rounded-[5px] bg-paper-2">{p.code}</span></td>
                      <td className="px-4.5 py-3 text-mut">{p.name}</td>
                      <td className="px-4.5 py-3 text-right font-mono">{p.qty.toLocaleString("en-AU")}</td>
                      <td className="px-4.5 py-3 text-right font-mono">${p.cost.toFixed(2)}</td>
                      <td className="px-4.5 py-3 text-right font-mono">${(p.last ?? 0).toFixed(2)}</td>
                      <td className="px-4.5 py-3 text-right font-mono font-semibold">${money2(posValue(p))}</td>
                      <td className={`px-4.5 py-3 text-right font-mono ${isUp ? "text-gain" : "text-loss-d"}`}>
                        ${money2(pl)}
                        {plp !== null && (
                          <div className="text-[10px]">{isUp ? "+" : ""}{plp.toFixed(1)}%</div>
                        )}
                      </td>
                      <td className="px-4.5 py-3 text-center">
                        {getActionPill(sg ? sg.action : "Hold")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === "order history" && (
        <div className="space-y-3">
          {/* Ledger totals. Realised P&L is NOT sold − bought: most of what was
              bought is still held, so the two are not comparable. It comes from
              the replayed cost basis in realized_pnl. */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2.5">
            {[
              { label: "Bought", value: boughtTotal, tone: "" },
              { label: "Sold", value: soldTotal, tone: "" },
              { label: "Brokerage + GST", value: feesTotal, tone: "" },
              {
                label: "Realised P&L",
                value: realizedTotal,
                tone: realizedTotal >= 0 ? "text-gain" : "text-loss-d",
              },
            ].map((k) => (
              <div
                key={k.label}
                className="bg-white border border-line rounded-[14px] shadow-shadow px-4 py-3"
              >
                <div className="font-mono text-[10px] tracking-wider uppercase text-mut">
                  {k.label}
                </div>
                <div className={`font-mono text-[17px] mt-1 tabular-nums ${k.tone}`}>
                  {k.value < 0 ? "-$" : "$"}
                  {money2(Math.abs(k.value))}
                </div>
              </div>
            ))}
          </div>

          <RealizedPnlChart periods={chartPeriods} />

          {/* What the last run wants a human to know before trusting the rows:
              tickers it could not resolve, options it could not price. These are
              not errors — the run succeeded — but a number nobody was told was
              incomplete is worse than one nobody looked at. */}
          {runWarnings.length > 0 && (
            <div className="bg-white border border-line rounded-[14px] shadow-shadow px-4.5 py-3 text-[11px] text-loss-d space-y-1">
              {runWarnings.map((w, i) => (
                <div key={i}>{w}</div>
              ))}
            </div>
          )}

          {recalcNote && (
            <div
              className={`bg-white border border-line rounded-[14px] shadow-shadow px-4.5 py-3 text-[11px] ${
                recalcNote.tone === "ok" ? "text-mut" : "text-loss-d"
              }`}
            >
              {recalcNote.text}
            </div>
          )}

          <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
            <div className="px-4.5 py-3.5 border-b border-line bg-white select-none flex items-baseline justify-between">
              <div>
                <b className="text-sm font-semibold text-ink">P&amp;L by company</b>
                <div className="text-[11px] text-mut mt-0.5">
                  {summaryRows.length} row{summaryRows.length === 1 ? "" : "s"} from{" "}
                  {settledTrades.length} settled trade
                  {settledTrades.length === 1 ? "" : "s"}
                  {visibleTrades.length !== settledTrades.length &&
                    ` · ${visibleTrades.length - settledTrades.length} cancelled/reversed excluded`}
                  {" · exports match this table exactly"}
                </div>
                {/* A stored figure is only as good as its age, so the age is not
                    hidden. */}
                <div className="text-[11px] text-mut mt-0.5">
                  {lastComputedAt ? (
                    <>Calculated {stamp(lastComputedAt)}</>
                  ) : (
                    <span className="text-loss-d">
                      Never calculated — press Recalculate to build this client&apos;s P&amp;L.
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={previewCsv}
                  disabled={previewing}
                  title="Compute without storing, and download it in the P&L Calculator's CSV format — for diffing the two before trusting the stored figures"
                  className="border border-line bg-white rounded-[8px] px-2.5 py-1 text-[11px] font-semibold text-mut hover:text-ink hover:border-line-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  {previewing ? "Computing…" : "Preview CSV"}
                </button>
                <button
                  onClick={recalculate}
                  disabled={recalculating}
                  title="Rebuild from the stored ledger, the holdings snapshot and the Placement Trackers, at today's prices"
                  className="border border-line bg-white rounded-[8px] px-2.5 py-1 text-[11px] font-semibold text-mut hover:text-ink hover:border-line-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  {recalculating ? "Calculating…" : "Recalculate"}
                </button>
                {/* CSV for data, Excel for the colour-coded copy — plain CSV
                    cannot carry a fill. */}
                <button
                  onClick={exportCsv}
                  disabled={summaryRows.length === 0}
                  className="border border-line bg-white rounded-[8px] px-2.5 py-1 text-[11px] font-semibold text-mut hover:text-ink hover:border-line-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  Export CSV
                </button>
                <button
                  onClick={exportExcel}
                  disabled={
                    exporting || summaryRows.length === 0
                  }
                  title="Same rows as an .xlsx, colour-coded: amber = still open, green = fully exited, red = needs checking"
                  className="border border-line bg-white rounded-[8px] px-2.5 py-1 text-[11px] font-semibold text-mut hover:text-ink hover:border-line-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  {exporting ? "Building…" : "Export Excel"}
                </button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs font-medium">
                <thead>
                  <tr className="border-b border-line text-mut select-none">
                    {SUMMARY_HEADERS.map((h, i) => (
                      <th
                        key={h}
                        className={`px-4.5 py-2.5 ${i >= 2 && i <= 6 ? "text-right" : i === 7 ? "text-center" : ""}`}
                      >
                        {h}
                      </th>
                    ))}
                    <th className="px-4.5 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {summaryRows.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="px-4.5 py-10 text-center text-mut">
                        No contract notes imported for this client.
                      </td>
                    </tr>
                  ) : (
                    <>
                      {summaryRows.map((r) => (
                        <PnlRow
                          // Remount when the editor opens or closes, so its
                          // inputs always re-seed from the values currently in
                          // force rather than whatever was typed last time.
                          key={`${r.ticker}:${editing === r.ticker}`}
                          row={r}
                          editing={editing === r.ticker}
                          onEdit={() => setEditing(r.ticker)}
                          onClose={() => setEditing(null)}
                          accountId={acctFilter === "all" ? null : acctFilter}
                          clientId={cid}
                          money2={money2}
                        />
                      ))}

                      {/* Grand Total — the same three columns the exports sum.
                          Quantities are not totalled: units of different
                          companies are not the same thing. */}
                      <tr className="border-t-2 border-line-2 bg-paper-2 font-bold">
                        <td className="px-4.5 py-3" colSpan={2}>
                          Grand Total
                        </td>
                        <td className="px-4.5 py-3" />
                        <td className="px-4.5 py-3" />
                        <td className="px-4.5 py-3 text-right font-mono">
                          ${money2(summaryTotal.buyPrice)}
                        </td>
                        <td className="px-4.5 py-3 text-right font-mono">
                          ${money2(summaryTotal.sellOrCurrent)}
                        </td>
                        <td
                          className={`px-4.5 py-3 text-right font-mono ${summaryTotal.pnl >= 0 ? "text-gain" : "text-loss-d"}`}
                        >
                          {summaryTotal.pnl < 0 ? "-" : ""}$
                          {money2(Math.abs(summaryTotal.pnl))}
                        </td>
                        <td className="px-4.5 py-3" colSpan={3} />
                      </tr>
                    </>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {activeTab === "options" && (
        <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
          <div className="px-4.5 py-3.5 border-b border-line bg-white select-none">
            <b className="text-sm font-semibold text-ink">Client option register</b>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs font-medium">
              <thead>
                <tr className="border-b border-line text-mut select-none">
                  <th className="px-4.5 py-2.5">Series</th>
                  <th className="px-4.5 py-2.5">Type</th>
                  <th className="px-4.5 py-2.5 text-right">Qty</th>
                  <th className="px-4.5 py-2.5 text-right">Strike</th>
                  <th className="px-4.5 py-2.5 text-right">Underlying</th>
                  <th className="px-4.5 py-2.5 text-center">Moneyness</th>
                  <th className="px-4.5 py-2.5">Expiry window</th>
                  <th className="px-4.5 py-2.5 text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f0ede5]">
                {visibleOptions.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-center text-mut py-6">No option assets on record.</td>
                  </tr>
                ) : (
                  visibleOptions.map(o => {
                    const isItmVal = isITM(o);
                    return (
                      <tr key={o.id} className="hover:bg-[#faf9f5]">
                        <td className="px-4.5 py-3">
                          <span className="code font-mono px-1.5 py-0.5 rounded-[5px] bg-paper-2">{o.code}</span>
                          <span className="text-[10px] text-mut ml-2">{o.listed ? "Listed" : "Unlisted"}</span>
                        </td>
                        <td className="px-4.5 py-3 text-mut">{o.type}</td>
                        <td className="px-4.5 py-3 text-right font-mono">{o.qty ? o.qty.toLocaleString("en-AU") : "—"}</td>
                        <td className="px-4.5 py-3 text-right font-mono">${o.strike.toFixed(2)}</td>
                        <td className="px-4.5 py-3 text-right font-mono">${o.under.toFixed(2)}</td>
                        <td className="px-4.5 py-3 text-center">
                          <div className="inline-flex items-center gap-1.5">
                            <MoneynessBar strike={o.strike} under={o.under} type={o.type} />
                            <span className={`pill text-[10px] font-bold rounded-full px-1.5 py-0.5 ${isItmVal ? "bg-green-bg text-green-d" : "bg-paper-2 text-mut"}`}>
                              {isItmVal ? "ITM" : "OTM"}
                            </span>
                          </div>
                        </td>
                        <td className="px-4.5 py-3">
                          <ExpiryRail dte={o.dte} />
                        </td>
                        <td className="px-4.5 py-3 text-right capitalize text-mut font-semibold">{o.status}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === "bids" && (
        <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
          <div className="px-4.5 py-3.5 border-b border-line bg-white select-none">
            <b className="text-sm font-semibold text-ink">Bidding activities</b>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs font-medium">
              <thead>
                <tr className="border-b border-line text-mut select-none">
                  <th className="px-4.5 py-2.5">Deal</th>
                  <th className="px-4.5 py-2.5">Type</th>
                  <th className="px-4.5 py-2.5 text-right">Bid size</th>
                  <th className="px-4.5 py-2.5 text-right">Allotted</th>
                  <th className="px-4.5 py-2.5">Timeline close</th>
                  <th className="px-4.5 py-2.5 text-right">Payment</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f0ede5]">
                {bidRows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center text-mut py-6">No bids recorded.</td>
                  </tr>
                ) : (
                  bidRows.map(({ placement: p, bid }) => {
                    return (
                      <tr key={`${p.id}-${bid.accountId ?? "x"}`} className="hover:bg-[#faf9f5]">
                        <td className="px-4.5 py-3 font-bold"><span className="code font-mono px-1.5 py-0.5 rounded-[5px] bg-paper-2">{p.code}</span> &middot; {p.name}</td>
                        <td className="px-4.5 py-3 text-mut">{p.type}</td>
                        <td className="px-4.5 py-3 text-right font-mono">${bid.amount.toLocaleString("en-AU")}</td>
                        <td className="px-4.5 py-3 text-right font-mono">
                          {bid.alloc === null ? "—" : `$${bid.alloc.toLocaleString("en-AU")}`}
                        </td>
                        <td className="px-4.5 py-3 text-mut font-mono text-[11px]">
                          {p.closeDate ? new Date(p.closeDate).toLocaleDateString("en-AU", { day: "numeric", month: "short" }) : "—"}
                        </td>
                        <td className="px-4.5 py-3 text-right">
                          <span className={`pill text-[10px] font-bold px-2 py-0.5 rounded-full ${bid.paid ? "bg-green-bg text-green-d" : "bg-amber-bg text-amber-d"}`}>
                            {bid.paid ? "Received" : "Outstanding"}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === "alerts" && (
        <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
          <div className="px-4.5 py-3.5 border-b border-line bg-white select-none">
            <b className="text-sm font-semibold text-ink">Active alerts</b>
          </div>
          <div className="divide-y divide-line">
            {alerts.length === 0 ? (
              <div className="text-center text-mut py-8 text-xs select-none">No active alerts set for this client.</div>
            ) : (
              alerts.map(a => (
                <div key={a.id} className="p-4 flex justify-between items-center text-xs">
                  <div>
                    <div className="font-semibold text-ink flex items-center gap-2">
                      <span className={`pill text-[9px] font-bold px-1.5 py-0.5 rounded-full ${a.sev === "red" ? "bg-loss-bg text-loss-d" : (a.sev === "amber" ? "bg-amber-bg text-amber-d" : "bg-green-bg text-green-d")}`}>
                        {a.sev}
                      </span>
                      {a.title}
                    </div>
                    <p className="text-mut text-[11.5px] mt-0.5 leading-normal">{a.sub}</p>
                  </div>
                  <span className="text-[10px] font-mono text-mut leading-normal select-none">
                    {a.ack ? "Acknowledged" : "Active"}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
