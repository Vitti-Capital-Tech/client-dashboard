import { SETTLED, type LedgerLine } from "../import/trades.ts";

/**
 * The buy side the contract-note ledger does not carry — recovered so the
 * cost-basis replay can use it.
 *
 * ── The bug this exists to fix ──────────────────────────────────────────────
 * A placement is not transacted as a client contract note. It goes through the
 * house account and is journalled out, so the client's ledger shows the SALE
 * and no purchase at all. The stored recompute knows better: it merges the
 * Placement Tracker workbooks and fills those buy sides in (`recompute.ts` step
 * 2), which is why `pnl_summary` carries a real cost for them.
 *
 * The dated realised-P&L window and the by-month chart do not read
 * `pnl_summary`. They replay the raw ledger through `attributeSells`, because a
 * lifetime rollup has no dates in it and a date range needs per-sale
 * attribution. That replay had no idea placements existed, so it costed those
 * sales at zero and flagged them `noCostBasis` — "cost base not on file".
 *
 * On one real account that read, for a single holding:
 *
 *     window card:  1,280,953 units · cost $0     · P&L +$11,402
 *     table below:  1,280,953 units · cost $6,405 · P&L  +$4,997
 *
 * Same units, same proceeds, one screen, and the card's own footnote told the
 * client Vitti was still confirming a cost base that was sitting in the
 * database. The overstated figure was the one printed largest.
 *
 * ── How the missing parcel is recovered ─────────────────────────────────────
 * By DIFFERENCE, rather than by parsing the trackers again — that parse costs
 * ~48s and cannot happen in a page render.
 *
 * `buildPnlSummary` starts from the ledger, so a stored row's buy side is
 * "ledger buys, plus whatever the tracker merge added". Subtract the ledger's
 * own buys and what is left IS what the merge added. No new column, no second
 * source of truth, and the arithmetic cannot drift from the merge because it is
 * defined as the merge's output minus its input.
 *
 * It also picks up the other off-ledger case for free, and correctly: a free
 * option grant contributes UNITS at ZERO value. That turns a sale the replay
 * called "cost unknown" into one it costs at nothing — which is not a
 * technicality but the difference between a figure that is missing and a figure
 * that is zero. Only the first deserves a warning.
 *
 * ── Which grain, and why not per raw ticker ─────────────────────────────────
 * Per PARENT, matching the replay: it pools `HYD` and `HYDOC` under `HYD` on
 * purpose, so a placement bought as one code and sold as another nets out as
 * the one round trip it really was. Differencing per raw ticker would leave the
 * option row's units unexplained inside a pool that had already absorbed them.
 */

/** The stored fields this needs. Structural, so the tests need no database. */
export type StoredBuySide = {
  ticker: string;
  parentTicker: string | null;
  /** Units the stored row's buy side carries, tracker fills included. */
  buyQty: number;
  /** A VALUE sum for those units, not a per-unit price. */
  buyPrice: number;
};

/** The ledger fields this needs. */
export type LedgerBuySide = {
  parent: string;
  side: "BUY" | "SELL";
  tradeDate: string;
  units: number;
  value: number;
  status: string;
};

/**
 * Quantities are `numeric(20,4)` and values `numeric(18,2)`, arriving as
 * strings over PostgREST and coerced to floats. A residue of a ten-thousandth
 * of a unit is float dust, not a parcel.
 */
const EPSILON = 1e-4;

/**
 * Synthetic BUY lines for the parcels the ledger never recorded.
 *
 * Both arguments must already be narrowed to the SAME account scope — the
 * replay pools by parent alone (`attributeSells` passes `scope: ""`) and relies
 * on its caller to have filtered, so a mismatch here would cost one account's
 * sales against another's purchases.
 *
 * Returns lines ready to concatenate onto the ledger before replaying it.
 */
