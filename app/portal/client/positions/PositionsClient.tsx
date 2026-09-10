"use client";

import { useMemo, useState } from "react";
import { Search, X } from "lucide-react";
import type {
  AccountRow,
  Position,
  SignalRow,
  TradeRow,
  SecurityCommentaryRow,
} from "@/lib/data/queries";
import {
  posValue,
  posCost,
  posPL,
  realizedBetween,
  realizedByPeriod,
  attributeSells,
  monthsBack,
} from "@/lib/data/compute";
import {
  buildPnlSummaryCsv,
  grandTotal,
  pnlSummaryFilename,
  SUMMARY_HEADERS,
  type PnlSummaryRow,
} from "@/lib/export/order-history";
import { buildPnlSummaryXlsx } from "@/app/actions/exports";
// The row predicates, the filters and the option derivation are shared with the
// staff console, which shows these same three tables. That sharing is the point:
// a client and their adviser reading different numbers under the same heading is
// not a display bug, it is a conversation nobody can win.
import {
  isRowUnlistedOption,
  filterPnlRows,
  pnlFilterCounts,
  optionSummaryRows,
  filterOptionRows,
  optionFilterCounts,
  optionTotals,
  CLIENT_PNL_FILTERS,
  PNL_FILTER_LABELS,
  isRowOpen,
  OPTION_FILTERS,
  OPTION_FILTER_LABELS,
  type PnlFilter,
  type OptionFilter,
} from "@/lib/pnl/summary-rows";
import type { ClientSummary } from "@/lib/pnl/client-portfolio";
import type { LedgerLine } from "@/lib/import/trades";
import { MoneynessBadge, StrikeSpot } from "@/app/components/MoneynessBadge";
import { PnlRow } from "@/app/components/PnlRow";
import { RealizedPnlChart } from "@/app/components/RealizedPnlChart";
import { TablePagination } from "@/app/components/TablePagination";
import { TransactionsTable } from "./TransactionsTable";

const money0 = (n: number) => `$${Math.round(n).toLocaleString("en-AU")}`;
const qty0 = (n: number) => (n ? Math.round(n).toLocaleString("en-AU") : "—");

/**
 * Money to the cent, thousands-separated — no `$`, the callers add it.
 *
 * The rest of this page rounds to the dollar, which is right for a portfolio
 * headline. The Historical P&L and Options tables do NOT: they show settled
 * cash amounts from contract notes, and a $3,634.80 sale must not read as
 * $3,635 on the client's screen while their adviser's screen shows the cents.
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
 * A return as a percentage of cost, or null when there is no cost to divide by.
 *
 * Free placement options have a cost base of zero, so `pl / cost` was `Infinity`
 * — and `0 / 0` was `NaN`. Both reached the screen: the Top movers table read
 * `+Infinity%` on three rows and `+NaN%` on a fourth, and because it SORTED by
 * that percentage the infinities took every top slot, so the one thing the table
 * exists to show was pushed off it entirely.
 */
const returnPct = (pl: number, cost: number): number | null =>
  cost > 0 && Number.isFinite(pl / cost) ? (pl / cost) * 100 : null;

