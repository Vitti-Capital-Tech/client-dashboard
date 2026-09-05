import test from "node:test";
import assert from "node:assert/strict";

import { sectorMix } from "./sector-mix.ts";
import type { ClientPortfolioRow } from "./client-portfolio.ts";

/**
 * The sector chart, over held and past holdings.
 *
 * The interesting cases are all about what a slice MEANS: a sold parcel has no
 * market value, a free option grant has no cost base, and an unclassified
 * holding must not silently become a sector called "Other" covering everything.
 */

function row(over: Partial<ClientPortfolioRow> = {}): ClientPortfolioRow {
  return {
    ticker: "EOS",
    name: "Electro Optic",
    buyQty: 1000,
    sellQty: 0,
    heldQty: 1000,
    buyPrice: 5000,
    sellOrCurrent: 8000,
    pnl: 3000,
    openPosition: true,
    type: "Equity",
    ...over,
  };
}

const SECTORS: Record<string, string> = {
  EOS: "Industrials",
  EOSXX: "Industrials", // the option, rolled up to its ordinary
  LDX: "Health Care",
  BM1: "Materials",
};
const sectorOf = (t: string) => SECTORS[t] ?? null;
const noMarket = () => null;

test("sector: held scope sizes slices by market value", () => {
  const mix = sectorMix(
    [row({ ticker: "EOS" }), row({ ticker: "LDX", buyPrice: 1000, pnl: -200 })],
    "held",
    sectorOf,
    (t) => (t === "EOS" ? 8000 : 800),
  );

  assert.deepEqual(
    mix.buckets.map((b) => [b.label, b.value]),
    [
      ["Industrials", 8000],
      ["Health Care", 800],
    ],
  );
  assert.equal(mix.total, 8800);
});

test("sector: all-time scope sizes slices by what was invested", () => {
  // Cost base, not market value — the only measure a sold parcel still has.
  const mix = sectorMix(
    [row({ ticker: "EOS", buyPrice: 5000 }), row({ ticker: "BM1", buyPrice: 2000, pnl: 500 })],
    "alltime",
    sectorOf,
    noMarket,
  );

  assert.deepEqual(
    mix.buckets.map((b) => [b.label, b.value]),
    [
      ["Industrials", 5000],
      ["Materials", 2000],
    ],
  );
});

test("sector: a sold-out holding is in all-time and out of held", () => {
  const sold = row({
    ticker: "BM1",
    openPosition: false,
    heldQty: 0,
    sellQty: 1000,
    buyPrice: 2000,
    sellOrCurrent: 3000,
    pnl: 1000,
  });

  const held = sectorMix([sold], "held", sectorOf, noMarket);
  assert.deepEqual(held.buckets, [], "nothing is held, so nothing is exposed");

  const all = sectorMix([sold], "alltime", sectorOf, noMarket);
  assert.equal(all.buckets.length, 1);
  assert.equal(all.buckets[0].label, "Materials");
  assert.equal(all.buckets[0].pnl, 1000);
});

test("sector: every slice carries its own P&L and return on cost", () => {
  const mix = sectorMix(
    [
      row({ ticker: "EOS", buyPrice: 5000, pnl: 3000 }),
      row({ ticker: "LDX", buyPrice: 1000, pnl: -400 }),
    ],
    "alltime",
    sectorOf,
    noMarket,
  );

  const ind = mix.buckets.find((b) => b.label === "Industrials")!;
  assert.equal(ind.pnl, 3000);
  assert.equal(ind.cost, 5000);
  assert.equal(ind.returnPct, 60);

  const health = mix.buckets.find((b) => b.label === "Health Care")!;
  assert.equal(health.returnPct, -40);
  assert.equal(mix.totalPnl, 2600);
});

test("sector: an option is folded into its underlying's sector", () => {
  // Exposure through a grant is exposure to the underlying, which is the
  // question a sector chart is asking.
  const mix = sectorMix(
    [
      row({ ticker: "EOS", buyPrice: 5000, pnl: 3000 }),
      row({ ticker: "EOSXX", type: "Unlisted Option", buyPrice: 0, pnl: 900 }),
    ],
    "alltime",
    sectorOf,
    noMarket,
  );

  assert.equal(mix.buckets.length, 1);
  assert.deepEqual(mix.buckets[0].tickers, ["EOS", "EOSXX"]);
  assert.equal(mix.buckets[0].pnl, 3900);
  assert.equal(mix.buckets[0].holdings, 2);
});

test("sector: a free grant keeps its P&L instead of being dropped for having no cost", () => {
  const mix = sectorMix(
    [row({ ticker: "EOSXX", type: "Unlisted Option", buyPrice: 0, pnl: 900 })],
    "alltime",
    sectorOf,
    noMarket,
  );

  assert.equal(mix.buckets.length, 1, "zero cost is not zero result");
  assert.equal(mix.buckets[0].pnl, 900);
  assert.equal(
    mix.buckets[0].returnPct,
    null,
    "a return on a cost base of nothing is Infinity, which is not a percentage",
  );
});

test("sector: an unclassified holding is 'Other', and all-Other is reported as such", () => {
  const mix = sectorMix(
    [row({ ticker: "WHO", buyPrice: 1000, pnl: 10 })],
    "alltime",
    sectorOf,
    noMarket,
  );

  assert.equal(mix.buckets[0].label, "Other");
  assert.equal(
    mix.unclassified,
    true,
    "one slice reading 'Other 100%' looks broken; the caller needs to know it is empty",
  );
});

