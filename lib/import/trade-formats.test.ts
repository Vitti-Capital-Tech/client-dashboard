import test from "node:test";
import assert from "node:assert/strict";

import { parseTradeCsv, reduceTrades, SETTLED } from "./trades.ts";
import { detectCsvKind } from "./runner.ts";

/**
 * The broker's `ContractNotesListing` dialect.
 *
 * Every case here is taken from a real file off the morning mail. The
 * translation is small but each part of it can silently corrupt money: a side
 * read the wrong way round, a negative quantity subtracting from units sold, a
 * status that quietly promotes a reversed trade into the P&L.
 */

const HEADER =
  "Organisation Code,Branch,Branch Name,Adviser,Adviser Name,Account Name," +
  "Contract Date,Settlement Date,C/Note Number,Contract Status,Order Number," +
  "Type,Account,Security Code,Units,Consideration,Avg Price,Brokerage,GST,Nett";

/** One row in the broker's own shape. Quoting matches the real export. */
function row(over: Partial<Record<string, string>> = {}): string {
  const f = {
    cnote: "2080845",
    status: "S",
    type: "B",
    account: "1102011",
    security: "BRUXX",
    date: "3/9/2025",
    units: '"250,000"',
    consideration: '"5,000.00"',
    avgPrice: "0.020000",
    brokerage: "0.00",
    gst: "0.00",
    nett: '"5,000.00"',
    ...over,
  };
  return [
    "TPVITT,VT,VITTI CAPITAL PTY LTD,IZR,IZAAC RONAY,MR IZAAC RONAY",
    f.date,
    "4/9/2025",
    f.cnote,
    f.status,
    "S2009600",
    f.type,
    f.account,
    f.security,
    f.units,
    f.consideration,
    f.avgPrice,
    f.brokerage,
    f.gst,
    f.nett,
  ].join(",");
}

const csv = (...rows: string[]) => [HEADER, ...rows, ""].join("\n");

// ---------------------------------------------------------------------------
// Recognition
// ---------------------------------------------------------------------------

test("dialect: a ContractNotesListing export is recognised as a trade ledger", () => {
  assert.equal(detectCsvKind(csv(row())), "trades");
});

test("dialect: the broker's empty-day report is NOT mistaken for data", () => {
  // A day with no trades produces the search-criteria block and no data
  // section at all. Skipping it is right; parsing it as a ledger would not be.
  const noResults = [
    ",,,Contract Notes Listing,,,",
    "Search Criteria,,,,,,",
    "Organisation:,,,,[ALL],,",
    "Market:,,,,ASX,,",
    "Start Date:,,,,01/08/2023,,",
    "",
  ].join("\n");
  assert.equal(detectCsvKind(noResults), "unknown");
});

// ---------------------------------------------------------------------------
// The translation
// ---------------------------------------------------------------------------

test("dialect: B and S become BUY and SELL", () => {
  const { trades } = parseTradeCsv(csv(row({ type: "B" }), row({ type: "S", cnote: "2", units: '"-100"' })));
  assert.deepEqual(trades.map((t) => t.side), ["BUY", "SELL"]);
});

test("dialect: a sale's negative units are stored as a magnitude", () => {
  // The sign is a second statement of the side, which `Type` already made.
  // Carried through it fails the settled-units check, and if that check ever
  // moved it would subtract from units sold instead of adding to them.
  const { trades, errors } = parseTradeCsv(csv(row({ type: "S", units: '"-58,824"' })));
  assert.equal(errors.length, 0, "a negative sale must not be rejected");
  assert.equal(trades[0].units, 58824);
  assert.equal(trades[0].side, "SELL");
});

test("dialect: only S counts as settled; other codes survive verbatim", () => {
  // The desk confirmed only `S` reaches P&L. What R, V, U and P mean precisely
  // was never established, so they are stored as the broker wrote them rather
  // than mapped to a guess — and are excluded simply by not being SETTLED.
  const { trades } = parseTradeCsv(
    csv(
      row({ status: "S", cnote: "1" }),
      row({ status: "R", cnote: "2" }),
      row({ status: "V", cnote: "3" }),
      row({ status: "U", cnote: "4" }),
      row({ status: "P", cnote: "5" }),
    ),
  );

  assert.deepEqual(trades.map((t) => t.status), [SETTLED, "R", "V", "U", "P"]);
  assert.equal(trades.filter((t) => t.status === SETTLED).length, 1);
});

test("dialect: a non-settled row is exempt from the positive-units rule", () => {
  // Reversals and voids legitimately carry odd quantities. Rejecting them would
  // lose the audit trail for the very rows a human most wants to see.
  const { trades, errors } = parseTradeCsv(csv(row({ status: "V", units: "0" })));
  assert.equal(errors.length, 0);
  assert.equal(trades[0].status, "V");
});

