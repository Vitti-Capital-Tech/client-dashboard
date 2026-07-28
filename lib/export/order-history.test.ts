import test from "node:test";
import assert from "node:assert/strict";

import {
  buildOrderHistoryCsv,
  orderHistoryFilename,
  type ExportGroup,
} from "./order-history.ts";

const trade = (over: Partial<ExportGroup["trades"][number]> = {}) =>
  ({
    id: "t1",
    cnote: "2462073",
    accountId: "a1",
    clientId: "c1",
    code: "EOS",
    parent: "EOS",
    name: "ELECTRO OPTIC SYS.",
    instrument: "FPO",
    side: "SELL" as const,
    tradeDate: "2026-05-21",
    units: 407,
    avgPrice: 8.11,
    consideration: 3300.77,
    brokerage: 100,
    otherCharges: 0,
    gst: 10,
    value: 3190.77,
    adviser: "VIZ",
    status: "SETTLED",
    ...over,
  }) as ExportGroup["trades"][number];

const summary = (over = {}) => ({
  realizedPl: -65.23,
  proceeds: 3190.77,
  costOfSold: 3256,
  unitsSold: 407,
  fees: 110,
  tradeCount: 2,
  firstTrade: "2026-05-19",
  lastTrade: "2026-05-21",
  hasPartial: false,
  shortHistory: false,
  ...over,
});

function parse(csv: string) {
  return csv.split("\r\n").map((line) => {
    // Good enough for assertions: the fixtures below quote only whole fields.
    const out: string[] = [];
    let f = "",
      q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { f += '"'; i++; }
        else if (c === '"') q = false;
        else f += c;
      } else if (c === '"') q = true;
      else if (c === ",") { out.push(f); f = ""; }
      else f += c;
    }
    out.push(f);
    return out;
  });
}

test("csv: a SUMMARY row precedes each company's TRADE rows", () => {
  const groups: ExportGroup[] = [
    { parent: "EOS", name: "ELECTRO OPTIC SYS.", trades: [trade()], realized: summary() },
  ];
  const rows = parse(buildOrderHistoryCsv(groups));

  assert.equal(rows[0][0], "Row type");
  assert.equal(rows[1][0], "SUMMARY");
  assert.equal(rows[2][0], "TRADE");
  assert.equal(rows[1][1], "EOS");
  assert.equal(rows[2][1], "EOS", "trade rows carry the rollup ticker too");
});

test("csv: the two grains never share a money column", () => {
  const rows = parse(
    buildOrderHistoryCsv([
      { parent: "EOS", name: "ELECTRO OPTIC SYS.", trades: [trade()], realized: summary() },
    ]),
  );
  const h = rows[0];
  const valueCol = h.indexOf("Value");
  const realisedCol = h.indexOf("Realised P&L");

  // Summing "Value" must pick up trades only; summing "Realised P&L" summaries
  // only. Either column double-counting would silently inflate a report.
  assert.equal(rows[1][valueCol], "", "summary contributes nothing to Value");
  assert.equal(rows[2][realisedCol], "", "trade contributes nothing to Realised");
  assert.equal(rows[1][realisedCol], "-65.23");
  assert.equal(rows[2][valueCol], "3190.77");
});

test("csv: money keeps its cents", () => {
  const rows = parse(
    buildOrderHistoryCsv([
      {
        parent: "BKB",
        name: "BLACKBEARMINERALSLTD",
        trades: [trade({ value: 3634.8, consideration: 3634.8, brokerage: 0, gst: 0 })],
        realized: summary({ realizedPl: 3634.8, proceeds: 3634.8, costOfSold: 0 }),
      },
    ]),
  );
  const valueCol = rows[0].indexOf("Value");
  assert.equal(rows[2][valueCol], "3634.80", "never rounded to whole dollars");
});

test("csv: a company name containing a comma survives the round trip", () => {
  const rows = parse(
    buildOrderHistoryCsv([
      {
        parent: "SMI",
        name: 'SMITH, JOHN + JANE "FAMILY" TRUST',
        trades: [trade({ name: "x" })],
        realized: null,
      },
    ]),
  );
  assert.equal(rows[1][2], 'SMITH, JOHN + JANE "FAMILY" TRUST');
  assert.equal(rows[1].length, rows[0].length, "column count must not shift");
});

test("csv: the cost-basis caveat travels with the number", () => {
  const col = (csv: string) => {
    const rows = parse(csv);
    return rows[1][rows[0].indexOf("Cost basis")];
  };

  const g = (realized: ExportGroup["realized"]): ExportGroup[] => [
    { parent: "EUR", name: "EUROPEAN LITHIUM LTD", trades: [trade()], realized },
  ];

  assert.match(col(buildOrderHistoryCsv(g(summary({ shortHistory: true })))), /^MISSING/);
  assert.match(col(buildOrderHistoryCsv(g(summary({ hasPartial: true })))), /^approximate/);
  assert.equal(col(buildOrderHistoryCsv(g(summary()))), "complete");
  assert.equal(col(buildOrderHistoryCsv(g(summary({ unitsSold: 0 })))), "still open");
});

test("csv: every row has the same column count", () => {
  const rows = parse(
    buildOrderHistoryCsv([
      { parent: "EOS", name: "ELECTRO OPTIC SYS.", trades: [trade(), trade({ id: "t2" })], realized: summary() },
      { parent: "IMU", name: "IMUGENE LIMITED", trades: [trade({ id: "t3" })], realized: null },
    ]),
  );
  const width = rows[0].length;
  for (const [i, r] of rows.entries()) {
    assert.equal(r.length, width, `row ${i} has ${r.length} columns, expected ${width}`);
  }
});

test("filename: slugged, dated, and account-scoped when filtered", () => {
  assert.equal(
    orderHistoryFilename("SRI GURU NANAK PTY LTD", null, "2026-07-28"),
    "order-history-sri-guru-nanak-pty-ltd-2026-07-28.csv",
  );
  assert.equal(
    orderHistoryFilename("Smith, John", "Halloran SMSF", "2026-07-28"),
    "order-history-smith-john-halloran-smsf-2026-07-28.csv",
  );
});
