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
 * The two legs as they stand AFTER any desk override — which is what every
 * question about the row's state has to be asked of.
 *
 * The stored flags answer for the figures the sources produced. An override
 * exists precisely because those were wrong, so once someone corrects a
 * quantity the stored `is_matched` is stale: a row whose legs now balance went
 * on reading "Unmatched" on the client profile, and went on being counted by
 * the Unmatched tab, long after the mismatch it names was fixed.
 *
 * Only recomputed when a QUANTITY was actually overridden. Left alone, the
 * stored flag stays authoritative — it knows things the two numbers do not,
 * such as a DB-only row whose legs match trivially because both were set from
 * the same held quantity.
 */
type EffectiveState = {
  /** Legs reconcile — the calculator's rule, restated on the values in force. */
  isMatched: boolean;
  /** Units still held on the corrected figures. */
  openQty: number;
  /** The desk supplied the buy quantity the sources could not. */
  buySideSupplied: boolean;
};

/**
 * The status cell.
 *
 * Deliberately the same wording, in the same precedence order, as the
 * calculator's `exportStatus`: a row that reads "Listed Options" on the
 * calculator page must not read "Open" on the client profile. Re-stated here rather than
 * imported because the flags arrive already flattened onto the stored row, and
 * reconstructing a `PnlSummaryItem` just to ask it a question would be worse.
 */
function statusOf(r: StoredPnlRow, eff: EffectiveState): string {
  // Ahead of everything else: the row's figures are blank, so no status that
  // describes them can be true. Unless the desk has since typed the missing buy
  // side in, at which point the row is judged on its figures like any other.
  if (r.buySideUnknown && !eff.buySideSupplied) return "Buy Side Unknown";
  // Before `isMatched`, because a DB-only row trivially reconciles — both legs
  // came from the same held quantity — and "Matched" would imply a trade
  // reconciliation that never happened. Both wordings say WHY there are no trades
  // behind the row: an option reached the snapshot with a code, so it is listed
  // (reading against the modelled `Unlisted Option` rows); an equity is an open
  // holding the ledger never recorded, which is the wording `buildPnlSummary` has
  // always used for the same case.
  if (r.isDbOnly) return r.isOption ? "Listed Options" : "Open - no ledger history";
  if (r.isUnlistedOption) return "Unlisted Option";
  if (eff.isMatched) return "Matched";
  if (r.isOption) return "Option";
  if (r.isPartialExit) return "Partial exit";
  if (eff.openQty > 0) return "Open";
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

    // Correcting a quantity is how a mismatch gets FIXED, so the row has to be
    // re-judged on the corrected pair — same rule the calculator applies to the
    // sources (`buyQty === sellQty && buyQty > 0`). Without a quantity edit the
    // stored answers stand, untouched.
    const qtyEdited = overridden.buyQty || overridden.sellQty;
    const eff: EffectiveState = {
      isMatched: qtyEdited ? buyQty === sellQty && buyQty > 0 : r.isMatched,
      openQty: qtyEdited ? Math.max(buyQty - sellQty, 0) : r.openQty,
      // Judged on the QUANTITY, which is the leg the label names — the
      // Mismatches page words the same row "0 Buys vs N Sold". A desk that
      // supplied only the cost has not answered that, so the flag stands.
      buySideSupplied: overridden.buyQty && buyQty > 0,
    };

    const status = statusOf(r, eff);

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
      openPosition: eff.openQty > 0,
      type: edited ? `${status} (edited)` : status,
      flagged: r.buySideUnknown || r.placementYearUnresolved,
      edited,
      overridden,
      note: o?.note ?? r.comment ?? null,
      computed,
      // Correcting the buy side by hand is exactly how such a row rejoins the
      // total, so this tracks the value in force rather than the stored flag.
      excludedFromTotal: r.buySideUnknown && buyPrice === 0 && buyQty === 0,
      // The values in force, not the stored ones — the Unmatched tab and the
      // Unmatched badge both read these, and a corrected row must leave both.
      isMatched: eff.isMatched,
      isOption: r.isOption,
      isUnlistedOption: r.isUnlistedOption,
      isDbOpenValued: r.isDbOpenValued,
      isDbOnly: r.isDbOnly,
      openQty: eff.openQty,
      // Only a modelled option carries its own terms. Left undefined elsewhere
      // so the Options tab can tell "no strike on this row" from "strike of 0".
      strike: r.unlistedOption?.strike ?? null,
      underlyingPrice: r.unlistedOption?.spot ?? null,
      expiry: r.unlistedOption?.expiry ?? null,
    };
  });

  // Biggest result first, matching the computed path; flagged rows are visible
  // by colour, not by position.
  return rows.sort((a, b) => b.pnl - a.pnl || a.ticker.localeCompare(b.ticker));
}
