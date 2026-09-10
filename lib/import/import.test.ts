import test from "node:test";
import assert from "node:assert/strict";

import { parseCsvRecords } from "./csv.ts";
import { parentCode, parseTradeDate, num, initialsOf } from "./normalize.ts";
import {
  parseTradeCsv,
  reduceTrades,
  replayLedger,
  type LedgerLine,
  type ParsedTrade,
} from "./trades.ts";
import { reconcile, findDrift } from "./reconcile.ts";

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

// ---------------------------------------------------------------------------
// Per-sale attribution (what the dated chart is built on)
// ---------------------------------------------------------------------------

function sellsOf(...rows: string[]) {
  const { trades } = parseTradeCsv([HEADER, ...rows].join("\n"));
  return replayLedger(
    trades.map((t) => ({
      scope: t.accountRef,
      parent: t.parent,
      code: t.rawSecurity,
      cnote: t.cnote,
      side: t.side,
      tradeDate: t.tradeDate,
      units: t.units,
      value: t.value,
      status: t.status,
      fees: t.brokerage + t.otherCharges + t.gst,
    })),
  ).sells;
}

test("attribution: each sale keeps the date its money was realised on", () => {
  const sells = sellsOf(
    row("1", "BUY", "LDX", "01/02/26", "1000", "2000"),
    row("2", "SELL", "LDX", "15/03/26", "400", "1000"),
    row("3", "SELL", "LDX", "20/05/26", "600", "1800"),
  );

  assert.equal(sells.length, 2, "only sales realise anything");
  assert.deepEqual(
    sells.map((s) => s.tradeDate),
    ["2026-03-15", "2026-05-20"],
  );
  // WAC is $2/unit: 400 units cost $800, 600 cost $1,200.
  assert.equal(sells[0].costOfSold, 800);
  assert.equal(sells[0].realizedPl, 200);
  assert.equal(sells[1].costOfSold, 1200);
  assert.equal(sells[1].realizedPl, 600);
});

test("attribution: per-sale results sum to the rollup they came from", () => {
  // The single-pass replay is what guarantees this — the dated chart and the
  // stored per-ticker total are two views of one calculation, not two of them.
  const rows = [
    row("1", "BUY", "BM1", "22/10/25", "12403", "6311.50"),
    row("2", "SELL", "BM1", "10/11/25", "6000", "3340.00"),
    row("3", "SELL", "BM1", "19/01/26", "6403", "5652.70"),
  ];
  const { trades } = parseTradeCsv([HEADER, ...rows].join("\n"));
  const [rollup] = reduceTrades(trades);
  const sells = sellsOf(...rows);

  const summed = sells.reduce((s, x) => s + x.realizedPl, 0);
  assert.equal(Number(summed.toFixed(2)), rollup.realizedPl);
  assert.equal(rollup.realizedPl, 2681.2);
});

test("attribution: an uncosted sale is flagged on the sale itself", () => {
  const sells = sellsOf(row("1", "SELL", "EUR", "22/09/25", "115385", "10397.08"));
  assert.equal(sells[0].noCostBasis, true);
  assert.equal(sells[0].costOfSold, 0);
});

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

function reconcileCsv(...rows: string[]) {
  const { trades } = parseTradeCsv([HEADER, ...rows].join("\n"));
  return reconcile(trades, reduceTrades(trades));
}

test("reconcile: an exact unit match under another ticker is proposed", () => {
  // The real JBY → BKB rename: bought 4,681 under one code, sold under another.
  const [e] = reconcileCsv(
    row("1", "BUY", "JBY", "10/11/25", "4681", "3339.89"),
    row("2", "SELL", "BKB", "16/12/25", "4681", "3634.80"),
  );
  assert.equal(e.kind, "probable-ticker-change");
  assert.equal(e.parent, "BKB");
  assert.equal(e.suggestion?.fromParent, "JBY");
  assert.equal(e.suggestion?.value, 3339.89);
  assert.equal(e.reportedRealized, 3634.8);
  assert.equal(e.correctedRealized, 294.91);
});

