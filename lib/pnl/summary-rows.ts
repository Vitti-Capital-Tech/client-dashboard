import {
  moneynessOf,
  UNKNOWN_MONEYNESS,
  type OptionMoneyness,
} from "../options/moneyness.ts";
import type { PnlSummaryRow } from "../export/order-history.ts";

/**
 * How a `PnlSummaryRow` is CLASSIFIED, and how the Historical P&L and Options
 * tables are filtered — for every screen that renders those rows.
 *
 * These predicates lived inline in the staff client-detail island, which was
 * fine while it was the only reader. It no longer is: the client's own Portfolio
 * shows the same three tables, and the whole point of that is that a client and
 * their adviser read the SAME rows under the same headings. Two copies of
 * "which rows count as options" is exactly how that stops being true — silently,
 * because both copies keep working.
 *
 * Deliberately pure and free of any server import, so both islands and the
 * tests can use it directly.
 *
 * ── Why each test is this generous ──────────────────────────────────────────
 * Every one of them checks several fields for the same fact. That is not
 * defensiveness for its own sake: the rows arrive from `storedToSummaryRows`
 * where the flags are authoritative, but a `-UO` ticker suffix and the `type`
 * wording are what identify a modelled grant that predates those flags. Asking
 * all three keeps an older stored row classified the way it always was.
 */

export const isRowOption = (r: PnlSummaryRow): boolean =>
  Boolean(
    r.isOption ||
      r.isUnlistedOption ||
      r.ticker.endsWith("-UO") ||
      r.type.toLowerCase().includes("option"),
  );

export const isRowUnlistedOption = (r: PnlSummaryRow): boolean =>
  Boolean(
    r.isUnlistedOption ||
      r.ticker.endsWith("-UO") ||
      r.type.toLowerCase().includes("unlisted"),
  );

export const isRowMatched = (r: PnlSummaryRow): boolean =>
  Boolean(r.isMatched || r.type.startsWith("Matched"));

export const isRowOpen = (r: PnlSummaryRow): boolean =>
  Boolean(
    r.openPosition ||
      (r.openQty !== undefined && r.openQty > 0) ||
      r.isDbOpenValued ||
      r.type.startsWith("Open"),
  );

/**
 * Neither reconciled nor an option — the rows whose two legs the ledger cannot
 * account for. Options are excluded because a grant has nothing to reconcile
 * against: it was never bought.
 */
export const isRowUnmatched = (r: PnlSummaryRow): boolean =>
  !isRowMatched(r) && !isRowOption(r);

export const isRowEquity = (r: PnlSummaryRow): boolean => !isRowOption(r);

/**
 * What identifies ONE row of the Historical P&L table.
 *
 * Not the ticker. `pnl_summary` is keyed `(account_id, ticker)`, so under "All
 * accounts" a client holding EOS in two accounts has two EOS rows — and every
 * consumer that used the ticker as an identity treated them as one thing: React
 * saw duplicate keys, and the staff table's inline editor opened on both rows
 * from a single click.
 *
 * Falls back to the ticker where a row carries no account, which is the
 * computed path (`buildPnlSummary`) — a single scope, where the ticker really
 * is unique.
 */
export const pnlRowId = (r: PnlSummaryRow): string =>
  r.accountId ? `${r.accountId}|${r.ticker}` : r.ticker;

// ---------------------------------------------------------------------------
// The Historical P&L filter bar
// ---------------------------------------------------------------------------

export const PNL_FILTERS = [
  "all",
  "equity",
  "options",
  "unlisted",
  "open",
  "matched",
  "profit",
  "loss",
  "unmatched",
] as const;

export type PnlFilter = (typeof PNL_FILTERS)[number];

/**
 * The pills a CLIENT is offered.
 *
 * `matched` and `unmatched` are withheld, and the reason is the one §8.41
 * already applies to the rest of the tab: they are not facts about the client's
 * money. `isRowUnmatched` means "neither reconciled nor an option" — it says
 * whether OUR ledger's two legs account for each other, the same category as
 * the "Calculated at" stamp and the run warnings the client's tab leaves out. A
 * client cannot act on "this row is unmatched", and what the gap actually costs
 * them is already said in words on the row: a line whose cost base is still
 * being confirmed says so under the table.
 *
 * Listed out in full rather than derived from `PNL_FILTERS` by subtraction, so
 * that the default for a NEWLY added pill is that a client does not see it until
 * somebody decides they should. Deriving it the other way round gets that
 * backwards — a pill invented for the desk would appear on the client's screen
 * the moment it was added, which is exactly the accident this boundary exists
 * to prevent.
 */
export const CLIENT_PNL_FILTERS = [
  "all",
  "equity",
  "options",
  "unlisted",
  "open",
  "profit",
  "loss",
] as const;

