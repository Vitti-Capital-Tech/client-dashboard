import test from "node:test";
import assert from "node:assert/strict";

import { clientSummary, clientPortfolio } from "./client-portfolio.ts";
import type { StoredPnlRow } from "../data/pnl.ts";
import type { PnlOverrideRow } from "../data/holdings.ts";

/**
 * What a client is and is not shown of their own P&L rows.
 *
 * The client portal renders the desk's own Historical P&L and Options tables,
 * which means it is handed full `PnlSummaryRow`s rather than the narrow shape
 * this module used to return. That is fine for everything that describes the
 * client's POSITION and not fine for the desk's working — the free-text reason
 * behind a correction, and the marks saying a figure was corrected at all.
 *
 * These tests hold that line where it has to hold: in the returned data, not in
 * whether a component happens to render it. An unrendered field is still in the
 * page's payload, and "the client cannot see it" has to mean they were never
 * sent it.
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
    heldQty: 0,
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
    notInHoldings: false,
    isUnlistedOption: false,
    placementYearUnresolved: false,
    placementYearNote: null,
    buySideUnknown: false,
    unlistedOption: null,
    comment: null,
    computedAt: "2026-08-07T00:00:00Z",
    ...over,
  };
}

function override(over: Partial<PnlOverrideRow> = {}): PnlOverrideRow {
  return {
    accountId: "a1",
    parent: "EOS",
    buyQty: null,
    sellQty: null,
    heldQty: null,
    buyPrice: 4000,
    sellOrCurrent: null,
    note: "cost base from the 2023 statement — S. Goyal",
    updatedBy: "S. Goyal (staff)",
    updatedAt: "2026-09-01T00:00:00Z",
    ...over,
  };
}

test("clientSummary: the desk's working note never leaves the server", () => {
  const { rows } = clientSummary([row()], [override()]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].note, null, "the override's reason must not reach the client");
});

test("clientSummary: a corrected figure is applied, but not advertised as corrected", () => {
  const { rows } = clientSummary([row()], [override()]);
  const [r] = rows;

  // The correction lands: $4,000 in place of the computed $5,000, and the P&L
  // moves with it. A client and their adviser must read the same figure.
  assert.equal(r.buyPrice, 4000);
  assert.equal(r.pnl, 4000);

  // But nothing says a human typed it — including in `type`, where the rollup
  // appends "(edited)" to the status itself.
  assert.equal(r.edited, false);
  assert.equal(r.type, "Matched");
  assert.deepEqual(r.overridden, {
    buyQty: false,
    sellQty: false,
    buyPrice: false,
    sellOrCurrent: false,
  });
  // `computed` is what the table renders as "was $X" beside an edited cell, so
  // it is set to the values in force — there is nothing to compare against.
  assert.equal(r.computed.buyPrice, 4000);
  assert.equal(r.computed.pnl, 4000);
});

test("clientSummary: the SIZE of a correction still crosses over, for the chart", () => {
  // The dated window and the by-month chart are replayed from the trade ledger,
  // not from these rows. Without the delta they would ignore every correction
  // the table already reflects, and two figures on one screen would disagree.
  const { overrideDeltas } = clientSummary([row()], [override()]);
  assert.deepEqual(overrideDeltas, [["EOS", 1000]]);
});

test("clientSummary: an uncorrected book reports no deltas", () => {
  const { overrideDeltas } = clientSummary([row()], []);
  assert.deepEqual(overrideDeltas, []);
});

test("clientSummary: the position's own facts DO cross over", () => {
  // These are what the Options and Historical P&L tables are built on. Stripping
  // them was the reason the client portal could not show those tables at all.
  const { rows } = clientSummary([
    row({
      ticker: "ACW-UO",
      isOption: true,
      isUnlistedOption: true,
      isMatched: false,
      buyQty: 0,
      sellQty: 250_000,
      unlistedOption: {
        strike: 0.02,
        spot: 0.05,
        spotSource: "yahoo",
        expiry: "2027-11-30",
        expiryAssumed: false,
        optionPrice: 0.03,
        pricingMethod: "intrinsic",
        raw: "1:3 @ $0.02 exp 30/11/27",
      },
    }),
  ]);
  const [r] = rows;

  assert.equal(r.isOption, true);
  assert.equal(r.isUnlistedOption, true);
  assert.equal(r.strike, 0.02);
  assert.equal(r.underlyingPrice, 0.05);
});

test("clientSummary: a row with no cost stays out of the total, and is counted", () => {
  // Summing a blank cost would report the whole sale proceeds as profit — the
  // exact error the blank exists to prevent. The client is told the total does
  // not cover everything without being handed the desk's unresolved work.
  const { total, outsideTotal } = clientSummary([
    row(),
    // `excludedFromTotal` is judged on the values in FORCE: unknown buy side,
    // no cost and no buy quantity. A desk correction to any of them is exactly
    // how such a row rejoins the total.
    row({
      ticker: "ADN",
      buySideUnknown: true,
      buyQty: 0,
      buyPrice: 0,
      sellQty: 900,
      sellPrice: 900,
      pnl: 900,
    }),
  ]);

  assert.equal(outsideTotal, 1);
  assert.equal(total.pnl, 3000, "the unknown-cost row contributes nothing");
});

test("clientPortfolio: the narrow view agrees with the full one it delegates to", () => {
  const stored = [row(), row({ ticker: "ADN", pnl: -400, buyPrice: 900, sellPrice: 500 })];
  const overrides = [override()];

  const full = clientSummary(stored, overrides);
  const narrow = clientPortfolio(stored, overrides);

  assert.deepEqual(narrow.total, full.total);
  assert.equal(narrow.outsideTotal, full.outsideTotal);
  assert.deepEqual(narrow.overrideDeltas, full.overrideDeltas);
  assert.deepEqual(
    narrow.rows.map((r) => [r.ticker, r.pnl]),
    full.rows.map((r) => [r.ticker, r.pnl]),
  );
  // `heldQty` is optional on the full row and required on the narrow one, so the
  // absent case has to land as 0 rather than as undefined.
  assert.equal(narrow.rows[0].heldQty, 0);
});