test("reconcile: no candidate means a genuine pre-window purchase", () => {
  const [e] = reconcileCsv(row("1", "SELL", "EUR", "22/09/25", "115385", "10397.08"));
  assert.equal(e.kind, "missing-opening-balance");
  assert.equal(e.suggestion, null);
  assert.equal(e.correctedRealized, null);
});

test("reconcile: a buy dated AFTER the sale is not a rename", () => {
  const [e] = reconcileCsv(
    row("1", "SELL", "BKB", "16/12/25", "4681", "3634.80"),
    row("2", "BUY", "JBY", "20/12/25", "4681", "3339.89"),
  );
  assert.equal(e.kind, "missing-opening-balance");
  assert.equal(e.suggestion, null);
});

test("reconcile: two equally plausible candidates are left to a human", () => {
  const found = reconcileCsv(
    row("1", "BUY", "AAA", "01/10/25", "4681", "1000"),
    row("2", "BUY", "CCC", "02/10/25", "4681", "2000"),
    row("3", "SELL", "BKB", "16/12/25", "4681", "3634.80"),
  );
  assert.equal(found[0].suggestion, null, "ambiguity must not become a guess");
});

test("reconcile: options are reported but never auto-matched", () => {
  const csv = [
    HEADER,
    // Same unit count, but the buy is an instalment option — exercise or
    // conversion, not a rename. Matching them would invent a tax event.
    "1,114716,BUY,ACWXX,ACTINOGEN,INSTOPLAC,03/02/26,VIZ,71429,0.042,3000.02,0,0,0,3000.02,0,SETTLED",
    "2,114716,SELL,ZZZXX,OTHER CO,INSTPLAC,01/03/26,VIZ,71429,0.05,3600,0,0,0,3600,0,SETTLED",
  ].join("\n");
  const { trades } = parseTradeCsv(csv);
  const [e] = reconcile(trades, reduceTrades(trades));
  assert.equal(e.isOption, true);
  assert.equal(e.kind, "unsold-option");
  assert.equal(e.suggestion, null);
});

test("reconcile: a clean ledger produces no exceptions", () => {
  const found = reconcileCsv(
    row("1", "BUY", "LDX", "01/02/26", "1000", "2000"),
    row("2", "SELL", "LDX", "01/03/26", "1000", "2500"),
  );
  assert.deepEqual(found, []);
});

