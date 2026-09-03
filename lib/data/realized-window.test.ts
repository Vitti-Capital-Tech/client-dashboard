import test from "node:test";
import assert from "node:assert/strict";

import { realizedBetween, monthsBack } from "./compute.ts";
import type { SellAttribution } from "../import/trades.ts";

/**
 * The client's "P&L from this date to that date".
 *
 * What is actually at risk here is not the addition. It is the boundaries — a
 * sale on the last day of the range either counts or it does not, and either
 * answer is defensible until someone writes it down — and the interaction with
 * the desk's per-ticker corrections, which carry no date and so have to be
 * spread across a company's sales before any window is taken.
 */

function sell(
  parent: string,
  tradeDate: string,
  realizedPl: number,
  opts: Partial<SellAttribution> = {},
): SellAttribution {
  return {
    scope: "",
    parent,
    cnote: `${parent}-${tradeDate}`,
    tradeDate,
    units: 100,
    proceeds: 1000,
    costOfSold: 1000 - realizedPl,
    realizedPl,
    noCostBasis: false,
    ...opts,
  };
}

const SELLS = [
  sell("LDX", "2026-01-15", 100),
  sell("EOS", "2026-03-01", 200),
  sell("EOS", "2026-03-31", 400),
  sell("BM1", "2026-04-01", 800),
  sell("LDX", "2026-06-30", 1600),
];

test("window: both ends are inclusive", () => {
  // The whole point of a date picker is that the dates you type are in it.
  const w = realizedBetween(SELLS, "2026-03-01", "2026-03-31");
  assert.equal(w.realizedPl, 600, "1 March and 31 March both count");
  assert.equal(w.saleCount, 2);
});

test("window: a day either side is excluded", () => {
  const w = realizedBetween(SELLS, "2026-03-02", "2026-03-30");
  assert.equal(w.realizedPl, 0);
  assert.equal(w.saleCount, 0);
  assert.deepEqual(w.contributors, []);
});

test("window: swapped bounds are read as the range meant, not as nothing", () => {
  const forward = realizedBetween(SELLS, "2026-01-01", "2026-12-31");
  const backward = realizedBetween(SELLS, "2026-12-31", "2026-01-01");
  assert.equal(backward.realizedPl, forward.realizedPl);
  assert.equal(backward.from, "2026-01-01", "the window reports itself in order");
  assert.equal(backward.to, "2026-12-31");
});

test("window: contributors roll several sales of one company into one line", () => {
  const w = realizedBetween(SELLS, "2026-01-01", "2026-12-31");
  const eos = w.contributors.find((c) => c.parent === "EOS")!;
  assert.equal(eos.realizedPl, 600);
  assert.equal(eos.saleCount, 2);
  assert.equal(eos.units, 200);
});

test("window: contributors are ordered by the SIZE of the result", () => {
  // Not by profit: a loss of $2,000 is the more important line on the screen
  // than a gain of $100, and sorting signed would bury it at the bottom.
  const withLoss = [...SELLS, sell("ZZZ", "2026-05-01", -5000)];
  const w = realizedBetween(withLoss, "2026-01-01", "2026-12-31");
  assert.equal(w.contributors[0].parent, "ZZZ");
});

test("window: totals are the sum of the parts", () => {
  const w = realizedBetween(SELLS, "2026-01-01", "2026-12-31");
  assert.equal(
    w.realizedPl,
    w.contributors.reduce((n, c) => n + c.realizedPl, 0),
  );
  assert.equal(w.realizedPl, 3100);
  assert.equal(w.saleCount, 5);
});

test("window: a sale with no cost basis is flagged rather than quietly counted", () => {
  const w = realizedBetween(
    [sell("NEW", "2026-02-10", 900, { noCostBasis: true, costOfSold: 0 })],
    "2026-01-01",
    "2026-12-31",
  );
  assert.equal(w.hasUncosted, true, "that $900 is proceeds, not profit");
  assert.equal(w.contributors[0].noCostBasis, true);
});

test("window: an empty range reports zero, not a crash", () => {
  const w = realizedBetween([], "2026-01-01", "2026-12-31");
  assert.equal(w.realizedPl, 0);
  assert.equal(w.saleCount, 0);
  assert.equal(w.hasUncosted, false);
});

// ---------------------------------------------------------------------------
// Desk corrections, which have no date of their own
// ---------------------------------------------------------------------------

test("window: an override is spread pro-rata by units across a company's sales", () => {
  // EOS sold 100 units in each of two March sales, so a +$1,000 correction is
  // $500 against each.
  const deltas = new Map([["EOS", 1000]]);
  const first = realizedBetween(SELLS, "2026-03-01", "2026-03-01", deltas);
  assert.equal(first.realizedPl, 700, "200 + half of the 1,000 correction");

  const both = realizedBetween(SELLS, "2026-03-01", "2026-03-31", deltas);
  assert.equal(both.realizedPl, 1600, "600 + the whole correction");
});

test("window: the pro-rata weights come from the FULL history, not the window", () => {
  // This is the trap. LDX sold 100 units in January and 100 in June. A window
  // covering only January must carry HALF of an LDX correction — the half that
  // belongs to the January sale — and not all of it, which is what re-deriving
  // the weights inside the window would produce.
  const deltas = new Map([["LDX", 400]]);
  const jan = realizedBetween(SELLS, "2026-01-01", "2026-01-31", deltas);
  assert.equal(jan.realizedPl, 300, "100 + 200, not 100 + 400");
});

test("window: a correction on a company with no sales changes nothing", () => {
  // Correcting an unsold position moves unrealised P&L, and nothing unrealised
  // belongs on a realised figure.
  const deltas = new Map([["NEVERSOLD", 10_000]]);
  const w = realizedBetween(SELLS, "2026-01-01", "2026-12-31", deltas);
  assert.equal(w.realizedPl, 3100);
});

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

test("monthsBack: an ordinary month walk", () => {
  assert.deepEqual(monthsBack("2026-06-12", 3), {
    from: "2026-03-12",
    to: "2026-06-12",
  });
});

test("monthsBack: crossing the year boundary", () => {
  assert.deepEqual(monthsBack("2026-02-10", 3), {
    from: "2025-11-10",
    to: "2026-02-10",
  });
  assert.deepEqual(monthsBack("2026-06-12", 12), {
    from: "2025-06-12",
    to: "2026-06-12",
  });
});

test("monthsBack: a 31st clamps instead of rolling into the next month", () => {
  // `setMonth` would answer 3 March here, which is a month a client did not ask
  // for and three extra days of sales in the range.
  assert.deepEqual(monthsBack("2026-03-31", 1), {
    from: "2026-02-28",
    to: "2026-03-31",
  });
  assert.deepEqual(monthsBack("2024-03-31", 1), {
    from: "2024-02-29",
    to: "2024-03-31",
  });
  assert.deepEqual(monthsBack("2026-05-31", 1), {
    from: "2026-04-30",
    to: "2026-05-31",
  });
});