test("dialect: Nett is the fee-inclusive value the reducer needs", () => {
  // Verified against the real file: BUY = consideration + fees,
  // SELL = consideration - fees. That is exactly `value`'s contract.
  const { trades } = parseTradeCsv(
    csv(
      row({ type: "B", cnote: "1", consideration: '"5,042.73"', brokerage: "100.00", gst: "10.00", nett: '"5,152.73"' }),
      row({ type: "S", cnote: "2", units: '"-100"', consideration: '"5,117.69"', brokerage: "100.00", gst: "10.00", nett: '"5,007.69"' }),
    ),
  );

  assert.equal(trades[0].value, 5152.73);
  assert.equal(trades[0].consideration, 5042.73);
  assert.equal(trades[1].value, 5007.69);
});

test("dialect: dates are read day-first", () => {
  // Confirmed from the real file: 2,413 rows have a first component above 12
  // and none have a second above 12. Month-first would silently reorder the
  // ledger and corrupt every weighted-average cost.
  const { trades } = parseTradeCsv(csv(row({ date: "3/9/2025" })));
  assert.equal(trades[0].tradeDate, "2025-09-03");
});

test("dialect: there is no company name, and none is invented", () => {
  // `Account Name` holds the CLIENT, not the company. Borrowing it would put a
  // person's name in the company column of every export. Names reach the
  // database through the holdings snapshot, which does carry them.
  const { trades } = parseTradeCsv(csv(row()));
  assert.equal(trades[0].company, "");
});

test("dialect: derivative codes still roll up to their ordinary", () => {
  const { trades } = parseTradeCsv(csv(row({ security: "BRUXX" })));
  assert.equal(trades[0].rawSecurity, "BRUXX");
  assert.equal(trades[0].parent, "BRU");
});

// ---------------------------------------------------------------------------
// End to end
// ---------------------------------------------------------------------------

test("dialect: a round trip through the dialect reduces to the right P&L", () => {
  const { trades } = parseTradeCsv(
    csv(
      row({ cnote: "1", type: "B", security: "EOS", date: "19/5/2026", units: '"1,000"', consideration: '"5,000.00"', nett: '"5,000.00"' }),
      row({ cnote: "2", type: "S", security: "EOS", date: "21/5/2026", units: '"-1,000"', consideration: '"8,000.00"', nett: '"8,000.00"' }),
      // Reversed — must not touch the result.
      row({ cnote: "3", status: "R", type: "S", security: "EOS", date: "22/5/2026", units: '"-1,000"', consideration: '"99,000.00"', nett: '"99,000.00"' }),
    ),
  );

  const [rollup] = reduceTrades(trades);
  assert.equal(rollup.parent, "EOS");
  assert.equal(rollup.unitsBought, 1000);
  assert.equal(rollup.unitsSold, 1000);
  assert.equal(rollup.realizedPl, 3000, "not 102000 — the reversal is excluded");
});

// ---------------------------------------------------------------------------
// Foreign listings
// ---------------------------------------------------------------------------

test("foreign: an exchange-qualified code is its own parent", () => {
  // `BRAI` is a whole NASDAQ ticker, not `BRA` plus a derivative suffix.
  // Slicing to three would file Braiin under an invented `BRA` and merge it
  // with any ASX code that happens to start the same way.
  const { trades, errors } = parseTradeCsv(csv(row({ security: "BRAI:NAS" })));
  assert.equal(errors.length, 0, "a US holding must not be rejected");
  assert.equal(trades[0].rawSecurity, "BRAI:NAS");
  assert.equal(trades[0].parent, "BRAI:NAS");
});

test("foreign: a US ticker is never read as an ASX option", () => {
  // The "an O after the third character" tell is an ASX convention. On a
  // foreign ticker it is a coincidence — `SONO:NAS` is not an option on `SON`.
  const { trades } = parseTradeCsv(csv(row({ security: "SONO:NAS" })));
  assert.equal(trades[0].parent, "SONO:NAS");
});

test("foreign: ASX codes are untouched by the foreign-listing rule", () => {
  const { trades } = parseTradeCsv(
    csv(
      row({ cnote: "1", security: "EOS" }),
      row({ cnote: "2", security: "EOSXX" }),
      row({ cnote: "3", security: "AT4" }),
    ),
  );
  assert.deepEqual(trades.map((t) => t.parent), ["EOS", "EOS", "AT4"]);
});

test("foreign: genuinely unreadable codes are still refused", () => {
  // Widening for `:NAS` must not turn the check into a rubber stamp — a code
  // that is neither shape is still an error rather than a silent import.
  const { errors } = parseTradeCsv(csv(row({ security: "??" })));
  assert.equal(errors.length, 1);
  assert.match(errors[0].reason, /Unrecognised security code/);
});
