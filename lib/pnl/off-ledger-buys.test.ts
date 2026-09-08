import test from "node:test";
import assert from "node:assert/strict";

import {
  offLedgerBuyLines,
  type StoredBuySide,
  type LedgerBuySide,
} from "./off-ledger-buys.ts";
import { replayLedger, type LedgerLine } from "../import/trades.ts";

/**
 * A placement reaches a client as a SALE with no matching purchase — it is
 * transacted through the house account and journalled out, so no client
 * contract note exists. The stored recompute fills that buy side in from the
 * Placement Tracker; the dated realised window replays the raw ledger and could
 * not see it, so it costed those sales at zero and told the client their cost
 * base was "not on file" while the table beside it showed the real cost.
 *
 * These tests are about the recovery: what the difference between the two
 * sources is, and — the part that actually matters — that feeding it back into
 * the replay produces the cost the stored rows already agreed on.
 */

function stored(over: Partial<StoredBuySide> = {}): StoredBuySide {
  return {
    ticker: "HYD",
    parentTicker: "HYD",
    buyQty: 1_280_953,
    buyPrice: 6_405,
    ...over,
  };
}

function trade(over: Partial<LedgerBuySide> = {}): LedgerBuySide {
  return {
    parent: "HYD",
    side: "SELL",
    tradeDate: "2026-05-14",
    units: 1_280_953,
    value: 11_402,
    status: "SETTLED",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// What the difference recovers
// ---------------------------------------------------------------------------

test("off-ledger: a placement with no contract note is recovered in full", () => {
  const lines = offLedgerBuyLines([stored()], [trade()]);

  assert.equal(lines.length, 1);
  assert.equal(lines[0].parent, "HYD");
  assert.equal(lines[0].side, "BUY");
  assert.equal(lines[0].units, 1_280_953);
  assert.equal(lines[0].value, 6_405);
  assert.equal(lines[0].status, "SETTLED");
});

test("off-ledger: a book the ledger already accounts for recovers nothing", () => {
  // Bought on-market: the stored buy side IS the ledger's buy side, so there is
  // no gap and nothing must be added — adding it would double the cost.
  const lines = offLedgerBuyLines(
    [stored({ ticker: "VR1", parentTicker: "VR1", buyQty: 130_400, buyPrice: 8_696 })],
    [
      trade({ parent: "VR1", side: "BUY", tradeDate: "2025-11-03", units: 130_400, value: 8_696 }),
      trade({ parent: "VR1", side: "SELL", tradeDate: "2026-04-02", units: 130_400, value: 3_020 }),
    ],
  );
  assert.deepEqual(lines, []);
});

test("off-ledger: a SHORT buy side is capped at what the ledger cannot cost", () => {
  // Some buys are recorded and a placement supplied the rest. The tracker's
  // parcel is 600,000 units, but only 500,000 were sold without cost behind
  // them — the other 100,000 are still held and need no cost to value a SALE.
  //
  // The whole $5,000 goes onto the 500,000, rather than being spread pro-rata.
  // That front-loads cost slightly onto the sold units, which is the
  // conservative direction for a client-facing profit figure, and it is what
  // keeps a placement whose option row is untraded from diluting itself — see
  // the cap's own note.
  const lines = offLedgerBuyLines(
    [stored({ ticker: "X2M", parentTicker: "X2M", buyQty: 1_000_000, buyPrice: 9_000 })],
    [
      trade({ parent: "X2M", side: "BUY", tradeDate: "2025-06-01", units: 400_000, value: 4_000 }),
      trade({ parent: "X2M", side: "SELL", tradeDate: "2026-03-01", units: 900_000, value: 12_000 }),
    ],
  );

  assert.equal(lines.length, 1);
  assert.equal(lines[0].units, 500_000);
  assert.equal(lines[0].value, 5_000);
});

test("off-ledger: a traded free grant recovers UNITS at ZERO value", () => {
  // The distinction the whole flag turns on: a free option's cost is zero, not
  // unknown. Recovering the units at no value is what lets the replay say so.
  const lines = offLedgerBuyLines(
    [stored({ ticker: "HYDOC", parentTicker: "HYD", buyQty: 600_000, buyPrice: 0 })],
    [trade({ parent: "HYD", side: "SELL", units: 600_000, value: 600 })],
  );

  assert.equal(lines.length, 1);
  assert.equal(lines[0].units, 600_000);
  assert.equal(lines[0].value, 0);
});

test("off-ledger: an UNTRADED option row does not dilute the shares' cost", () => {
  // The regression the cap exists for. `HYDOC` sits in the stored figures with
  // 1,280,953 units at zero value, and never appears in the ledger — nothing
  // was ever sold under it. Recovering those units anyway put them in the
  // parent's pool, where weighted-average cost spread the shares' $6,405 across
  // twice as many units and reported the sale at $3,202.
  //
  // The ledger is short of exactly the 1,280,953 shares it sold, so that is all
  // that is recovered, and the whole $6,405 lands on them.
  const lines = offLedgerBuyLines(
    [
      stored({ ticker: "HYD", parentTicker: "HYD", buyQty: 1_280_953, buyPrice: 6_405 }),
      stored({ ticker: "HYDOC", parentTicker: "HYD", buyQty: 1_280_953, buyPrice: 0 }),
    ],
    [trade({ parent: "HYD", side: "SELL", units: 1_280_953, value: 11_402 })],
  );

  assert.equal(lines.length, 1);
  assert.equal(lines[0].units, 1_280_953);
  assert.equal(lines[0].value, 6_405);
});

test("off-ledger: a fully-accounted parent is left alone even with an option row", () => {
  // Bought on-market, sold on-market, cost already correct — plus a free option
  // row the ledger never traded. Three holdings on one real account lost half
  // their cost to exactly this shape. The ledger is short of nothing, so
  // nothing is recovered.
  const lines = offLedgerBuyLines(
    [
      stored({ ticker: "WHK", parentTicker: "WHK", buyQty: 357_143, buyPrice: 5_000 }),
      stored({ ticker: "WHK-UO", parentTicker: "WHK", buyQty: 357_143, buyPrice: 0 }),
    ],
    [
      trade({ parent: "WHK", side: "BUY", tradeDate: "2025-07-01", units: 357_143, value: 5_000 }),
      trade({ parent: "WHK", side: "SELL", tradeDate: "2026-01-20", units: 357_143, value: 6_200 }),
    ],
  );
  assert.deepEqual(lines, []);
});

test("off-ledger: rolled up per PARENT, matching how the replay pools", () => {
  // `HYD` and `HYDOC` share one pool in the replay on purpose, so a placement
  // bought as one code and sold as another nets out. The difference has to be
  // taken at the same grain or the option row's units sit unexplained inside a
  // pool that already absorbed them. Here BOTH legs trade, so both are short
  // and both are recovered.
  const lines = offLedgerBuyLines(
    [
      stored({ ticker: "HYD", parentTicker: "HYD", buyQty: 800_000, buyPrice: 4_000 }),
      stored({ ticker: "HYDOC", parentTicker: "HYD", buyQty: 800_000, buyPrice: 0 }),
    ],
    [trade({ parent: "HYD", side: "SELL", units: 1_600_000, value: 8_459 })],
  );

  assert.equal(lines.length, 1);
  assert.equal(lines[0].units, 1_600_000);
  assert.equal(lines[0].value, 4_000);
});

test("off-ledger: a ledger holding MORE than the stored row subtracts nothing", () => {
  // A negative difference is not a negative purchase. It means the merge left
  // this row alone, or a correction reduced it — either way the answer is to add
  // nothing rather than to eat into a real recorded buy.
  const lines = offLedgerBuyLines(
    [stored({ ticker: "14D", parentTicker: "14D", buyQty: 0, buyPrice: 0 })],
    [
      trade({ parent: "14D", side: "BUY", tradeDate: "2025-09-10", units: 209_524, value: 8_800 }),
      trade({ parent: "14D", side: "SELL", units: 628_572, value: 21_120 }),
    ],
  );
  assert.deepEqual(lines, []);
});

test("off-ledger: a value with no units behind it is not invented into a parcel", () => {
  const lines = offLedgerBuyLines(
    [stored({ buyQty: 100, buyPrice: 5_000 })],
    [trade({ side: "BUY", tradeDate: "2025-01-01", units: 100, value: 1_000 })],
  );
  assert.deepEqual(lines, []);
});

test("off-ledger: unsettled ledger rows are ignored, as the replay ignores them", () => {
  // A cancelled or reversed note never moved money. Counting it as a recorded
  // buy would shrink the gap and leave part of a real sale uncosted.
  const lines = offLedgerBuyLines(
    [stored({ buyQty: 500, buyPrice: 2_000 })],
    [
      trade({ side: "BUY", tradeDate: "2025-01-01", units: 500, value: 2_000, status: "CANCELLED" }),
      trade({ units: 500, value: 3_000 }),
    ],
  );

  assert.equal(lines.length, 1);
  assert.equal(lines[0].units, 500);
  assert.equal(lines[0].value, 2_000);
});

test("off-ledger: a parent with no trades at all yields nothing to cost", () => {
  // Still held, never sold: there is no sale for a recovered parcel to serve,
  // and no date to place it on either.
  const lines = offLedgerBuyLines([stored()], []);
  assert.deepEqual(lines, []);
});

test("off-ledger: `parentTicker` null falls back to the row's own code", () => {
  const lines = offLedgerBuyLines(
    [stored({ ticker: "PRS", parentTicker: null, buyQty: 200_000, buyPrice: 3_000 })],
    [trade({ parent: "PRS", side: "SELL", units: 200_000, value: 3_290 })],
  );
  assert.equal(lines.length, 1);
  assert.equal(lines[0].parent, "PRS");
});

// ---------------------------------------------------------------------------
// The point of it: the replay's answer changes, and to the right number
// ---------------------------------------------------------------------------

/** The screenshot's real row, as the ledger alone carries it. */
const HYD_LEDGER: LedgerLine[] = [
  {
    scope: "",
    parent: "HYD",
    cnote: "2571139",
    side: "SELL",
    tradeDate: "2026-05-14",
    units: 1_280_953,
    value: 11_402,
    status: "SETTLED",
    fees: 0,
  },
];

test("replay: without the recovered parcel the sale is uncosted — the bug", () => {
  const { sells } = replayLedger(HYD_LEDGER);

  assert.equal(sells.length, 1);
  assert.equal(sells[0].costOfSold, 0);
  assert.equal(sells[0].realizedPl, 11_402, "the whole sale booked as profit");
  assert.equal(sells[0].noCostBasis, true, '"cost base not on file"');
});

test("replay: with it, the cost is the one the stored rows already agreed on", () => {
  const recovered = offLedgerBuyLines(
    [stored()],
    [
      {
        parent: "HYD",
        side: "SELL",
        tradeDate: "2026-05-14",
        units: 1_280_953,
        value: 11_402,
        status: "SETTLED",
      },
    ],
  );

  const { sells } = replayLedger([...HYD_LEDGER, ...recovered]);

  assert.equal(sells.length, 1);
  assert.equal(sells[0].costOfSold, 6_405);
  // 11,402 − 6,405. The figure the P&L-by-company table was already showing.
  assert.equal(sells[0].realizedPl, 4_997);
  assert.equal(sells[0].noCostBasis, false, "no warning, because nothing is missing");
});

test("replay: the recovered parcel is placed before the sale it has to cost", () => {
  // It carries no date of its own, so it is placed on the earliest date the
  // parent appears at all, with an empty contract note so it sorts first within
  // that date. Same-day is the case that would break: cost has to be in the
  // pool before the sale, not after it.
  const sameDay: LedgerBuySide[] = [
    { parent: "IXR", side: "SELL", tradeDate: "2026-02-10", units: 625_000, value: 9_780, status: "SETTLED" },
  ];
  const recovered = offLedgerBuyLines(
    [{ ticker: "IXR", parentTicker: "IXR", buyQty: 625_000, buyPrice: 10_000 }],
    sameDay,
  );

  assert.equal(recovered[0].tradeDate, "2026-02-10");
  assert.equal(recovered[0].cnote, "");

  const { sells } = replayLedger([
    {
      scope: "",
      parent: "IXR",
      cnote: "2500001",
      side: "SELL",
      tradeDate: "2026-02-10",
      units: 625_000,
      value: 9_780,
      status: "SETTLED",
      fees: 0,
    },
    ...recovered,
  ]);

  assert.equal(sells[0].costOfSold, 10_000);
  assert.equal(sells[0].realizedPl, -220);
  assert.equal(sells[0].noCostBasis, false);
});

test("replay: a free grant's sale is costed at zero, and not warned about", () => {
  const recovered = offLedgerBuyLines(
    [{ ticker: "HYDOC", parentTicker: "HYD", buyQty: 600_000, buyPrice: 0 }],
    [{ parent: "HYD", side: "SELL", tradeDate: "2026-06-01", units: 600_000, value: 600, status: "SETTLED" }],
  );

  const { sells } = replayLedger([
    {
      scope: "",
      parent: "HYD",
      cnote: "2600001",
      side: "SELL",
      tradeDate: "2026-06-01",
      units: 600_000,
      value: 600,
      status: "SETTLED",
      fees: 0,
    },
    ...recovered,
  ]);

  assert.equal(sells[0].costOfSold, 0);
  assert.equal(sells[0].realizedPl, 600);
  // The whole point: nothing was paid, so nothing is MISSING.
  assert.equal(sells[0].noCostBasis, false);
});

test("replay: a genuinely unknown cost still warns", () => {
  // The export starts at 2023-10-30. A parcel bought before that has no buy
  // anywhere — not in the ledger and not in a tracker — and the flag has to
  // keep firing, or the fix would have replaced a wrong number with a silent one.
  const recovered = offLedgerBuyLines(
    [{ ticker: "OLD", parentTicker: "OLD", buyQty: 0, buyPrice: 0 }],
    [{ parent: "OLD", side: "SELL", tradeDate: "2024-01-15", units: 10_000, value: 5_000, status: "SETTLED" }],
  );
  assert.deepEqual(recovered, []);

  const { sells } = replayLedger([
    {
      scope: "",
      parent: "OLD",
      cnote: "2300001",
      side: "SELL",
      tradeDate: "2024-01-15",
      units: 10_000,
      value: 5_000,
      status: "SETTLED",
      fees: 0,
    },
  ]);

  assert.equal(sells[0].noCostBasis, true);
});
