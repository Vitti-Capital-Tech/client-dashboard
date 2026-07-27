import test from "node:test";
import assert from "node:assert/strict";

import { parseCsvRecords } from "./csv.ts";
import { parentCode, parseTradeDate, num, initialsOf } from "./normalize.ts";
import { parseTradeCsv, reduceTrades, type ParsedTrade } from "./trades.ts";

/**
 * Tests for the broker import pipeline. No test framework needed — Node's
 * built-in runner:  node --test lib/import/
 *
 * The cases here are the ones that would silently corrupt money if they broke:
 * day-first dates, parent-code rollup, and cost-basis attribution.
 */

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

test("csv: quoted fields keep their commas and headers are trimmed", () => {
  const { headers, rows } = parseCsvRecords(
    'Account Number,Account Name ,Qty\n1,"SMITH, JOHN + JANE",10\n',
  );
  assert.deepEqual(headers, ["Account Number", "Account Name", "Qty"]);
  assert.equal(rows[0]["Account Name"], "SMITH, JOHN + JANE");
  assert.equal(rows[0]["Qty"], "10");
});

test("csv: a leading BOM does not poison the first header", () => {
  const { headers } = parseCsvRecords("﻿CNote,Account\n1,2\n");
  assert.equal(headers[0], "CNote");
});

// ---------------------------------------------------------------------------
// Security codes
// ---------------------------------------------------------------------------

test("parentCode: derivatives collapse to the 3-char ordinary", () => {
  assert.equal(parentCode("EOSXX"), "EOS");
  assert.equal(parentCode("ACWXX"), "ACW");
  assert.equal(parentCode("PC2ZZ"), "PC2");
  assert.equal(parentCode("ADNOD"), "ADN");
  assert.equal(parentCode("AT4OE"), "AT4");
  assert.equal(parentCode("88EOA"), "88E");
});

test("parentCode: a real 3-char code ending in X is left alone", () => {
  // The whole reason the rule is "first three chars" and not "strip XX":
  // LDX is Lumos Diagnostics, not LD + X.
  assert.equal(parentCode("LDX"), "LDX");
  assert.equal(parentCode("IMU"), "IMU");
  assert.equal(parentCode("BM1"), "BM1");
});

test("parentCode: rejects junk rather than guessing", () => {
  assert.throws(() => parentCode("XX"));
  assert.throws(() => parentCode(""));
  assert.throws(() => parentCode("TOO-LONG-CODE"));
});

// ---------------------------------------------------------------------------
// Dates — the highest-consequence parser in the pipeline
// ---------------------------------------------------------------------------

test("parseTradeDate: the broker export is day-first", () => {
  // 04/02/26 is 4 February, NOT 2 April. Reading it month-first would reorder
  // the ledger and corrupt every weighted-average cost downstream.
  assert.equal(parseTradeDate("04/02/26"), "2026-02-04");
  assert.equal(parseTradeDate("21/05/26"), "2026-05-21");
  assert.equal(parseTradeDate("23/01/26"), "2026-01-23");
  assert.equal(parseTradeDate("04-09-25"), "2025-09-04");
  assert.equal(parseTradeDate("22/09/2025"), "2025-09-22");
});

test("parseTradeDate: two-digit years pivot at 70", () => {
  assert.equal(parseTradeDate("01/01/26"), "2026-01-01");
  assert.equal(parseTradeDate("01/01/98"), "1998-01-01");
});

test("parseTradeDate: impossible dates throw", () => {
  assert.throws(() => parseTradeDate("31/02/26")); // no 31 February
  assert.throws(() => parseTradeDate("01/13/26")); // month 13 → not day-first
  assert.throws(() => parseTradeDate("not a date"));
});

// ---------------------------------------------------------------------------
// Numbers & text
// ---------------------------------------------------------------------------

test("num: handles separators, currency and accounting negatives", () => {
  assert.equal(num("3,300.77"), 3300.77);
  assert.equal(num("$1,000"), 1000);
  assert.equal(num("(1,234.50)"), -1234.5);
  assert.equal(num(""), 0);
  assert.equal(num("-20000.0000000000"), -20000);
});

test("initialsOf: skips honorifics and company suffixes", () => {
  assert.equal(initialsOf("MR IZAAC RONAY"), "IR");
  assert.equal(initialsOf("SRI GURU NANAK PTY LTD"), "SN");
});

// ---------------------------------------------------------------------------
// Trade parsing
// ---------------------------------------------------------------------------

const HEADER =
  "CNote,Account,Type,Security,Company,Description,Contract Date,Adviser," +
  "Units,Avg Price,Consideration,Brokerage,Other Charges,GST,Value," +
  "Brokerage %,Status";

const row = (
  cnote: string,
  side: string,
  sec: string,
  date: string,
  units: string,
  value: string,
  status = "SETTLED",
  brokerage = "0",
  gst = "0",
) =>
  `${cnote},114716,${side},${sec},TEST CO,FPO,${date},VIZ,${units},1,0,` +
  `${brokerage},0,${gst},${value},0,${status}`;

test("parseTradeCsv: keeps non-settled rows with zero/negative units", () => {
  // CANCELLED exports as 0 units and REVERSAL as a negative. Both belong in the
  // audit trail; rejecting them would lose contract notes.
  const csv = [
    HEADER,
    row("1", "BUY", "PC2ZZ", "16/09/25", "20000", "5000", "REVERSED"),
    row("2", "BUY", "PC2ZZ", "22/09/25", "-20000", "-5000", "REVERSAL"),
    row("3", "BUY", "LM8", "15/09/25", "0", "0", "CANCELLED"),
  ].join("\n");

  const { trades, errors } = parseTradeCsv(csv);
  assert.equal(errors.length, 0);
  assert.equal(trades.length, 3);
});

