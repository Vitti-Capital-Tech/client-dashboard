import type { WindowContributor } from "../data/compute.ts";
import type { PnlSummaryRow } from "../export/order-history.ts";

/**
 * The dated realised-P&L window, as Historical P&L rows.
 *
 * ── Why this is shared rather than owned by one screen ──────────────────────
 * The client's Portfolio built this inline, and it was the only screen with a
 * date range on Historical P&L. The desk console now has the same picker, and a
 * second copy of "what a sale looks like as a row" is exactly how a client and
 * their adviser end up reading different tables under one heading — the thing
 * `lib/pnl/summary-rows.ts` already exists to prevent.
 *
 * Pure and free of any server import, so both islands and the tests can use it.
 */

/** The presets, in the order they read: shortest window first. */
export const RANGE_PRESETS: { label: string; months: number }[] = [
  { label: "3M", months: 3 },
  { label: "6M", months: 6 },
  { label: "1Y", months: 12 },
  { label: "3Y", months: 36 },
];

const NOTHING_OVERRIDDEN = {
  buyQty: false,
  sellQty: false,
  buyPrice: false,
  sellOrCurrent: false,
} as const;

/**
 * The sales in the range, as table rows.
 *
 * A date range can only describe money that changed hands, so this is what the
 * table shows once one is picked. Built into the same `PnlSummaryRow` shape the
 * all-time rows use, so ONE table body renders both and the two views cannot
 * drift into looking like different tables.
 *
 * ── The row is the INSTRUMENT, and it carries its classification across ──────
 * It used to be keyed on `c.parent`, which folded an option into its ordinary:
 * `OD6O`'s sale landed on a row labelled `OD6` wearing the option's company
 * name, and every option line the all-time view lists disappeared. The window
 * groups per instrument, and each row inherits the stored row's own flags so
 * the filter bar means the same thing in both views — an option is still an
 * option inside a date range.
 *
 * `buyQty` is the units CLOSED, which the FIFO consumed to make this sale, so
 * the column is populated rather than reading "—". It is deliberately not
 * "units bought in the window": the parcel was acquired earlier, quite possibly
 * outside the range, and claiming otherwise would invite the reader to check it
 * against a purchase that is not on screen.
 */
export function realisedWindowRows(
  contributors: WindowContributor[],
  summaryRows: PnlSummaryRow[],
): PnlSummaryRow[] {
  const storedBy = new Map(summaryRows.map((r) => [r.ticker, r]));

  return contributors.map((c) => {
    const stored = storedBy.get(c.code) ?? storedBy.get(c.parent);
    return {
      // The account the sale belongs to, carried so `pnlRowId` can still tell
      // two accounts' rows for one company apart inside a window.
      accountId: stored?.accountId,
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
      /**
       * Carried across for the same reason as the flags above it.
       *
       * `isRowUnmatched` means "the ledger's two legs do not account for each
       * other", and it is derived as "not matched and not an option" — so a row
       * that simply never said whether it was matched lands in Unmatched by
       * default. Left unset here, EVERY equity sale in a window did: the desk's
       * Matched P&L pill read 0 and Unmatched read 72 the moment a date range
       * was picked, on rows that all-time reported as Matched.
       *
       * That was never true of these rows. A window row's own legs balance by
       * construction — `buyQty` and `sellQty` are both the units the FIFO
       * closed — so absent a stored row to say otherwise it is matched, and
       * where there is one its answer is the one worth reporting.
       */
      isMatched: stored?.isMatched ?? true,
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
      overridden: { ...NOTHING_OVERRIDDEN },
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
}
