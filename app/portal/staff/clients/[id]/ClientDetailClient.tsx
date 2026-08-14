"use client";

import React, { useState, useMemo } from "react";
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
  type PnlSummaryRow,
} from "@/lib/export/order-history";
import { storedToSummaryRows } from "@/lib/export/stored-pnl";
import { moneynessOf, UNKNOWN_MONEYNESS } from "@/lib/options/moneyness";
import { MoneynessBadge, StrikeSpot } from "@/app/components/MoneynessBadge";
import type { StoredPnlRow, PnlRunRow } from "@/lib/data/pnl";
import { buildPnlSummaryXlsx } from "@/app/actions/exports";
import { recalculateClientPnl, previewClientPnlCsv } from "@/app/actions/pnl";
import { TablePagination } from "@/app/components/TablePagination";
import { PnlRow } from "./PnlRow";
import { RealizedPnlChart } from "./RealizedPnlChart";
import { posValue, posCost, posPL, unlistedValue } from "@/lib/data/compute";

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
 * Option strikes and spots, which are quoted in fractions of a cent. Rounding
 * a $0.0125 strike to $0.01 would make the ITM arithmetic beside it fail to
 * add up, so up to four places are kept and trailing zeros dropped.
 */
const money4 = (n: number): string =>
  n.toLocaleString("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
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

const TABS = [
  { id: "holdings", label: "Holdings" },
  { id: "historical p&l", label: "Historical P&L" },
  { id: "options", label: "Options" },
  { id: "bids", label: "Bids" },
  { id: "alerts", label: "Alerts" },
] as const;

type TabId = (typeof TABS)[number]["id"];

type HistoricalPnlFilter =
  | "all"
  | "equity"
  | "options"
  | "unlisted"
  | "open"
  | "matched"
  | "profit"
  | "loss"
  | "unmatched";

const isRowOption = (r: PnlSummaryRow) =>
  Boolean(
    r.isOption ||
    r.isUnlistedOption ||
    r.ticker.endsWith("-UO") ||
    r.type.toLowerCase().includes("option")
  );

const isRowUnlistedOption = (r: PnlSummaryRow) =>
  Boolean(
    r.isUnlistedOption ||
    r.ticker.endsWith("-UO") ||
    r.type.toLowerCase().includes("unlisted")
  );

const isRowMatched = (r: PnlSummaryRow) =>
  Boolean(r.isMatched || r.type.startsWith("Matched"));

const isRowOpen = (r: PnlSummaryRow) =>
  Boolean(
    r.openPosition ||
    (r.openQty !== undefined && r.openQty > 0) ||
    r.isDbOpenValued ||
    r.type.startsWith("Open")
  );

const isRowUnmatched = (r: PnlSummaryRow) =>
  !isRowMatched(r) && !isRowOption(r);

const isRowEquity = (r: PnlSummaryRow) => !isRowOption(r);

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
  queuedAccountIds,
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
  /** Accounts a run could not finish — still owed a recompute. */
  queuedAccountIds: string[];
}) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<TabId>("holdings");
  const [pnlFilter, setPnlFilter] = useState<HistoricalPnlFilter>("all");
  const [pnlSearch, setPnlSearch] = useState<string>("");
  const [optionsTabFilter, setOptionsTabFilter] = useState<
    "all" | "listed" | "unlisted" | "itm"
  >("all");
  const [optionsSearch, setOptionsSearch] = useState<string>("");
  // Account filter: "all" aggregates across the client's accounts, else scope
  // to one account. Holdings/options/bids/cash follow this; alerts stay
  // person-level.
  const [acctFilter, setAcctFilter] = useState<string>("all");
  // Which summary row has its inline editor open, by ticker.
  const [editing, setEditing] = useState<string | null>(null);

  // Pagination states for all tabs
  const [holdingsPage, setHoldingsPage] = useState(1);
  const [holdingsPageSize, setHoldingsPageSize] = useState(10);

  const [pnlPage, setPnlPage] = useState(1);
  const [pnlPageSize, setPnlPageSize] = useState(15);

  const [optionsPage, setOptionsPage] = useState(1);
  const [optionsPageSize, setOptionsPageSize] = useState(10);

  const [bidsPage, setBidsPage] = useState(1);
  const [bidsPageSize, setBidsPageSize] = useState(10);

  const [alertsPage, setAlertsPage] = useState(1);
  const [alertsPageSize, setAlertsPageSize] = useState(10);

  const handleSelectAccount = (id: string) => {
    setAcctFilter(id);
    setHoldingsPage(1);
    setPnlPage(1);
    setOptionsPage(1);
    setBidsPage(1);
    setOptionsSearch("");
    setOptionsTabFilter("all");
  };

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

  const pnlTabCounts: Record<HistoricalPnlFilter, number> = {
    all: summaryRows.length,
    equity: summaryRows.filter(isRowEquity).length,
    options: summaryRows.filter(isRowOption).length,
    unlisted: summaryRows.filter(isRowUnlistedOption).length,
    open: summaryRows.filter(isRowOpen).length,
    matched: summaryRows.filter(isRowMatched).length,
    profit: summaryRows.filter((r) => r.pnl > 0).length,
    loss: summaryRows.filter((r) => r.pnl < 0).length,
    unmatched: summaryRows.filter(isRowUnmatched).length,
  };

  const filteredSummaryRows = useMemo(() => {
    return summaryRows.filter((r) => {
      const query = pnlSearch.trim().toLowerCase();
      const matchesSearch =
        !query ||
        r.ticker.toLowerCase().includes(query) ||
        r.name.toLowerCase().includes(query);

      if (!matchesSearch) return false;

      if (pnlFilter === "matched") return isRowMatched(r);
      if (pnlFilter === "profit") return r.pnl > 0;
      if (pnlFilter === "loss") return r.pnl < 0;
      if (pnlFilter === "unmatched") return isRowUnmatched(r);
      if (pnlFilter === "options") return isRowOption(r);
      if (pnlFilter === "unlisted") return isRowUnlistedOption(r);
      if (pnlFilter === "open") return isRowOpen(r);
      if (pnlFilter === "equity") return isRowEquity(r);
      return true;
    });
  }, [summaryRows, pnlSearch, pnlFilter]);

  const filteredSummaryTotal = useMemo(
    () => grandTotal(filteredSummaryRows),
    [filteredSummaryRows],
  );

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

  /**
   * Accounts in view that are still QUEUED for a recompute.
   *
   * The stamp above cannot say this on its own. A morning that ran out of
   * budget leaves accounts owed — 19 of 43 on one real run — and their figures
   * then carry yesterday's "Calculated" time, which reads as "nothing has
   * changed since" when it actually means "this morning's contract notes are
   * imported but not yet in this number". Those are opposite conclusions from
   * identical-looking UI, so the queue is asked directly.
   *
   * Scoped by the same account filter as everything else, so switching to a
   * single account does not report another account's backlog.
   */
  const pendingRecomputes = queuedAccountIds.filter((id) => inAcct(id)).length;

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
    download(buildPnlSummaryCsv(filteredSummaryRows), exportName("csv"), "text/csv");

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
        filteredSummaryRows,
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

  // Paginated slices for each tab
  const paginatedPositions = useMemo(() => {
    if (holdingsPageSize >= visiblePositions.length) return visiblePositions;
    const start = (holdingsPage - 1) * holdingsPageSize;
    return visiblePositions.slice(start, start + holdingsPageSize);
  }, [visiblePositions, holdingsPage, holdingsPageSize]);

  const paginatedPnlRows = useMemo(() => {
    if (pnlPageSize >= filteredSummaryRows.length) return filteredSummaryRows;
    const start = (pnlPage - 1) * pnlPageSize;
    return filteredSummaryRows.slice(start, start + pnlPageSize);
  }, [filteredSummaryRows, pnlPage, pnlPageSize]);

  // Option rows derived from the Historical P&L summary rows (which includes both
  // listed options and unlisted options with Black-Scholes valuation).
  //
  // Each is decorated with the quantity actually behind it and, for a modelled
  // grant, where its strike sits against the underlying — the ITM badge and the
  // exercise value that badge claims both read off this ONE derivation, so they
  // cannot disagree.
  const allOptionSummaryRows = useMemo(() => {
    return summaryRows.filter(isRowOption).map((r) => {
      // An unlisted grant's count sits on the sell side (it was never bought)
      // and its open quantity is negative, so magnitude is what is held.
      const qty =
        r.openQty !== undefined && r.openQty > 0
          ? r.openQty
          : r.buyQty > 0
          ? r.buyQty
          : r.sellQty || Math.abs(r.openQty ?? 0);

      // ONLY the modelled grants. A listed series is quoted and traded on its
      // own market — the Current Value column already carries what it is worth,
      // and an intrinsic figure struck off the underlying would be a second,
      // unrelated number sitting beside it claiming to describe the same row.
      const isUnlisted = isRowUnlistedOption(r);
      const strike = isUnlisted ? r.strike ?? null : null;
      const spot = isUnlisted ? r.underlyingPrice ?? null : null;

      return {
        row: r,
        qty,
        strike,
        spot,
        // Placement grants are calls by construction.
        money: isUnlisted
          ? moneynessOf({ spot, strike, qty, kind: "Call" })
          : UNKNOWN_MONEYNESS,
      };
    });
  }, [summaryRows]);

  type OptionTabId = "all" | "listed" | "unlisted" | "itm";

  const optionTabCounts: Record<OptionTabId, number> = {
    all: allOptionSummaryRows.length,
    listed: allOptionSummaryRows.filter((o) => !isRowUnlistedOption(o.row)).length,
    unlisted: allOptionSummaryRows.filter((o) => isRowUnlistedOption(o.row)).length,
    itm: allOptionSummaryRows.filter((o) => o.money.isItm).length,
  };

  const filteredOptionRows = useMemo(() => {
    return allOptionSummaryRows.filter((o) => {
      const r = o.row;
      const query = optionsSearch.trim().toLowerCase();
      const matchesSearch =
        !query ||
        r.ticker.toLowerCase().includes(query) ||
        r.name.toLowerCase().includes(query) ||
        (r.note && r.note.toLowerCase().includes(query));

      if (!matchesSearch) return false;

      if (optionsTabFilter === "listed") return !isRowUnlistedOption(r);
      if (optionsTabFilter === "unlisted") return isRowUnlistedOption(r);
      if (optionsTabFilter === "itm") return o.money.isItm;
      return true;
    });
  }, [allOptionSummaryRows, optionsTabFilter, optionsSearch]);

  const paginatedOptions = useMemo(() => {
    if (optionsPageSize >= filteredOptionRows.length) return filteredOptionRows;
    const start = (optionsPage - 1) * optionsPageSize;
    return filteredOptionRows.slice(start, start + optionsPageSize);
  }, [filteredOptionRows, optionsPage, optionsPageSize]);

  const filteredOptionTotal = useMemo(() => {
    const buyPrice = filteredOptionRows.reduce((s, o) => s + o.row.buyPrice, 0);
    const sellOrCurrent = filteredOptionRows.reduce((s, o) => s + o.row.sellOrCurrent, 0);
    const pnl = filteredOptionRows.reduce((s, o) => s + o.row.pnl, 0);
    const qty = filteredOptionRows.reduce((s, o) => s + o.qty, 0);
    const intrinsic = filteredOptionRows.reduce((s, o) => s + o.money.intrinsicValue, 0);
    return { buyPrice, sellOrCurrent, pnl, qty, intrinsic };
  }, [filteredOptionRows]);

  const paginatedBids = useMemo(() => {
    if (bidsPageSize >= bidRows.length) return bidRows;
    const start = (bidsPage - 1) * bidsPageSize;
    return bidRows.slice(start, start + bidsPageSize);
  }, [bidRows, bidsPage, bidsPageSize]);

  const paginatedAlerts = useMemo(() => {
    if (alertsPageSize >= alerts.length) return alerts;
    const start = (alertsPage - 1) * alertsPageSize;
    return alerts.slice(start, start + alertsPageSize);
  }, [alerts, alertsPage, alertsPageSize]);

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
          onClick={() => router.push("/portal/staff/clients")}
          className="text-green-d font-semibold text-xs underline underline-offset-2 cursor-pointer hover:opacity-85"
        >
          &larr; Clients
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
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`text-xs font-semibold px-3.5 py-1.5 rounded-[7px] cursor-pointer transition-colors ${activeTab === t.id
                ? "bg-white text-ink shadow-shadow"
                : "text-mut hover:text-ink"
                }`}
            >
              {t.label}
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
              onClick={() => handleSelectAccount(a.id)}
              className={`text-xs font-semibold px-3 py-1.5 rounded-full border cursor-pointer transition-colors ${acctFilter === a.id
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
                {paginatedPositions.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-center text-mut py-8">
                      No equity positions on record for this account.
                    </td>
                  </tr>
                ) : (
                  paginatedPositions.map(p => {
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
                  })
                )}
              </tbody>
            </table>
          </div>
          <TablePagination
            totalItems={visiblePositions.length}
            currentPage={holdingsPage}
            pageSize={holdingsPageSize}
            onPageChange={setHoldingsPage}
            onPageSizeChange={setHoldingsPageSize}
            pageSizeOptions={[5, 10, 25, 50]}
            itemLabel="positions"
          />
        </div>
      )}

      {activeTab === "historical p&l" && (
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
              className={`bg-white border border-line rounded-[14px] shadow-shadow px-4.5 py-3 text-[11px] ${recalcNote.tone === "ok" ? "text-mut" : "text-loss-d"
                }`}
            >
              {recalcNote.text}
            </div>
          )}

          <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
            <div className="px-4.5 py-3.5 border-b border-line bg-white select-none flex flex-col md:flex-row md:items-baseline justify-between gap-3">
              <div>
                <b className="text-sm font-semibold text-ink">P&amp;L by company</b>
                <div className="text-[11px] text-mut mt-0.5">
                  {filteredSummaryRows.length !== summaryRows.length ? (
                    <>
                      <span className="font-semibold text-ink">{filteredSummaryRows.length}</span> of{" "}
                      {summaryRows.length} row{summaryRows.length === 1 ? "" : "s"}
                    </>
                  ) : (
                    <>
                      {summaryRows.length} row{summaryRows.length === 1 ? "" : "s"}
                    </>
                  )}{" "}
                  from {settledTrades.length} settled trade
                  {settledTrades.length === 1 ? "" : "s"}
                  {visibleTrades.length !== settledTrades.length &&
                    ` · ${visibleTrades.length - settledTrades.length} cancelled/reversed excluded`}
                  {" · exports match this table exactly"}
                </div>
                {/* A stored figure is only as good as its age, so the age is not
                    hidden. */}
                <div className="text-[11px] text-mut mt-0.5 flex items-center gap-2 flex-wrap">
                  {lastComputedAt ? (
                    <>Calculated {stamp(lastComputedAt)}</>
                  ) : (
                    <span className="text-loss-d">
                      Never calculated — press Recalculate to build this client&apos;s P&amp;L.
                    </span>
                  )}
                  {pendingRecomputes > 0 && (
                    <span
                      title={
                        "The morning ingest imported this client's data but ran out of time " +
                        "before rebuilding their P&L. The next scheduled run will take it, or " +
                        "press Recalculate now."
                      }
                      className="bg-amber-bg text-amber-d font-semibold rounded-[6px] px-1.5 py-0.5 text-[10px] whitespace-nowrap"
                    >
                      Recompute pending
                      {pendingRecomputes > 1 ? ` · ${pendingRecomputes} accounts` : ""}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2.5 flex-wrap sm:flex-nowrap">
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
                  disabled={filteredSummaryRows.length === 0}
                  className="border border-line bg-white rounded-[8px] px-2.5 py-1 text-[11px] font-semibold text-mut hover:text-ink hover:border-line-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  Export CSV
                </button>
                <button
                  onClick={exportExcel}
                  disabled={exporting || filteredSummaryRows.length === 0}
                  title="Same rows as an .xlsx, colour-coded: amber = still open, green = fully exited, red = needs checking"
                  className="border border-line bg-white rounded-[8px] px-2.5 py-1 text-[11px] font-semibold text-mut hover:text-ink hover:border-line-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                >
                  {exporting ? "Building…" : "Export Excel"}
                </button>
              </div>
            </div>

            {/* Filter Tabs & Search Controls Bar */}
            <div className="px-4.5 py-3 border-b border-line bg-white space-y-2.5 select-none">
              {/* Full-width Segmented Filter Tabs */}
              <div className="w-full bg-paper-2 rounded-[10px] p-1 flex items-center gap-1 overflow-x-auto lg:overflow-visible flex-wrap sm:flex-nowrap border border-line/60">
                {(
                  [
                    "all",
                    "equity",
                    "options",
                    "unlisted",
                    "open",
                    "matched",
                    "profit",
                    "loss",
                    "unmatched",
                  ] as const
                ).map((f) => {
                  const active = pnlFilter === f;
                  const count = pnlTabCounts[f];
                  const labels: Record<HistoricalPnlFilter, string> = {
                    all: "All Tickers",
                    equity: "Equity",
                    options: "Options",
                    unlisted: "Unlisted Options",
                    open: "Open",
                    matched: "Matched P&L",
                    profit: "Profit Only",
                    loss: "Loss Only",
                    unmatched: "Unmatched",
                  };
                  return (
                    <button
                      key={f}
                      type="button"
                      onClick={() => {
                        setPnlFilter(f);
                        setPnlPage(1);
                      }}
                      className={`flex-1 flex items-center justify-center gap-2 px-2.5 py-1.75 rounded-[7px] text-xs cursor-pointer transition-all whitespace-nowrap ${active
                        ? "bg-white text-ink font-semibold shadow-shadow border border-line/60"
                        : "text-mut hover:text-ink font-medium hover:bg-white/50"
                        }`}
                    >
                      <span>{labels[f]}</span>
                      <span
                        className={`text-[10.5px] font-mono px-1.5 py-0.5 rounded-[4px] font-semibold transition-colors ${active
                          ? f === "profit"
                            ? "bg-gain-bg text-gain"
                            : f === "loss"
                              ? "bg-loss-bg text-loss-d"
                              : "bg-paper-2 text-ink"
                          : f === "profit"
                            ? "bg-gain-bg/50 text-gain"
                            : f === "loss"
                              ? "bg-loss-bg/50 text-loss-d"
                              : "bg-line/40 text-mut"
                          }`}
                      >
                        {count}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Search & Quick Controls Row */}
              <div className="flex items-center justify-between gap-3 pt-0.5">
                <div className="relative flex-1 max-w-sm">
                  <svg
                    className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-mut pointer-events-none"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth="2"
                      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                    />
                  </svg>
                  <input
                    type="text"
                    placeholder="Search ticker or company..."
                    value={pnlSearch}
                    onChange={(e) => {
                      setPnlSearch(e.target.value);
                      setPnlPage(1);
                    }}
                    className="w-full bg-paper-2/60 hover:bg-paper-2 focus:bg-white border border-line rounded-[8px] pl-8.5 pr-7 py-1.5 text-xs text-ink placeholder:text-mut focus:outline-none focus:border-navy transition-all font-medium"
                  />
                  {pnlSearch && (
                    <button
                      type="button"
                      onClick={() => {
                        setPnlSearch("");
                        setPnlPage(1);
                      }}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-mut hover:text-ink p-0.5 cursor-pointer"
                      title="Clear search"
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  )}
                </div>

                {(pnlFilter !== "all" || pnlSearch) && (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-mut">
                      Showing <strong className="text-ink">{filteredSummaryRows.length}</strong> of {summaryRows.length}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setPnlFilter("all");
                        setPnlSearch("");
                        setPnlPage(1);
                      }}
                      className="inline-flex items-center gap-1 border border-line bg-white hover:bg-paper-2 rounded-[7px] px-2.5 py-1 text-[11px] font-semibold text-mut hover:text-ink transition-colors cursor-pointer"
                    >
                      <svg className="w-3 h-3 text-mut" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                      Reset Filter
                    </button>
                  </div>
                )}
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
                  {filteredSummaryRows.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="px-4.5 py-10 text-center text-mut">
                        {summaryRows.length === 0
                          ? "No contract notes imported for this client."
                          : "No company records match the current filter or search."}
                      </td>
                    </tr>
                  ) : (
                    <>
                      {paginatedPnlRows.map((r) => (
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
                          Grand Total{filteredSummaryRows.length !== summaryRows.length ? ` (${filteredSummaryRows.length} filtered)` : ""}
                        </td>
                        <td className="px-4.5 py-3" />
                        <td className="px-4.5 py-3" />
                        <td className="px-4.5 py-3 text-right font-mono">
                          ${money2(filteredSummaryTotal.buyPrice)}
                        </td>
                        <td className="px-4.5 py-3 text-right font-mono">
                          ${money2(filteredSummaryTotal.sellOrCurrent)}
                        </td>
                        <td
                          className={`px-4.5 py-3 text-right font-mono ${filteredSummaryTotal.pnl >= 0 ? "text-gain" : "text-loss-d"}`}
                        >
                          {filteredSummaryTotal.pnl < 0 ? "-" : ""}$
                          {money2(Math.abs(filteredSummaryTotal.pnl))}
                        </td>
                        <td className="px-4.5 py-3" colSpan={3} />
                      </tr>
                    </>
                  )}
                </tbody>
              </table>
            </div>

            <TablePagination
              totalItems={filteredSummaryRows.length}
              currentPage={pnlPage}
              pageSize={pnlPageSize}
              onPageChange={setPnlPage}
              onPageSizeChange={setPnlPageSize}
              pageSizeOptions={[10, 15, 25, 50, 100]}
              itemLabel="tickers"
            />
          </div>
        </div>
      )}

      {activeTab === "options" && (
        <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden space-y-0">
          <div className="px-4.5 py-3.5 border-b border-line bg-white select-none flex items-center justify-between flex-wrap gap-2">
            <div>
              <b className="text-sm font-semibold text-ink">Client option register</b>
              <div className="text-[11px] text-mut mt-0.5">
                Listed exchange-traded options, and unlisted placement options carried at intrinsic value
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono px-2 py-0.5 rounded-[6px] bg-paper-2 border border-line/60 font-semibold text-ink">
                {filteredOptionRows.length} {filteredOptionRows.length === 1 ? "option" : "options"}
              </span>
            </div>
          </div>

          {/* Filter Tabs & Search Controls Bar */}
          <div className="px-4.5 py-3 border-b border-line bg-white space-y-2.5 select-none">
            {/* Segmented Filter Pills */}
            <div className="w-full bg-paper-2 rounded-[10px] p-1 flex items-center gap-1 overflow-x-auto flex-wrap sm:flex-nowrap border border-line/60">
              {(
                [
                  { id: "all", label: "All Options" },
                  { id: "listed", label: "Listed Options" },
                  { id: "unlisted", label: "Unlisted Options" },
                  { id: "itm", label: "In the Money" },
                ] as const
              ).map((t) => {
                const active = optionsTabFilter === t.id;
                const count = optionTabCounts[t.id];
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => {
                      setOptionsTabFilter(t.id);
                      setOptionsPage(1);
                    }}
                    className={`flex-1 flex items-center justify-center gap-2 px-3 py-1.75 rounded-[7px] text-xs cursor-pointer transition-all whitespace-nowrap ${
                      active
                        ? "bg-white text-ink font-semibold shadow-shadow border border-line/60"
                        : "text-mut hover:text-ink font-medium hover:bg-white/50"
                    }`}
                  >
                    <span>{t.label}</span>
                    <span
                      className={`text-[10.5px] font-mono px-1.5 py-0.5 rounded-[4px] font-semibold transition-colors ${
                        active
                          ? "bg-paper-2 text-ink"
                          : "bg-line/40 text-mut"
                      }`}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Search & Quick Controls Row */}
            <div className="flex items-center justify-between gap-3 pt-0.5">
              <div className="relative flex-1 max-w-sm">
                <svg
                  className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-mut pointer-events-none"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
                <input
                  type="text"
                  placeholder="Search series, company, terms..."
                  value={optionsSearch}
                  onChange={(e) => {
                    setOptionsSearch(e.target.value);
                    setOptionsPage(1);
                  }}
                  className="w-full bg-paper-2/60 hover:bg-paper-2 focus:bg-white border border-line rounded-[8px] pl-8.5 pr-7 py-1.5 text-xs text-ink placeholder:text-mut focus:outline-none focus:border-navy transition-all font-medium"
                />
                {optionsSearch && (
                  <button
                    type="button"
                    onClick={() => {
                      setOptionsSearch("");
                      setOptionsPage(1);
                    }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-mut hover:text-ink p-0.5 cursor-pointer"
                    title="Clear search"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>

              {(optionsTabFilter !== "all" || optionsSearch) && (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-mut">
                    Showing <strong className="text-ink">{filteredOptionRows.length}</strong> of {allOptionSummaryRows.length}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setOptionsTabFilter("all");
                      setOptionsSearch("");
                      setOptionsPage(1);
                    }}
                    className="inline-flex items-center gap-1 border border-line bg-white hover:bg-paper-2 rounded-[7px] px-2.5 py-1 text-[11px] font-semibold text-mut hover:text-ink transition-colors cursor-pointer"
                  >
                    <svg className="w-3 h-3 text-mut" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                    Reset Filter
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs font-medium">
              <thead>
                <tr className="border-b border-line text-mut select-none">
                  <th className="px-4.5 py-2.5 whitespace-nowrap">Series</th>
                  <th className="px-4.5 py-2.5">Underlying</th>
                  <th className="px-4.5 py-2.5 whitespace-nowrap">Type</th>
                  <th className="px-4.5 py-2.5 text-right whitespace-nowrap" title="Options held — the count the exercise value is struck on">
                    Buy Qty
                  </th>
                  <th
                    className="px-4.5 py-2.5 whitespace-nowrap"
                    title="Exercise price → underlying price. Unlisted grants only — a listed series trades on its own market."
                  >
                    Strike &rarr; Spot
                  </th>
                  <th
                    className="px-4.5 py-2.5 text-right whitespace-nowrap"
                    title="Qty × (Spot − Strike), floored at zero. Unlisted grants only."
                  >
                    Exercise Value ($)
                  </th>
                  <th className="px-4.5 py-2.5 text-right whitespace-nowrap">Cost ($)</th>
                  <th className="px-4.5 py-2.5 text-right whitespace-nowrap">Current Value ($)</th>
                  <th className="px-4.5 py-2.5 text-right whitespace-nowrap">Unreal. P&amp;L ($)</th>
                  <th className="px-4.5 py-2.5 whitespace-nowrap">Terms / Valuation Notes</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f0ede5]">
                {filteredOptionRows.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="text-center text-mut py-8">
                      {allOptionSummaryRows.length === 0
                        ? "No option holdings or placement grants on record for this account."
                        : "No options match the current filter or search."}
                    </td>
                  </tr>
                ) : (
                  <>
                    {paginatedOptions.map(({ row: o, qty, strike, spot, money }) => {
                      const isUnlisted = isRowUnlistedOption(o);
                      const isUp = o.pnl >= 0;

                      return (
                        <tr
                          key={o.ticker}
                          className={money.isItm ? "bg-green-bg/25 hover:bg-green-bg/40" : "hover:bg-[#faf9f5]"}
                        >
                          <td className="px-4.5 py-3 whitespace-nowrap">
                            <span className="code font-mono px-1.5 py-0.5 rounded-[5px] bg-paper-2 font-bold text-ink whitespace-nowrap inline-block">
                              {o.ticker}
                            </span>
                          </td>
                          <td className="px-4.5 py-3 text-ink font-semibold min-w-[200px]">{o.name}</td>
                          <td className="px-4.5 py-3 whitespace-nowrap">
                            <div className="flex items-center gap-1.5">
                              <span
                                className={`pill text-[10.5px] font-semibold rounded-full px-2.5 py-0.5 whitespace-nowrap inline-block ${
                                  isUnlisted
                                    ? "bg-[#ece9f3] text-[#5c5775]"
                                    : "bg-paper-2 text-ink border border-line/60"
                                }`}
                              >
                                {isUnlisted ? "Unlisted Option" : "Listed Option"}
                              </span>
                              <MoneynessBadge
                                money={money}
                                title={
                                  money.isItm
                                    ? `In the money by $${money4(money.intrinsicPerOption)} per option`
                                    : undefined
                                }
                              />
                            </div>
                          </td>
                          <td className="px-4.5 py-3 text-right font-mono text-ink whitespace-nowrap">
                            {qty > 0 ? qty.toLocaleString("en-AU") : "—"}
                          </td>
                          <td className="px-4.5 py-3 whitespace-nowrap">
                            <StrikeSpot strike={strike} spot={spot} money4={money4} />
                          </td>
                          {/* Intrinsic, not the model price: what the parcel is
                              worth exercised today, which is the arithmetic the
                              ITM badge beside it claims. */}
                          <td
                            className={`px-4.5 py-3 text-right font-mono whitespace-nowrap ${
                              money.isItm ? "text-gain font-semibold" : "text-mut"
                            }`}
                            title={
                              money.moneyness === "unknown"
                                ? isUnlisted
                                  ? "No strike on record for this grant"
                                  : "Listed series — marked to its own market, see Current Value"
                                : `${qty.toLocaleString("en-AU")} × $${money4(money.intrinsicPerOption)}`
                            }
                          >
                            {money.moneyness === "unknown" ? "—" : `$${money2(money.intrinsicValue)}`}
                          </td>
                          <td className="px-4.5 py-3 text-right font-mono text-mut whitespace-nowrap">
                            ${money2(o.buyPrice)}
                          </td>
                          <td className="px-4.5 py-3 text-right font-mono font-semibold text-ink whitespace-nowrap">
                            ${money2(o.sellOrCurrent)}
                          </td>
                          <td
                            className={`px-4.5 py-3 text-right font-mono font-semibold whitespace-nowrap ${
                              isUp ? "text-gain" : "text-loss-d"
                            }`}
                          >
                            {o.pnl < 0 ? "-" : "+"}${money2(Math.abs(o.pnl))}
                          </td>
                          <td className="px-4.5 py-3 text-mut text-[11px] font-mono leading-relaxed max-w-sm truncate" title={o.note || o.type}>
                            {o.note || o.type}
                          </td>
                        </tr>
                      );
                    })}

                    {/* Options Grand Total */}
                    <tr className="border-t-2 border-line-2 bg-paper-2 font-bold">
                      <td className="px-4.5 py-3" colSpan={3}>
                        Grand Total ({filteredOptionRows.length} {filteredOptionRows.length === 1 ? "option" : "options"})
                      </td>
                      {/* Option counts DO add up — unlike share quantities, these
                          are all contracts over the same client's positions. */}
                      <td className="px-4.5 py-3 text-right font-mono">
                        {filteredOptionTotal.qty.toLocaleString("en-AU")}
                      </td>
                      <td className="px-4.5 py-3" />
                      <td className="px-4.5 py-3 text-right font-mono text-gain">
                        ${money2(filteredOptionTotal.intrinsic)}
                      </td>
                      <td className="px-4.5 py-3 text-right font-mono">
                        ${money2(filteredOptionTotal.buyPrice)}
                      </td>
                      <td className="px-4.5 py-3 text-right font-mono">
                        ${money2(filteredOptionTotal.sellOrCurrent)}
                      </td>
                      <td
                        className={`px-4.5 py-3 text-right font-mono ${
                          filteredOptionTotal.pnl >= 0 ? "text-gain" : "text-loss-d"
                        }`}
                      >
                        {filteredOptionTotal.pnl < 0 ? "-" : "+"}$
                        {money2(Math.abs(filteredOptionTotal.pnl))}
                      </td>
                      <td className="px-4.5 py-3" />
                    </tr>
                  </>
                )}
              </tbody>
            </table>
          </div>

          <TablePagination
            totalItems={filteredOptionRows.length}
            currentPage={optionsPage}
            pageSize={optionsPageSize}
            onPageChange={setOptionsPage}
            onPageSizeChange={setOptionsPageSize}
            pageSizeOptions={[5, 10, 25, 50]}
            itemLabel="options"
          />
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
                  paginatedBids.map(({ placement: p, bid }) => {
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
          <TablePagination
            totalItems={bidRows.length}
            currentPage={bidsPage}
            pageSize={bidsPageSize}
            onPageChange={setBidsPage}
            onPageSizeChange={setBidsPageSize}
            pageSizeOptions={[5, 10, 25, 50]}
            itemLabel="bids"
          />
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
              paginatedAlerts.map(a => (
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
          <TablePagination
            totalItems={alerts.length}
            currentPage={alertsPage}
            pageSize={alertsPageSize}
            onPageChange={setAlertsPage}
            onPageSizeChange={setAlertsPageSize}
            pageSizeOptions={[5, 10, 25]}
            itemLabel="alerts"
          />
        </div>
      )}
    </div>
  );
}
