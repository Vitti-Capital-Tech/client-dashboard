import assert from "node:assert/strict";
import { test } from "node:test";
import { asxCode, priceRiseDue, priceRiseText, runPriceRise, type SessionOpen } from "./price-rise.ts";
import { excelSerialDate } from "./tracker-format.ts";
import type { GraphCall } from "./tracker-writer.ts";

const serial = (iso: string) => excelSerialDate(iso)!;

test("price rise: open against issue price, signed, to two places", () => {
  assert.equal(priceRiseText(0.007, 0.009), "$0.0090 (+28.57%)");
  assert.equal(priceRiseText(0.041, 0.033), "$0.0330 (-19.51%)");
  assert.equal(priceRiseText(0.1, 0.1), "$0.1000 (0.00%)");
  assert.equal(priceRiseText(1.2, 1.5), "$1.500 (+25.00%)");
  // EIQ, 6 Jul 2026: a half-cent tick above a dollar must not print as $1.60.
  assert.equal(priceRiseText(1.45, 1.605), "$1.605 (+10.69%)");
});

test("price rise: repeat raises are read by their code, private deals are not", () => {
  assert.equal(asxCode("PV1 (a)"), "PV1");
  assert.equal(asxCode("CC9 (b)"), "CC9");
  assert.equal(asxCode("L1M(T2)"), "L1M");
  assert.equal(asxCode("AAU"), "AAU");
  assert.equal(asxCode("Yatima"), null);
  assert.equal(asxCode(""), null);
});

test("price rise: due on the 12pm Sydney tick of a trading day only", () => {
  const always = () => true;
  // Thu 15 Oct 2026, AEDT (UTC+11).
  assert.equal(priceRiseDue(new Date("2026-10-15T01:00:00Z"), always), true, "12:00pm");
  assert.equal(priceRiseDue(new Date("2026-10-15T01:10:00Z"), always), false, "12:10pm");
  assert.equal(priceRiseDue(new Date("2026-10-15T00:00:00Z"), always), false, "11:00am");
  assert.equal(priceRiseDue(new Date("2026-10-15T01:00:00Z"), () => false), false, "holiday");
});

/** Overview C..M as Graph returns it: ticker, …, Settlement Date at F, Issue Price at H, Price Rise at M. */
function overviewRow(ticker: string, settlement: string | "", issue: unknown, priceRise = ""): unknown[] {
  return [ticker, "", "", settlement ? serial(settlement) : "", "", issue, "", "", "", "", priceRise];
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

const target = { driveId: "d", itemId: "i", overviewSheet: "2026 Overview" };

test("price rise: settlement-day open, written once, everything else left as it was", async () => {
  const { graph, writes } = fakeGraph([
    overviewRow("AAU", "2026-10-08", 0.007), // settled, empty → filled
    overviewRow("P1E", "2026-10-08", 0.041, "$0.0400 (-2.44%)"), // already filled → untouched
    overviewRow("CVB", "2026-10-26", 0.05), // settles later → not yet
    overviewRow("Yatima", "2026-10-08", 0.05, "by hand"), // private deal
    overviewRow("OD6", "2026-10-09", "#DIV/0!"), // no issue price
    overviewRow("TOR", "2026-10-15", 0.19), // settles today, no bar yet → pending
    overviewRow("", "", ""),
  ]);
  const asked: string[] = [];
  const opens = new Map<string, SessionOpen>([["AAU", { open: 0.007, on: "2026-10-08" }]]);

  const report = await runPriceRise({
    today: "2026-10-15",
    graph,
    target,
    openFrom: async (code, from) => {
      asked.push(`${code}@${from}`);
      return opens.get(code) ?? null;
    },
  });

  assert.deepEqual(asked.sort(), ["AAU@2026-10-08", "TOR@2026-10-15"]);
  assert.equal(report.rows, 6);
  assert.deepEqual(report.updated, [
    { ticker: "AAU", settlementDate: "2026-10-08", openOn: "2026-10-08", text: "$0.0070 (0.00%)" },
  ]);
  assert.deepEqual(report.pending, [{ ticker: "TOR", settlementDate: "2026-10-15" }]);

  // Only the cell it filled — nothing it merely read is written back.
  assert.equal(writes.length, 1);
  assert.match(writes[0].path, /range\(address='M4:M4'\)/);
  assert.deepEqual(writes[0].body, { formulas: [["$0.0070 (0.00%)"]] });
});

test("price rise: adjacent fills share a write, a gap starts another", async () => {
  const { graph, writes } = fakeGraph([
    overviewRow("AAU", "2026-10-08", 0.007),
    overviewRow("P1E", "2026-10-08", 0.041),
    overviewRow("GG1", "2026-10-07", 0.1, "$0.0990 (-1.00%)"),
    overviewRow("TOR", "2026-10-15", 0.19),
  ]);
  const report = await runPriceRise({
    today: "2026-10-15",
    graph,
    target,
    openFrom: async (code, from) => ({ open: code === "P1E" ? 0.04 : 0.185, on: from }),
  });
  assert.equal(report.updated.length, 3);
  assert.deepEqual(
    writes.map((w) => /address='([^']+)'/.exec(w.path)?.[1]),
    ["M4:M5", "M7:M7"],
  );
});

test("price rise: a lookup that throws leaves the row pending rather than failing the run", async () => {
  const { graph, writes } = fakeGraph([overviewRow("AAU", "2026-10-08", 0.007)]);
  const report = await runPriceRise({
    today: "2026-10-15",
    graph,
    target,
    openFrom: async () => {
      throw new Error("Yahoo 429");
    },
  });
  assert.deepEqual(report.pending, [{ ticker: "AAU", settlementDate: "2026-10-08" }]);
  assert.equal(writes.length, 0);
});
