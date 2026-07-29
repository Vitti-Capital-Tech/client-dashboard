import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPnlSummary,
  buildPnlSummaryCsv,
  grandTotal,
  pnlSummaryFilename,
  type ExportGroup,
  type HeldPosition,
} from "./order-history.ts";

const summary = (over = {}) => ({
  realizedPl: 0,
  proceeds: 0,
  costOfSold: 0,
  unitsSold: 0,
  fees: 0,
  tradeCount: 0,
  firstTrade: null,
  lastTrade: null,
  hasPartial: false,
  shortHistory: false,
  unitsBought: 0,
  ...over,
});

const group = (
  parent: string,
  realized: ReturnType<typeof summary> | null,
  name = `${parent} CO`,
): ExportGroup => ({ parent, name, trades: [], realized });

const held = (over: Partial<HeldPosition> = {}): HeldPosition => ({
  qty: 100,
  costBase: 1000,
  marketValue: 1200,
  hasPrice: true,
  ...over,
});

// ---------------------------------------------------------------------------
// The two halves
// ---------------------------------------------------------------------------

test("summary: sold half comes from the ledger, held half from the snapshot", () => {
  // Bought 1,000 for $2,000; sold 400 (cost $800) for $1,000; 600 still held
  // at a $1,200 cost base, now worth $1,500.
  const [r] = buildPnlSummary(
    [group("LDX", summary({ unitsBought: 1000, unitsSold: 400, proceeds: 1000, costOfSold: 800 }))],
    new Map([["LDX", held({ qty: 600, costBase: 1200, marketValue: 1500 })]]),
  );

  assert.equal(r.buyPrice, 2000, "cost of sold + cost base of held");
  assert.equal(r.sellOrCurrent, 2500, "proceeds + market value of held");
  assert.equal(r.pnl, 500, "realised 200 + unrealised 300");
  assert.equal(r.openPosition, true);
  assert.equal(r.type, "Partial exit");
});

test("summary: a fully exited company uses the ledger alone", () => {
  const [r] = buildPnlSummary(
    [group("EOS", summary({ unitsBought: 407, unitsSold: 407, proceeds: 3190.77, costOfSold: 3256 }))],
    new Map(),
  );
  assert.equal(r.buyPrice, 3256);
  assert.equal(r.sellOrCurrent, 3190.77);
  assert.equal(Number(r.pnl.toFixed(2)), -65.23);
  assert.equal(r.openPosition, false);
  assert.equal(r.type, "Full exit");
  assert.equal(r.flagged, false);
});

test("summary: a holding with no ledger history uses the snapshot alone", () => {
  const [r] = buildPnlSummary(
    [],
    new Map([["IMU", held({ qty: 16302, costBase: 5652.68, marketValue: 1499.78 })]]),
  );
  assert.equal(r.buyPrice, 5652.68);
  assert.equal(r.sellOrCurrent, 1499.78);
  assert.equal(r.openPosition, true);
  assert.equal(r.type, "Open - no ledger history");
  assert.equal(r.flagged, true);
});

// ---------------------------------------------------------------------------
// Type classification
// ---------------------------------------------------------------------------

test("type: buy qty > sell qty is a partial exit", () => {
  const [r] = buildPnlSummary(
    [group("ACW", summary({ unitsBought: 250939, unitsSold: 179510, proceeds: 6352.36, costOfSold: 5666.78 }))],
    new Map([["ACW", held({ qty: 71429 })]]),
  );
  assert.equal(r.type, "Partial exit");
  assert.equal(r.flagged, false);
});

test("type: selling more than was bought is flagged as missing", () => {
  // The real EUR case: 115,385 units sold, no purchase in the ledger.
  const [r] = buildPnlSummary(
    [group("EUR", summary({ unitsBought: 0, unitsSold: 115385, proceeds: 10397.08 }))],
    new Map(),
  );
  assert.equal(r.type, "CHECK - sold more than bought");
  assert.equal(r.flagged, true);
});

test("type: the two sources contradicting each other is flagged", () => {
  // Ledger says units remain open; the snapshot holds none of them.
  const [partial] = buildPnlSummary(
    [group("ACW", summary({ unitsBought: 250939, unitsSold: 179510 }))],
    new Map(),
  );
  assert.equal(partial.type, "CHECK - partial exit but nothing held");
  assert.equal(partial.flagged, true);

  // Ledger says the position closed; the snapshot still holds units.
  const [full] = buildPnlSummary(
    [group("BM1", summary({ unitsBought: 12403, unitsSold: 12403 }))],
    new Map([["BM1", held({ qty: 500 })]]),
  );
  assert.equal(full.type, "CHECK - full exit but still holding");
  assert.equal(full.flagged, true);
});

