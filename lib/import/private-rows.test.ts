import assert from "node:assert/strict";
import { test } from "node:test";
import {
  netPositionEffects,
  toIsoDate,
  toPrivateTransactions,
  type PrivateTxnRow,
} from "./private-rows.ts";
import type { ParsedTradeRow } from "../pnl-calculator.ts";

/**
 * The gate between a spreadsheet somebody typed and a client's portfolio.
 *
 * `parsePnlFileBuffer` is covered in pnl-calculator.test.ts and is not retested
 * here; what these pin is the half that decides what reaches the database, and
 * the netting that keeps a whole file's weighted average cost correct however
 * the rows happen to be ordered.
 */

const row = (over: Partial<ParsedTradeRow> = {}): ParsedTradeRow => ({
  type: "BUY",
  ticker: "LDX",
  company: "LUMOS DIAGNOSTICS",
  contractDate: "01-03-2026",
  units: 10_000,
  avgPrice: 0.25,
  value: 2500,
  status: "SETTLED",
  ...over,
});

test("dates are read day-first, and an ISO date is never re-read as one", () => {
  // The whole reason ISO is matched first: `2026-03-04` day-first would be 3 April.
  assert.equal(toIsoDate("2026-03-04"), "2026-03-04");
  assert.equal(toIsoDate("04-03-2026"), "2026-03-04");
  assert.equal(toIsoDate("4/3/26"), "2026-03-04");
  assert.equal(toIsoDate(""), null);
  assert.equal(toIsoDate("not a date"), null);
  assert.equal(toIsoDate("32-01-2026"), null);
  assert.equal(toIsoDate("01-13-2026"), null);
});

test("an Excel serial date is a date, not a five-digit number", () => {
  // 46085 is 2026-03-04 under Excel's epoch, the 1900-leap-year bug included.
  assert.equal(toIsoDate("46085"), "2026-03-04");
});

test("an ordinary file maps straight through", () => {
  const { rows, errors } = toPrivateTransactions([row()]);
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    securityCode: "LDX",
    securityName: "LUMOS DIAGNOSTICS",
    side: "BUY",
    tradeDate: "2026-03-01",
    units: 10_000,
    avgPrice: 0.25,
    consideration: null,
    cnote: null,
  });
});

test("a blank status is accepted, because a desk spreadsheet has no broker column", () => {
  const { rows, errors } = toPrivateTransactions([row({ status: "" }), row({ status: undefined })]);
  assert.equal(rows.length, 2);
  assert.deepEqual(errors, []);
});

test("a cancelled or pending row is refused, and says which it was", () => {
  const { rows, errors } = toPrivateTransactions([
    row({ status: "CANCELLED" }),
    row({ status: "PENDING" }),
  ]);
  assert.equal(rows.length, 0);
  assert.equal(errors.length, 2);
  assert.match(errors[0].reason, /CANCELLED/);
  assert.match(errors[1].reason, /PENDING/);
});

test("a bad row is REPORTED, not dropped — and does not take the file with it", () => {
  /**
   * The failure this file exists to prevent: a silent skip leaves the client's
   * portfolio missing a parcel with nothing anywhere saying so.
   */
  const { rows, errors } = toPrivateTransactions([
    row({ ticker: "AAA" }),
    row({ ticker: "", company: "NO CODE" }),
    row({ ticker: "BBB", units: 0 }),
    row({ ticker: "CCC", contractDate: "rubbish" }),
    row({ ticker: "DDD" }),
  ]);

  assert.deepEqual(rows.map((r) => r.securityCode), ["AAA", "DDD"]);
  assert.equal(errors.length, 3);
  // Line numbers are the desk's own count, so a reported row can be found.
  assert.deepEqual(errors.map((e) => e.line), [2, 3, 4]);
  assert.match(errors[1].reason, /Units/);
  assert.match(errors[2].reason, /date/);
});

test("consideration is carried only when it is a real figure", () => {
  const { rows } = toPrivateTransactions([
    row({ consideration: 2499.5 }),
    row({ ticker: "AAA", consideration: 0 }),
  ]);
  assert.equal(rows[0].consideration, 2499.5);
  // Zero means "the column was empty", and must fall through to units × price
  // rather than book the parcel as free.
  assert.equal(rows[1].consideration, null);
});

const txn = (over: Partial<PrivateTxnRow> = {}): PrivateTxnRow => ({
  securityCode: "LDX",
  securityName: "LUMOS",
  side: "BUY",
  tradeDate: "2026-03-04",
  units: 1000,
  avgPrice: 1,
  consideration: null,
  cnote: null,
  ...over,
});

test("a file's effect on a holding is netted per code, not applied row by row", () => {
  const effects = netPositionEffects([
    txn({ securityCode: "LDX", side: "BUY", units: 1000, avgPrice: 1 }),
    txn({ securityCode: "LDX", side: "BUY", units: 1000, avgPrice: 3 }),
    txn({ securityCode: "LDX", side: "SELL", units: 500, avgPrice: 9 }),
    txn({ securityCode: "EOS", side: "BUY", units: 200, avgPrice: 5 }),
  ]);

  assert.equal(effects.size, 2);
  const ldx = effects.get("LDX")!;
  assert.equal(ldx.deltaUnits, 1500);
  assert.equal(ldx.buyUnits, 2000);
  // Only BUYs carry cost — the 500 sold at $9 must not enter the cost base.
  assert.equal(ldx.buyCost, 4000);
  assert.equal(effects.get("EOS")!.buyCost, 1000);
});

test("the netted cost is the same whichever order the rows arrive in", () => {
  /**
   * The reason netting exists at all. Applied row by row, a SELL sitting above
   * later BUYs would be weighted against a cost base those BUYs had not yet
   * contributed to, and the answer would depend on how the spreadsheet was
   * sorted.
   */
  const rows = [
    txn({ side: "BUY", units: 1000, avgPrice: 1 }),
    txn({ side: "SELL", units: 400, avgPrice: 7 }),
    txn({ side: "BUY", units: 1000, avgPrice: 3 }),
  ];
  const forward = netPositionEffects(rows).get("LDX")!;
  const reversed = netPositionEffects([...rows].reverse()).get("LDX")!;

  assert.deepEqual(
    { u: forward.deltaUnits, c: forward.buyCost },
    { u: reversed.deltaUnits, c: reversed.buyCost },
  );
});

test("a blank company later in the file does not erase the name", () => {
  const effects = netPositionEffects([
    txn({ securityName: "LUMOS DIAGNOSTICS" }),
    txn({ securityName: null }),
  ]);
  assert.equal(effects.get("LDX")!.name, "LUMOS DIAGNOSTICS");
});
