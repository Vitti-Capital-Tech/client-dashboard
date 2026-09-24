import test from "node:test";
import assert from "node:assert/strict";

import {
  allTimeRealised,
  holdingsTotals,
  netPnlFigures,
  unlistedGrantHoldings,
} from "./net-pnl.ts";
import { attributeSells } from "../data/compute.ts";
import { optionSummaryRows } from "./summary-rows.ts";
import type { Position, TradeRow } from "../data/queries";
import type { PnlSummaryRow } from "../export/order-history.ts";

/**
 * Net P&L is shown on two screens, computed on two sides of the wire. What
 * these pin is that it is the SUM of the two figures the client can see
 * itemised — realised and holdings — and that the one-call path Home uses
 * gives exactly what the Portfolio page gets by composing the pieces.
 */

function trade(over: Partial<TradeRow> = {}): TradeRow {
  return {
    id: "t1",
    cnote: "1",
    accountId: "a1",
    clientId: "c1",
    code: "LDX",
    parent: "LDX",
    name: "LUMOS",
    instrument: "FPO",
    side: "BUY",
    tradeDate: "2026-01-10",
    units: 1000,
    avgPrice: 1,
    consideration: 1000,
    brokerage: 0,
    otherCharges: 0,
    gst: 0,
    value: 1000,
    adviser: null,
    status: "SETTLED",
    ...over,
  };
}

function position(over: Partial<Position> = {}): Position {
  return {
    accountId: "a1",
    clientId: "c1",
    code: "EOS",
    parent: "EOS",
    name: "ELECTRO OPTIC",
    sector: null,
    qty: 100,
    cost: 5,
    last: 8,
    ...over,
  };
}

function row(over: Partial<PnlSummaryRow> = {}): PnlSummaryRow {
  return {
    ticker: "EOS",
    name: "ELECTRO OPTIC",
    buyQty: 1000,
    sellQty: 0,
    heldQty: 1000,
    buyPrice: 5000,
    sellOrCurrent: 8000,
    pnl: 3000,
    openPosition: true,
    type: "Open",
    flagged: false,
    edited: false,
    overridden: { buyQty: false, sellQty: false, buyPrice: false, sellOrCurrent: false },
    note: null,
    computed: { buyQty: 1000, sellQty: 0, buyPrice: 5000, sellOrCurrent: 8000, pnl: 3000 },
    ...over,
  };
}

/** A grant the recompute priced: nothing paid, carried at $600. */
const grant = row({
  ticker: "EOSO-UO",
  name: "EOS unlisted options",
  buyQty: 3000,
  buyPrice: 0,
  sellOrCurrent: 600,
  pnl: 600,
  type: "Unlisted Option",
  isUnlistedOption: true,
});

const roundTrip = [
  trade({ id: "b", cnote: "1", side: "BUY", tradeDate: "2026-01-10", units: 1000, value: 1000 }),
  trade({ id: "s", cnote: "2", side: "SELL", tradeDate: "2026-03-10", units: 1000, value: 1500 }),
];

test("net-pnl: realised is the whole ledger, first sale to last", () => {
  const sells = attributeSells([
    ...roundTrip,
    trade({ id: "b2", cnote: "3", code: "EOS", parent: "EOS", side: "BUY", tradeDate: "2026-02-01", units: 100, value: 500 }),
    trade({ id: "s2", cnote: "4", code: "EOS", parent: "EOS", side: "SELL", tradeDate: "2026-08-01", units: 100, value: 400 }),
  ]);
  // LDX +500, EOS -100: both sales, months apart, are inside "all time".
  assert.equal(allTimeRealised(sells), 400);
});

test("net-pnl: no sales is zero realised, not a failure", () => {
  assert.equal(allTimeRealised([]), 0);
});

test("net-pnl: a desk correction reaches the realised figure", () => {
  const sells = attributeSells(roundTrip);
  assert.equal(allTimeRealised(sells, new Map([["LDX", -200]])), 300);
});

test("net-pnl: holdings count listed positions AND unlisted grants", () => {
  /**
   * The grant has no contract note and no snapshot line; leaving it out made
   * the Holdings total disagree with the P&L by exactly what was granted.
   */
  const unlisted = unlistedGrantHoldings(optionSummaryRows([row(), grant]));
  assert.equal(unlisted.length, 1);
  assert.equal(unlisted[0].code, "EOSO-UO");

  const totals = holdingsTotals([position()], unlisted);
  // Listed: 100 × $8 − 100 × $5 = $300. Grant: $600 − $0.
  assert.deepEqual(totals, { value: 1400, cost: 500, pnl: 900 });
});

test("net-pnl: a position with no price is valued at zero, not skipped", () => {
  // Matches the Holdings table, which shows the same row with no last price.
  const totals = holdingsTotals([position({ last: null })], []);
  assert.equal(totals.value, 0);
  assert.equal(totals.pnl, -500);
});

test("net-pnl: the total is exactly realised + holdings", () => {
  const net = netPnlFigures({
    trades: roundTrip,
    offLedger: [],
    overrideDeltas: [],
    positions: [position()],
    summaryRows: [row(), grant],
  });
  assert.deepEqual(net, { realised: 500, holdings: 900, net: 1400 });
});

test("net-pnl: Home's one call equals the Portfolio page's composed pieces", () => {
  /**
   * The reason this module exists. Home calls `netPnlFigures`; the Portfolio
   * page composes `allTimeRealised` + `holdingsTotals` itself for its tabs. If
   * the two ever diverge, the client sees two totals on two screens.
   */
  const trades = roundTrip;
  const positions = [position(), position({ code: "LDX", parent: "LDX", qty: 50, cost: 1, last: 0.5 })];
  const summaryRows = [row(), grant];
  const overrideDeltas: [string, number][] = [["LDX", 75]];

  const home = netPnlFigures({ trades, offLedger: [], overrideDeltas, positions, summaryRows });

  const portfolioRealised = allTimeRealised(attributeSells(trades, []), new Map(overrideDeltas));
  const portfolioHoldings = holdingsTotals(
    positions,
    unlistedGrantHoldings(optionSummaryRows(summaryRows)),
  ).pnl;

  assert.equal(home.realised, portfolioRealised);
  assert.equal(home.holdings, portfolioHoldings);
  assert.equal(home.net, portfolioRealised + portfolioHoldings);
});
