import test from "node:test";
import assert from "node:assert/strict";

import { storedToSummaryRows } from "./stored-pnl.ts";
import { grandTotal, type PnlOverride } from "./order-history.ts";
import type { StoredPnlRow } from "../data/pnl.ts";

/**
 * The stored rows feed the on-screen table, the CSV and the .xlsx from ONE
 * array. These tests cover the part of that mapping which changes money: which
 * rows the Grand Total is allowed to include, and how a desk override lands on
 * top of a stored figure.
 */

function row(over: Partial<StoredPnlRow> = {}): StoredPnlRow {
  return {
    accountId: "a1",
    clientId: "c1",
    ticker: "EOS",
    parentTicker: "EOS",
    company: "ELECTRO OPTIC",
    instrument: "FPO",
    buyQty: 1000,
    sellQty: 1000,
    openQty: 0,
    buyPrice: 5000,
    sellPrice: 8000,
    pnl: 3000,
    tradeCount: 2,
    isMatched: true,
    isOption: false,
    isEnriched: false,
    isDbMarketValued: false,
    isDbOpenValued: false,
    isDbOnly: false,
    isPartialExit: false,
    isPartialBuy: false,
    isUnlistedOption: false,
    placementYearUnresolved: false,
    placementYearNote: null,
    buySideUnknown: false,
    comment: null,
    computedAt: "2026-08-07T00:00:00Z",
    ...over,
  };
}

test("stored: a plain round trip maps straight through", () => {
  const [r] = storedToSummaryRows([row()]);
  assert.equal(r.ticker, "EOS");
  assert.equal(r.name, "ELECTRO OPTIC");
  assert.equal(r.buyPrice, 5000);
  assert.equal(r.sellOrCurrent, 8000);
  assert.equal(r.pnl, 3000);
  assert.equal(r.type, "Matched");
  assert.equal(r.openPosition, false);
});

test("stored: an unknown buy side is kept off the Grand Total", () => {
  // The row's cost is blank, not zero. Summing its proceeds would report the
  // whole sale as profit — the exact error the blank exists to prevent.
  const rows = storedToSummaryRows([
    row(),
    row({
      ticker: "EUR",
      buySideUnknown: true,
      placementYearUnresolved: true,
      buyQty: 0,
      buyPrice: 0,
      sellQty: 115385,
      sellPrice: 40000,
      pnl: 40000,
      isMatched: false,
    }),
  ]);

  const unknown = rows.find((r) => r.ticker === "EUR")!;
  assert.equal(unknown.type, "Buy Side Unknown");
  assert.equal(unknown.excludedFromTotal, true);
  assert.equal(unknown.flagged, true);

  const total = grandTotal(rows);
  assert.equal(total.pnl, 3000, "the $40,000 with no cost behind it is excluded");
  assert.equal(total.sellOrCurrent, 8000, "not even its proceeds are counted");
});

test("stored: correcting the buy side by hand puts the row back in the total", () => {
  // This is the whole point of the override: a blank row is not permanently
  // exiled, it rejoins as soon as someone supplies what the sources could not.
  const overrides = new Map<string, PnlOverride>([
    [
      "EUR",
      {
        parent: "EUR",
        buyQty: 115385,
        sellQty: null,
        buyPrice: 25000,
        sellOrCurrent: null,
        note: "Cost from the June statement",
        updatedBy: "desk",
        updatedAt: "2026-08-07T00:00:00Z",
      },
    ],
  ]);

  const rows = storedToSummaryRows(
    [
      row({
        ticker: "EUR",
        buySideUnknown: true,
        buyQty: 0,
        buyPrice: 0,
        sellQty: 115385,
        sellPrice: 40000,
        pnl: 40000,
        isMatched: false,
      }),
    ],
    overrides,
  );

  const r = rows[0];
  assert.equal(r.edited, true);
  assert.equal(r.buyPrice, 25000);
  assert.equal(r.pnl, 15000, "recomputed as sell − buy, never taken from the override");
  assert.equal(r.excludedFromTotal, false);
  assert.equal(grandTotal(rows).pnl, 15000);
});

test("stored: P&L is recomputed from the values in force, never overridden directly", () => {
  const overrides = new Map<string, PnlOverride>([
    [
      "EOS",
      {
        parent: "EOS",
        buyQty: null,
        sellQty: null,
        buyPrice: 6000,
        sellOrCurrent: null,
        note: null,
        updatedBy: "desk",
        updatedAt: "2026-08-07T00:00:00Z",
      },
    ],
  ]);

  const [r] = storedToSummaryRows([row()], overrides);
  assert.equal(r.buyPrice, 6000);
  assert.equal(r.pnl, 2000, "8000 − 6000, not the stored 3000");
  assert.equal(r.computed.pnl, 3000, "what the sources said is kept");
  assert.match(r.type, /\(edited\)$/);
});

test("stored: an option line never inherits the underlying's override", () => {
  // The override was authored against the company row (EOS). Applying it to a
  // separate option position (EOSO) would change a figure nobody edited.
  const overrides = new Map<string, PnlOverride>([
    [
      "EOSO",
      {
        parent: "EOSO",
        buyQty: null,
        sellQty: null,
        buyPrice: 999,
        sellOrCurrent: null,
        note: null,
        updatedBy: "desk",
        updatedAt: "2026-08-07T00:00:00Z",
      },
    ],
  ]);

  const [r] = storedToSummaryRows(
    [row({ ticker: "EOSO", isOption: true, buyPrice: 0, isMatched: false })],
    overrides,
  );
  assert.equal(r.edited, false);
  assert.equal(r.buyPrice, 0);
  assert.equal(r.type, "Option");
});

test("stored: status precedence matches the calculator's", () => {
  const status = (over: Partial<StoredPnlRow>) =>
    storedToSummaryRows([row(over)])[0].type;

  // Blank figures first — no status describing them can be true.
  assert.equal(status({ buySideUnknown: true, isDbOnly: true, isMatched: true }), "Buy Side Unknown");
  // A DB-only row trivially "matches" because both legs came from the same held
  // quantity, so where the figures came from is the useful fact.
  assert.equal(status({ isDbOnly: true, isMatched: true }), "DB Holding");
  assert.equal(status({ isUnlistedOption: true, isMatched: true }), "Unlisted Option");
  assert.equal(status({ isMatched: false, isOption: true }), "Option");
  assert.equal(status({ isMatched: false, openQty: 500 }), "Open");
  assert.equal(status({ isMatched: false }), "Unmatched");
});

test("stored: rows are ordered biggest result first", () => {
  const rows = storedToSummaryRows([
    row({ ticker: "AAA", pnl: 100, sellPrice: 100, buyPrice: 0 }),
    row({ ticker: "BBB", pnl: 900, sellPrice: 900, buyPrice: 0 }),
    row({ ticker: "CCC", pnl: -50, sellPrice: 0, buyPrice: 50 }),
  ]);
  assert.deepEqual(rows.map((r) => r.ticker), ["BBB", "AAA", "CCC"]);
});
