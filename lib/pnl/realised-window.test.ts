import test from "node:test";
import assert from "node:assert/strict";

import { realisedWindowRows } from "./realised-window.ts";
import { isRowMatched, isRowUnmatched, isRowOption, pnlRowId } from "./summary-rows.ts";
import type { WindowContributor } from "../data/compute.ts";
import type { PnlSummaryRow } from "../export/order-history.ts";

/**
 * The dated window's rows are rendered by the SAME table as the all-time rows,
 * through the same filter bar. These cover the part of that mapping which
 * decides which pill a row lands under — where the two views disagreeing is
 * indistinguishable, on screen, from the figures being wrong.
 */

function contributor(over: Partial<WindowContributor> = {}): WindowContributor {
  return {
    parent: "EOS",
    code: "EOS",
    realizedPl: 3000,
    proceeds: 8000,
    costOfSold: 5000,
    units: 1000,
    saleCount: 1,
    noCostBasis: false,
    freeGrant: false,
    ...over,
  };
}

function stored(over: Partial<PnlSummaryRow> = {}): PnlSummaryRow {
  return {
    accountId: "a1",
    ticker: "EOS",
    name: "ELECTRO OPTIC",
    buyQty: 1000,
    sellQty: 1000,
    buyPrice: 5000,
    sellOrCurrent: 8000,
    pnl: 3000,
    openPosition: false,
    type: "Matched",
    flagged: false,
    edited: false,
    overridden: {
      buyQty: false,
      sellQty: false,
      buyPrice: false,
      sellOrCurrent: false,
    },
    note: null,
    computed: {
      buyQty: 1000,
      sellQty: 1000,
      buyPrice: 5000,
      sellOrCurrent: 8000,
      pnl: 3000,
    },
    isMatched: true,
    ...over,
  };
}

test("window: a realised sale is not reported as Unmatched", () => {
  /**
   * The bug this covers: the window row's `type` is "Realised", not "Matched",
   * and `isRowMatched` reads the flag or that wording. With neither set, every
   * equity sale fell through to `isRowUnmatched` — which is "not matched and
   * not an option" — so picking a date range on the desk console flipped the
   * Matched P&L pill from 118 to 0 and Unmatched from 0 to 72, on exactly the
   * rows that had just been reported as Matched.
   */
  const [r] = realisedWindowRows([contributor()], [stored()]);

  assert.equal(isRowMatched(r), true);
  assert.equal(isRowUnmatched(r), false);
});

test("window: a parcel the book cannot reconcile stays Unmatched in a range", () => {
  // The other direction: inheriting must not launder a genuine mismatch into a
  // clean row just because a sale fell inside the window.
  const [r] = realisedWindowRows(
    [contributor()],
    [stored({ isMatched: false, type: "Missing Buys" })],
  );

  assert.equal(isRowMatched(r), false);
  assert.equal(isRowUnmatched(r), true);
});

test("window: a sale with no stored row behind it is matched, not unmatched", () => {
  // Its own two legs are the units the FIFO closed, so they balance by
  // construction. With nothing to say otherwise, "Unmatched" would be a claim
  // about the ledger that nothing on the row supports.
  const [r] = realisedWindowRows([contributor()], []);

  assert.equal(isRowMatched(r), true);
  assert.equal(isRowUnmatched(r), false);
});

test("window: an option keeps its classification inside a range", () => {
  const [r] = realisedWindowRows(
    [contributor({ code: "EOSO", parent: "EOS", freeGrant: true })],
    [stored({ ticker: "EOSO", isOption: true, type: "Option" })],
  );

  assert.equal(isRowOption(r), true);
  // Options are excluded from Unmatched — a grant has nothing to reconcile
  // against, because it was never bought.
  assert.equal(isRowUnmatched(r), false);
  assert.equal(r.type, "Realised · free grant");
});

test("window: a part-sold parcel is still Open inside the range", () => {
  const [r] = realisedWindowRows(
    [contributor()],
    [stored({ openPosition: true, type: "Partial exit" })],
  );

  assert.equal(r.openPosition, true);
});

test("window: rows keep the account, so two accounts stay two rows", () => {
  const [a] = realisedWindowRows([contributor()], [stored({ accountId: "a1" })]);
  const [b] = realisedWindowRows([contributor()], [stored({ accountId: "a2" })]);

  assert.equal(a.accountId, "a1");
  assert.notEqual(pnlRowId(a), pnlRowId(b));
});

test("window: a sale with no cost basis is flagged, a free grant is not", () => {
  const [uncosted] = realisedWindowRows(
    [contributor({ noCostBasis: true })],
    [stored()],
  );
  assert.equal(uncosted.flagged, true);
  assert.equal(uncosted.type, "Realised · cost base not on file");

  // The firm's treatment puts a placement's whole cost on the shares, so $0 on
  // the attaching option is the answer rather than a gap.
  const [grant] = realisedWindowRows(
    [contributor({ noCostBasis: true, freeGrant: true })],
    [stored()],
  );
  assert.equal(grant.flagged, false);
  assert.equal(grant.type, "Realised · free grant");
});