export function offLedgerBuyLines(
  stored: StoredBuySide[],
  ledger: LedgerBuySide[],
): LedgerLine[] {
  // ── What the stored rows say the buy side is, per parent ──────────────────
  const storedByParent = new Map<string, { units: number; value: number }>();
  for (const r of stored) {
    const parent = r.parentTicker ?? r.ticker;
    const acc = storedByParent.get(parent) ?? { units: 0, value: 0 };
    acc.units += Number(r.buyQty) || 0;
    acc.value += Number(r.buyPrice) || 0;
    storedByParent.set(parent, acc);
  }

  // ── What the ledger itself accounts for, per parent ───────────────────────
  const ledgerByParent = new Map<
    string,
    { buyUnits: number; buyValue: number; sellUnits: number }
  >();
  // The earliest date the parent appears on, which is where a recovered parcel
  // has to sit — see the date note below.
  const earliestByParent = new Map<string, string>();

  for (const t of ledger) {
    if (t.status !== SETTLED) continue;

    const seen = earliestByParent.get(t.parent);
    if (!seen || t.tradeDate < seen) earliestByParent.set(t.parent, t.tradeDate);

    const acc =
      ledgerByParent.get(t.parent) ?? { buyUnits: 0, buyValue: 0, sellUnits: 0 };
    if (t.side === "BUY") {
      acc.buyUnits += Number(t.units) || 0;
      acc.buyValue += Number(t.value) || 0;
    } else {
      acc.sellUnits += Number(t.units) || 0;
    }
    ledgerByParent.set(t.parent, acc);
  }

  // `code` is the parent for these: a recovered purchase is a DIFFERENCE
  // against the stored row, computed per parent, so there is no instrument it
  // can honestly claim to be. It only ever supplies cost to the FIFO, which is
  // parent-keyed anyway.
  const lines: LedgerLine[] = [];

  for (const [parent, storedBuy] of storedByParent) {
    const onLedger =
      ledgerByParent.get(parent) ?? { buyUnits: 0, buyValue: 0, sellUnits: 0 };

    // Floored at zero in both columns, independently. A negative difference
    // means the ledger records MORE than the stored row does — a row whose buy
    // side the merge left alone, or one a desk correction reduced — and the
    // answer there is to add nothing, never to subtract from a real purchase.
    const gapUnits = Math.max(0, storedBuy.units - onLedger.buyUnits);
    const value = Math.max(0, storedBuy.value - onLedger.buyValue);

    /**
     * ── Capped at what the ledger is actually SHORT of ─────────────────────
     *
     * Without this the recovery makes previously-correct rows wrong, and it is
     * the free option grants that do it. Every option row in `pnl_summary`
     * carries units at ZERO value — the firm's own treatment puts a placement's
     * whole cost on the shares and none on the attaching options — but most of
     * those option codes never trade: 65 of 70 parents on one real account had
     * an option row in the stored figures and no option line in the ledger at
     * all.
     *
     * Recovering their units anyway dropped them into the parent's pool, where
     * weighted-average cost promptly spread the shares' real cost across them.
     * Three holdings on that account went from a correct cost of $5,000 to
     * $2,500 — half the cost parked on units that were free and had not even
     * been sold.
     *
     * `sells − buys` is the only thing the replay genuinely cannot cost, so
     * that is the ceiling. Its most important property is at zero: a parent the
     * ledger already accounts for in full is short of nothing, so nothing is
     * recovered and its figures are left exactly as they were. The value is NOT
     * capped — it is the money actually paid, and it lands on the units that
     * needed cost rather than being diluted across units that did not.
     */
    const shortfall = Math.max(0, onLedger.sellUnits - onLedger.buyUnits);
    const units = Math.min(gapUnits, shortfall);

    // No units means nothing to open a parcel with, so there is nothing the
    // replay could attach a cost to. A value-only difference is left alone
    // rather than invented into a quantity.
    if (units <= EPSILON) continue;

    /**
     * ── The date, which the recovered parcel does not have ─────────────────
     *
     * A stored row is a lifetime rollup and carries no purchase date, and the
     * replay is order-dependent: cost has to be in the pool BEFORE the sale
     * that draws on it, or the sale is costed at zero — the very thing this is
     * fixing.
     *
     * So the parcel is placed at the earliest date the parent appears on at
     * all, with an empty contract note so it sorts first within that date
     * (`replayLedger` orders by date then cnote, and an empty string sorts
     * before every real note number). As early as the data allows is the only
     * choice that cannot leave a real sale uncosted for want of a date nobody
     * recorded — and it is honest about the limit: this fixes HOW MUCH a sale
     * cost, not WHEN the parcel was acquired.
     *
     * Buy-versus-buy order is irrelevant either way. Weighted-average cost
     * pools every purchase that precedes a sale, so only the buy/sell boundary
     * can change an answer.
     */
    const tradeDate = earliestByParent.get(parent);
    if (!tradeDate) continue; // No trades on this parent, so no sale to cost.

    lines.push({
      // Pooled by parent alone, exactly as `attributeSells` does.
      scope: "",
      parent,
      // The parent, deliberately: a recovered purchase is a DIFFERENCE against
      // the stored row computed per parent, so there is no instrument it can
      // honestly claim to be. It only supplies cost to the FIFO, which is
      // parent-keyed anyway.
      code: parent,
      cnote: "",
      side: "BUY",
      tradeDate,
      units,
      value,
      status: SETTLED,
      fees: 0,
    });
  }

  return lines;
}
