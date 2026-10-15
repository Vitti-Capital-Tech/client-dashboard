import assert from "node:assert/strict";
import { test } from "node:test";
import {
  priceRiseDue,
  priceRiseText,
  runPriceRise,
  tradedToday,
  type OpenQuote,
} from "./price-rise.ts";
import type { GraphCall } from "./tracker-writer.ts";

test("price rise: open against issue price, signed, to two places", () => {
  assert.equal(priceRiseText(0.007, 0.009), "$0.0090 (+28.57%)");
  assert.equal(priceRiseText(0.041, 0.033), "$0.0330 (-19.51%)");
  assert.equal(priceRiseText(0.1, 0.1), "$0.1000 (0.00%)");
  assert.equal(priceRiseText(1.2, 1.5), "$1.50 (+25.00%)");
});

test("price rise: an open counts only when the last trade printed today, Sydney", () => {
  // 15 Oct 2026 12:24pm AEDT.
  assert.equal(tradedToday("2026-10-15T01:24:26.000Z", "2026-10-15"), true);
  // 14 Oct 2026 2:22pm AEDT — yesterday's open, still quoted by Yahoo.
  assert.equal(tradedToday("2026-10-14T03:22:04.000Z", "2026-10-15"), false);
  assert.equal(tradedToday(null, "2026-10-15"), false);
});

test("price rise: due on the 12pm Sydney tick of a trading day only", () => {
  const always = () => true;
  // Thu 15 Oct 2026, AEDT (UTC+11).
  assert.equal(priceRiseDue(new Date("2026-10-15T01:00:00Z"), always), true, "12:00pm");
  assert.equal(priceRiseDue(new Date("2026-10-15T01:10:00Z"), always), false, "12:10pm");
  assert.equal(priceRiseDue(new Date("2026-10-15T00:00:00Z"), always), false, "11:00am");
  assert.equal(priceRiseDue(new Date("2026-10-15T01:00:00Z"), () => false), false, "holiday");
});

/** Overview C..M as Graph returns it: ticker, …, Issue Price at H, Price Rise at M. */
function overviewRow(ticker: string, issue: unknown, priceRise = ""): unknown[] {
  return [ticker, "", "", "", "", issue, "", "", "", "", priceRise];
}

function fakeGraph(rows: unknown[][]) {
  const writes: { path: string; body: unknown }[] = [];
  const graph: GraphCall = async (path, init) => {
    if (init?.method === "PATCH") {
      writes.push({ path, body: init.body });
      return { ok: true, status: 200, body: {} };
    }
    assert.match(path, /2026%20Overview.*C4:M400/);
    return { ok: true, status: 200, body: { values: rows, formulas: rows } };
  };
  return { graph, writes };
}

test("price rise: one write of column M, keeping cells it has nothing new for", async () => {
  const { graph, writes } = fakeGraph([
    overviewRow("AAU", 0.007),
    overviewRow("GG1", 0.1, "$0.0900 (-10.00%)"), // no trade today
    overviewRow("Yatima", 0.05, "by hand"), // private deal
    overviewRow("OD6", "#DIV/0!"), // no issue price
    overviewRow("ZZZ", 0.2), // no quote
    overviewRow("", ""),
    overviewRow("", ""),
  ]);
  const quotes = new Map<string, OpenQuote>([
    ["AAU", { open: 0.009, tradedAt: "2026-10-15T01:24:26.000Z" }],
    ["GG1", { open: 0.085, tradedAt: "2026-10-14T03:22:04.000Z" }],
  ]);
  const report = await runPriceRise({
    today: "2026-10-15",
    graph,
    target: { driveId: "d", itemId: "i", overviewSheet: "2026 Overview" },
    quotes: async (codes) => {
      assert.deepEqual(codes, ["AAU", "GG1", "ZZZ"]);
      return quotes;
    },
  });

  assert.equal(report.rows, 5);
  assert.equal(report.updated, 1);
  assert.deepEqual(report.noTradeToday, ["GG1"]);
  assert.deepEqual(report.noQuote, ["ZZZ"]);

  assert.equal(writes.length, 1);
  assert.match(writes[0].path, /range\(address='M4:M8'\)/);
  assert.deepEqual(writes[0].body, {
    formulas: [["$0.0090 (+28.57%)"], ["$0.0900 (-10.00%)"], ["by hand"], [""], [""]],
  });
});

test("price rise: nothing to update means nothing is written", async () => {
  const { graph, writes } = fakeGraph([overviewRow("GG1", 0.1)]);
  const report = await runPriceRise({
    today: "2026-10-15",
    graph,
    target: { driveId: "d", itemId: "i", overviewSheet: "2026 Overview" },
    quotes: async () => new Map(),
  });
  assert.equal(report.updated, 0);
  assert.equal(writes.length, 0);
});