export const PNL_FILTER_LABELS: Record<PnlFilter, string> = {
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

/** Does this row belong under that filter? Search is applied separately. */
export function matchesPnlFilter(r: PnlSummaryRow, filter: PnlFilter): boolean {
  switch (filter) {
    case "matched":
      return isRowMatched(r);
    case "profit":
      return r.pnl > 0;
    case "loss":
      return r.pnl < 0;
    case "unmatched":
      return isRowUnmatched(r);
    case "options":
      return isRowOption(r);
    case "unlisted":
      return isRowUnlistedOption(r);
    case "open":
      return isRowOpen(r);
    case "equity":
      return isRowEquity(r);
    case "all":
      return true;
  }
}

/** Ticker or company, case-insensitively. A blank query matches everything. */
export function matchesTickerOrName(r: PnlSummaryRow, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  return (
    r.ticker.toLowerCase().includes(q) || r.name.toLowerCase().includes(q)
  );
}

export function filterPnlRows(
  rows: PnlSummaryRow[],
  filter: PnlFilter,
  search: string,
): PnlSummaryRow[] {
  return rows.filter(
    (r) => matchesTickerOrName(r, search) && matchesPnlFilter(r, filter),
  );
}

/** How many rows each pill would show, for the counts beside their labels. */
export function pnlFilterCounts(
  rows: PnlSummaryRow[],
): Record<PnlFilter, number> {
  const out = {} as Record<PnlFilter, number>;
  for (const f of PNL_FILTERS) {
    out[f] = rows.filter((r) => matchesPnlFilter(r, f)).length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The options register
// ---------------------------------------------------------------------------

/**
 * One option line: the summary row, the quantity actually behind it, and — for
 * a modelled grant — where its strike sits against the underlying.
 *
 * The ITM badge and the exercise value beside it both read off this ONE
 * derivation, so they cannot disagree about whether a parcel is in the money.
 */
export type OptionSummaryRow = {
  row: PnlSummaryRow;
  qty: number;
  strike: number | null;
  spot: number | null;
  money: OptionMoneyness;
};

/**
 * The option lines from a set of summary rows.
 *
 * ── The quantity ───────────────────────────────────────────────────────────
 * An unlisted grant's count sits on the SELL side (it was never bought) and its
 * open quantity is negative, so the magnitude is what is held. Reading `buyQty`
 * alone put a zero in the column the exercise value is struck on, which showed
 * free option grants as worth nothing at all.
 *
 * ── Why only unlisted grants get a strike and a spot ───────────────────────
 * A listed series is quoted and traded on its own market: `sellOrCurrent`
 * already carries what it is worth, and an intrinsic figure struck off the
 * underlying would be a second, unrelated number sitting beside it claiming to
 * describe the same row.
 */
export function optionSummaryRows(
  rows: PnlSummaryRow[],
): OptionSummaryRow[] {
  return rows.filter(isRowOption).map((r) => {
    const qty =
      r.buyQty > 0
        ? r.buyQty
        : r.sellQty > 0
          ? r.sellQty
          : r.openQty !== undefined && r.openQty !== 0
            ? Math.abs(r.openQty)
            : 0;

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
}

export const OPTION_FILTERS = ["all", "listed", "unlisted", "itm"] as const;

export type OptionFilter = (typeof OPTION_FILTERS)[number];

export const OPTION_FILTER_LABELS: Record<OptionFilter, string> = {
  all: "All Options",
  listed: "Listed Options",
  unlisted: "Unlisted Options",
  itm: "In the Money",
};

export function matchesOptionFilter(
  o: OptionSummaryRow,
  filter: OptionFilter,
): boolean {
  switch (filter) {
    case "listed":
      return !isRowUnlistedOption(o.row);
    case "unlisted":
      return isRowUnlistedOption(o.row);
    case "itm":
      // At OR in the money — see `isExercisable`. A grant on its strike belongs
      // with the live ones, not filed beside the out-of-the-money rows.
      return o.money.isExercisable;
    case "all":
      return true;
  }
}

/**
 * Options search also covers the valuation note, which is where a grant's terms
 * are written — "$0.0125 strike, expires Nov 27" is what someone looking for it
 * actually remembers, rather than its series code.
 */
export function filterOptionRows(
  rows: OptionSummaryRow[],
  filter: OptionFilter,
  search: string,
): OptionSummaryRow[] {
  const q = search.trim().toLowerCase();
  return rows.filter((o) => {
    const r = o.row;
    const matchesSearch =
      !q ||
      r.ticker.toLowerCase().includes(q) ||
      r.name.toLowerCase().includes(q) ||
      Boolean(r.note && r.note.toLowerCase().includes(q));
    return matchesSearch && matchesOptionFilter(o, filter);
  });
}

export function optionFilterCounts(
  rows: OptionSummaryRow[],
): Record<OptionFilter, number> {
  const out = {} as Record<OptionFilter, number>;
  for (const f of OPTION_FILTERS) {
    out[f] = rows.filter((o) => matchesOptionFilter(o, f)).length;
  }
  return out;
}

/**
 * The options grand total.
 *
 * Option counts DO add up — unlike share quantities, these are all contracts
 * over the same holder's positions — so `qty` is summed rather than left blank.
 */
export function optionTotals(rows: OptionSummaryRow[]): {
  buyPrice: number;
  sellOrCurrent: number;
  pnl: number;
  qty: number;
  intrinsic: number;
} {
  return {
    buyPrice: rows.reduce((s, o) => s + o.row.buyPrice, 0),
    sellOrCurrent: rows.reduce((s, o) => s + o.row.sellOrCurrent, 0),
    pnl: rows.reduce((s, o) => s + o.row.pnl, 0),
    qty: rows.reduce((s, o) => s + o.qty, 0),
    intrinsic: rows.reduce((s, o) => s + o.money.intrinsicValue, 0),
  };
}
