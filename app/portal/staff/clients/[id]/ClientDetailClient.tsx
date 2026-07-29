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
import { rollUpRealized, type RealizedRow } from "@/lib/data/compute";
import {
  buildPnlSummary,
  buildPnlSummaryCsv,
  pnlSummaryFilename,
  type HeldPosition,
} from "@/lib/export/order-history";
import { buildPnlSummaryXlsx } from "@/app/actions/exports";
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
}) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<
    "holdings" | "order history" | "options" | "bids" | "alerts"
  >("holdings");
  // Account filter: "all" aggregates across the client's accounts, else scope
  // to one account. Holdings/options/bids/cash follow this; alerts stay
  // person-level.
  const [acctFilter, setAcctFilter] = useState<string>("all");

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
  const chartRows = [...realizedMap.entries()].map(([parent, r]) => ({
    parent,
    ...r,
  }));

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

  // Group the ledger by parent ticker so each company's trades sit together
  // under its realised result — the same tickers, in the same order, as the
  // chart above. Reading down the table then answers "why is that bar that
  // size", which a flat chronological list cannot.
  const tradeGroups = (() => {
    const byParent = new Map<string, { name: string; trades: TradeRow[] }>();
    for (const t of visibleTrades) {
      const g = byParent.get(t.parent);
      if (g) g.trades.push(t);
      else byParent.set(t.parent, { name: t.name, trades: [t] });
    }

    return [...byParent.entries()]
      .map(([parent, g]) => ({
        parent,
        name: g.name,
        // Oldest first within a company: the buy that established the cost
        // basis should be read before the sale that closed it.
        trades: [...g.trades].sort((a, b) =>
          a.tradeDate === b.tradeDate
            ? a.cnote.localeCompare(b.cnote)
            : a.tradeDate.localeCompare(b.tradeDate),
        ),
        realized: realizedMap.get(parent) ?? null,
      }))
      .sort((a, b) => {
        // Companies with a realised result lead, ranked exactly as the chart
        // ranks them. Still-open positions follow, most recent first.
        const ar = a.realized?.unitsSold ? a.realized.realizedPl : null;
        const br = b.realized?.unitsSold ? b.realized.realizedPl : null;
        if (ar !== null && br !== null) return br - ar;
        if (ar !== null) return -1;
        if (br !== null) return 1;
        return b.trades[b.trades.length - 1].tradeDate.localeCompare(
          a.trades[a.trades.length - 1].tradeDate,
        );
      });
  })();
  // Still-held units per company, rolled up from the holdings snapshot. This is
  // the other half of every export row: the ledger supplies what was sold, this
  // supplies what is still owned. Derivatives fold into their ordinary, matching
  // how the ledger groups by parent code.
  const heldByParent = (() => {
    const m = new Map<string, HeldPosition>();
    for (const p of visiblePositions) {
      const prev = m.get(p.parent);
      const priced = p.last !== null;
      m.set(p.parent, {
        qty: (prev?.qty ?? 0) + p.qty,
        costBase: (prev?.costBase ?? 0) + p.qty * p.cost,
        marketValue: (prev?.marketValue ?? 0) + (priced ? p.qty * p.last! : 0),
        // One unpriced line makes the whole company's market value incomplete.
        hasPrice: (prev?.hasPrice ?? true) && priced,
      });
    }
    return m;
  })();

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

  const summaryRows = () => buildPnlSummary(tradeGroups, heldByParent);

  const exportCsv = () =>
    download(buildPnlSummaryCsv(summaryRows()), exportName("csv"), "text/csv");

  // The workbook is built by a server action (ExcelJS stays out of the client
  // bundle), so this one is async and the button reflects that.
  const [exporting, setExporting] = useState(false);
  const exportExcel = async () => {
    setExporting(true);
    try {
      const base64 = await buildPnlSummaryXlsx(
        summaryRows(),
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

          <RealizedPnlChart rows={chartRows} />

          <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
            <div className="px-4.5 py-3.5 border-b border-line bg-white select-none flex items-baseline justify-between">
              <b className="text-sm font-semibold text-ink">Order history</b>
              <div className="flex items-center gap-3">
                <span className="text-[11px] text-mut">
                  {settledTrades.length} settled
                  {visibleTrades.length !== settledTrades.length &&
                    ` · ${visibleTrades.length - settledTrades.length} cancelled/reversed`}
                </span>
                {/* CSV for data, Excel for the colour-coded copy — plain CSV
                    cannot carry a fill. */}
                <button
                  onClick={exportCsv}
                  disabled={tradeGroups.length === 0 && heldByParent.size === 0}
                  className="border border-line bg-white rounded-[8px] px-2.5 py-1 text-[11px] font-semibold text-mut hover:text-ink hover:border-line-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  Export CSV
                </button>
                <button
                  onClick={exportExcel}
                  disabled={
                    exporting || (tradeGroups.length === 0 && heldByParent.size === 0)
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
                    <th className="px-4.5 py-2.5">Date</th>
                    <th className="px-4.5 py-2.5">Type</th>
                    <th className="px-4.5 py-2.5">Code</th>
                    <th className="px-4.5 py-2.5">Stock</th>
                    <th className="px-4.5 py-2.5 text-right">Units</th>
                    <th className="px-4.5 py-2.5 text-right">Avg price</th>
                    <th className="px-4.5 py-2.5 text-right">Brokerage</th>
                    <th className="px-4.5 py-2.5 text-right">Value</th>
                    <th className="px-4.5 py-2.5 text-center">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {tradeGroups.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-4.5 py-10 text-center text-mut">
                        No contract notes imported for this client.
                      </td>
                    </tr>
                  ) : (
                    tradeGroups.map((g) => {
                      const rz = g.realized;
                      const sold = (rz?.unitsSold ?? 0) > 0;
                      const pl = rz?.realizedPl ?? 0;

                      return (
                        <React.Fragment key={g.parent}>
                          {/* Company header — carries the realised result that
                              the bar above is showing. */}
                          <tr className="border-t border-line bg-[#faf9f5]">
                            <td colSpan={4} className="px-4.5 py-2.5">
                              <span className="code font-mono px-1.5 py-0.5 rounded-[5px] bg-paper-2 font-bold text-ink">
                                {g.parent}
                              </span>
                              <span className="ml-2 text-mut">{g.name}</span>
                              {rz?.shortHistory && (
                                <span
                                  title="No purchase for these units exists in the ledger, so the sale is booked against zero cost and this realised figure is overstated. Needs an opening balance or an earlier statement."
                                  className="ml-1.5 rounded-full bg-loss-bg px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-loss-d cursor-help"
                                >
                                  no cost basis
                                </span>
                              )}
                            </td>
                            <td
                              colSpan={4}
                              className="px-4.5 py-2.5 text-right text-[11px] text-mut"
                            >
                              {g.trades.length} trade
                              {g.trades.length === 1 ? "" : "s"}
                              {sold && (
                                <>
                                  {" · "}
                                  {rz!.unitsSold.toLocaleString("en-AU")} units sold
                                  {" · realised "}
                                  <b
                                    className={`font-mono text-[12px] ${pl >= 0 ? "text-gain" : "text-loss-d"}`}
                                  >
                                    {pl < 0 ? "-" : "+"}${money2(Math.abs(pl))}
                                  </b>
                                </>
                              )}
                              {!sold && " · still open"}
                            </td>
                            <td className="px-4.5 py-2.5" />
                          </tr>

                          {g.trades.map((t) => {
                            const settled = t.status === "SETTLED";
                            const isBuy = t.side === "BUY";

                            return (
                              <tr
                                key={t.id}
                                className={`border-t border-[#f0ede5] hover:bg-[#faf9f5] ${settled ? "" : "opacity-45"}`}
                              >
                                <td className="px-4.5 py-3 pl-7 font-mono text-mut whitespace-nowrap">
                                  {new Date(
                                    `${t.tradeDate}T00:00:00Z`,
                                  ).toLocaleDateString("en-AU", {
                                    day: "2-digit",
                                    month: "short",
                                    year: "2-digit",
                                    timeZone: "UTC",
                                  })}
                                </td>
                                <td className="px-4.5 py-3">
                                  <span
                                    className={`rounded-[5px] px-1.5 py-0.5 text-[10.5px] font-bold ${isBuy ? "bg-green-bg text-green-d" : "bg-loss-bg text-loss-d"}`}
                                  >
                                    {t.side}
                                  </span>
                                </td>
                                <td className="px-4.5 py-3">
                                  {/* Within a group the parent is the header, so
                                      only a differing traded code is worth ink. */}
                                  {t.code === g.parent ? (
                                    <span className="text-mut-d">—</span>
                                  ) : (
                                    <span className="code font-mono px-1.5 py-0.5 rounded-[5px] bg-paper-2">
                                      {t.code}
                                    </span>
                                  )}
                                </td>
                                <td className="px-4.5 py-3 text-mut">
                                  {t.instrument ?? "—"}
                                </td>
                                <td className="px-4.5 py-3 text-right font-mono">
                                  {t.units.toLocaleString("en-AU")}
                                </td>
                                <td className="px-4.5 py-3 text-right font-mono">
                                  ${t.avgPrice.toFixed(t.avgPrice < 1 ? 4 : 2)}
                                </td>
                                <td className="px-4.5 py-3 text-right font-mono text-mut">
                                  {t.brokerage + t.otherCharges + t.gst === 0
                                    ? "—"
                                    : `$${(t.brokerage + t.otherCharges + t.gst).toFixed(2)}`}
                                </td>
                                <td
                                  className={`px-4.5 py-3 text-right font-mono font-semibold ${isBuy ? "text-ink" : "text-gain"}`}
                                >
                                  {isBuy ? "-" : "+"}${money2(t.value)}
                                </td>
                                <td className="px-4.5 py-3 text-center">
                                  <span
                                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${settled ? "bg-paper-2 text-mut" : "bg-amber-bg text-amber-d"}`}
                                  >
                                    {t.status}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </React.Fragment>
                      );
                    })
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