const pct1 = (n: number | null) => (n === null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`);


/** The presets, in the order they read: shortest window first. */
const RANGE_PRESETS: { label: string; months: number }[] = [
  { label: "3M", months: 3 },
  { label: "6M", months: 6 },
  { label: "1Y", months: 12 },
  { label: "3Y", months: 36 },
];

export function PositionsClient({
  accounts,
  activeAccountId,
  positions,
  signals,
  summaryByScope,
  offLedgerByScope,
  trades,
  commentary,
}: {
  /** Every account this client holds — what the account filter offers. */
  accounts: AccountRow[];
  /**
   * The account the portal header's own switcher is on.
   *
   * Seeds the filter below, so the page opens agreeing with the "Viewing
   * &lt;account&gt;" line above it rather than on a total the header does not
   * claim. From then on the two are independent: the filter can widen to All
   * accounts, which the header switcher deliberately cannot offer — every other
   * client page is scoped to exactly one account.
   */
  activeAccountId: string;
  /** The client's whole book, at account grain. Filtered here, not fetched so. */
  positions: Position[];
  signals: Record<string, SignalRow>;
  /**
   * The desk's own stored P&L rows, one set per account plus `all`.
   *
   * Pre-scoped on the server because a desk correction is stored per account
   * and is resolved while the row is built — see the page for why filtering
   * finished rows would apply one account's correction to another's figures.
   */
  summaryByScope: Record<string, ClientSummary>;
  /**
   * Per scope, the purchases the contract-note ledger never recorded — chiefly
   * placement parcels, which reach the client as a sale with no matching buy.
   *
   * Replayed alongside the ledger so those sales are costed instead of being
   * reported as pure profit and flagged "cost base not on file". Recovered on
   * the server, from the pre-override stored figures; see the page and
   * lib/pnl/off-ledger-buys.ts.
   */
  offLedgerByScope: Record<string, LedgerLine[]>;
  /**
   * The contract-note ledger. The dated realised window, the by-month chart and
   * the Bought / Sold / Fees totals are all replayed from it in the browser, at
   * whatever account scope is selected — which is exactly what the staff console
   * does with the same rows, through the same `attributeSells`.
   */
  trades: TradeRow[];
  /**
   * This week's note per security, in both framings. Which one a holder is
   * shown depends on the sign of their own P&L on that holding — the note is
   * one market read, not two opinions.
   */
  commentary: Record<string, SecurityCommentaryRow>;
}) {
  const [tab, setTab] = useState<
    "holdings" | "historical" | "options" | "transactions"
  >("holdings");
  const [selectedHolding, setSelectedHolding] = useState<string | null>(null);

  /**
   * Which account the figures cover: `all`, or one of them.
   *
   * Seeded from the portal header's switcher so the page agrees with it on
   * load. Only rendered — and only meaningful — where there is more than one
   * account, which is also the only case the server builds per-account scopes
   * for: a single-account client falls through to `all`, which for them IS that
   * one account.
   */
  const [acctFilter, setAcctFilter] = useState<string>(() =>
    accounts.length > 1 && activeAccountId ? activeAccountId : "all",
  );

  // Search + paging per table. A client with a long history has hundreds of P&L
  // lines — one tested account has 334 — and scrolling is not a way to find a
  // ticker in that.
  const [holdSearch, setHoldSearch] = useState("");
  const [holdPage, setHoldPage] = useState(1);
  const [holdSize, setHoldSize] = useState(25);
  const [pnlSearch, setPnlSearch] = useState("");
  const [pnlFilter, setPnlFilter] = useState<PnlFilter>("all");
  const [pnlPage, setPnlPage] = useState(1);
  const [pnlSize, setPnlSize] = useState(25);
  const [optionsSearch, setOptionsSearch] = useState("");
  const [optionsFilter, setOptionsFilter] = useState<OptionFilter>("all");
  const [optionsPage, setOptionsPage] = useState(1);
  const [optionsSize, setOptionsSize] = useState(25);

  /**
   * Everything the account filter decides, in one place.
   *
   * `inAcct` is the same test the staff console uses, and the four collections
   * below are the same four it derives from it. Positions, options and trades
   * each state their own account so they are filtered here; the P&L summary
   * rows arrive already scoped (see the props).
   */
  const scoped = summaryByScope[acctFilter] ?? summaryByScope.all;
  const summaryRows = scoped.rows;

  /** What the KPI strip says its figures cover, in words. */
  const scopeLabel =
    acctFilter === "all"
      ? accounts.length > 1
        ? "all accounts"
        : "your account"
      : (accounts.find((a) => a.id === acctFilter)?.label ?? "this account");

  // Compared inline rather than through a shared `inAcct(id)` helper: a closure
  // over `acctFilter` is invisible to the dependency linter, so each of these
  // would need its rule silenced to say what the array already says.
  const visiblePositions = useMemo(
    () =>
      acctFilter === "all"
        ? positions
        : positions.filter((p) => p.accountId === acctFilter),
    [positions, acctFilter],
  );
  const visibleTrades = useMemo(
    () =>
      acctFilter === "all"
        ? trades
        : trades.filter((t) => t.accountId === acctFilter),
    [trades, acctFilter],
  );

  const changeAccount = (id: string) => {
    setAcctFilter(id);
    setHoldPage(1);
    setPnlPage(1);
    setOptionsPage(1);
    setPnlSearch("");
    setPnlFilter("all");
    setOptionsSearch("");
    setOptionsFilter("all");
    // Back to "derived", so the dated window follows the new account's own sale
    // history instead of keeping a range taken over the previous account's.
    setRange(null);
  };

  /**
   * The positions the ANALYTICS tab reads, which is the active account's —
   * unchanged from when this page fetched only that account.
   *
   * Analytics deliberately sits outside the account filter: its asset-allocation
   * and top-movers cards are about one account's current book, its P&L split is
   * about the whole client, and it says so on each card. The filter row is
   * hidden while that tab is open rather than left showing over figures it does
   * not move.
   */

  /**
   * Every sale, with the date its money was realised on.
   *
   * Replayed in the browser through the importer's own cost-basis walk, at
   * whatever account scope is selected — the same call the staff console makes
   * on the same rows. It used to be done on the server and shipped
   * pre-attributed, which was cheaper but can no longer answer the question:
   * cost basis is attributed per scope, so an account filter changes the
   * arithmetic and not just which rows survive it.
   *
   * The recovered off-ledger purchases go in alongside the ledger, so a
   * placement's sale is costed rather than booked as pure profit.
   */
  const sells = useMemo(
    () =>
      attributeSells(
        visibleTrades,
        offLedgerByScope[acctFilter] ?? offLedgerByScope.all ?? [],
      ),
    [visibleTrades, offLedgerByScope, acctFilter],
  );

  /**
   * The realised-P&L window.
   *
   * `to` defaults to the last day anything was actually sold rather than to
   * today. An account whose last sale was in June would otherwise open on a
   * range ending today, and every preset inside it would read $0 — a screen
   * that looks broken to the one client it matters most to. Where there are no
   * sales at all the card says so instead of drawing a picker over nothing.
   */
  const lastSaleDate = useMemo(
    () => sells.reduce((latest, s) => (s.tradeDate > latest ? s.tradeDate : latest), ""),
    [sells],
  );
  const firstSaleDate = useMemo(
    () =>
      sells.reduce(
        (earliest, s) => (!earliest || s.tradeDate < earliest ? s.tradeDate : earliest),
        "",
      ),
    [sells],
  );

  /** Every sale on file — what "All time" means, and the pickers' own bounds. */
  const defaultRange = useMemo(
    () => ({ from: firstSaleDate, to: lastSaleDate }),
    [firstSaleDate, lastSaleDate],
  );

  /**
   * The picked range, or `null` for ALL TIME.
   *
   * Nullable rather than two seeded strings, and that carries two facts at once.
   *
   * Seeded state does not re-seed, so with the account filter alongside it, two
   * strings left the pickers pinned to the previous account's sale history — a
   * range whose own `min`/`max` no longer contained it, reading $0 realised over
   * a window the client never chose. `null` follows the scope instead.
   *
   * And `null` is what the table reads to decide WHAT it is showing: all time is
   * every parcel the client has ever held, sold or not, which is the reference
   * view. A narrower range can only describe money that actually changed hands,
   * so the table switches to realised sales — see `tableRows`.
   */
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const isAllTime = range === null;
  const rangeFrom = range?.from ?? defaultRange.from;
  const rangeTo = range?.to ?? defaultRange.to;

  const deltaByTicker = useMemo(
    () => new Map(scoped.overrideDeltas),
    [scoped.overrideDeltas],
  );
  const window_ = useMemo(
    () =>
      rangeFrom && rangeTo
        ? realizedBetween(sells, rangeFrom, rangeTo, deltaByTicker)
        : null,
    [sells, rangeFrom, rangeTo, deltaByTicker],
  );

  /** Which preset, if any, the current range corresponds to — for the pills. */
  const activePreset = useMemo(() => {
    // All time has its own pill. Without this guard a client whose sale history
    // happens to be almost exactly a year long would see both it and `1Y` lit,
    // which is two answers to "what am I looking at".
    if (isAllTime || !lastSaleDate || rangeTo !== lastSaleDate) return null;
    return (
      RANGE_PRESETS.find((p) => monthsBack(lastSaleDate, p.months).from === rangeFrom)
        ?.label ?? null
    );
  }, [isAllTime, lastSaleDate, rangeFrom, rangeTo]);

  /**
   * Changing the period changes WHICH TABLE is on screen — all-time parcels, or
   * the sales inside a window — so the filter and the page number go back to
   * the start with it. A `Matched` pill carried into a realised view would
   * match nothing and read as an empty account.
   */
  const pickRange = (next: { from: string; to: string } | null) => {
    setRange(next);
    setPnlFilter("all");
    setPnlPage(1);
  };

  const pickPreset = (months: number) => {
    if (!lastSaleDate) return;
    pickRange(monthsBack(lastSaleDate, months));
  };

  /** Back to `null`, which is All time AND the table's reference view. */
  const pickAllTime = () => pickRange(null);

  // Custom states for trade execution inside modal
  const [isTradeModalOpen, setIsTradeModalOpen] = useState(false);
  const [tradeAction, setTradeAction] = useState<"Buy" | "Sell">("Buy");
  const [tradeAmount, setTradeAmount] = useState("10,000");

  // Cash and market value, following the account filter. The `active*` pair
  // beside these belonged to Analytics, which has moved to Home.
  const scopedCash =
    acctFilter === "all"
      ? accounts.reduce((sum, a) => sum + a.cash, 0)
      : (accounts.find((a) => a.id === acctFilter)?.cash ?? 0);

  // Market value of what is held right now. Cost base and P&L deliberately do
  // NOT come from here — see below.
  const scopedTv = visiblePositions.reduce((sum, p) => sum + posValue(p), 0);

  // The desk's stored figures, at the selected scope. Cost base and P&L come
  // from here rather than from `scopedTv` above, so this page and the adviser's
  // screen cannot report different returns on the same holdings.
  const deskCost = scoped.total.buyPrice;
  const deskPnl = scoped.total.pnl;
  const deskPnlPct = deskCost > 0 ? (deskPnl / deskCost) * 100 : 0;

  // ── The Historical P&L tab's own derivations ───────────────────────────────
  //
  // Every one of them is the staff console's, on the same rows: the ledger
  // totals, the filtered table, and the by-month chart the corrections are
  // folded into. Nothing here is a second way of working the numbers out — that
  // is the whole point of the tab. What is different is the date range, which
  // every figure on the tab now follows.

  // Settled trades are the only ones that moved money; the rest are shown in
  // the count for completeness but excluded from every total.
  const settledTrades = useMemo(
    () => visibleTrades.filter((t) => t.status === "SETTLED"),
    [visibleTrades],
  );

  /**
   * The trades inside the selected range, which is what the tiles count.
   *
   * All time is not special-cased: the range then spans every sale on file, and
   * a purchase older than the first sale is deliberately still counted — it is
   * money the client did spend, and "Bought" that silently omitted the oldest
   * parcels would not tie to anything.
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
   * Realised P&L over the range.
   *
   * NOT sold − bought: most of what was bought is still held, so the two are
   * not comparable. It comes from the replay, which is also what the chart and
   * the realised table below read — one number, three renderings.
   *
   * The stored `realized_pnl` rollup is deliberately not used here even for All
   * time. It is the importer's replay of the contract-note ledger alone, so it
   * carries the same placement gap this page now corrects for; reading it would
   * put a figure on the tile that the table underneath contradicts.
   */
  const realizedTotal = window_?.realizedPl ?? 0;

  /**
   * The sales in the range, as table rows.
   *
   * A date range can only describe money that changed hands, so this is what
   * the table shows once one is picked. Built into the same `PnlSummaryRow`
   * shape the all-time rows use, so ONE table body renders both and the two
   * views cannot drift into looking like different tables.
   *
   * ── The row is the INSTRUMENT, and it carries its classification across ────
   * It used to be keyed on `c.parent`, which folded an option into its
   * ordinary: `OD6O`'s sale landed on a row labelled `OD6` wearing the option's
   * company name, and every option line the all-time view lists disappeared.
   * The window now groups per instrument (see `realizedBetween`), and each row
   * inherits the stored row's own flags so the filter bar means the same thing
   * in both views — an option is still an option inside a date range.
   *
   * `buyQty` is the units CLOSED, which the FIFO consumed to make this sale, so
   * the column is populated rather than reading "—". It is deliberately not
   * "units bought in the window": the parcel was acquired earlier, quite
   * possibly outside the range, and claiming otherwise would invite the reader
   * to check it against a purchase that is not on screen.
   */
  const realisedRows: PnlSummaryRow[] = useMemo(() => {
    if (!window_) return [];

    const storedBy = new Map(summaryRows.map((r) => [r.ticker, r]));

    return window_.contributors.map((c) => {
      const stored = storedBy.get(c.code) ?? storedBy.get(c.parent);
      return {
      ticker: c.code,
      name: stored?.name ?? c.code,
      buyQty: c.units,
      sellQty: c.units,
      heldQty: 0,
      buyPrice: c.costOfSold,
      sellOrCurrent: c.proceeds,
      pnl: c.realizedPl,
      // Taken from the stored row rather than forced false: a part-sold parcel
      // realised money inside the window AND is still held, and the Open pill
      // has to be able to say so in a range exactly as it does over all time.
      openPosition: Boolean(stored?.openPosition),
      isOption: stored?.isOption,
      isUnlistedOption: stored?.isUnlistedOption,
      // The status column reads "Closed" off these — which is the truth about a
      // sale — and the cost warning travels in the wording instead.
      //
      // A FREE GRANT is not a warning. The firm's treatment puts a placement's
      // whole cost on the shares and none on the attaching options, so a $0
      // cost there is the answer rather than a gap — 187 such sales worth
      // $255,139 were reading "cost base not on file" in red, sending the
      // reader to look for something that was never missing.
      type: c.freeGrant
        ? "Realised · free grant"
        : c.noCostBasis
          ? "Realised · cost base not on file"
          : "Realised",
      flagged: c.noCostBasis && !c.freeGrant,
      edited: false,
      overridden: {
        buyQty: false,
        sellQty: false,
        buyPrice: false,
        sellOrCurrent: false,
      },
      note: null,
      computed: {
        buyQty: c.units,
        sellQty: c.units,
        buyPrice: c.costOfSold,
        sellOrCurrent: c.proceeds,
        pnl: c.realizedPl,
      },
      };
    });
  }, [window_, summaryRows]);

  /**
   * All-time rows, MINUS the parcels that are purely open.
   *
   * A position the client still holds in full is already on the Holdings table
   * directly above this one, with its market value and its unrealised move. It
   * was here too, so the same holding was stated twice on one screen under two
   * headings — and this table is called Historical P&L, which a live holding is
   * not.
   *
   * ── Why not simply the Open flag ────────────────────────────────────────────
   * `isRowOpen` is true for a PARTIAL exit as well: 10,000 bought, 4,000 sold,
   * 6,000 still held. Those rows carry realised money — measured across the
   * stored rows, dropping every open row would have taken **$18,029 of realised
   * P&L** off the table with them, which is the kind of quiet subtraction this
   * screen must never do. So the test is "did anything actually sell".
   *
   * ── And why `sellQty > 0` alone is not that test ─────────────────────────────
   * A **DB-only** row has no ledger history at all — measured, all 56 of them
   * carry `trade_count = 0` — and for an OPTION the merge sets *both* legs from
   * the one held count, because "an option's two legs are set from one count and
   * it holds nothing separate" (`stored-pnl.ts`). So `sellQty` on those rows is
   * a held quantity wearing a sold column, and reading it as a sale kept 50 free
   * grants worth **$24,841 of unrealised value** on a table headed Historical
   * P&L — while the snapshot says the client still holds every one of them.
   *
   * That is what `hasRealised` is for: a row has realised money only if the
   * LEDGER sold something. A db-only row never did, whatever its columns say.
   */
  const closedOrPartlySold = useMemo(() => {
    const hasRealised = (r: PnlSummaryRow) => !r.isDbOnly && r.sellQty > 0;
    return summaryRows.filter((r) => hasRealised(r) || !isRowOpen(r));
  }, [summaryRows]);

  /** All time is every parcel that has sold something; a range is the sales in it. */
  const tableRows = isAllTime ? closedOrPartlySold : realisedRows;

  /**
   * The same pills in both views, which they were not.
   *
   * A range used to offer only All / Profit / Loss, on the reasoning that Open
   * and Options "describe the STATE of a position" and every row in a realised
   * view is a completed sale. Half of that was true and the conclusion was
   * wrong: a realised row IS still an option or an equity, and a part-sold
   * parcel IS still open. Dropping the pills meant picking a date range changed
   * the table's columns AND its filter bar at once, so the same figures looked
   * like a different screen — and there was no way at all to see options inside
   * a period.
   *
   * Now every row carries the stored row's classification (see `realisedRows`),
   * so each pill answers the same question it answers over all time. `Unlisted
   * Options` will read zero in most ranges, and that is honest rather than
   * broken: a free grant is never sold, so no window can realise one.
   */
  const activeFilters = CLIENT_PNL_FILTERS;

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
   * The over-time chart, on the same range as everything else on the tab.
   *
   * The bucket width is the bucketer's call, not the picker's: a range up to a
   * year is drawn in months, up to three years in quarters, longer in years —
   * so the column count stays near a dozen at every range this picker offers
   * and the axis labels never have to be thinned to fit.
   *
   * A desk correction carries no date of its own, so each corrected company's
   * delta is handed to the bucketer to spread across that company's sale
   * months. Without it a corrected row would move the table's total and leave
   * the chart behind — two figures on one screen, disagreeing.
   */
  const chartPeriods = useMemo(() => {
    const inRange = isAllTime
      ? sells
      : sells.filter((s) => s.tradeDate >= rangeFrom && s.tradeDate <= rangeTo);
    return realizedByPeriod(inRange, deltaByTicker);
  }, [sells, isAllTime, rangeFrom, rangeTo, deltaByTicker]);

  // ── The Options tab, through the shared derivation ─────────────────────────
  const allOptionRows = useMemo(
    () => optionSummaryRows(summaryRows),
    [summaryRows],
  );
  const optionTabCounts = useMemo(
    () => optionFilterCounts(allOptionRows),
    [allOptionRows],
  );
  const filteredOptionRows = useMemo(
    () => filterOptionRows(allOptionRows, optionsFilter, optionsSearch),
    [allOptionRows, optionsFilter, optionsSearch],
  );
  const filteredOptionTotal = useMemo(
    () => optionTotals(filteredOptionRows),
    [filteredOptionRows],
  );

  /**
   * Exports, which are the two the desk has: the CSV for the data and the .xlsx
   * for the colour-coded copy, since plain CSV cannot carry a fill.
   *
   * Both are built from `filteredSummaryRows` — the array the table itself
   * renders — so the file always matches the screen, filter and search
   * included. Recalculate and Preview CSV are deliberately NOT here: rebuilding
   * the firm's stored figures is the desk's call, and `recalculateClientPnl`
   * would refuse a client anyway.
   */
  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportName = (ext: "csv" | "xlsx") =>
    pnlSummaryFilename(
      "My portfolio",
      acctFilter === "all"
        ? null
        : (accounts.find((a) => a.id === acctFilter)?.label ?? null),
      new Date().toISOString().slice(0, 10),
      ext,
    );

  const exportCsv = () =>
    // The BOM makes Excel read the text as UTF-8 rather than the local
    // codepage, which otherwise mangles non-ASCII company names.
    downloadBlob(
      new Blob(["﻿", buildPnlSummaryCsv(filteredSummaryRows)], {
        type: "text/csv;charset=utf-8",
      }),
      exportName("csv"),
    );

  // The workbook is built by a server action (ExcelJS stays out of the client
  // bundle), so this one is async and the button reflects that.
  const [exporting, setExporting] = useState(false);
  const exportExcel = async () => {
    setExporting(true);
    try {
      const base64 = await buildPnlSummaryXlsx(
        filteredSummaryRows,
        "My portfolio — P&L summary",
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

  const handleOpenHolding = (code: string) => {
    setSelectedHolding(code);
  };

  const handleCloseHolding = () => {
    setSelectedHolding(null);
  };

  const getActionPill = (action: string) => {
    const maps: Record<string, string> = {
      Add: "bg-green-bg text-green-d",
      Hold: "bg-paper-2 text-mut",
      Trim: "bg-amber-bg text-amber-d",
      "Take profit": "bg-amber-bg text-amber-d",
      Watch: "bg-[#ece9f3] text-[#5c5775]"
    };
    return (
      <span className={`pill px-2.5 py-0.5 rounded-full text-[11.5px] font-semibold tracking-wide ${maps[action] || "bg-paper-2 text-mut"}`}>
        {action}
      </span>
    );
  };

  // Run calculation for trade amount
  const tradeCalculatedShares = () => {
    const raw = tradeAmount.replace(/[^0-9]/g, "");
    const amt = raw ? parseInt(raw, 10) : 0;
    const p = positions.find(pos => pos.code === selectedHolding);
    if (!p || !p.last) return 0;
    return Math.round(amt / p.last);
  };

  const executeTradeOrder = () => {
    const p = positions.find(pos => pos.code === selectedHolding);
    if (!p) return;
    const raw = tradeAmount.replace(/[^0-9]/g, "");
    const amt = raw ? parseInt(raw, 10) : 0;
    if (!amt) return;

    // Simulate ordering (in reality we would mutate the DB, but since we are doing standard controlled simulation we can alert and log)
    alert(`Order placed: ${tradeAction === "Buy" ? "Buy" : "Sell"} ${tradeAction === "Buy" ? "$" : ""}${amt.toLocaleString("en-AU")} of ${selectedHolding} routed to the Vitti desk.`);

    setIsTradeModalOpen(false);
    handleCloseHolding();
  };

  // Render analytics view
  /**
   * The desk's own P&L table, for this client.
   *
   * Same rows, same rollup and same corrections as the staff console — see
   * lib/pnl/client-portfolio.ts — minus the desk's working notes. Sorted by
   * absolute P&L so the positions that moved the total are at the top, which is
   * the order somebody reads their own return in.
   */
  /**
   * The unlisted option grants, as holdings.
   *
   * ── Why they belong in this table ──────────────────────────────────────────
   * They were missing from it, and that made the Holdings tab disagree with the
   * client's own P&L: a free placement grant is a real, valued position — the
   * recompute prices it and the Historical P&L tab counts its result — but it
   * has no contract note and no line in the broker's holdings snapshot, which
   * is the only thing this table used to read. So a client could see a gain in
   * their P&L with nothing in Holdings to explain it.
   *
   * They cannot come from `option_holdings`: that table has never held a row —
   * it was demo-seed data, and nothing in the import or the tracker pipeline
   * writes it. The grants live in the stored P&L rows, which is where the
   * Options tab reads them from too, through the same `optionSummaryRows` call.
   *
   * ── What a "last price" means for one ──────────────────────────────────────
   * `sellOrCurrent` is a VALUE for the whole parcel, so the per-option figure is
   * derived rather than read. It is a modelled price, not a market one — nothing
   * quotes these — which is why the row says so on its face.
   */
  const unlistedHoldings = useMemo(
    () =>
      allOptionRows
        .filter((o) => isRowUnlistedOption(o.row))
        .map((o) => ({
          code: o.row.ticker,
          name: o.row.name,
          qty: o.qty,
          value: o.row.sellOrCurrent,
          cost: o.row.buyPrice,
          pnl: o.row.pnl,
        })),
    [allOptionRows],
  );

  /** What the unlisted grants in scope are carried at, all in. */
  const unlistedScopedValue = unlistedHoldings.reduce((s, o) => s + o.value, 0);

  /**
   * The Holdings table's footer.
   *
   * Taken over everything in scope, never over the page or the search result —
   * the same rule the P&L table's Grand Total follows, and for the same reason:
   * a footer that silently totalled 25 of 334 rows would be a different number
   * every time you paged.
   *
   * `pnl` here is UNREALISED, because that is what the column above it is:
   * today's value against what was paid, on positions still held. Realised P&L
   * belongs to sales and lives on the Historical P&L tab, where it can be dated.
   * Summing the two under one heading would add a figure that has settled to one
   * that moves with the market.
   *
   * Quantities are deliberately not totalled: units of different companies are
   * not the same thing.
   */
  const holdingsTotal = useMemo(() => {
    const value =
      visiblePositions.reduce((s, p) => s + posValue(p), 0) +
      unlistedHoldings.reduce((s, o) => s + o.value, 0);
    const cost =
      visiblePositions.reduce((s, p) => s + posCost(p), 0) +
      unlistedHoldings.reduce((s, o) => s + o.cost, 0);
    return { value, cost, pnl: value - cost };
  }, [visiblePositions, unlistedHoldings]);

  /**
   * One row per holding, listed and unlisted together.
   *
   * A tagged union rather than two tables: they answer the same question — what
   * do I hold and what is it worth — and splitting them would leave the reader
   * adding two subtotals to get their own position.
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

  /**
   * The period every figure on the Historical P&L tab is taken over.
   *
   * ── Why it lives on the table rather than in a card of its own ────────────
   * It used to drive a separate "Realised over a period" card, whose own
   * contributors table listed holding, units sold, cost, proceeds and P&L —
   * which is the same five things the P&L-by-company table underneath it was
   * already listing. Two tables of the same shape, one screen, and the reader
   * had to work out which one answered their question. There is one table now,
   * and this says what it covers.
   *
   * ── What the range can and cannot mean ────────────────────────────────────
   * Captioned as REALISED, never as "your return over this period". A date range
   * can only describe money that actually changed hands: unrealised P&L is a
   * cost base against today's price, it belongs to no date, and there is no
   * price history here to value a holding as at an earlier one. Labelling this
   * as a period return would be the wrong number with no way to tell.
   *
   * That is also why All time is a distinct state rather than the widest range:
   * over all time the table shows every parcel that has sold anything, in full
   * or in part, which is the reference view. Narrow it and only the sales inside
   * the window remain.
   *
   * Parcels still held IN FULL are on Holdings and not here — they were on both,
   * which stated one holding twice on one screen, and a live position is not
   * "historical P&L". Part-sold parcels stay: their realised half is the point.
   */
  const renderRangeBar = () => {
    const dateStr = (iso: string) =>
      new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-AU", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      });

    // No sales at all: there is nothing a range could narrow, so the controls
    // are replaced by the reason rather than drawn over nothing.
    if (!lastSaleDate) {
      return (
        <div className="px-4.5 py-3 border-b border-line bg-paper-2/40 text-[11px] text-mut leading-relaxed select-none">
          Nothing has been sold from your accounts yet, so there is no period to
          choose between — the table below covers everything you hold.
        </div>
      );
    }

    return (
      <div className="px-4.5 py-3 border-b border-line bg-paper-2/40 space-y-2.5 select-none">
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              onClick={pickAllTime}
              className={`text-[11.5px] font-semibold px-2.5 py-1.5 rounded-[7px] cursor-pointer transition-colors ${
                isAllTime ? "bg-navy text-white" : "bg-white border border-line text-mut hover:text-ink"
              }`}
            >
              All time
            </button>
            {RANGE_PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => pickPreset(p.months)}
                className={`text-[11.5px] font-semibold px-2.5 py-1.5 rounded-[7px] cursor-pointer transition-colors ${
                  activePreset === p.label
                    ? "bg-navy text-white"
                    : "bg-white border border-line text-mut hover:text-ink"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* `min`/`max` are pinned to the sale history, so the range cannot be
              dragged somewhere there was never anything to realise. */}
          <div className="flex items-end gap-3">
            <div className="space-y-1">
              <label
                htmlFor="pnl-from"
                className="block text-[10px] font-semibold uppercase tracking-wider text-mut"
              >
                From
              </label>
              <input
                id="pnl-from"
                type="date"
                value={rangeFrom}
                min={firstSaleDate}
                max={lastSaleDate}
                onChange={(e) => pickRange({ from: e.target.value, to: rangeTo })}
                className="border border-line-2 bg-white rounded-[8px] px-2.5 py-1.5 text-[11.5px] font-mono focus:border-green focus:outline-none"
              />
            </div>
            <div className="space-y-1">
              <label
                htmlFor="pnl-to"
                className="block text-[10px] font-semibold uppercase tracking-wider text-mut"
              >
                To
              </label>
              <input
                id="pnl-to"
                type="date"
                value={rangeTo}
                min={firstSaleDate}
                max={lastSaleDate}
                onChange={(e) => pickRange({ from: rangeFrom, to: e.target.value })}
                className="border border-line-2 bg-white rounded-[8px] px-2.5 py-1.5 text-[11.5px] font-mono focus:border-green focus:outline-none"
              />
            </div>
          </div>
        </div>

        <p className="text-[11px] text-mut leading-normal">
          {isAllTime ? (
            <>
              Every parcel that has sold, in full or in part. Sales run{" "}
              {dateStr(firstSaleDate)} – {dateStr(lastSaleDate)} — narrow the
              period to see just what was <b>realised</b> in it. Positions you
              still hold — shares and option grants alike — are on{" "}
              <b>Holdings</b> above, not here.
            </>
          ) : (
            <>
              Showing what was <b>realised</b> between {dateStr(rangeFrom)} and{" "}
              {dateStr(rangeTo)}. Holdings you still own are not in these figures.
            </>
          )}
        </p>
      </div>
    );
  };

  /**
   * This week's note about one holding.
   *
   * ── Which of the two framings ───────────────────────────────────────────────
   * Chosen by the sign of the client's own unrealised P&L on the position, which
   * is the only thing that differs between two clients holding the same stock.
   * The market read underneath is identical for both, deliberately — see the
   * 20260904100000 migration.
   *
   * ── Labelled as general information, and dated ─────────────────────────────
   * The note is written from market conditions and the client's own figures,
   * not from their objectives or circumstances, so it is general information and
   * says so. It is also stamped with the week it was written: a note that
   * describes "this week" without saying which week is a note that quietly goes
   * stale, and the reader has no way to tell.
   */
  const renderCommentary = (position: Position) => {
    const note = commentary[position.code];
    if (!note) return null;

    const pl = posPL(position);
    // Flat counts as ahead: the note for a holder who is level reads as "what
    // to watch from here", which is right, where the loss framing would be
    // explaining a fall that has not happened.
    const text = pl < 0 ? note.lossNote : note.profitNote;

    const weekLabel = new Date(`${note.weekOf}T00:00:00Z`).toLocaleDateString("en-AU", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });

    return (
      <div className="rounded-[10px] border border-line bg-paper-2/50 p-3.5 space-y-2">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <b className="text-[12.5px] font-semibold text-ink">
            {pl < 0 ? "What has been weighing on this" : "Where this stands"}
          </b>
          <span className="text-[10px] font-mono text-mut whitespace-nowrap">
            week to {weekLabel}
          </span>
        </div>

        <p className="text-xs text-mut leading-relaxed">{text}</p>

        {note.sources.length > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 pt-0.5">
            {/* A market claim nobody can check is not worth showing a client. */}
            {note.sources.slice(0, 3).map((src) => (
              <a
                key={src.url}
                href={src.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10.5px] text-mut underline decoration-dotted hover:text-ink truncate max-w-45"
                title={src.title}
              >
                {src.title}
              </a>
            ))}
          </div>
        )}

        <p className="text-[10px] text-mut-d leading-normal">
          General information about the market, not personal advice. It does not take your
          objectives or circumstances into account.
          {note.editedBy ? ` Written by ${note.editedBy}.` : " Updated weekly."}
        </p>
      </div>
    );
  };


  /**
   * Historical P&L — the desk's own tab, on the client's own rows.
   *
   * Reads top to bottom the way the question is actually asked: what did I make
   * recently (the dated window), then how has realised profit arrived over time
   * (the chart), then the parcel-by-parcel reference the first two can be
   * checked against.
   *
   * ── What the desk has here and a client does not ────────────────────────────
   * Recalculate and Preview CSV are absent: rebuilding the firm's stored figures
   * is the desk's call, and `recalculateClientPnl` refuses a non-staff caller in
   * any case. So is the "Calculated <time>" stamp and the run's warnings — those
   * describe the state of OUR pipeline, and a client cannot act on the news that
   * a recompute is queued. What the age of a figure actually costs them is
   * already said in the words that matter: a line whose cost base is still being
   * confirmed says so, at the bottom of the table.
   *
   * The rows themselves are the desk's, rendered `readOnly` — same columns, same
   * status pills, same colours, no way into the override editor and none of the
   * working notes behind it. See lib/pnl/client-portfolio.ts.
   */
  const renderHistoricalPnl = () => {
    const page = filteredSummaryRows.slice(
      (pnlPage - 1) * pnlSize,
      (pnlPage - 1) * pnlSize + pnlSize,
    );

    return (
      <div className="space-y-4">
        {/* Ledger totals, over whatever period the table is showing. Realised
            P&L is NOT sold − bought: most of what was bought is still held, so
            the two are not comparable. It comes from the replayed cost basis. */}
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

        <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
          <div className="px-4.5 py-3.5 border-b border-line bg-white select-none flex flex-col md:flex-row md:items-baseline justify-between gap-3">
            <div>
              <b className="text-sm font-semibold text-ink">P&amp;L by company</b>
              <div className="text-[11px] text-mut mt-0.5">
                {filteredSummaryRows.length !== tableRows.length ? (
                  <>
                    <span className="font-semibold text-ink">
                      {filteredSummaryRows.length}
                    </span>{" "}
                    of {tableRows.length} row
                    {tableRows.length === 1 ? "" : "s"}
                  </>
                ) : (
                  <>
                    {tableRows.length} row{tableRows.length === 1 ? "" : "s"}
                  </>
                )}{" "}
                from {rangedTrades.length} settled trade
                {rangedTrades.length === 1 ? "" : "s"}
                {isAllTime && visibleTrades.length !== settledTrades.length &&
                  ` · ${visibleTrades.length - settledTrades.length} cancelled/reversed excluded`}
                {" · downloads match this table exactly"}
              </div>
            </div>
            <div className="flex items-center gap-2.5 flex-wrap sm:flex-nowrap">
              {/* CSV for the data, Excel for the colour-coded copy — plain CSV
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

          {/* The period this table covers, and what that makes it. */}
          {renderRangeBar()}

          {/* Filter Tabs & Search Controls Bar */}
          <div className="px-4.5 py-3 border-b border-line bg-white space-y-2.5 select-none">
            <div className="w-full bg-paper-2 rounded-[10px] p-1 flex items-center gap-1 overflow-x-auto lg:overflow-visible flex-wrap sm:flex-nowrap border border-line/60">
              {activeFilters.map((f) => {
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
                    className={`flex-1 flex items-center justify-center gap-2 px-2.5 py-1.75 rounded-[7px] text-xs cursor-pointer transition-all whitespace-nowrap ${
                      active
                        ? "bg-white text-ink font-semibold shadow-shadow border border-line/60"
                        : "text-mut hover:text-ink font-medium hover:bg-white/50"
                    }`}
                  >
                    <span>{PNL_FILTER_LABELS[f]}</span>
                    <span
                      className={`text-[10.5px] font-mono px-1.5 py-0.5 rounded-[4px] font-semibold transition-colors ${
                        active
                          ? f === "profit"
                            ? "bg-gain-bg text-gain"
                            : f === "loss"
                              ? "bg-loss-bg text-loss-d"
                              : f === "open"
                                ? "bg-amber-bg text-amber-d border border-amber/30"
                                : "bg-paper-2 text-ink"
                          : f === "profit"
                            ? "bg-gain-bg/50 text-gain"
                            : f === "loss"
                              ? "bg-loss-bg/50 text-loss-d"
                              : f === "open"
                                ? "bg-amber-bg/50 text-amber-d"
                                : "bg-line/40 text-mut"
                      }`}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

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
                    Showing{" "}
                    <strong className="text-ink">{filteredSummaryRows.length}</strong>{" "}
                    of {tableRows.length}
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
                </tr>
              </thead>
              <tbody>
                {filteredSummaryRows.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-4.5 py-10 text-center text-mut">
                      {tableRows.length === 0
                        ? isAllTime
                          ? "No figures yet. Your P&L appears once Vitti has processed your first contract notes."
                          : "Nothing was sold in this period. Widen it, or pick All time to see everything you hold."
                        : "No company records match the current filter or search."}
                    </td>
                  </tr>
                ) : (
                  <>
                    {/* Keyed by position in the list, not by ticker: under All
                        accounts a client who holds EOS in two accounts has two
                        EOS rows, and a duplicate key silently drops one of
                        them. The rows arrive in a stable order (P&L desc, then
                        ticker) so the index is stable across renders. */}
                    {page.map((r, i) => (
                      <PnlRow
                        key={`${r.ticker}-${(pnlPage - 1) * pnlSize + i}`}
                        row={r}
                        money2={money2}
                        readOnly
                      />
                    ))}

                    {/* Grand Total — the same three columns the downloads sum.
                        Quantities are not totalled: units of different
                        companies are not the same thing. */}
                    <tr className="border-t-2 border-line-2 bg-paper-2 font-bold">
                      <td className="px-4.5 py-3" colSpan={2}>
                        Grand Total
                        {filteredSummaryRows.length !== tableRows.length
                          ? ` (${filteredSummaryRows.length} filtered)`
                          : ""}
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
                      <td className="px-4.5 py-3" colSpan={2} />
                    </tr>
                  </>
                )}
              </tbody>
            </table>
          </div>

          <TablePagination
            totalItems={filteredSummaryRows.length}
            currentPage={pnlPage}
            pageSize={pnlSize}
            onPageChange={setPnlPage}
            onPageSizeChange={(size) => {
              setPnlSize(size);
              setPnlPage(1);
            }}
            pageSizeOptions={[10, 25, 50, 100, 1000]}
            itemLabel="tickers"
          />

          {/* A total that quietly omits a holding is worse than one that says
              so. `outsideTotal` counts the all-time rows whose cost is unknown,
              so it is only true of the all-time table. */}
          {isAllTime && scoped.outsideTotal > 0 && (
            <div className="px-4.5 py-3 border-t border-line text-xs text-mut leading-relaxed">
              {scoped.outsideTotal} line
              {scoped.outsideTotal === 1 ? " is" : "s are"} outside the Grand Total
              while Vitti confirms {scoped.outsideTotal === 1 ? "its" : "their"} cost
              base. Ask your adviser if you would like the detail.
            </div>
          )}

          {/* The same fact for a realised view, where it is per SALE rather than
              per row. Where profit has no cost behind it the figure is
              overstated, and saying so is the difference between a number and a
              misleading one. */}
          {!isAllTime && window_?.hasUncosted && (
            <div className="px-4.5 py-3 border-t border-line text-xs text-mut leading-relaxed">
              Some of these sales have no purchase on file yet, so their profit is
              shown as the full proceeds and this total is higher than the real
              result. Vitti is confirming the cost base.
            </div>
          )}
        </div>
      </div>
    );
  };

  /**
   * The options register — listed series and unlisted placement grants.
   *
   * Identical to the desk's, because it is derived by the same call
   * (`optionSummaryRows`) off the same rows. The one column worth reading
   * carefully is Exercise Value: it is intrinsic, `Qty × (Spot − Strike)`
   * floored at zero, and it is filled for UNLISTED grants only. A listed series
   * trades on its own market, so Current Value beside it is already what it is
   * worth and a second figure struck off the underlying would be describing
   * something else entirely.
   */
  const renderOptions = () => {
    const page = filteredOptionRows.slice(
      (optionsPage - 1) * optionsSize,
      (optionsPage - 1) * optionsSize + optionsSize,
    );

    return (
      <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden space-y-0">
        <div className="px-4.5 py-3.5 border-b border-line bg-white select-none flex items-center justify-between flex-wrap gap-2">
          <div>
            <b className="text-sm font-semibold text-ink">Your option register</b>
            <div className="text-[11px] text-mut mt-0.5">
              Listed exchange-traded options, and unlisted placement options carried
              at intrinsic value
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono px-2 py-0.5 rounded-[6px] bg-paper-2 border border-line/60 font-semibold text-ink">
              {filteredOptionRows.length}{" "}
              {filteredOptionRows.length === 1 ? "option" : "options"}
            </span>
          </div>
        </div>

        {/* Filter Tabs & Search Controls Bar */}
        <div className="px-4.5 py-3 border-b border-line bg-white space-y-2.5 select-none">
          <div className="w-full bg-paper-2 rounded-[10px] p-1 flex items-center gap-1 overflow-x-auto flex-wrap sm:flex-nowrap border border-line/60">
            {OPTION_FILTERS.map((t) => {
              const active = optionsFilter === t;
              const count = optionTabCounts[t];
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => {
                    setOptionsFilter(t);
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
                      active ? "bg-paper-2 text-ink" : "bg-line/40 text-mut"
                    }`}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

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

            {(optionsFilter !== "all" || optionsSearch) && (
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-mut">
                  Showing{" "}
                  <strong className="text-ink">{filteredOptionRows.length}</strong> of{" "}
                  {allOptionRows.length}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setOptionsFilter("all");
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
                <th
                  className="px-4.5 py-2.5 text-right whitespace-nowrap"
                  title="Options held — the count the exercise value is struck on"
                >
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
                <th className="px-4.5 py-2.5 text-right whitespace-nowrap">
                  Current Value ($)
                </th>
                <th className="px-4.5 py-2.5 text-right whitespace-nowrap">
                  Unreal. P&amp;L ($)
                </th>
                <th className="px-4.5 py-2.5 whitespace-nowrap">
                  Terms / Valuation Notes
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#f0ede5]">
              {filteredOptionRows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="text-center text-mut py-8">
                    {allOptionRows.length === 0
                      ? "No option holdings or placement grants on record."
                      : "No options match the current filter or search."}
                  </td>
                </tr>
              ) : (
                <>
                  {page.map(({ row: o, qty, strike, spot, money }, i) => {
                    const isUnlisted = isRowUnlistedOption(o);
                    const isUp = o.pnl >= 0;

                    return (
                      <tr
                        // By position, not by series: the same grant can be held
                        // in two accounts, and All accounts shows both.
                        key={`${o.ticker}-${(optionsPage - 1) * optionsSize + i}`}
                        className={
                          money.isExercisable
                            ? "bg-green-bg/25 hover:bg-green-bg/40"
                            : "hover:bg-paper-2/60 transition-colors"
                        }
                      >
                        <td className="px-4.5 py-3 whitespace-nowrap">
                          <span className="code font-mono px-1.5 py-0.5 rounded-[5px] bg-paper-2 font-bold text-ink whitespace-nowrap inline-block">
                            {o.ticker}
                          </span>
                        </td>
                        <td className="px-4.5 py-3 text-ink font-semibold min-w-[200px]">
                          {o.name}
                        </td>
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
                          {money.moneyness === "unknown"
                            ? "—"
                            : `$${money2(money.intrinsicValue)}`}
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
                        <td
                          className="px-4.5 py-3 text-mut text-[11px] font-mono leading-relaxed max-w-sm truncate"
                          title={o.type}
                        >
                          {o.type}
                        </td>
                      </tr>
                    );
                  })}

                  {/* Options Grand Total */}
                  <tr className="border-t-2 border-line-2 bg-paper-2 font-bold">
                    <td className="px-4.5 py-3" colSpan={3}>
                      Grand Total ({filteredOptionRows.length}{" "}
                      {filteredOptionRows.length === 1 ? "option" : "options"})
                    </td>
                    {/* Option counts DO add up — unlike share quantities, these
                        are all contracts over the same holder's positions. */}
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
          pageSize={optionsSize}
          onPageChange={setOptionsPage}
          onPageSizeChange={(size) => {
            setOptionsSize(size);
            setOptionsPage(1);
          }}
          pageSizeOptions={[10, 25, 50, 100]}
          itemLabel="options"
        />
      </div>
    );
  };


  const selectedStock = positions.find(pos => pos.code === selectedHolding);
  const advice = selectedHolding ? signals[selectedHolding] : null;

  return (
    <div className="space-y-4">
      {/* Page Header */}
      <div className="flex justify-between items-end gap-3 flex-wrap">
        <div>
          <div className="font-mono text-xs tracking-wider uppercase text-mut">Listed equities &middot; broker feed</div>
          <h1 className="font-disp font-medium text-[26px] mt-0.5 text-ink">Portfolio</h1>
        </div>

        {/* Tabs switcher. The first three are the desk's own tabs, in the desk's
            own order, so a client and their adviser can talk about "the Options
            tab" and mean one thing. */}
        <div className="inline-flex bg-paper-2 rounded-[9px] p-0.75 flex-wrap">
          {(
            [
              { id: "holdings", label: "Holdings" },
              { id: "historical", label: "Historical P&L" },
              { id: "options", label: "Options" },
              { id: "transactions", label: "Transactions" },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`text-xs font-semibold px-4 py-2 rounded-[7px] cursor-pointer transition-colors ${tab === t.id ? "bg-white text-ink shadow-shadow" : "text-mut hover:text-ink"}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {/* Account filter — only where there is more than one account to choose
          between, exactly as on the staff console. Every tab left here follows
          it; Analytics, which deliberately sat outside it, has moved to Home. */}
      {accounts.length > 1 && (
        <div className="flex items-center gap-2 flex-wrap select-none">
          <span className="text-[11px] tracking-wider uppercase text-mut font-semibold mr-1">
            Account
          </span>
          {[{ id: "all", label: "All accounts" }, ...accounts].map((a) => (
            <button
              key={a.id}
              onClick={() => changeAccount(a.id)}
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

      {/* KPI Cards Grid

          The first three are the desk's own Grand Total and are the SAME
          question — cost, what it came to, the difference. They were briefly
          shown beside "Market value", which is a different question entirely
          (current holdings of ONE account at last price), and the pair read as a
          catastrophe: $3,289 next to a $9.9M lifetime cost base. Comparable
          figures sit together; the account's current value is labelled as what
          it is and put last. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Cost base</div>
          <div className="font-disp font-medium text-lg sm:text-2xl tabular-nums mt-1 text-ink">{money0(deskCost)}</div>
          <div className="text-xs text-mut mt-1">invested, {scopeLabel}</div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Proceeds &amp; value</div>
          <div className="font-disp font-medium text-lg sm:text-2xl tabular-nums mt-1 text-ink">{money0(scoped.total.sellOrCurrent)}</div>
          <div className="text-xs text-mut mt-1">sold, plus what is still held</div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Profit &amp; loss</div>
          <div className={`font-disp font-medium text-lg sm:text-2xl tabular-nums mt-1 ${deskPnl >= 0 ? "text-gain" : "text-loss-d"}`}>
            {deskPnl >= 0 ? "+" : ""}{money0(deskPnl)}
          </div>
          <div className={`text-xs mt-1 font-mono ${deskPnl >= 0 ? "text-gain" : "text-loss-d"}`}>
            {deskPnl >= 0 ? "+" : ""}{deskPnlPct.toFixed(1)}% &middot; realised + open
          </div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">
            {acctFilter === "all" && accounts.length > 1 ? "All accounts now" : "This account now"}
          </div>
          {/* Unlisted grants are in this figure now. They are a real, valued
              position — the Holdings table lists them and the P&L counts their
              result — so leaving them out made the account read light by exactly
              what the client had been granted. */}
          <div className="font-disp font-medium text-lg sm:text-2xl tabular-nums mt-1 text-ink">${Math.round(scopedTv + scopedCash + unlistedScopedValue).toLocaleString("en-AU")}</div>
          <div className="text-xs text-mut mt-1">
            {holdingRows.length} holding{holdingRows.length === 1 ? "" : "s"} + cash
            {unlistedScopedValue > 0 ? ", incl. unlisted options" : ", at last price"}
          </div>
        </div>
      </div>

      {/* Render selected Tab content */}
      {tab === "transactions" ? (
        /* The ledger unpooled — see TransactionsTable for why Historical P&L
           cannot serve this purpose. Scoped by the same account filter as
           every other tab. */
        <TransactionsTable trades={visibleTrades} accountLabel={scopeLabel} />
      ) : tab === "historical" ? (
        renderHistoricalPnl()
      ) : tab === "options" ? (
        renderOptions()
      ) : (
        <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
          <div className="flex justify-between items-center px-4.5 py-4 border-b border-line bg-white select-none flex-wrap gap-2">
            <div>
              <b className="text-ink text-sm font-semibold">Holdings</b>
              <p className="text-xs text-mut mt-0.5">
                Listed positions and unlisted option grants · tap a listed
                holding for Vitti&apos;s view
              </p>
            </div>
            <input
              type="search"
              value={holdSearch}
              onChange={(e) => {
                setHoldSearch(e.target.value);
                setHoldPage(1);
              }}
              placeholder="Search ticker or name"
              aria-label="Search holdings"
              className="w-46 border border-line-2 bg-white rounded-[9px] px-3 py-2 text-xs focus:border-green focus:outline-none transition-colors"
            />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-[12.5px] font-medium">
              <thead>
                <tr className="border-b border-line text-mut select-none">
                  <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3">Code</th>
                  <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 hidden sm:table-cell">Holding</th>
                  <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right">Qty</th>
                  <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right hidden sm:table-cell">Last</th>
                  <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right">Value</th>
                  <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right">Unreal. P&amp;L</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f0ede5]">
                {holdingRows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-center text-mut py-6">
                      {holdSearch.trim()
                        ? `Nothing matches "${holdSearch.trim()}".`
                        : "No holdings in this account."}
                    </td>
                  </tr>
                )}
                {holdingRows
                  .slice((holdPage - 1) * holdSize, (holdPage - 1) * holdSize + holdSize)
                  .map((row, i) => {
                  // Position, not code: under All accounts the same security
                  // held in two accounts is two rows.
                  const rowKey = (code: string) =>
                    `${code}-${(holdPage - 1) * holdSize + i}`;

                  /**
                   * An unlisted grant. Not clickable, because the modal behind a
                   * listed row offers the desk's view and this week's note on a
                   * traded security — neither of which exists for a grant, and an
                   * empty modal is worse than no modal.
                   */
                  if (row.kind === "unlisted") {
                    const o = row.option;
                    const isUp = o.pnl >= 0;
                    // Derived, because the parcel is valued whole. Kept to four
                    // places: these are quoted in fractions of a cent, and $0.00
                    // against a real value would look like a bug.
                    const perOption = o.qty > 0 ? o.value / o.qty : 0;

                    return (
                      <tr key={rowKey(o.code)} className="hover:bg-paper-2/60 transition-colors">
                        <td className="px-4.5 py-3">
                          <span className="code text-[13px] bg-paper-2 rounded-[5px] px-1.5 py-0.5">
                            {o.code}
                          </span>
                        </td>
                        <td className="px-4.5 py-3 hidden sm:table-cell text-mut">
                          <span className="text-ink font-semibold">{o.name}</span>
                          <div className="text-[10.5px] mt-0.5">
                            Unlisted option · carried at modelled value
                          </div>
                        </td>
                        <td className="px-4.5 py-3 text-right font-mono">{qty0(o.qty)}</td>
                        <td
                          className="px-4.5 py-3 text-right font-mono hidden sm:table-cell text-mut"
                          title="Modelled value per option — an unlisted grant has no market price of its own"
                        >
                          ${money4(perOption)}
                        </td>
                        <td className="px-4.5 py-3 text-right font-mono font-semibold">
                          ${Math.round(o.value).toLocaleString("en-AU")}
                        </td>
                        <td
                          className={`px-4.5 py-3 text-right font-mono ${isUp ? "text-gain" : "text-loss-d"}`}
                        >
                          ${Math.round(o.pnl).toLocaleString("en-AU")}
                          {/* No percentage: a grant costs nothing, so a return
                              on cost is undefined rather than infinite. */}
                          <div className="text-[10.5px]">
                            {o.cost > 0 ? pct1(returnPct(o.pnl, o.cost)) : ""}
                          </div>
                        </td>
                      </tr>
                    );
                  }

                  const p = row.position;
                  const pl = posPL(p);
                  const plp = returnPct(pl, posCost(p));
                  const val = posValue(p);
                  const isUp = pl >= 0;
                  return (
                    <tr
                      key={rowKey(p.code)}
                      onClick={() => handleOpenHolding(p.code)}
                      className="hover:bg-paper-2/60 cursor-pointer transition-colors"
                    >
                      <td className="px-4.5 py-3">
                        <span className="code text-[13px] bg-paper-2 rounded-[5px] px-1.5 py-0.5">{p.code}</span>
                        {/* There is a weekly note behind this row. Without a
                            hint, a note that only exists inside a modal is a
                            note nobody knows to open. */}
                        {commentary[p.code] && (
                          <span
                            className="ml-1.5 align-middle inline-block w-1.5 h-1.5 rounded-full bg-green"
                            title="A note on this holding was written this week — open the row to read it"
                            aria-label="Weekly note available"
                          />
                        )}
                      </td>
                      <td className="px-4.5 py-3 hidden sm:table-cell text-mut">
                        <span className="text-ink font-semibold">{p.name}</span>
                        <div className="text-[10.5px] mt-0.5">{p.sector ?? "—"}</div>
                      </td>
                      <td className="px-4.5 py-3 text-right font-mono">{p.qty.toLocaleString("en-AU")}</td>
                      <td className="px-4.5 py-3 text-right font-mono hidden sm:table-cell">${(p.last ?? 0).toFixed(2)}</td>
                      <td className="px-4.5 py-3 text-right font-mono font-semibold">${Math.round(val).toLocaleString("en-AU")}</td>
                      <td className={`px-4.5 py-3 text-right font-mono ${isUp ? "text-gain" : "text-loss-d"}`}>
                        ${Math.round(pl).toLocaleString("en-AU")}
                        <div className="text-[10.5px]">{pct1(plp)}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {holdingRows.length > 0 && (
                <tfoot>
                  <tr className="border-t-2 border-line bg-paper-2 font-semibold">
                    <td className="px-4.5 py-3.5 text-ink" colSpan={2}>
                      Total
                      {holdingRows.length !== visiblePositions.length + unlistedHoldings.length
                        ? " (all holdings)"
                        : ""}
                    </td>
                    {/* Quantities are not totalled — units of different
                        companies are not the same thing. */}
                    <td className="px-4.5 py-3.5" />
                    <td className="px-4.5 py-3.5 hidden sm:table-cell" />
                    <td className="px-4.5 py-3.5 text-right font-mono text-ink">
                      ${Math.round(holdingsTotal.value).toLocaleString("en-AU")}
                    </td>
                    <td
                      className={`px-4.5 py-3.5 text-right font-mono ${holdingsTotal.pnl >= 0 ? "text-gain" : "text-loss-d"}`}
                    >
                      ${Math.round(holdingsTotal.pnl).toLocaleString("en-AU")}
                      <div className="text-[10.5px]">
                        {pct1(returnPct(holdingsTotal.pnl, holdingsTotal.cost))}
                      </div>
                    </td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>

          <TablePagination
            totalItems={holdingRows.length}
            currentPage={holdPage}
            pageSize={holdSize}
            onPageChange={setHoldPage}
            onPageSizeChange={(size) => {
              setHoldSize(size);
              setHoldPage(1);
            }}
            pageSizeOptions={[10, 25, 50, 100, 1000]}
            itemLabel="holdings"
          />
        </div>
      )}

      {/* Holdings Detailed Advice Modal */}
      {selectedStock && (
        <div className="fixed inset-0 bg-navy/55 backdrop-blur-[2px] z-50 flex items-center justify-center p-4.5 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-110 w-full p-6 shadow-shadow-lg text-ink space-y-4 my-auto max-h-[92vh] overflow-y-auto">
            <div className="flex items-center gap-2.5">
              <span className="code text-lg bg-paper-2 rounded-[5px] px-2 py-0.5">{selectedHolding}</span>
              {advice && getActionPill(advice.action)}
            </div>

            <div>
              <h3 className="font-disp font-medium text-lg leading-tight text-ink">{selectedStock.name}</h3>
            </div>

            <div className="divide-y divide-line">
              <div className="flex justify-between py-2 text-xs">
                <span className="text-mut font-semibold">Your holding</span>
                <b className="font-mono text-ink font-semibold">
                  {selectedStock.qty.toLocaleString("en-AU")} &middot; ${Math.round(posValue(selectedStock)).toLocaleString("en-AU")}
                </b>
              </div>
              <div className="flex justify-between py-2 text-xs">
                <span className="text-mut font-semibold">Unrealised P&amp;L</span>
                <b className={`font-mono font-semibold ${posPL(selectedStock) >= 0 ? "text-gain" : "text-loss-d"}`}>
                  {posPL(selectedStock) >= 0 ? "+" : ""}${Math.round(posPL(selectedStock)).toLocaleString("en-AU")}
                  {/* The same zero-cost trap this file's own header describes,
                      in the one place it was left unguarded: a free grant makes
                      this Infinity, and 0/0 makes it NaN. */}
                  {posCost(selectedStock) > 0 &&
                  Number.isFinite(posPL(selectedStock) / posCost(selectedStock))
                    ? ` (${((posPL(selectedStock) / posCost(selectedStock)) * 100).toFixed(1)}%)`
                    : ""}
                </b>
              </div>
              {advice && (
                <div className="flex justify-between py-2 text-xs">
                  <span className="text-mut font-semibold">Vitti target</span>
                  <b className="font-mono text-ink font-semibold">
                    {advice.target && selectedStock.last
                      ? `$${advice.target.toFixed(2)} · +${Math.round((advice.target / selectedStock.last - 1) * 100)}%`
                      : "—"}
                  </b>
                </div>
              )}
            </div>

            {advice && (
              <div className="space-y-1">
                <div className="font-semibold text-[13.5px] leading-snug">{advice.headline}</div>
                <p className="text-xs text-mut leading-relaxed">{advice.detail}</p>
              </div>
            )}

            {renderCommentary(selectedStock)}

            <div className="flex gap-2.5 pt-2">
              <button
                onClick={handleCloseHolding}
                className="btn border border-line rounded-[10px] py-2 px-4 hover:border-mut text-xs font-semibold cursor-pointer flex-1"
              >
                Close
              </button>

              {advice?.action === "Add" && (
                <button
                  onClick={() => {
                    setTradeAction("Buy");
                    setIsTradeModalOpen(true);
                  }}
                  className="btn bg-green text-[#08130e] hover:shadow-lg rounded-[10px] py-2 px-4 text-xs font-semibold cursor-pointer flex-1.5"
                >
                  Add to position &rarr;
                </button>
              )}

              {(advice?.action === "Trim" || advice?.action === "Take profit") && (
                <button
                  onClick={() => {
                    setTradeAction("Sell");
                    setIsTradeModalOpen(true);
                  }}
                  className="btn bg-navy text-white hover:bg-slate-800 rounded-[10px] py-2 px-4 text-xs font-semibold cursor-pointer flex-1.5"
                >
                  Trim &rarr;
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Trade Execution Modal */}
      {isTradeModalOpen && selectedStock && (
        <div className="fixed inset-0 bg-navy/55 backdrop-blur-[2px] z-50 flex items-center justify-center p-4.5 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-110 w-full p-6 shadow-shadow-lg text-ink space-y-4 my-auto max-h-[92vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="font-disp font-medium text-lg text-ink">
              Route {tradeAction === "Buy" ? "Buy" : "Sell"} Order to Desk
            </h3>
            <p className="text-xs text-mut">
              {selectedStock.name} &middot; last close ${(selectedStock.last ?? 0).toFixed(2)}
            </p>

            <div className="space-y-1">
              <label className="block text-xs font-semibold text-ink">Amount to {tradeAction === "Buy" ? "invest" : "sell"} (AUD)</label>
              <input
                type="text"
                value={tradeAmount}
                onChange={e => setTradeAmount(e.target.value.replace(/[^0-9,]/g, ""))}
                className="w-full border border-line-2 bg-white rounded-[9px] px-3.5 py-2.5 font-mono text-sm focus:border-green focus:outline-none"
              />
              <div className="text-[11px] text-mut mt-1">
                &asymp; {tradeCalculatedShares().toLocaleString("en-AU")} shares at ${(selectedStock.last ?? 0).toFixed(2)}
              </div>
            </div>

            <div className="text-xs text-mut bg-paper-2 rounded-[9px] p-3 leading-normal">
              Your order will be routed directly to the Vitti trading desk. Execution prices will be matched as close to the current market price as possible. Brokerage charges apply.
            </div>

            <div className="flex gap-2.5 pt-2">
              <button
                onClick={() => setIsTradeModalOpen(false)}
                className="btn border border-line rounded-[10px] py-2 px-4 hover:border-mut text-xs font-semibold cursor-pointer flex-1"
              >
                Back
              </button>
              <button
                onClick={executeTradeOrder}
                className="btn bg-green text-[#08130e] hover:shadow-lg rounded-[10px] py-2 px-4 text-xs font-semibold cursor-pointer flex-1.5"
              >
                Confirm with Desk
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