test("parseTradeCsv: a settled trade with non-positive units is rejected", () => {
  const { trades, errors } = parseTradeCsv(
    [HEADER, row("1", "BUY", "LDX", "01/01/26", "0", "100")].join("\n"),
  );
  assert.equal(trades.length, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /non-positive units/);
});

test("parseTradeCsv: a missing column fails loudly", () => {
  assert.throws(
    () => parseTradeCsv("CNote,Account\n1,2\n"),
    /missing expected column/,
  );
});

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

function reduceCsv(...rows: string[]) {
  const { trades } = parseTradeCsv([HEADER, ...rows].join("\n"));
  return reduceTrades(trades);
}

test("reduce: a full close realizes proceeds minus everything paid", () => {
  // Buy 1,000 for $2,000 (incl. fees), sell the lot for $2,500 net → +$500.
  const [r] = reduceCsv(
    row("1", "BUY", "LDX", "01/02/26", "1000", "2000"),
    row("2", "SELL", "LDX", "01/03/26", "1000", "2500"),
  );
  assert.equal(r.realizedPl, 500);
  assert.equal(r.openUnits, 0);
  assert.equal(r.openCost, 0);
  assert.equal(r.costOfSold, 2000);
  assert.equal(r.hasPartial, false);
  assert.equal(r.shortHistory, false);
});

test("reduce: fees are already inside `value`, so P&L is fee-inclusive", () => {
  // Real EOS round trip: bought EOSXX at 3256.00, sold EOS netting 3190.77.
  const [r] = reduceCsv(
    "2458396,114716,BUY,EOSXX,ELECTRO OPTIC SYS.,INSTPLAC,19/05/26,VIZ,407,8,3256,0,0,0,3256,0,SETTLED",
    "2462073,114716,SELL,EOS,ELECTRO OPTIC SYS.,FPO,21/05/26,VIZ,407,8.11,3300.77,100,0,10,3190.77,3.0296,SETTLED",
  );
  assert.equal(r.parent, "EOS", "EOSXX and EOS must roll up together");
  assert.equal(r.realizedPl, -65.23);
  assert.equal(r.fees, 110); // $100 brokerage + $10 GST
});

test("reduce: only SETTLED trades reach P&L", () => {
  const rollups = reduceCsv(
    row("1", "BUY", "PC2ZZ", "16/09/25", "20000", "5000", "REVERSED"),
    row("2", "BUY", "PC2ZZ", "22/09/25", "-20000", "-5000", "REVERSAL"),
    row("3", "BUY", "PC2ZZ", "23/09/25", "20000", "5000"),
    row("4", "SELL", "PC2", "24/09/25", "20000", "6311.62"),
  );
  assert.equal(rollups.length, 1);
  assert.equal(rollups[0].unitsBought, 20000, "the reversed pair must not count");
  assert.equal(rollups[0].realizedPl, 1311.62);
});

test("reduce: selling units never bought is flagged, not silently costed", () => {
  const [r] = reduceCsv(row("1", "SELL", "EUR", "01/03/26", "115385", "10397.08"));
  assert.equal(r.shortHistory, true);
  assert.equal(r.costOfSold, 0);
  assert.equal(r.realizedPl, 10397.08); // overstated, and the flag says so
});

test("reduce: a partial sale from a single-price parcel is exact, not flagged", () => {
  // Real BM1 shape: one buy, two sells. WAC is the exact answer here.
  const [r] = reduceCsv(
    row("1", "BUY", "BM1", "22/10/25", "12403", "6311.50"),
    row("2", "SELL", "BM1", "10/11/25", "6000", "3340.00"),
    row("3", "SELL", "BM1", "19/01/26", "6403", "5652.70"),
  );
  assert.equal(r.hasPartial, false, "single-price parcel needs no approximation");
  assert.equal(r.realizedPl, 2681.2);
  assert.equal(r.openUnits, 0);
});

test("reduce: a partial sale from a mixed-price parcel IS flagged approximate", () => {
  const [r] = reduceCsv(
    row("1", "BUY", "ABC", "01/01/26", "1000", "1000"), // $1.00/unit
    row("2", "BUY", "ABC", "02/01/26", "1000", "3000"), // $3.00/unit
    row("3", "SELL", "ABC", "03/01/26", "500", "1500"),
  );
  assert.equal(r.hasPartial, true);
  // WAC = $2.00/unit → 500 units cost $1,000 → $500 gain.
  assert.equal(r.costOfSold, 1000);
  assert.equal(r.realizedPl, 500);
  assert.equal(r.openUnits, 1500);
  assert.equal(r.openCost, 3000);
});

test("reduce: replays chronologically regardless of file order", () => {
  const forward = reduceCsv(
    row("1", "BUY", "XYZ", "01/01/26", "100", "100"),
    row("2", "SELL", "XYZ", "01/06/26", "100", "300"),
  );
  const reversed = reduceCsv(
    row("2", "SELL", "XYZ", "01/06/26", "100", "300"),
    row("1", "BUY", "XYZ", "01/01/26", "100", "100"),
  );
  assert.deepEqual(reversed, forward);
  assert.equal(forward[0].shortHistory, false);
});

test("reduce: accounts are kept separate", () => {
  const { trades } = parseTradeCsv(
    [HEADER, row("1", "BUY", "LDX", "01/01/26", "100", "100")].join("\n"),
  );
  const other: ParsedTrade = { ...trades[0], accountRef: "999999" };
  const rollups = reduceTrades([...trades, other]);
  assert.equal(rollups.length, 2);
  assert.deepEqual(
    rollups.map((r) => r.accountRef),
    ["114716", "999999"],
  );
});
