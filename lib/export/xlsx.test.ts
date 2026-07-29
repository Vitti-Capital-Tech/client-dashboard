import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";

import { buildPnlSummaryWorkbook, XLSX_FILLS } from "./xlsx.ts";
import { buildPnlSummary, type ExportGroup, type HeldPosition } from "./order-history.ts";

/**
 * Round-trip tests: generate the workbook, read it back with ExcelJS, and
 * assert on what Excel would actually show. Asserting on the input object
 * would prove nothing — the point is that the fills, the number formats and
 * the total survive serialisation.
 */

const summary = (over = {}) => ({
  realizedPl: 0,
  proceeds: 0,
  costOfSold: 0,
  unitsBought: 0,
  unitsSold: 0,
  fees: 0,
  tradeCount: 0,
  firstTrade: null,
  lastTrade: null,
  hasPartial: false,
  shortHistory: false,
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

const ROWS = () =>
  buildPnlSummary(
    [
      // Fully exited, clean.
      group("LDX", summary({ unitsBought: 1000, unitsSold: 1000, proceeds: 2500, costOfSold: 2000 })),
      // Still open — partial exit.
      group("ACW", summary({ unitsBought: 300, unitsSold: 100, proceeds: 500, costOfSold: 400 })),
      // Flagged — sold units the ledger never saw bought.
      group("EUR", summary({ unitsSold: 115385, proceeds: 10397.08 })),
    ],
    new Map([["ACW", held({ qty: 200, costBase: 800, marketValue: 900 })]]),
  );

async function readBack(rows = ROWS()) {
  const buf = await buildPnlSummaryWorkbook(rows, "Test client — P&L summary");
  const wb = new ExcelJS.Workbook();
  // ExcelJS ships its own Buffer declaration, which no longer structurally
  // matches @types/node's generic `Buffer<ArrayBufferLike>`. Runtime is fine.
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  return { wb, ws: wb.getWorksheet("P&L summary")!, rows };
}

const fillOf = (ws: ExcelJS.Worksheet, rowNo: number) =>
  (ws.getRow(rowNo).getCell(1).fill as ExcelJS.FillPattern | undefined)?.fgColor?.argb;

test("xlsx: it is a real workbook with the expected sheet and headers", async () => {
  const { ws } = await readBack();
  assert.ok(ws, "sheet 'P&L summary' exists");
  // ExcelJS rows are 1-indexed, so `values` carries an empty slot at [0].
  assert.deepEqual((ws.getRow(1).values as unknown[]).slice(1), [
    "Row Labels",
    "Company",
    "Buy Qty",
    "Sell Qty",
    "Buy Price",
    "Sell Price / Current Price",
    "PnL",
    "Open Positions",
    "Type",
  ]);
});

test("xlsx: open rows are amber, exited rows green", async () => {
  const { ws, rows } = await readBack();

  for (const [i, r] of rows.entries()) {
    const expected = r.openPosition ? XLSX_FILLS.FILL_OPEN : XLSX_FILLS.FILL_CLOSED;
    assert.equal(
      fillOf(ws, i + 2),
      expected,
      `${r.ticker} (open=${r.openPosition}) should be ${expected}`,
    );
  }
});

test("xlsx: a flagged row carries the warning ink on top of its fill", async () => {
  const { ws, rows } = await readBack();
  const idx = rows.findIndex((r) => r.ticker === "EUR");
  const row = ws.getRow(idx + 2);

  assert.equal(row.getCell(1).font?.color?.argb, XLSX_FILLS.INK_FLAG);
  assert.equal(row.getCell(1).font?.bold, true);
  // The open/closed fill is still there — both signals coexist.
  assert.ok(fillOf(ws, idx + 2));
});

test("xlsx: money cells are numbers, not text, and carry a 2dp format", async () => {
  const { ws, rows } = await readBack();

  for (let i = 0; i < rows.length; i++) {
    for (const col of [5, 6, 7]) {
      const cell = ws.getRow(i + 2).getCell(col);
      assert.equal(
        typeof cell.value,
        "number",
        `row ${i + 2} col ${col} must be numeric so the sheet can sum it`,
      );
      assert.equal(cell.numFmt, "#,##0.00");
    }
  }
});

test("xlsx: the Grand Total row sums the body and is visually separated", async () => {
  const { ws, rows } = await readBack();
  const totalRow = ws.getRow(rows.length + 2);

  assert.equal(totalRow.getCell(1).value, "Grand Total");
  assert.equal(totalRow.getCell(5).value, rows.reduce((s, r) => s + r.buyPrice, 0));
  assert.equal(totalRow.getCell(6).value, rows.reduce((s, r) => s + r.sellOrCurrent, 0));
  assert.equal(
    Number((totalRow.getCell(7).value as number).toFixed(2)),
    Number(rows.reduce((s, r) => s + r.pnl, 0).toFixed(2)),
  );
  assert.equal(totalRow.getCell(1).font?.bold, true);
  assert.equal(totalRow.getCell(1).border?.top?.style, "double");
});

test("xlsx: the autofilter covers the data rows but never the total", async () => {
  const { ws, rows } = await readBack();
  // Set as {from,to} but serialised back as an A1 range, e.g. "A1:G4".
  const af = ws.autoFilter as unknown as string;
  assert.equal(
    af,
    `A1:I${rows.length + 1}`,
    "the Grand Total row must stay outside the filter so it cannot be sorted into the middle",
  );
});

test("xlsx: an empty export still produces a valid workbook", async () => {
  const { ws } = await readBack([]);
  assert.equal(ws.getRow(2).getCell(1).value, "Grand Total");
  assert.equal(ws.getRow(2).getCell(5).value, 0);
});