test("sector: a partly classified portfolio is not reported as unclassified", () => {
  const mix = sectorMix(
    [
      row({ ticker: "WHO", buyPrice: 1000, pnl: 10 }),
      row({ ticker: "LDX", buyPrice: 1000, pnl: 10 }),
    ],
    "alltime",
    sectorOf,
    noMarket,
  );
  assert.equal(mix.unclassified, false);
  assert.equal(mix.buckets.length, 2);
});

test("sector: an empty portfolio is empty, not unclassified", () => {
  const mix = sectorMix([], "held", sectorOf, noMarket);
  assert.deepEqual(mix.buckets, []);
  assert.equal(mix.total, 0);
  assert.equal(mix.unclassified, false);
});

test("sector: slices are ordered largest first", () => {
  const mix = sectorMix(
    [
      row({ ticker: "LDX", buyPrice: 9000, pnl: 0 }),
      row({ ticker: "EOS", buyPrice: 1000, pnl: 0 }),
      row({ ticker: "BM1", buyPrice: 5000, pnl: 0 }),
    ],
    "alltime",
    sectorOf,
    noMarket,
  );
  assert.deepEqual(
    mix.buckets.map((b) => b.label),
    ["Health Care", "Materials", "Industrials"],
  );
});

test("sector: percentages taken against the total add up", () => {
  const mix = sectorMix(
    [
      row({ ticker: "EOS", buyPrice: 5000, pnl: 0 }),
      row({ ticker: "LDX", buyPrice: 3000, pnl: 0 }),
      row({ ticker: "BM1", buyPrice: 2000, pnl: 0 }),
    ],
    "alltime",
    sectorOf,
    noMarket,
  );
  const shares = mix.buckets.map((b) => Math.round((b.value / mix.total) * 100));
  assert.deepEqual(shares, [50, 30, 20]);
  assert.equal(
    shares.reduce((a, b) => a + b, 0),
    100,
  );
});

/**
 * Folding the long tail.
 *
 * The rule is a presentation one — sub-1% slices are swept into `Other` — so
 * every test here also checks that the arithmetic it is applied to survives it.
 */

test("sector: a sub-1% slice is folded into Other", () => {
  const rows = [
    row({ ticker: "BM1", buyPrice: 99_000, sellOrCurrent: 99_000, pnl: 0 }),
    row({ ticker: "LDX", buyPrice: 500, sellOrCurrent: 500, pnl: 0 }),
  ];
  const mix = sectorMix(rows, "alltime", sectorOf, noMarket);

  assert.deepEqual(
    mix.buckets.map((b) => b.label),
    ["Materials", "Other"],
  );
  const other = mix.buckets.find((b) => b.label === "Other");
  assert.equal(other?.value, 500);
  assert.deepEqual(other?.tickers, ["LDX"]);
  // The fold moves nothing: the total is still everything that went in.
  assert.equal(mix.total, 99_500);
});

test("sector: a folded slice keeps its P&L, cost and holdings count", () => {
  const rows = [
    row({ ticker: "BM1", buyPrice: 99_000, sellOrCurrent: 99_000, pnl: 1_000 }),
    row({ ticker: "LDX", buyPrice: 300, sellOrCurrent: 300, pnl: 120 }),
    row({ ticker: "EOS", buyPrice: 200, sellOrCurrent: 200, pnl: -20 }),
  ];
  const mix = sectorMix(rows, "alltime", sectorOf, noMarket);

  const other = mix.buckets.find((b) => b.label === "Other");
  assert.equal(other?.pnl, 100, "both tails' P&L, summed");
  assert.equal(other?.cost, 500);
  assert.equal(other?.holdings, 2);
  assert.deepEqual(other?.tickers, ["EOS", "LDX"]);
  assert.equal(other?.returnPct, 20, "return on the folded cost base");
  assert.equal(mix.totalPnl, 1_100);
});

test("sector: an unclassified holding folds in with the tail, under one label", () => {
  const rows = [
    row({ ticker: "BM1", buyPrice: 99_000, sellOrCurrent: 99_000, pnl: 0 }),
    row({ ticker: "LDX", buyPrice: 400, sellOrCurrent: 400, pnl: 0 }),
    row({ ticker: "ZZZ", buyPrice: 300, sellOrCurrent: 300, pnl: 0 }), // no sector
  ];
  const mix = sectorMix(rows, "alltime", sectorOf, noMarket);

  assert.equal(mix.buckets.filter((b) => b.label === "Other").length, 1);
  assert.equal(mix.buckets.find((b) => b.label === "Other")?.value, 700);
});

test("sector: Other sits last even when it outweighs a slice above it", () => {
  const rows = [
    row({ ticker: "BM1", buyPrice: 60_000, sellOrCurrent: 60_000, pnl: 0 }),
    row({ ticker: "ZZZ", buyPrice: 30_000, sellOrCurrent: 30_000, pnl: 0 }), // no sector
    row({ ticker: "LDX", buyPrice: 10_000, sellOrCurrent: 10_000, pnl: 0 }),
  ];
  const mix = sectorMix(rows, "alltime", sectorOf, noMarket);

  assert.deepEqual(
    mix.buckets.map((b) => b.label),
    ["Materials", "Health Care", "Other"],
  );
});

test("sector: the largest slice is never folded, however small its share", () => {
  // Every sector is 1/3 of the book, which is above the threshold anyway; the
  // guard matters for the degenerate case, so check it holds when there is only
  // one bucket and it would otherwise be compared against itself.
  const mix = sectorMix(
    [row({ ticker: "BM1", buyPrice: 100, sellOrCurrent: 100, pnl: 0 })],
    "alltime",
    sectorOf,
    noMarket,
  );
  assert.deepEqual(
    mix.buckets.map((b) => b.label),
    ["Materials"],
  );
});
