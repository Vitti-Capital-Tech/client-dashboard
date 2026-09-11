import { storedToSummaryRows } from "../export/stored-pnl.ts";
import { grandTotal, type PnlSummaryRow } from "../export/order-history.ts";
import type { PnlOverrideRow } from "../data/holdings.ts";
import type { StoredPnlRow } from "../data/pnl.ts";

/**
 * The client's own portfolio, as the desk sees it.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The client portal used to compute its own P&L from the current holdings
 * snapshot — `posCost` / `posValue` against a last price — while the staff
 * console showed the STORED figures from `lib/pnl/recompute.ts`. Two methods,
 * two answers, and the client's was the thinner one: mark-to-market on what is
 * held right now knows nothing about parcels already sold, so realised profit
 * simply did not appear on their own screen.
 *
 * A client and their adviser reading different numbers for the same holding is
 * not a display bug, it is a conversation nobody can win. So this returns the
 * stored rows, through the same rollup the staff page uses, with the same
 * overrides applied.
 *
 * ── What is deliberately NOT carried across ─────────────────────────────────
 * `PnlSummaryRow` also holds the desk's working notes — `edited` / `overridden`
 * (a figure was corrected by hand) and the free-text `note` — and those are how
 * the firm works, not facts about the client's money. A client seeing
 * "corrected by hand" against their own position learns nothing they can act on
 * and quite a lot about internal process.
 *
 * The one operational field whose EFFECT must survive is `excludedFromTotal`:
 * it is set when a row's cost is genuinely unknown, and summing such a row
 * would report the whole sale proceeds as profit. So the total is taken with
 * `grandTotal` BEFORE the flags are stripped — the client sees the same total
 * as the desk, and simply is not told which row was left out of it.
 *
 * ── Scoping is the caller's job ─────────────────────────────────────────────
 * Pure, and it formats exactly the rows it is handed. Restriction to one
 * client's rows comes from the client-scoped getters plus the `pnl_summary` and
 * `pnl_overrides` RLS policies (`is_staff() OR client_id = current_client_id()`).
 */

/** One holding, as a client sees it: the figures, and nothing about the desk. */
export type ClientPortfolioRow = {
  ticker: string;
  name: string;
  /** Units bought, per the ledger. */
  buyQty: number;
  /** Units sold. Never the parcel still held — that is `heldQty`. */
  sellQty: number;
  /** Units still held, per the latest holdings snapshot. */
  heldQty: number;
  /** Cost of the parcel. */
  buyPrice: number;
  /** Proceeds where sold, current value where held. */
  sellOrCurrent: number;
  pnl: number;
  openPosition: boolean;
  /** `Equity`, `Option`, `Unlisted Option` — the rollup's own wording. */
  type: string;
};

export type ClientPortfolio = {
  rows: ClientPortfolioRow[];
  /** Identical to the desk's Grand Total for the same client. */
  total: { buyPrice: number; sellOrCurrent: number; pnl: number };
  /**
   * Rows whose cost could not be established, so they sit outside the total.
   *
   * A count, not the rows: the client is owed the fact that the total does not
   * cover everything — a figure that quietly omits a holding is worse than one
   * that says so — without being handed the desk's unresolved work.
   */
  outsideTotal: number;
  /**
   * How far each corrected row's P&L moved from what the engine computed, as
   * `[ticker, delta]` pairs.
   *
   * Needed by the dated realised-P&L window, which is built by replaying the
   * trade ledger rather than by reading these rows — so without the deltas a
   * client's "realised between these dates" would ignore every correction their
   * own P&L table already reflects, and the two figures on one screen would
   * disagree. `realizedBetween` spreads each delta across that company's sales.
   *
   * Only the SIZE of the correction crosses over, never the fact that a row was
   * corrected: that is the desk's working note, not a fact about the money (see
   * the section above).
   */
  overrideDeltas: [string, number][];
};

/**
 * The same figures, but as full `PnlSummaryRow`s — so the client portal can
 * render the desk's own Historical P&L and Options tables rather than thinner
 * tables of its own.
 *
 * ── Why the full row, and what is blanked out of it ─────────────────────────
 * Those tables ask things `ClientPortfolioRow` cannot answer: is this a listed
 * series or a modelled grant, what is its strike against spot, do the two legs
 * reconcile, is the parcel still open. Every one of those is a fact about the
 * client's own position, so it crosses over.
 *
 * What does not cross over is the desk's WORKING — the free-text `note`, which
 * is written for the audit trail and addressed to us, and the `edited` /
 * `overridden` marks that say a figure was corrected by hand. Those are blanked
 * HERE, on the server, rather than merely left unrendered: an unrendered field
 * is still in the page's payload, and "the client cannot see it" has to mean
 * they were never sent it.
 *
 * `flagged` and `type` are kept verbatim, deliberately. `type` already says
 * "CHECK - sold more than bought" in words, so dropping the styling that goes
 * with it would hide the signal while keeping the sentence — and re-wording it
 * for the client would be the one thing `statusOf` warns against: one row
 * reading two different things on two screens.
 */