test("findDrift: ledger open units must agree with the snapshot", () => {
  const { trades } = parseTradeCsv(
    [HEADER, row("1", "BUY", "ACW", "01/02/26", "71429", "3000.02")].join("\n"),
  );
  const rollups = reduceTrades(trades);

  assert.deepEqual(
    findDrift(rollups, new Map([["114716::ACW", 71429]])),
    [],
    "matching units are not drift",
  );

  const [d] = findDrift(rollups, new Map());
  assert.equal(d.parent, "ACW");
  assert.equal(d.ledgerOpenUnits, 71429);
  assert.equal(d.snapshotUnits, 0);
  assert.equal(d.strandedCost, 3000.02);
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

// ---------------------------------------------------------------------------
// Cost is attributed per INSTRUMENT for options, per parent for everything else
// ---------------------------------------------------------------------------

const line = (
  code: string,
  side: "BUY" | "SELL",
  tradeDate: string,
  units: number,
  value: number,
): LedgerLine => ({
  scope: "A1",
  parent: code.slice(0, 3),
  code,
  cnote: `${code}-${tradeDate}-${side}`,
  side,
  tradeDate,
  units,
  value,
  status: "SETTLED",
  fees: 0,
});

test("ledger: an option sale does not draw cost from the ordinary's parcel", () => {
  /**
   * The FIFO was keyed on the parent, and `getParentTicker("FRSOB")` is `FRS`.
   * So buying shares and then selling the free attaching options costed the
   * options against the shares — the option came out showing the shares' cost
   * and the shares kept a parcel they no longer had. `pnl_summary` states the
   * rule: "an option line is a position in its own right (EOS and EOSO have
   * different prices)".
   *
   * Measured over the live ledger this moved 9 (account, parent) groups across
   * 8 accounts, and raised realised P&L by $38,013 — the options had been
   * absorbing cost that was never theirs.
   */
  const { sells } = replayLedger([
    line("FRS", "BUY", "2026-01-10", 1000, 5000),
    // The grant is free and never bought, so nothing costs it.
    line("FRSOB", "SELL", "2026-02-10", 500, 800),
    line("FRS", "SELL", "2026-03-10", 1000, 6000),
  ]);

  const option = sells.find((s) => s.code === "FRSOB")!;
  const shares = sells.find((s) => s.code === "FRS")!;

  assert.equal(option.costOfSold, 0, "a free grant has no cost to draw on");
  assert.equal(option.realizedPl, 800, "so its whole proceeds are the result");

  // FREE GRANT, not "cost base not on file". The difference is between "this
  // cost nothing" and "we do not know what this cost", and only the second is a
  // warning. The firm's treatment puts a placement's whole cost on the shares,
  // so zero here is the answer — 187 such sales were reading as missing data.
  assert.equal(option.freeGrant, true);
  assert.equal(option.noCostBasis, false, "nothing is missing, so nothing is flagged");

  // The shares keep the parcel they actually bought — the option sale no longer
  // eats half of it.
  assert.equal(shares.costOfSold, 5000);
  assert.equal(shares.realizedPl, 1000);
  assert.equal(shares.noCostBasis, false);
});

test("ledger: a grant booked at ZERO for half its units is still free", () => {
  /**
   * EPMO, verbatim from the ledger. Every account carries an `EPMO BUY` at
   * `value = 0` for roughly HALF the units later sold — 23,810 bought against
   * 47,620 sold, and the same ratio on four other accounts.
   *
   * So the parcel exists, is exhausted mid-sale, and the excess read as missing
   * data. It is not: the units the broker DID record cost nothing, so the ones
   * it skipped would have cost nothing either. The P&L is identical whichever
   * way it is labelled — only the red "cost base not on file" was wrong, and it
   * sent the reader looking for a contract note that does not exist.
   */
  const { sells } = replayLedger([
    line("EPMO", "BUY", "2025-12-11", 23810, 0),
    line("EPMO", "SELL", "2026-01-21", 47620, 794.78),
  ]);

  const sale = sells[0];
  assert.equal(sale.freeGrant, true, "a zero-cost parcel makes the excess free too");
  assert.equal(sale.noCostBasis, false, "so there is nothing to warn about");
  assert.equal(sale.costOfSold, 0);
  assert.equal(sale.realizedPl, 794.78);
});

test("ledger: an option BOUGHT before the file starts is unknown, not free", () => {
  // The two look identical at the moment of sale — an empty parcel either way —
  // and only the whole file separates them: a grant has no buy line ANYWHERE,
  // while this one's purchase simply predates the export. Calling it free would
  // report its entire proceeds as profit. Live ledger: 187 grants against 8 of
  // these.
  const { sells } = replayLedger([
    // Sold in February, bought in June FOR MONEY: the sale is short, not a
    // grant. This is CCOOA in the live ledger — sold 777,778 on 17 May 2024,
    // then 2,500,000 bought for $2,527.50 on 3 June.
    line("FRSOB", "SELL", "2026-02-10", 500, 800),
    line("FRSOB", "BUY", "2026-06-10", 500, 200),
  ]);

  const sale = sells.find((s) => s.code === "FRSOB")!;
  assert.equal(sale.noCostBasis, true, "the cost is genuinely unknown");
  assert.equal(sale.freeGrant, undefined, "and it is not a grant");
});

test("ledger: a deferred-settlement line still pools with the ordinary", () => {
  /**
   * This is why the split is on `isOptionCode` and not on the code. `AVRXX` is
   * a deferred-settlement/rights line that BECOMES the ordinary — buying it in
   * a placement and selling `AVR` later is one position, and its cost has to
   * carry across. Keying the FIFO on the code outright would have broken this,
   * and it is the common case: over the live ledger 569 parcels mix an `XX`
   * code with its ordinary against 145 that mix in an option.
   */
  const { sells } = replayLedger([
    line("AVRXX", "BUY", "2026-01-10", 1000, 4000),
    line("AVR", "SELL", "2026-02-10", 1000, 5000),
  ]);

  const sale = sells.find((s) => s.code === "AVR")!;
  assert.equal(sale.costOfSold, 4000, "the placement's cost carried across");
  assert.equal(sale.realizedPl, 1000);
  assert.equal(sale.noCostBasis, false, "nothing here is uncosted");
});

test("ledger: the parent rollup still reports both instruments together", () => {
  // The FIFO split must not split the ROLLUP: `realized_pnl` is keyed at parent
  // grain and stays that way. One row for FRS, carrying both lines' result.
  const { rollups } = replayLedger([
    line("FRS", "BUY", "2026-01-10", 1000, 5000),
    line("FRSOB", "SELL", "2026-02-10", 500, 800),
    line("FRS", "SELL", "2026-03-10", 1000, 6000),
  ]);

  assert.equal(rollups.length, 1, "one rollup, at parent grain");
  assert.equal(rollups[0].parent, "FRS");
  assert.equal(rollups[0].realizedPl, 1800, "1,000 on the shares + 800 on the grant");
  assert.equal(rollups[0].openUnits, 0, "the shares closed out fully");
});

// ---------------------------------------------------------------------------
// A sale that closes ONE lot is costed at that lot, not at a blend
// ---------------------------------------------------------------------------

test("ledger: a sale matching one open lot is costed at that lot", () => {
  /**
   * `ACW` on a live account, verbatim. Two parcels are open at once — an
   * on-market one bought in January and a placement bought in February — and
   * the April sale closes the placement exactly.
   *
   * Weighted average blended the January parcel in and costed the sale at
   * $10,761.96, even though that parcel's own sale is in JULY, outside the
   * period being reported. The broker's closed-trades report costs it at
   * $9,999.99, the lot it actually closed. `ARL` confirms the pairing
   * independently: its buys are `ARLXX` and its sells `ARL`, and our figure
   * already matched the desk's corrected one to the cent.
   */
  const { sells } = replayLedger([
    line("ACW", "BUY", "2025-10-20", 157_740, 4_999.94),
    line("ACW", "SELL", "2025-10-29", 157_740, 5_253.16),
    line("ACW", "BUY", "2026-01-23", 95_882, 5_095.86),
    // The placement arrives as the deferred-settlement line and is sold as the
    // ordinary — which is why this cannot be found by matching codes.
    line("ACWXX", "BUY", "2026-02-03", 238_095, 9_999.99),
    line("ACW", "SELL", "2026-04-20", 238_095, 10_360.94),
    line("ACW", "SELL", "2026-07-03", 95_882, 3_341.75),
  ]);

  const april = sells.find((s) => s.tradeDate === "2026-04-20")!;
  assert.equal(april.costOfSold, 9_999.99, "the lot it closed, not a blend");
  assert.equal(april.realizedPl, 360.95);

  // And the January parcel's cost stays with the July sale, where it belongs.
  const july = sells.find((s) => s.tradeDate === "2026-07-03")!;
  assert.equal(july.costOfSold, 5_095.86);

  // Together they reproduce the broker's own two-line figures.
  const inPeriod = sells.filter((s) => s.tradeDate < "2026-07-01");
  assert.equal(
    inPeriod.reduce((n, s) => n + s.costOfSold, 0),
    14_999.93,
    "broker: BUY 14,999.93",
  );
  assert.equal(
    Number(inPeriod.reduce((n, s) => n + s.realizedPl, 0).toFixed(2)),
    614.17,
    "broker: P&L 614.17",
  );
});

test("ledger: an AMBIGUOUS quantity falls back to weighted average", () => {
  // The safety condition. Placement parcels are round numbers and two of them
  // under one parent collide by coincidence — 200,000 twice here. Picking the
  // first would pair the wrong purchase and put one parcel's cost on the
  // other's sale, so an ambiguous match is refused and WAC answers instead.
  const { sells } = replayLedger([
    line("ABC", "BUY", "2026-01-10", 200_000, 4_000),
    line("ABC", "BUY", "2026-02-10", 200_000, 6_000),
    line("ABC", "SELL", "2026-03-10", 200_000, 5_500),
  ]);

  // WAC over 400,000 units at $10,000 → $5,000 for half of them.
  assert.equal(sells[0].costOfSold, 5_000);
  assert.equal(sells[0].realizedPl, 500);
});

test("ledger: a same-day two-way pool keeps weighted average", () => {
  /**
   * Lot matching is switched off where a pool buys and sells on one day,
   * because there the answer is decided by ORDERING rather than by costing:
   * this ledger records a round trip's SELL before its BUY often enough that
   * the sale meets an empty parcel.
   *
   * Measured over the live book, lot matching moves 22 groups — 17 of them
   * same-day two-way pools carrying ~$38k (4DX alone −$53.5k) against 5 of the
   * two-parcel shape worth ~+$5k. Reading a cost out of a sequence nobody has
   * established is not an improvement, so those pools are left as they were
   * until the ordering question is answered on its own.
   */
  const { sells } = replayLedger([
    line("XYZ", "BUY", "2026-01-10", 30_000, 600),
    // Same day, both ways: this is what disables the rule for XYZ entirely.
    line("XYZ", "SELL", "2026-02-10", 10_000, 300),
    line("XYZ", "BUY", "2026-02-10", 10_000, 500),
    line("XYZ", "SELL", "2026-03-10", 10_000, 400),
  ]);

  // The March sale exactly matches the February lot, whose value is $500 — and
  // gets $275 instead, which is weighted average over what is left of the
  // pooled parcel. The two answers are deliberately far apart, or the test
  // would pass whether or not the rule was actually off.
  const march = sells.find((s) => s.tradeDate === "2026-03-10")!;
  assert.equal(march.costOfSold, 275, "weighted average, not the $500 lot");
  assert.equal(march.realizedPl, 125);
});

test("ledger: a same-day BUY is replayed before the SELL, whatever the notes say", () => {
  /**
   * Saturn's `ING`, both legs on 22 Jun 2026, verbatim — and the note numbers
   * run the wrong way round:
   *
   *   SELL 7,000 @ $13,302.50   cnote 2505031
   *   BUY  7,000 @ $14,000.00   cnote 2506714
   *
   * `cnote` is an issuing sequence, not an economic one. Ordered by it the sale
   * met an empty parcel and reported its whole $13,302.50 as profit, on a day
   * trade that lost $697.50.
   *
   * Verified rather than reasoned: replaying buy-first reproduces the desk's own
   * report to the cent on every ticker it covers — 8 of 8, including `4DX`
   * −3,636.97, `CU6` −19,761.19 and `PLS` −18,410.00, where our stored figures
   * had +$78,652, +$25,915 and +$24,896.
   */
  const { sells } = replayLedger([
    { ...line("ING", "SELL", "2026-06-22", 7_000, 13_302.5), cnote: "2505031" },
    { ...line("ING", "BUY", "2026-06-22", 7_000, 14_000), cnote: "2506714" },
  ]);

  assert.equal(sells.length, 1);
  assert.equal(sells[0].costOfSold, 14_000, "the same-day buy costed it");
  assert.equal(sells[0].realizedPl, -697.5, "a loss, not $13,302.50 of profit");
  assert.equal(sells[0].noCostBasis, false, "and nothing is missing");
});
