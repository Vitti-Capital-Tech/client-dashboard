import test from "node:test";
import assert from "node:assert/strict";

import {
  isRowOption,
  isRowUnlistedOption,
  isRowMatched,
  isRowOpen,
  isRowUnmatched,
  isRowEquity,
  filterPnlRows,
  pnlFilterCounts,
  optionSummaryRows,
  filterOptionRows,
  optionFilterCounts,
  optionTotals,
  PNL_FILTERS,
  OPTION_FILTERS,
} from "./summary-rows.ts";
import type { PnlSummaryRow } from "../export/order-history.ts";

/**
 * These predicates decide which rows the client portal and the staff console
 * each put under "Options", "Open" and "Unmatched" — the two screens now share
 * this one implementation precisely so those answers cannot drift apart. The
 * tests below are therefore about the CLASSIFICATION, not about the layout: a
 * row that counts as an option here counts as one on both screens, and a
 * quantity read off the wrong leg is wrong in both places at once.
 */

function row(over: Partial<PnlSummaryRow> = {}): PnlSummaryRow {
  return {
    ticker: "EOS",
    name: "ELECTRO OPTIC",
    buyQty: 1000,
    sellQty: 1000,
    heldQty: 0,
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
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

test("summary-rows: an ordinary round trip is equity, matched, not open", () => {
  const r = row();
  assert.equal(isRowOption(r), false);
  assert.equal(isRowEquity(r), true);
  assert.equal(isRowMatched(r), true);
  assert.equal(isRowOpen(r), false);
  assert.equal(isRowUnmatched(r), false);
});

test("summary-rows: an option is recognised by its flag, its suffix OR its type", () => {
  // Three independent tells, because rows stored before the flags existed carry
  // only the ticker suffix or the wording.
  assert.equal(isRowOption(row({ isOption: true })), true);
  assert.equal(isRowOption(row({ ticker: "EOS-UO" })), true);
  assert.equal(isRowOption(row({ type: "Listed Options" })), true);
  assert.equal(isRowOption(row({ type: "Unlisted Option" })), true);
});

test("summary-rows: only an UNLISTED grant reads as unlisted", () => {
  assert.equal(isRowUnlistedOption(row({ isUnlistedOption: true })), true);
  assert.equal(isRowUnlistedOption(row({ ticker: "ACW-UO" })), true);
  // A listed series is an option but not an unlisted one — the distinction the
  // strike / spot / exercise-value columns are filled from.
  assert.equal(isRowUnlistedOption(row({ isOption: true, type: "Option" })), false);
});

test("summary-rows: an option is never counted as unmatched", () => {
  // A grant was never bought, so it has nothing to reconcile against. Counting
  // it under Unmatched would put every free option on the worklist forever.
  const grant = row({ isUnlistedOption: true, isMatched: false, type: "Unlisted Option" });
  assert.equal(isRowUnmatched(grant), false);

  const shortBuy = row({ isMatched: false, type: "CHECK - sold more than bought" });
  assert.equal(isRowUnmatched(shortBuy), true);
});

test("summary-rows: open is true on any of the four things that mean held", () => {
  assert.equal(isRowOpen(row({ openPosition: true })), true);
  assert.equal(isRowOpen(row({ openQty: 500 })), true);
  assert.equal(isRowOpen(row({ isDbOpenValued: true })), true);
  assert.equal(isRowOpen(row({ type: "Open - no ledger history" })), true);
  // A negative open quantity is an unlisted grant's own bookkeeping, not a held
  // parcel — reading it as "open" would put every grant on the Open tab.
  assert.equal(isRowOpen(row({ openQty: -500 })), false);
});

// ---------------------------------------------------------------------------
// The filter bar
// ---------------------------------------------------------------------------

test("summary-rows: every pill filters, and the counts match what it shows", () => {
  const rows = [
    row({ ticker: "EOS", pnl: 3000 }),
    row({ ticker: "ADN", pnl: -400, type: "Partial exit", isMatched: false, openPosition: true }),
    row({ ticker: "ACW-UO", pnl: 1200, isUnlistedOption: true, type: "Unlisted Option" }),
    row({ ticker: "PLS", pnl: 0, isOption: true, type: "Option" }),
  ];

  const counts = pnlFilterCounts(rows);
  for (const f of PNL_FILTERS) {
    assert.equal(
      filterPnlRows(rows, f, "").length,
      counts[f],
      `count for "${f}" disagrees with the rows it filters to`,
    );
  }

  assert.equal(counts.all, 4);
  assert.equal(counts.options, 2);
  assert.equal(counts.unlisted, 1);
  assert.equal(counts.equity, 2);
  assert.equal(counts.profit, 2);
  assert.equal(counts.loss, 1);
});

test("summary-rows: search matches ticker or company, and combines with the pill", () => {
  const rows = [
    row({ ticker: "EOS", name: "ELECTRO OPTIC" }),
    row({ ticker: "ADN", name: "ANDROMEDA METALS", pnl: -100 }),
  ];

  assert.equal(filterPnlRows(rows, "all", "eos").length, 1);
  assert.equal(filterPnlRows(rows, "all", "androm").length, 1);
  assert.equal(filterPnlRows(rows, "all", "  ").length, 2, "a blank query matches everything");
  // Both conditions apply: ADN matches the search but not the Profit pill.
  assert.equal(filterPnlRows(rows, "profit", "androm").length, 0);
});

// ---------------------------------------------------------------------------
// The options register
// ---------------------------------------------------------------------------

test("options: a grant's quantity comes off the SELL leg it was booked on", () => {
  // An unlisted grant was never bought, so `buyQty` is zero and the count sits
  // on the sell side. Reading `buyQty` alone showed free grants as nil quantity
  // — and the exercise value is struck on this number.
  const [o] = optionSummaryRows([
    row({
      ticker: "ACW-UO",
      isUnlistedOption: true,
      type: "Unlisted Option",
      buyQty: 0,
      sellQty: 250_000,
    }),
  ]);
  assert.equal(o.qty, 250_000);
});

test("options: a negative open quantity is read as magnitude", () => {
  const [o] = optionSummaryRows([
    row({
      ticker: "EOS-UO",
      isUnlistedOption: true,
      buyQty: 0,
      sellQty: 0,
      openQty: -80_000,
    }),
  ]);
  assert.equal(o.qty, 80_000);
});

test("options: strike and spot are filled for grants and withheld from listed series", () => {
  const [grant, listed] = optionSummaryRows([
    row({
      ticker: "ACW-UO",
      isUnlistedOption: true,
      buyQty: 100_000,
      strike: 0.02,
      underlyingPrice: 0.05,
    }),
    row({
      ticker: "EOSOD",
      isOption: true,
      type: "Option",
      buyQty: 5_000,
      strike: 0.02,
      underlyingPrice: 0.05,
    }),
  ]);

  assert.equal(grant.strike, 0.02);
  assert.equal(grant.spot, 0.05);
  assert.equal(grant.money.isItm, true);
  // 100,000 × (0.05 − 0.02)
  assert.equal(Math.round(grant.money.intrinsicValue), 3_000);

  // A listed series trades on its own market: Current Value already says what
  // it is worth, and an intrinsic figure off the underlying would be a second,
  // unrelated number claiming to describe the same row.
  assert.equal(listed.strike, null);
  assert.equal(listed.spot, null);
  assert.equal(listed.money.moneyness, "unknown");
  assert.equal(listed.money.intrinsicValue, 0);
});

test("options: equity rows never reach the register", () => {
  const rows = optionSummaryRows([row({ ticker: "EOS" }), row({ ticker: "ADN" })]);
  assert.deepEqual(rows, []);
});

test("options: every pill filters, and the counts match what it shows", () => {
  const derived = optionSummaryRows([
    row({ ticker: "ACW-UO", isUnlistedOption: true, buyQty: 10, strike: 0.02, underlyingPrice: 0.05 }),
    row({ ticker: "EOS-UO", isUnlistedOption: true, buyQty: 10, strike: 0.09, underlyingPrice: 0.05 }),
    row({ ticker: "PLSOD", isOption: true, type: "Option", buyQty: 10 }),
  ]);

  const counts = optionFilterCounts(derived);
  for (const f of OPTION_FILTERS) {
    assert.equal(
      filterOptionRows(derived, f, "").length,
      counts[f],
      `count for "${f}" disagrees with the rows it filters to`,
    );
  }

  assert.equal(counts.all, 3);
  assert.equal(counts.unlisted, 2);
  assert.equal(counts.listed, 1);
  assert.equal(counts.itm, 1, "only the grant struck below spot is in the money");
});

test("options: search also covers the valuation note, where the terms are written", () => {
  const derived = optionSummaryRows([
    row({ ticker: "ACW-UO", isUnlistedOption: true, buyQty: 10, note: "expires Nov 27" }),
    row({ ticker: "EOS-UO", isUnlistedOption: true, buyQty: 10 }),
  ]);

  assert.equal(filterOptionRows(derived, "all", "nov 27").length, 1);
});

test("options: the grand total sums quantities, which for contracts DO add up", () => {
  const derived = optionSummaryRows([
    row({
      ticker: "ACW-UO",
      isUnlistedOption: true,
      buyQty: 100_000,
      buyPrice: 0,
      sellOrCurrent: 3_000,
      pnl: 3_000,
      strike: 0.02,
      underlyingPrice: 0.05,
    }),
    row({
      ticker: "PLSOD",
      isOption: true,
      type: "Option",
      buyQty: 5_000,
      buyPrice: 500,
      sellOrCurrent: 800,
      pnl: 300,
    }),
  ]);

  const totals = optionTotals(derived);
  assert.equal(totals.qty, 105_000);
  assert.equal(totals.buyPrice, 500);
  assert.equal(totals.sellOrCurrent, 3_800);
  assert.equal(totals.pnl, 3_300);
  // Only the grant contributes an exercise value; the listed series has none.
  assert.equal(Math.round(totals.intrinsic), 3_000);
});