export type ClientSummary = {
  rows: PnlSummaryRow[];
  total: { buyPrice: number; sellOrCurrent: number; pnl: number };
  outsideTotal: number;
  overrideDeltas: [string, number][];
};

const NOTHING_OVERRIDDEN = {
  buyQty: false,
  sellQty: false,
  buyPrice: false,
  sellOrCurrent: false,
} as const;

export function clientSummary(
  stored: StoredPnlRow[],
  overrides: PnlOverrideRow[] = [],
): ClientSummary {
  // Handed over as they came. `storedToSummaryRows` indexes them by account AND
  // parent itself — an override is stored per account, so keyed by code alone
  // two accounts' corrections on one company collapsed into a single entry.
  const summary = storedToSummaryRows(stored, overrides);

  // Taken while the rows still carry `excludedFromTotal`.
  const total = grandTotal(summary);
  const outsideTotal = summary.filter((r) => r.excludedFromTotal).length;

  // Half a cent of slack: these are two floating-point paths to the same
  // figure, and a delta of 1e-13 is not a correction anybody made.
  //
  // Read BEFORE the marks are blanked below, which is the only order that
  // works: these deltas are what keep the dated window and the chart agreeing
  // with the corrected table, and `edited` is how a correction is found.
  const overrideDeltas: [string, number][] = summary
    .filter((r) => r.edited && Math.abs(r.pnl - r.computed.pnl) > 0.005)
    .map((r) => [r.ticker, r.pnl - r.computed.pnl]);

  const rows: PnlSummaryRow[] = summary.map((r) => ({
    ...r,
    edited: false,
    overridden: { ...NOTHING_OVERRIDDEN },
    note: null,
    /**
     * The status, without the trailing `(edited)` marker.
     *
     * `storedToSummaryRows` appends that marker to `type` itself, which makes it
     * the one place the desk's working travels as WORDING rather than as a flag
     * — and the Type column prints `type` verbatim, so blanking `edited` and
     * `overridden` while leaving this would have put "Matched (edited)" on the
     * client's own screen. The status in front of it is kept exactly as it is;
     * only the marker goes.
     */
    type: r.type.replace(/ \(edited\)$/, ""),
    // `computed` is what the sources said BEFORE a correction, and the table
    // renders it as "was $X" beside an edited figure. Set to the values in
    // force, so there is nothing to compare against and nothing to leak.
    computed: {
      buyQty: r.buyQty,
      sellQty: r.sellQty,
      buyPrice: r.buyPrice,
      sellOrCurrent: r.sellOrCurrent,
      pnl: r.pnl,
    },
  }));

  return { rows, total, outsideTotal, overrideDeltas };
}

/**
 * The narrow view, for the screens that only need the figures.
 *
 * Delegates, so the sanitisation and the total have exactly one implementation.
 * This used to BE that implementation, and a second copy of "what a client is
 * not shown" is the last thing worth having two of.
 */
export function clientPortfolio(
  stored: StoredPnlRow[],
  overrides: PnlOverrideRow[] = [],
): ClientPortfolio {
  const summary = clientSummary(stored, overrides);

  const rows: ClientPortfolioRow[] = summary.rows.map((r) => ({
    ticker: r.ticker,
    name: r.name,
    buyQty: r.buyQty,
    sellQty: r.sellQty,
    heldQty: r.heldQty ?? 0,
    buyPrice: r.buyPrice,
    sellOrCurrent: r.sellOrCurrent,
    pnl: r.pnl,
    openPosition: r.openPosition,
    type: r.type,
  }));

  return {
    rows,
    total: summary.total,
    outsideTotal: summary.outsideTotal,
    overrideDeltas: summary.overrideDeltas,
  };
}

/** Is this row an option of either kind? The rollup says so in `type`. */
export function isOptionRow(r: ClientPortfolioRow): boolean {
  return r.type.toLowerCase().includes("option");
}
