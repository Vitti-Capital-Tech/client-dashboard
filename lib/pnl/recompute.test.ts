import test from "node:test";
import assert from "node:assert/strict";

import { fakeDb } from "../test-support/fake-db.ts";
import {
  dbTradesToParsedRows,
  loadAccountHolders,
  loadDbHoldings,
  type DbTradeRow,
} from "./from-db.ts";
import { recomputeAccountPnl } from "./recompute.ts";

/**
 * Tests for the database-driven P&L.
 *
 * The maths is the calculator's and is covered by lib/pnl-calculator.test.ts.
 * What is tested here is the seam: that stored trades reach the engine in the
 * shape it expects, that rows the sources have dropped disappear from the
 * stored P&L, and that a run is recorded for every figure written down.
 */

const ACCOUNT = "a1";

/** One account, one client, one round trip, one still-held option. */
function seeded() {
  return fakeDb({
    clients: [{ id: "c1", external_ref: "114716", display_name: "SMITH JOHN" }],
    accounts: [
      { id: ACCOUNT, external_ref: "114716", ref: "A1", client_id: "c1", label: "Smith" },
    ],
    securities: [
      { code: "EOS", parent_code: null, name: "ELECTRO OPTIC", last_price: 9 },
      { code: "EOSO", parent_code: "EOS", name: "ELECTRO OPTIC OPT", last_price: 0.5 },
    ],
    trades: [
      {
        cnote: "2001",
        account_id: ACCOUNT,
        raw_security: "EOS",
        security_code: "EOS",
        parent_code: "EOS",
        instrument: "FPO",
        side: "BUY",
        trade_date: "2026-05-19",
        units: "1000",
        avg_price: "5.00",
        consideration: "5000",
        value: "5000",
        status: "SETTLED",
      },
      {
        cnote: "2002",
        account_id: ACCOUNT,
        raw_security: "EOS",
        security_code: "EOS",
        parent_code: "EOS",
        instrument: "FPO",
        side: "SELL",
        trade_date: "2026-05-21",
        units: "1000",
        avg_price: "8.00",
        consideration: "8000",
        value: "8000",
        status: "SETTLED",
      },
    ],
    positions: [],
  });
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

const refs = new Map([[ACCOUNT, "114716"]]);

function tradeRow(over: Partial<DbTradeRow> = {}): DbTradeRow {
  return {
    cnote: "1",
    account_id: ACCOUNT,
    raw_security: "EOS",
    security_code: "EOS",
    parent_code: "EOS",
    instrument: "FPO",
    side: "BUY",
    trade_date: "2026-05-19",
    units: "100",
    avg_price: "5",
    consideration: "500",
    value: "500",
    status: "SETTLED",
    ...over,
  };
}

test("holders: the tracker's own names for a client are hints too", async () => {
  // The placement sheet is hand-typed and `display_name` is not, so one party is
  // written several ways — and what is left after normalising spelling is not
  // spelling at all: the real workbooks carry `PSG Capital Ltd` and `PSG Super`
  // against two SEPARATE clients. Which is which is a fact about the desk's
  // records, so it is stated in `clients.placement_aliases` rather than guessed at
  // by a looser matcher, which would move a parcel between two real clients.
  const { db } = fakeDb({
    clients: [
      {
        id: "c1",
        display_name: "Psg Capital Investments PTY LTD",
        placement_aliases: ["PSG Capital Pty Ltd", "PSG Investments"],
      },
    ],
    accounts: [{ id: ACCOUNT, client_id: "c1", label: "Smith", external_ref: "114716" }],
  });

  const holders = await loadAccountHolders(db, [ACCOUNT]);
  assert.deepEqual(holders, [
    "Psg Capital Investments PTY LTD",
    "PSG Capital Pty Ltd",
    "PSG Investments",
  ]);
});

test("holders: a client with no aliases behaves exactly as before", async () => {
  const holders = await loadAccountHolders(seeded().db, [ACCOUNT]);
  assert.deepEqual(holders, ["SMITH JOHN"]);
});

test("adapter: numerics arrive from PostgREST as strings and must be coerced", () => {
  // Left as strings, every sum downstream becomes string concatenation.
  const [row] = dbTradesToParsedRows([tradeRow()], refs);
  assert.equal(row.units, 100);
  assert.equal(row.value, 500);
  assert.equal(typeof row.units, "number");
  assert.equal(typeof row.value, "number");
});

test("adapter: only SETTLED trades reach the engine", () => {
  // The file parser drops these while reading the sheet, so the aggregator has
  // never had to check status. The database keeps them for the audit trail —
  // a REVERSAL is stored as the negative of the line it undoes, so letting one
  // through would move the P&L.
  const rows = dbTradesToParsedRows(
    [
      tradeRow({ cnote: "1", status: "SETTLED" }),
      tradeRow({ cnote: "2", status: "CANCELLED" }),
      tradeRow({ cnote: "3", status: "REVERSAL" }),
      tradeRow({ cnote: "4", status: "REVERSED" }),
    ],
    refs,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cnote, "1");
});

test("adapter: the account filter sees the broker's number, not the row id", () => {
  const [row] = dbTradesToParsedRows([tradeRow()], refs);
  assert.equal(row.account, "114716");
});

test("adapter: the stored date passes through as ISO, unreformatted", () => {
  // `trades.trade_date` is already `YYYY-MM-DD`, the first form the engine's
  // date parser recognises. Re-rendering it day-first would reintroduce the
  // exact ambiguity the ledger import resolved on the way in.
  const [row] = dbTradesToParsedRows([tradeRow({ trade_date: "2026-01-02" })], refs);
  assert.equal(row.contractDate, "2026-01-02");
});

// ---------------------------------------------------------------------------
// Holdings
// ---------------------------------------------------------------------------

test("holdings: an option is valued at its own price, never the underlying's", async () => {
  const { db, tables } = seeded();
  tables.positions.push({
    account_id: ACCOUNT,
    client_id: "c1",
    security_code: "EOSO",
    qty: 1000,
    avg_cost: 0,
  });

  const [held] = await loadDbHoldings(db, [ACCOUNT], refs);

  // EOSO at 0.50, not EOS at 9.00 — an 18x difference if grouped wrongly.
  assert.equal(held.ticker, "EOSO");
  assert.equal(held.marketValue, 500);
  assert.equal(held.parentTicker, "EOS");
});

test("holdings: a position with no quote is marked flat, not written off", async () => {
  const { db, tables } = seeded();
  tables.securities.push({ code: "NPX", parent_code: null, name: "NO PRICE", last_price: 0 });
  tables.positions.push({
    account_id: ACCOUNT,
    client_id: "c1",
    security_code: "NPX",
    qty: 100,
    avg_cost: 2,
  });

  const held = (await loadDbHoldings(db, [ACCOUNT], refs)).find((h) => h.ticker === "NPX")!;
  assert.equal(held.costBase, 200);
  assert.equal(held.marketValue, 200, "falls back to cost base, not to zero");
  assert.equal(held.unrealizedPnl, 0);
});

// ---------------------------------------------------------------------------
// Recompute
// ---------------------------------------------------------------------------

test("recompute: stores one row per ticker and a run to explain them", async () => {
  const { db, tables } = seeded();
  const res = await recomputeAccountPnl(db, ACCOUNT, { trigger: "ingest" });

  // Bought 1,000 for $5,000, sold the lot for $8,000.
  assert.equal(res.totalPnl, 3000);
  assert.equal(tables.pnl_summary.length, 1);

  const row = tables.pnl_summary[0];
  assert.equal(row.ticker, "EOS");
  assert.equal(row.pnl, 3000);
  assert.equal(row.account_id, ACCOUNT);
  assert.equal(row.client_id, "c1");

  // Every stored figure is tied to the run that produced it.
  assert.equal(tables.pnl_runs.length, 1);
  assert.equal(row.run_id, tables.pnl_runs[0].id);
  assert.equal(tables.pnl_runs[0].trigger, "ingest");
  assert.equal(tables.pnl_runs[0].total_pnl, 3000);
  assert.equal(tables.pnl_runs[0].row_count, 1);
});

test("recompute: a cancelled trade never moves the stored P&L", async () => {
  const { db, tables } = seeded();
  tables.trades.push({
    cnote: "2003",
    account_id: ACCOUNT,
    raw_security: "EOS",
    security_code: "EOS",
    parent_code: "EOS",
    instrument: "FPO",
    side: "SELL",
    trade_date: "2026-05-22",
    units: "1000",
    avg_price: "99",
    consideration: "99000",
    value: "99000",
    status: "CANCELLED",
  });

  const res = await recomputeAccountPnl(db, ACCOUNT);
  assert.equal(res.totalPnl, 3000, "not 102000");
});

test("recompute: an unmatched placement row is counted, not just described", async () => {
  // The sheet names two people and neither is this account holder, and the row
  // it would have filled has no buy side at all. Nothing is filled — the
  // stranger's parcel must not be stored here — and the count travels back as a
  // NUMBER so a rebuild of every account can say how many still need an alias
  // without anyone opening fifty client profiles.
  const { db, tables } = seeded();
  tables.trades.length = 0;
  tables.trades.push({
    cnote: "3001",
    account_id: ACCOUNT,
    raw_security: "ABE",
    security_code: "ABE",
    parent_code: "ABE",
    instrument: "FPO",
    side: "SELL",
    trade_date: "2026-05-21",
    units: "100000",
    avg_price: "0.10",
    consideration: "10000",
    value: "10000",
    status: "SETTLED",
  });
  tables.securities.push({ code: "ABE", parent_code: null, name: "ABE", last_price: 0.1 });

  const placements = new Map([
    [
      "ABE",
      {
        ticker: "ABE",
        totalShares: 200000,
        totalActualDollar: 20000,
        clientAllocations: [
          { clientName: "Zidiplus Pty Ltd", advisor: "VTC", askingBid: 0, allocationDollar: 10000, roundShares: 100000, actualDollar: 10000 },
          { clientName: "Ikigai Consortium Pty Ltd", advisor: "VTC", askingBid: 0, allocationDollar: 10000, roundShares: 100000, actualDollar: 10000 },
        ],
      },
    ],
  ]);

  const res = await recomputeAccountPnl(db, ACCOUNT, { placements });

  assert.equal(res.unfilledPlacements, 1);
  assert.equal(tables.pnl_summary.find((r) => r.ticker === "ABE")?.buy_qty, 0);
  assert.ok(res.warnings.some((w) => w.includes("incomplete buy side")));
});

test("recompute: a holding with no contract note still appears", async () => {
  // Free attaching options are never bought, so nothing in the ledger names
  // them. They exist only in the snapshot, and must not vanish from the P&L.
  const { db, tables } = seeded();
  tables.positions.push({
    account_id: ACCOUNT,
    client_id: "c1",
    security_code: "EOSO",
    qty: 1000,
    avg_cost: 0,
  });

  await recomputeAccountPnl(db, ACCOUNT);

  const optionRow = tables.pnl_summary.find((r) => r.ticker === "EOSO");
  assert.ok(optionRow, "the snapshot-only option must have a row");
  assert.equal(optionRow!.is_db_only, true);
});

test("recompute: replaces, so a ticker the sources dropped disappears", async () => {
  const { db, tables } = seeded();
  tables.positions.push({
    account_id: ACCOUNT,
    client_id: "c1",
    security_code: "EOSO",
    qty: 1000,
    avg_cost: 0,
  });

  await recomputeAccountPnl(db, ACCOUNT);
  assert.ok(tables.pnl_summary.some((r) => r.ticker === "EOSO"));

  // The client sells the option; the next snapshot no longer reports it.
  tables.positions.length = 0;
  await recomputeAccountPnl(db, ACCOUNT);

  assert.equal(
    tables.pnl_summary.some((r) => r.ticker === "EOSO"),
    false,
    "a position that is no longer held must leave the stored P&L",
  );
  assert.equal(tables.pnl_summary.length, 1);
});

test("recompute: another account's stored P&L is never touched", async () => {
  const { db, tables } = seeded();
  tables.pnl_summary.push({
    account_id: "a-other",
    client_id: "c-other",
    ticker: "ZZZ",
    pnl: 42,
  });

  await recomputeAccountPnl(db, ACCOUNT);

  assert.ok(
    tables.pnl_summary.some((r) => r.account_id === "a-other" && r.ticker === "ZZZ"),
    "the replace is scoped to one account",
  );
});

test("recompute: every run is appended, so a figure's history survives", async () => {
  const { db, tables } = seeded();
  await recomputeAccountPnl(db, ACCOUNT, { trigger: "ingest" });
  await recomputeAccountPnl(db, ACCOUNT, { trigger: "manual" });

  assert.equal(tables.pnl_runs.length, 2, "runs accumulate; summary rows do not");
  assert.equal(tables.pnl_summary.length, 1);
  assert.deepEqual(
    tables.pnl_runs.map((r) => r.trigger),
    ["ingest", "manual"],
  );
});
