"use client";

import React, { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import type {
  ClientRow,
  ClientLogin,
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
  attributeSells,
  realizedByPeriod,
  realizedBetween,
} from "@/lib/data/compute";
import {
  buildPnlSummaryCsv,
  grandTotal,
  pnlSummaryFilename,
  SUMMARY_HEADERS,
} from "@/lib/export/order-history";
import { storedToSummaryRows } from "@/lib/export/stored-pnl";
import { MoneynessBadge, StrikeSpot } from "@/app/components/MoneynessBadge";
// The row predicates, the filters and the option derivation are shared with the
// client portal, which shows these same three tables. See lib/pnl/summary-rows.ts.
import {
  isRowUnlistedOption,
  filterPnlRows,
  pnlRowId,
  pnlFilterCounts,
  optionSummaryRows,
  filterOptionRows,
  optionFilterCounts,
  optionTotals,
  PNL_FILTERS,
  PNL_FILTER_LABELS,
  OPTION_FILTERS,
  OPTION_FILTER_LABELS,
  type PnlFilter,
  type OptionFilter,
} from "@/lib/pnl/summary-rows";
import type { LedgerLine } from "@/lib/import/trades";
import type { StoredPnlRow, PnlRunRow } from "@/lib/data/pnl";
import { buildPnlSummaryXlsx } from "@/app/actions/exports";
import { recalculateClientPnl, previewClientPnlCsv } from "@/app/actions/pnl";
import { TablePagination } from "@/app/components/TablePagination";
import { PnlRow } from "@/app/components/PnlRow";
import { RealizedPnlChart } from "@/app/components/RealizedPnlChart";
import { RealisedRangePicker, type DateRange } from "@/app/components/RealisedRangePicker";
import { realisedWindowRows } from "@/lib/pnl/realised-window";
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

/**
 * Who can sign in as this client.
 *
 * ── Why the desk needs to see this at all ──────────────────────────────────
 * A client may hold several login addresses since
 * 20260911090000_client_emails.sql, and the register used to show none of them
 * — the detail page never printed an address. That was survivable while a
 * client WAS an address. It is not now: when somebody rings the desk, "which
 * of these people is on the phone" and "how many others can see this
 * portfolio" are both questions this page has to be able to answer, and
 * neither is derivable from anything else on it.
 *
 * The primary is marked because it is the one that reaches `clients.email` —
 * the address the claim queue prints and the rail in `approve_account_claim`
 * reasons about. A desk reading a claim refusal that names an address needs to
 * be able to find that address here.
 *
 * A client with no login at all (every broker-imported row) is said plainly
 * rather than left blank: "no logins" is a fact about the account somebody may
 * be about to act on, and an empty space reads as "not loaded".
 */
function Logins({ logins }: { logins: ClientLogin[] }) {
  if (logins.length === 0) {
    return (
      <div className="text-xs text-mut mt-1">
        Logins: <span className="font-semibold">none</span> — this client cannot
        sign in.
      </div>
    );
  }

  return (
    <div className="text-xs text-mut mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1">
      <span>
        {logins.length === 1 ? "Login:" : `Logins (${logins.length}):`}
      </span>
      {logins.map((l) => (
        <span
          key={l.email}
          className={`font-mono text-[11px] rounded-full px-2 py-0.5 ${
            l.isPrimary ? "bg-green-bg text-green-d font-semibold" : "bg-paper-2"
          }`}
          title={l.isPrimary ? "Primary address" : "Additional login"}
        >
          {l.email}
        </span>
      ))}
    </div>
  );
}

const TABS = [
  { id: "holdings", label: "Holdings" },
  { id: "historical p&l", label: "Historical P&L" },
  { id: "options", label: "Options" },
  { id: "bids", label: "Bids" },
  { id: "alerts", label: "Alerts" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function ClientDetailClient({
  client,
  accounts,
  positions,
  options,
  clientBids,
  alerts,
  signalsMap,
  trades,
  overrides,
  storedPnl,
  offLedgerByScope,
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
  overrides: PnlOverrideRow[];
  storedPnl: StoredPnlRow[];
  /**
   * Per account scope, the purchases the contract-note ledger never recorded —
   * chiefly placement parcels. Built on the server; see the page and
   * lib/pnl/off-ledger-buys.ts.
   */
  offLedgerByScope: Record<string, LedgerLine[]>;
  pnlRuns: PnlRunRow[];
  /** Accounts a run could not finish — still owed a recompute. */
  queuedAccountIds: string[];
}) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<TabId>("holdings");
  const [pnlFilter, setPnlFilter] = useState<PnlFilter>("all");
  /**
   * The period the Historical P&L tab is taken over, or `null` for All time.
   *
   * Nullable rather than two seeded strings: seeded state does not re-seed, so
   * alongside the account filter two strings would leave the pickers pinned to
   * the previous account's sale history — a range whose own min/max no longer
   * contained it, reading $0 over a window nobody chose.
   */
  const [range, setRange] = useState<DateRange | null>(null);
  const [pnlSearch, setPnlSearch] = useState<string>("");
  const [optionsTabFilter, setOptionsTabFilter] = useState<OptionFilter>("all");
  const [optionsSearch, setOptionsSearch] = useState<string>("");
  // Account filter: "all" aggregates across the client's accounts, else scope
  // to one account. Holdings/options/bids/cash follow this; alerts stay
  // person-level.
  const [acctFilter, setAcctFilter] = useState<string>("all");
  /**
   * Which summary row has its inline editor open.
   *
   * Held as `account:ticker` rather than as a ticker. Under "All accounts" a
   * client with EOS in two accounts has two EOS rows, and a ticker opened the
   * editor on both of them at once — over two different sets of figures, with
   * only one of them able to save.
   */
  const [editing, setEditing] = useState<string | null>(null);

  // Pagination states for all tabs
  const [holdSearch, setHoldSearch] = useState("");
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

  /**
   * Picking a period changes WHICH table is on screen — all-time rows, or the
   * sales inside a window — so the filter and the page number go back to the
   * start with it. A `Matched` pill carried into a realised view would match
   * nothing and read as an empty book.
   */
  const pickRange = (next: DateRange | null) => {
    setRange(next);
    setPnlFilter("all");
    setPnlPage(1);
    setEditing(null);
  };

  const handleSelectAccount = (id: string) => {
    setAcctFilter(id);
    // The sale history the pickers are bounded by belongs to the old scope.
    setRange(null);
    // The row being edited may not be in the new scope at all, and an editor
    // left open on it reappears the moment the filter comes back.
    setEditing(null);
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
  // Memoised because the ledger replay below is keyed on it — the same shape
  // the client's Portfolio uses for the same reason.
  const visibleTrades = useMemo(
    () =>
      acctFilter === "all"
        ? trades
        : trades.filter((t) => t.accountId === acctFilter),
    [trades, acctFilter],
  );

  // Settled trades are the only ones that moved money; the rest are shown for
  // completeness but excluded from every total below.
  const settledTrades = useMemo(
    () => visibleTrades.filter((t) => t.status === "SETTLED"),
    [visibleTrades],
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
  // Scoped, then handed over as an array. This used to be a Map keyed by
  // `parent` alone, which under "All accounts" collapsed two accounts'
  // corrections on one company into a single entry — one silently dropped, the
  // survivor applied to both rows. `storedToSummaryRows` now keys them by
  // account AND parent, which is how `pnl_overrides` itself is keyed.
  const visibleOverrides = overrides.filter((o) => inAcct(o.accountId));
  const visibleStoredPnl = storedPnl.filter((r) => inAcct(r.accountId));
  const summaryRows = storedToSummaryRows(visibleStoredPnl, visibleOverrides);

  /**
   * The purchases the ledger never recorded — chiefly placement parcels, which
   * reach a client as a sale with no matching buy — so the realised-P&L chart
   * costs them instead of drawing the whole proceeds as profit.
   *
   * Arrives pre-built per account scope rather than being derived here, for two
   * reasons. It has to be taken against the PRE-override stored figures — a
   * desk correction reaches the chart separately through `chartDeltas` below,
   * and counting it in both places would move every corrected month twice. And
   * calling it in this component put React Compiler off optimising the whole
   * island: `storedToSummaryRows` may alias its input, so any further call
   * holding those rows is one the compiler must assume could mutate what
   * `summaryRows` points at, which makes every `useMemo` keyed on it
   * unpreservable.
   */
  // Memoised rather than picked inline: `sells` below is keyed on it, and a
  // fresh `[]` from the fallback on every render would rebuild the whole ledger
  // replay each time — which is also what the compiler warns about here.
  const offLedger = useMemo(
    () => offLedgerByScope[acctFilter] ?? offLedgerByScope.all ?? [],
    [offLedgerByScope, acctFilter],
  );

  /**
   * How far each corrected row's P&L moved from what the engine computed.
   *
   * A desk edit carries no date of its own, so the delta is handed to whatever
   * dates the sales — the chart's buckets and the window's contributors alike —
   * to spread across that company's sale months. Without it an edited row would
   * move the table's total and leave both of them behind.
   */
  const chartDeltas = useMemo(
    () =>
      new Map(
        summaryRows
          .filter((r) => r.edited && Math.abs(r.pnl - r.computed.pnl) > 0.005)
          .map((r) => [r.ticker, r.pnl - r.computed.pnl]),
      ),
    [summaryRows],
  );

  const sells = useMemo(
    () => attributeSells(visibleTrades, offLedger),
    [visibleTrades, offLedger],
  );

  /**
   * The bounds a period can be picked between — every sale on file.
   *
   * `to` is the last day anything actually sold rather than today: a book whose
   * last sale was in June would otherwise open on a range ending today, and
   * every preset inside it would read $0.
   */
  const lastSaleDate = useMemo(
    () => sells.reduce((latest, x) => (x.tradeDate > latest ? x.tradeDate : latest), ""),
    [sells],
  );
  const firstSaleDate = useMemo(
    () =>
      sells.reduce(
        (earliest, x) => (!earliest || x.tradeDate < earliest ? x.tradeDate : earliest),
        "",
      ),
    [sells],
  );

  const isAllTime = range === null;
  const rangeFrom = range?.from ?? firstSaleDate;
  const rangeTo = range?.to ?? lastSaleDate;

  const window_ = useMemo(
    () =>
      rangeFrom && rangeTo
        ? realizedBetween(sells, rangeFrom, rangeTo, chartDeltas)
        : null,
    [sells, rangeFrom, rangeTo, chartDeltas],
  );

  /** The sales inside the window, through the same builder the client uses. */
  const realisedRows = useMemo(
    () => (window_ ? realisedWindowRows(window_.contributors, summaryRows) : []),
    [window_, summaryRows],
  );

  /**
   * What the table is showing.
   *
   * ── Where the desk deliberately parts company with the client ─────────────
   * All time here is EVERY stored row, open positions included. The client's
   * own screen drops parcels that have never sold — they are on their Holdings
   * table, and "Historical P&L" is not where a live position belongs — but the
   * desk is the one party that has to be able to see the whole book in one
   * table, including the rows nobody has traded yet. That is the 31-row gap
   * between the two screens, and it is the intended one.
   *
   * A RANGE means the same thing on both: a period can only describe money that
   * changed hands, so it is the sales inside it.
   */
  const tableRows = isAllTime ? summaryRows : realisedRows;

  /**
   * The trades inside the selected period, which is what the tiles count.
   *
   * All time is not special-cased in the arithmetic: the range then spans every
   * sale on file. It IS special-cased here only to keep trades that predate the
   * first sale — a book that has bought and never sold has no sale dates to
   * bound a range with, and its Bought tile must not read $0.
   */
  const rangedTrades = useMemo(
    () =>
      isAllTime
        ? settledTrades
        : settledTrades.filter(
            (t) => t.tradeDate >= rangeFrom && t.tradeDate <= rangeTo,
          ),
    [settledTrades, isAllTime, rangeFrom, rangeTo],
  );

  const boughtTotal = rangedTrades
    .filter((t) => t.side === "BUY")
    .reduce((s, t) => s + t.value, 0);
  const soldTotal = rangedTrades
    .filter((t) => t.side === "SELL")
    .reduce((s, t) => s + t.value, 0);
  const feesTotal = rangedTrades.reduce(
    (s, t) => s + t.brokerage + t.otherCharges + t.gst,
    0,
  );

  /**
   * Realised P&L over the period, read off the SAME window as the table.
   *
   * This used to sum `realized_pnl` straight from the database, which was a
   * second source for a figure the table below already states — and it took no
   * account of desk overrides, so a corrected row moved the table and the chart
   * and left this tile reading the uncorrected number. One window, one answer.
   */
  const realizedTotal = window_?.realizedPl ?? 0;

  const pnlTabCounts = useMemo(() => pnlFilterCounts(tableRows), [tableRows]);

  const filteredSummaryRows = useMemo(
    () => filterPnlRows(tableRows, pnlFilter, pnlSearch),
    [tableRows, pnlFilter, pnlSearch],
  );

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

  /**
   * The over-time chart, on the same period as everything else on the tab.
   *
   * The bucket width is the bucketer's call, not the picker's: a range up to a
   * year is drawn in months, up to three years in quarters, longer in years — so
   * the column count stays near a dozen at every range this picker offers.
   */
  const chartPeriods = useMemo(() => {
    const inRange = isAllTime
      ? sells
      : sells.filter((x) => x.tradeDate >= rangeFrom && x.tradeDate <= rangeTo);
    return realizedByPeriod(inRange, chartDeltas);
  }, [sells, isAllTime, rangeFrom, rangeTo, chartDeltas]);

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
  const allOptionSummaryRows = useMemo(
    () => optionSummaryRows(summaryRows),
    [summaryRows],
  );

  const optionTabCounts = useMemo(
    () => optionFilterCounts(allOptionSummaryRows),
    [allOptionSummaryRows],
  );

  /**
   * The unlisted grants, as holdings.
   *
   * `sellOrCurrent` is a VALUE for the whole parcel, so the per-option figure is
   * derived rather than read. It is a modelled price, not a market one — nothing
   * quotes these — which is why the row says so on its face.
   */
  const unlistedHoldings = useMemo(
    () =>
      allOptionSummaryRows
        .filter((o) => isRowUnlistedOption(o.row))
        .map((o) => ({
          code: o.row.ticker,
          name: o.row.name,
          qty: o.qty,
          value: o.row.sellOrCurrent,
          cost: o.row.buyPrice,
          pnl: o.row.pnl,
        })),
    [allOptionSummaryRows],
  );

  /**
   * One row per holding, listed and unlisted together.
   *
   * A tagged union rather than two tables, which is how the client's own
   * Portfolio reads it: they answer the same question — what is held and what
   * is it worth — and splitting them left the reader adding two subtotals off
   * two different tabs to get one position.
   */
  type HoldingRow =
    | { kind: "listed"; position: Position }
    | { kind: "unlisted"; option: (typeof unlistedHoldings)[number] };

  const holdingRows = useMemo<HoldingRow[]>(() => {
    const rows: HoldingRow[] = [
      ...visiblePositions.map((p): HoldingRow => ({ kind: "listed", position: p })),
      ...unlistedHoldings.map((o): HoldingRow => ({ kind: "unlisted", option: o })),
    ];

    const q = holdSearch.trim().toLowerCase();
    if (!q) return rows;

    return rows.filter((r) => {
      const code = r.kind === "listed" ? r.position.code : r.option.code;
      const name = (r.kind === "listed" ? r.position.name : r.option.name) ?? "";
      return code.toLowerCase().includes(q) || name.toLowerCase().includes(q);
    });
  }, [visiblePositions, unlistedHoldings, holdSearch]);

  const paginatedHoldings = useMemo(() => {
    if (holdingsPageSize >= holdingRows.length) return holdingRows;
    const start = (holdingsPage - 1) * holdingsPageSize;
    return holdingRows.slice(start, start + holdingsPageSize);
  }, [holdingRows, holdingsPage, holdingsPageSize]);

  const filteredOptionRows = useMemo(
    () => filterOptionRows(allOptionSummaryRows, optionsTabFilter, optionsSearch),
    [allOptionSummaryRows, optionsTabFilter, optionsSearch],
  );

  const paginatedOptions = useMemo(() => {
    if (optionsPageSize >= filteredOptionRows.length) return filteredOptionRows;
    const start = (optionsPage - 1) * optionsPageSize;
    return filteredOptionRows.slice(start, start + optionsPageSize);
  }, [filteredOptionRows, optionsPage, optionsPageSize]);

  const filteredOptionTotal = useMemo(
    () => optionTotals(filteredOptionRows),
    [filteredOptionRows],
  );

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

  // Over everything the Holdings table lists — the grants are rows in it now,
  // so a footer that skipped them would total less than the rows above it.
  let tv = 0;
  let tc = 0;
  visiblePositions.forEach(p => {
    tv += posValue(p);
    tc += posCost(p);
  });
  unlistedHoldings.forEach((o) => {
    tv += o.value;
    tc += o.cost;
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
            <Logins logins={client.logins} />
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
            <div className="flex flex-wrap items-center justify-between gap-3">
              <b className="text-sm font-semibold text-ink">Portfolio</b>
              <div className="relative">
                <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-mut pointer-events-none" />
                <input
                  type="search"
                  value={holdSearch}
                  onChange={(e) => {
                    setHoldSearch(e.target.value);
                    setHoldingsPage(1);
                  }}
                  placeholder="Search ticker or name"
                  aria-label="Search holdings"
                  className="w-56 border border-line-2 bg-white rounded-[9px] pl-8.5 pr-3 py-1.5 text-xs focus:border-green focus:outline-none transition-colors"
                />
              </div>
            </div>
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
                {paginatedHoldings.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-center text-mut py-8">
                      {holdSearch.trim()
                        ? "Nothing matches that search."
                        : "No positions on record for this account."}
                    </td>
                  </tr>
                ) : (
                  paginatedHoldings.map((row, i) => {
                    // Position, not code: under All accounts the same security
                    // held in two accounts is two rows.
                    const rowKey = (code: string) =>
                      `${code}-${(holdingsPage - 1) * holdingsPageSize + i}`;

                    if (row.kind === "unlisted") {
                      const o = row.option;
                      const isUp = o.pnl >= 0;
                      // Derived, because the parcel is valued whole. Kept to four
                      // places: these are quoted in fractions of a cent, and
                      // $0.00 against a real value would look like a bug.
                      const perOption = o.qty > 0 ? o.value / o.qty : 0;
                      const perCost = o.qty > 0 ? o.cost / o.qty : 0;
                      return (
                        <tr key={rowKey(o.code)} className="hover:bg-paper-2/60 transition-colors">
                          <td className="px-4.5 py-3">
                            <span className="code font-mono px-1.5 py-0.5 rounded-[5px] bg-paper-2">{o.code}</span>
                          </td>
                          <td className="px-4.5 py-3 text-mut">
                            <span className="text-ink font-semibold">{o.name}</span>
                            <div className="text-[10px] mt-0.5">
                              Unlisted option &middot; carried at modelled value
                            </div>
                          </td>
                          <td className="px-4.5 py-3 text-right font-mono">{o.qty.toLocaleString("en-AU")}</td>
                          <td className="px-4.5 py-3 text-right font-mono text-mut">
                            ${perCost.toFixed(4)}
                          </td>
                          <td
                            className="px-4.5 py-3 text-right font-mono text-mut"
                            title="Modelled value per option — an unlisted grant has no market price of its own"
                          >
                            ${perOption.toFixed(4)}
                          </td>
                          <td className="px-4.5 py-3 text-right font-mono font-semibold">${money2(o.value)}</td>
                          <td className={`px-4.5 py-3 text-right font-mono ${isUp ? "text-gain" : "text-loss-d"}`}>
                            ${money2(o.pnl)}
                            {/* No percentage: a grant costs nothing, so a return
                                on cost is undefined rather than infinite. */}
                            {o.cost > 0 && (
                              <div className="text-[10px]">
                                {isUp ? "+" : ""}{((o.pnl / o.cost) * 100).toFixed(1)}%
                              </div>
                            )}
                          </td>
                          {/* No signal on a grant the desk does not trade. */}
                          <td className="px-4.5 py-3 text-center text-mut-d">&mdash;</td>
                        </tr>
                      );
                    }

                    const p = row.position;
                    const pl = posPL(p);
                    const cost = posCost(p);
                    // Free-carried options (placement attachers) have a zero cost
                    // base, so a percentage return is undefined — not infinite.
                    const plp = cost === 0 ? null : (pl / cost) * 100;
                    const isUp = pl >= 0;
                    const sg = signalsMap[p.code];
                    return (
                      <tr key={rowKey(p.code)} className="hover:bg-paper-2/60 transition-colors">
                        <td className="px-4.5 py-3"><span className="code font-mono px-1.5 py-0.5 rounded-[5px] bg-paper-2">{p.code}</span></td>
                        <td className="px-4.5 py-3 text-mut">
                          <span className="text-ink font-semibold">{p.name}</span>
                          <div className="text-[10px] mt-0.5">{p.sector ?? "—"}</div>
                        </td>
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
              {/* The Grand Total the P&L and Options tables have always had, and
                  this one did not. Taken over every position in scope, never
                  over the page — a footer that totalled 10 of 54 would be a
                  different number every time you paged.

                  UNREALISED, matching the column above it: today's market value
                  against what was paid, on positions still held. Realised P&L is
                  on the Historical P&L tab, where a sale has a date to sit on.

                  Quantities are not totalled — units of different companies are
                  not the same thing. */}
              {holdingRows.length > 0 && (
                <tfoot>
                  <tr className="border-t-2 border-line-2 bg-paper-2 font-bold">
                    <td className="px-4.5 py-3" colSpan={2}>
                      Grand Total
                      {paginatedHoldings.length !== holdingRows.length
                        ? ` (all ${holdingRows.length} holdings)`
                        : ""}
                    </td>
                    <td className="px-4.5 py-3" />
                    <td className="px-4.5 py-3" />
                    <td className="px-4.5 py-3" />
                    <td className="px-4.5 py-3 text-right font-mono">${money2(tv)}</td>
                    <td
                      className={`px-4.5 py-3 text-right font-mono ${tpl >= 0 ? "text-gain" : "text-loss-d"}`}
                    >
                      {tpl < 0 ? "-" : ""}${money2(Math.abs(tpl))}
                      <div className="text-[10px] font-normal">
                        {tpl >= 0 ? "+" : ""}
                        {tplp.toFixed(1)}%
                      </div>
                    </td>
                    <td className="px-4.5 py-3" />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <TablePagination
            totalItems={holdingRows.length}
            currentPage={holdingsPage}
            pageSize={holdingsPageSize}
            onPageChange={setHoldingsPage}
            onPageSizeChange={setHoldingsPageSize}
            pageSizeOptions={[5, 10, 25, 50]}
            itemLabel="holdings"
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
                  {filteredSummaryRows.length !== tableRows.length ? (
                    <>
                      <span className="font-semibold text-ink">{filteredSummaryRows.length}</span> of{" "}
                      {tableRows.length} row{tableRows.length === 1 ? "" : "s"}
                    </>
                  ) : (
                    <>
                      {tableRows.length} row{tableRows.length === 1 ? "" : "s"}
                    </>
                  )}{" "}
                  from {rangedTrades.length} settled trade
                  {rangedTrades.length === 1 ? "" : "s"}
                  {/* Only worth saying over all time: inside a period the
                      difference counts cancellations from outside it, which is
                      a number about a window the reader is not looking at. */}
                  {isAllTime && visibleTrades.length !== settledTrades.length &&
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

            {/* The period every figure below is taken over. All time is every
                stored row, open positions included — the desk's view of the
                whole book. Narrow it and only the sales inside the window
                remain, which is the one thing a date range can honestly
                describe: unrealised P&L is a cost base against today's price
                and belongs to no date. */}
            {lastSaleDate ? (
              <RealisedRangePicker
                range={range}
                firstSaleDate={firstSaleDate}
                lastSaleDate={lastSaleDate}
                onPick={pickRange}
                allTimeIncludesOpen
              />
            ) : (
              <div className="px-4.5 py-3 border-b border-line bg-paper-2/40 text-[11px] text-mut leading-relaxed select-none">
                Nothing has been sold from this client&rsquo;s accounts yet, so there is
                no period to choose between — the table below covers the whole book.
              </div>
            )}

            {/* Filter Tabs & Search Controls Bar */}
            <div className="px-4.5 py-3 border-b border-line bg-white space-y-2.5 select-none">
              {/* Full-width Segmented Filter Tabs */}
              <div className="w-full bg-paper-2 rounded-[10px] p-1 flex items-center gap-1 overflow-x-auto lg:overflow-visible flex-wrap sm:flex-nowrap border border-line/60">
                {PNL_FILTERS.map((f) => {
                  const active = pnlFilter === f;
                  const count = pnlTabCounts[f];
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
                      <span>{PNL_FILTER_LABELS[f]}</span>
                      <span
                        className={`text-[10.5px] font-mono px-1.5 py-0.5 rounded-[4px] font-semibold transition-colors ${active
                          ? f === "profit"
                            ? "bg-gain-bg text-gain"
                            : f === "loss"
                              ? "bg-loss-bg text-loss-d"
                              : f === "open"
                                ? "bg-amber-bg text-amber-d border border-amber/30"
                                : f === "matched"
                                  ? "bg-green-bg text-green-d border border-green/30"
                                  : "bg-paper-2 text-ink"
                          : f === "profit"
                            ? "bg-gain-bg/50 text-gain"
                            : f === "loss"
                              ? "bg-loss-bg/50 text-loss-d"
                              : f === "open"
                                ? "bg-amber-bg/50 text-amber-d"
                                : f === "matched"
                                  ? "bg-green-bg/50 text-green-d"
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
                  <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-mut pointer-events-none" />
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
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>

                {(pnlFilter !== "all" || pnlSearch) && (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-mut">
                      Showing <strong className="text-ink">{filteredSummaryRows.length}</strong> of {tableRows.length}
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
                      <X className="w-3 h-3 text-mut" />
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
                      {paginatedPnlRows.map((r) => {
                        // The account AND the ticker: under "All accounts" the
                        // ticker alone is shared by a row per account, which
                        // gave React duplicate keys and opened one click's
                        // editor on every one of them.
                        const rowId = pnlRowId(r);
                        return (
                        <PnlRow
                          // Remount when the editor opens or closes, so its
                          // inputs always re-seed from the values currently in
                          // force rather than whatever was typed last time.
                          key={`${rowId}:${editing === rowId}`}
                          row={r}
                          editing={editing === rowId}
                          onEdit={() => setEditing(rowId)}
                          onClose={() => setEditing(null)}
                          accountId={acctFilter === "all" ? null : acctFilter}
                          clientId={cid}
                          money2={money2}
                        />
                        );
                      })}

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
              {OPTION_FILTERS.map((t) => {
                const active = optionsTabFilter === t;
                const count = optionTabCounts[t];
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => {
                      setOptionsTabFilter(t);
                      setOptionsPage(1);
                    }}
                    className={`flex-1 flex items-center justify-center gap-2 px-3 py-1.75 rounded-[7px] text-xs cursor-pointer transition-all whitespace-nowrap ${
                      active
                        ? "bg-white text-ink font-semibold shadow-shadow border border-line/60"
                        : "text-mut hover:text-ink font-medium hover:bg-white/50"
                    }`}
                  >
                    <span>{OPTION_FILTER_LABELS[t]}</span>
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
                <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-mut pointer-events-none" />
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
                    <X className="w-3 h-3" />
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
                    <X className="w-3 h-3 text-mut" />
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
                          className={money.isExercisable ? "bg-green-bg/25 hover:bg-green-bg/40 transition-colors" : "hover:bg-paper-2/60 transition-colors"}
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
                                    : money.moneyness === "ATM"
                                      ? "Sitting on its strike — exercising today is worth nothing yet"
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
                              money.isExercisable ? "text-gain font-semibold" : "text-mut"
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
                      <tr key={`${p.id}-${bid.accountId ?? "x"}`} className="hover:bg-paper-2/60 transition-colors">
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
