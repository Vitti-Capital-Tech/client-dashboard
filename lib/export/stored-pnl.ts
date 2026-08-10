import type { StoredPnlRow } from "../data/pnl";
import type { PnlOverride, OverriddenFields, PnlSummaryRow } from "./order-history";

/**
 * Render stored P&L rows as the `PnlSummaryRow`s the table and both exports
 * already speak.
 *
 * The point of going through the existing shape rather than teaching the table
 * a second one is that the on-screen rows, the CSV and the .xlsx stay three
 * renderings of ONE array. That property is what has kept them from disagreeing,
 * and swapping the source underneath must not cost it.
 *
 * Pure and client-safe — no server imports — so the download handlers stay two
 * liners and the numbers are unit-testable.
 */

/**
 * The status cell.
 *
 * Deliberately the same wording, in the same precedence order, as the
 * calculator's `exportStatus`: a row that reads "Listed Options" on the
 * calculator page must not read "Open" on the client profile. Re-stated here rather than
 * imported because the flags arrive already flattened onto the stored row, and
 * reconstructing a `PnlSummaryItem` just to ask it a question would be worse.
 */
function statusOf(r: StoredPnlRow): string {
  // Ahead of everything else: the row's figures are blank, so no status that
  // describes them can be true.
  if (r.buySideUnknown) return "Buy Side Unknown";
  // Before `isMatched`, because a DB-only row trivially reconciles — both legs
  // came from the same held quantity — and "Matched" would imply a trade
  // reconciliation that never happened. Both wordings say WHY there are no trades
  // behind the row: an option reached the snapshot with a code, so it is listed
  // (reading against the modelled `Unlisted Option` rows); an equity is an open
  // holding the ledger never recorded, which is the wording `buildPnlSummary` has
  // always used for the same case.
  if (r.isDbOnly) return r.isOption ? "Listed Options" : "Open - no ledger history";
  if (r.isUnlistedOption) return "Unlisted Option";
  if (r.isMatched) return "Matched";
  if (r.isOption) return "Option";
  if (r.isPartialExit) return "Partial exit";
  if (r.openQty > 0) return "Open";
  return "Unmatched";
}

/**
 * Overrides are keyed by the ORDINARY code while stored rows are keyed by
 * ticker, so an option line (EOSO) never picks up the underlying's correction
 * (EOS). That is the right default — an override was authored against a
 * company row, and silently applying it to a separate option position would
 * change a figure nobody edited.
 */
function overrideFor(
  r: StoredPnlRow,
  overrides: Map<string, PnlOverride>,
): PnlOverride | undefined {
  return r.isOption || r.isUnlistedOption ? undefined : overrides.get(r.ticker);
}

export function storedToSummaryRows(
  stored: StoredPnlRow[],
  overrides: Map<string, PnlOverride> = new Map(),
): PnlSummaryRow[] {
  const rows: PnlSummaryRow[] = stored.map((r) => {
    const o = overrideFor(r, overrides);

    const computed = {
      buyQty: r.buyQty,
      sellQty: r.sellQty,
      buyPrice: r.buyPrice,
      sellOrCurrent: r.sellPrice,
      pnl: r.pnl,
    };

    const overridden: OverriddenFields = {
      buyQty: o?.buyQty != null,
      sellQty: o?.sellQty != null,
      buyPrice: o?.buyPrice != null,
      sellOrCurrent: o?.sellOrCurrent != null,
    };
    const edited =
      overridden.buyQty ||
      overridden.sellQty ||
      overridden.buyPrice ||
      overridden.sellOrCurrent;

    const buyQty = o?.buyQty ?? computed.buyQty;
    const sellQty = o?.sellQty ?? computed.sellQty;
    const buyPrice = o?.buyPrice ?? computed.buyPrice;
    const sellOrCurrent = o?.sellOrCurrent ?? computed.sellOrCurrent;

    // P&L is never taken from an override — it stays `sell − buy`, recomputed
    // from whichever values are in force. That is what keeps a hand-edited row
    // internally consistent instead of letting someone type a total its own
    // columns contradict.
    const pnl = sellOrCurrent - buyPrice;

    const status = statusOf(r);

    // An edited row is no longer a pure derivation. Not an error, but a fact
    // the reader is entitled to, so it never travels silently.
    return {
      ticker: r.ticker,
      name: r.company || r.ticker,
      buyQty,
      sellQty,
      buyPrice,
      sellOrCurrent,
      pnl,
      openPosition: r.openQty > 0,
      type: edited ? `${status} (edited)` : status,
      flagged: r.buySideUnknown || r.placementYearUnresolved,
      edited,
      overridden,
      note: o?.note ?? r.comment ?? null,
      computed,
      // Correcting the buy side by hand is exactly how such a row rejoins the
      // total, so this tracks the value in force rather than the stored flag.
      excludedFromTotal: r.buySideUnknown && buyPrice === 0 && buyQty === 0,
      isMatched: r.isMatched,
      isOption: r.isOption,
      isUnlistedOption: r.isUnlistedOption,
      isDbOpenValued: r.isDbOpenValued,
      isDbOnly: r.isDbOnly,
      openQty: r.openQty,
    };
  });

  // Biggest result first, matching the computed path; flagged rows are visible
  // by colour, not by position.
  return rows.sort((a, b) => b.pnl - a.pnl || a.ticker.localeCompare(b.ticker));
}