test("type: an unpriced holding cannot be valued and says so", () => {
  const [r] = buildPnlSummary(
    [group("XYZ", summary({ unitsBought: 100 }))],
    new Map([["XYZ", held({ marketValue: 0, hasPrice: false })]]),
  );
  assert.match(r.type, /no market price/);
  assert.equal(r.flagged, true);
});

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

function parse(csv: string) {
  return csv.split("\r\n").map((line) => {
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

const SAMPLE = () =>
  buildPnlSummary(
    [
      group("LDX", summary({ unitsBought: 1000, unitsSold: 1000, proceeds: 2500, costOfSold: 2000 })),
      group("ACW", summary({ unitsBought: 300, unitsSold: 100, proceeds: 500, costOfSold: 400 })),
    ],
    new Map([["ACW", held({ qty: 200, costBase: 800, marketValue: 900 })]]),
  );

test("csv: headers are exactly the requested columns", () => {
  const rows = parse(buildPnlSummaryCsv(SAMPLE()));
  assert.deepEqual(rows[0], [
    "Row Labels",
    "Company",
    "Buy Price",
    "Sell Price / Current Price",
    "PnL",
    "Open Positions",
    "Type",
  ]);
});

test("csv: the last row is a Grand Total that sums the three money columns", () => {
  const rows = parse(buildPnlSummaryCsv(SAMPLE()));
  const last = rows[rows.length - 1];

  assert.equal(last[0], "Grand Total");
  // LDX 2000 + ACW (400 sold-cost + 800 held-cost) = 3200
  assert.equal(last[2], "3200.00");
  // LDX 2500 + ACW (500 proceeds + 900 market) = 3900
  assert.equal(last[3], "3900.00");
  assert.equal(last[4], "700.00");

  // And it must equal the sum of the body rows, not be computed separately.
  const body = rows.slice(1, -1);
  const sum = (i: number) => body.reduce((s, r) => s + Number(r[i]), 0);
  assert.equal(Number(last[2]), sum(2));
  assert.equal(Number(last[3]), sum(3));
  assert.equal(Number(last[4]), sum(4));
});

test("csv: money is bare 2dp so the cells stay numeric and summable", () => {
  const rows = parse(buildPnlSummaryCsv(SAMPLE()));
  for (const r of rows.slice(1)) {
    for (const i of [2, 3, 4]) {
      if (r[i] === "") continue;
      assert.match(r[i], /^-?\d+\.\d{2}$/, `"${r[i]}" must be a bare 2dp number`);
      assert.ok(!Number.isNaN(Number(r[i])));
    }
  }
});

test("csv: Open Positions is Yes/No", () => {
  const rows = parse(buildPnlSummaryCsv(SAMPLE()));
  const vals = rows.slice(1, -1).map((r) => r[5]);
  assert.deepEqual([...new Set(vals)].sort(), ["No", "Yes"]);
});

test("csv: a company name with a comma keeps the column count", () => {
  const rows = parse(
    buildPnlSummaryCsv(
      buildPnlSummary([group("SMI", summary({ unitsBought: 1 }), 'SMITH, JOHN "X"')], new Map()),
    ),
  );
  assert.equal(rows[1][1], 'SMITH, JOHN "X"');
  for (const r of rows) assert.equal(r.length, rows[0].length);
});

test("grandTotal: P&L total equals buy/sell totals differenced", () => {
  const t = grandTotal(SAMPLE());
  assert.equal(Number((t.sellOrCurrent - t.buyPrice).toFixed(2)), Number(t.pnl.toFixed(2)));
});

test("filename: slugged, dated, account-scoped, correct extension", () => {
  assert.equal(
    pnlSummaryFilename("SRI GURU NANAK PTY LTD", null, "2026-07-29", "csv"),
    "pnl-summary-sri-guru-nanak-pty-ltd-2026-07-29.csv",
  );
  assert.equal(
    pnlSummaryFilename("Smith, John", "Halloran SMSF", "2026-07-29", "xlsx"),
    "pnl-summary-smith-john-halloran-smsf-2026-07-29.xlsx",
  );
});
