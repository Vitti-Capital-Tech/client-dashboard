import test from "node:test";
import assert from "node:assert/strict";

import { detectCsvKind, ImportError } from "./runner.ts";
import { runHoldingsImport } from "./run-holdings.ts";
import { runTradeImport } from "./run-trades.ts";
import { fakeDb } from "../test-support/fake-db.ts";

/**
 * Tests for the import RUNNERS — the layer the CLI and the morning mail ingest
 * both call.
 *
 * The parsers and the P&L reducer are covered in import.test.ts; what is at
 * stake here is everything that only shows up once a database is involved:
 * which rows a full replace is allowed to delete, whether re-running a file
 * double-counts it, and whether a file that cannot be identified is refused
 * rather than guessed at.
 *
 * They run against a fake PostgREST client rather than a real Supabase, so
 * they are fast, hermetic, and safe to run on a laptop with production
 * credentials in .env.local.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HOLDINGS_CSV = [
  "Account Number,Account Name,Security Code,Company Name,Holding Qty,Market Price,Average Cost,Market Value,Portfolio Value,Status,Advisor Code,Advisor Name",
  "114716,SMITH JOHN,EOS,ELECTRO OPTIC,1000,8.00,5.00,8000,5000,ACTIVE,VIZ,Vitti",
  "114716,SMITH JOHN,EOSXX,ELECTRO OPTIC OPT,500,0.50,0.10,250,50,ACTIVE,VIZ,Vitti",
  "220001,JONES MARY,LDX,LUMOS DIAGNOSTICS,2000,0.275,0.235,550,470,ACTIVE,VIZ,Vitti",
  "",
].join("\n");

const TRADES_CSV = [
  "CNote,Account,Type,Security,Company,Contract Date,Units,Value,Avg Price,Consideration,Brokerage,Other Charges,GST,Status",
  "2001,114716,BUY,EOS,ELECTRO OPTIC,19/05/26,1000,5000,5.00,5000,0,0,0,SETTLED",
  "2002,114716,SELL,EOS,ELECTRO OPTIC,21/05/26,1000,8000,8.00,8000,0,0,0,SETTLED",
  "",
].join("\n");

/** The state a trade import expects: accounts already created by a snapshot. */
function seededForTrades() {
  return fakeDb({
    clients: [{ id: "c1", external_ref: "114716" }],
    accounts: [{ id: "a1", external_ref: "114716", client_id: "c1" }],
    securities: [{ code: "EOS", parent_code: null }],
  });
}

// ---------------------------------------------------------------------------
// detectCsvKind — the mail ingest's only way of telling the files apart
// ---------------------------------------------------------------------------

test("detect: a holdings export is identified by its columns", () => {
  assert.equal(detectCsvKind(HOLDINGS_CSV), "holdings");
});

test("detect: a trade ledger is identified by its columns", () => {
  assert.equal(detectCsvKind(TRADES_CSV), "trades");
});

test("detect: extra and re-ordered columns still identify the file", () => {
  // The broker is free to add columns and shuffle them; only the presence of
  // the ones we read is load-bearing. This is the whole reason classification
  // is not done on the filename.
  const shuffled =
    "Junk,Average Cost,Company Name,Market Price,Account Name,Holding Qty," +
    "Security Code,Account Number,Another\n" +
    "x,5.00,ELECTRO OPTIC,8.00,SMITH JOHN,1000,EOS,114716,y\n";
  assert.equal(detectCsvKind(shuffled), "holdings");
});

test("detect: an unrecognised file is never guessed at", () => {
  assert.equal(detectCsvKind("Invoice No,Amount\n1,2\n"), "unknown");
  assert.equal(detectCsvKind(""), "unknown");
  // A near miss — trade columns with `Units` renamed — must NOT pass as trades.
  assert.equal(
    detectCsvKind("CNote,Account,Type,Security,Company,Contract Date,Qty,Value,Status\n"),
    "unknown",
  );
});

// ---------------------------------------------------------------------------
// Holdings
// ---------------------------------------------------------------------------

test("holdings: a dry run reports the file and writes nothing", async () => {
  const { db, tables } = fakeDb();
  const res = await runHoldingsImport(db, HOLDINGS_CSV, { dryRun: true });

  assert.equal(res.applied, false);
  assert.equal(res.written, null);
  assert.equal(res.parsed.holdings, 3);
  assert.equal(res.parsed.accounts, 2);
  assert.equal(res.parsed.marketValue, 8800);
  assert.equal(res.parsed.costBase, 5520);
  assert.deepEqual(res.derivativeLinks, ["EOSXX→EOS"]);

  for (const [name, rows] of Object.entries(tables)) {
    assert.equal(rows.length, 0, `${name} should be untouched by a dry run`);
  }
});

test("holdings: a real run creates clients, accounts, securities and positions", async () => {
  const { db, tables } = fakeDb();
  const res = await runHoldingsImport(db, HOLDINGS_CSV);

  assert.equal(res.applied, true);
  assert.equal(tables.clients.length, 2);
  assert.equal(tables.accounts.length, 2);
  assert.equal(tables.positions.length, 3);
  assert.equal(res.written!.positions, 3);

  // The derivative is linked back to its ordinary, which is what lets EOS and
  // EOSXX roll up as one company later.
  const eosxx = tables.securities.find((s) => s.code === "EOSXX");
  assert.equal(eosxx!.parent_code, "EOS");

  // Both accounts are reported as touched — the P&L recompute scope.
  assert.deepEqual(res.touched.accountRefs.sort(), ["114716", "220001"]);
  assert.equal(res.touched.accountIds.length, 2);
});

test("holdings: the full replace deletes only the accounts in the file", async () => {
  const { db, tables } = fakeDb();
  await runHoldingsImport(db, HOLDINGS_CSV);

  const untouchedAccountId = "a-not-in-file";
  tables.accounts.push({
    id: untouchedAccountId,
    external_ref: "999999",
    client_id: "c-other",
  });
  tables.positions.push({
    account_id: untouchedAccountId,
    client_id: "c-other",
    security_code: "ABC",
    qty: 5,
  });

  // A holding that has since been sold: present in the database, absent from
  // today's snapshot. It must disappear.
  const acct114716 = tables.accounts.find((a) => a.external_ref === "114716")!;
  tables.positions.push({
    account_id: acct114716.id,
    client_id: acct114716.client_id,
    security_code: "GONE",
    qty: 42,
  });

  const res = await runHoldingsImport(db, HOLDINGS_CSV);

  assert.equal(
    tables.positions.some((p) => p.security_code === "GONE"),
    false,
    "a holding absent from the snapshot has been sold and must be removed",
  );
  assert.equal(
    tables.positions.some((p) => p.account_id === untouchedAccountId),
    true,
    "an account absent from the file must be left completely alone",
  );
  assert.equal(res.written!.staleRemoved, 4);
});

test("holdings: re-running the same file converges, it does not accumulate", async () => {
  const { db, tables } = fakeDb();
  await runHoldingsImport(db, HOLDINGS_CSV);
  await runHoldingsImport(db, HOLDINGS_CSV);

  assert.equal(tables.clients.length, 2);
  assert.equal(tables.accounts.length, 2);
  assert.equal(tables.positions.length, 3);
});

test("holdings: a file with no usable rows is refused, not applied", async () => {
  const { db } = fakeDb();
  const headerOnly = HOLDINGS_CSV.split("\n")[0] + "\n";

  await assert.rejects(
    () => runHoldingsImport(db, headerOnly),
    (err: unknown) => {
      assert.ok(err instanceof ImportError);
      assert.equal(err.code, "NO_ROWS");
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Trades
// ---------------------------------------------------------------------------

test("trades: an unknown account number is refused rather than guessed", async () => {
  // No holdings snapshot has run, so no account exists to attach the trade to.
  const { db } = fakeDb();

  await assert.rejects(
    () => runTradeImport(db, TRADES_CSV),
    (err: unknown) => {
      assert.ok(err instanceof ImportError);
      assert.equal(err.code, "UNKNOWN_ACCOUNTS");
      assert.deepEqual(err.details, ["114716"]);
      return true;
    },
  );
});

test("trades: a real run stores the ledger and rebuilds realized P&L", async () => {
  const { db, tables } = seededForTrades();
  const res = await runTradeImport(db, TRADES_CSV, { sourceFile: "t.csv" });

  assert.equal(res.applied, true);
  assert.equal(tables.trades.length, 2);
  assert.equal(tables.realized_pnl.length, 1);

  // Bought 1000 for $5,000, sold the lot for $8,000.
  const rollup = tables.realized_pnl[0];
  assert.equal(rollup.parent_code, "EOS");
  assert.equal(rollup.realized_pl, 3000);
  assert.equal(res.totalRealized, 3000);

  assert.equal(tables.trades[0].source_file, "t.csv");
  assert.deepEqual(res.touched.accountIds, ["a1"]);
});

test("trades: re-importing the same contract notes never double-counts", async () => {
  const { db, tables } = seededForTrades();
  await runTradeImport(db, TRADES_CSV);
  const second = await runTradeImport(db, TRADES_CSV);

  assert.equal(tables.trades.length, 2, "upserted on (cnote, security, side)");
  assert.equal(tables.realized_pnl.length, 1);
  assert.equal(second.totalRealized, 3000, "not 6000");
});

test("trades: a dry run previews the P&L and writes nothing", async () => {
  const { db, tables } = seededForTrades();
  const res = await runTradeImport(db, TRADES_CSV, { dryRun: true });

  assert.equal(res.applied, false);
  assert.equal(res.written, null);
  assert.equal(res.totalRealized, 3000);
  assert.equal(tables.trades.length, 0);
  assert.equal(tables.realized_pnl.length, 0);
  // Drift needs the stored snapshot to compare against, so it is not attempted.
  assert.deepEqual(res.drift, []);
});

test("trades: non-settled rows are stored for the audit trail but not counted", async () => {
  const { db, tables } = seededForTrades();
  const withCancelled =
    TRADES_CSV.trimEnd() +
    "\n2003,114716,BUY,EOS,ELECTRO OPTIC,22/05/26,0,0,0,0,0,0,0,CANCELLED\n";

  const res = await runTradeImport(db, withCancelled);

  assert.equal(res.parsed.trades, 3);
  assert.equal(res.parsed.settled, 2);
  assert.deepEqual(res.parsed.byStatus, { CANCELLED: 1 });
  assert.equal(tables.trades.length, 3, "kept for the audit trail");
  assert.equal(res.totalRealized, 3000, "but never reaches the reducer");
});

test("trades: a ledger-only security gets a stub so nothing is dropped", async () => {
  // LDX was fully exited, so it is absent from the holdings snapshot — but
  // trades.security_code is a real FK and still needs a row to point at.
  const { db, tables } = seededForTrades();
  const withExited =
    TRADES_CSV.trimEnd() +
    "\n2004,114716,SELL,LDX,LUMOS DIAGNOSTICS,04/02/26,100,275,2.75,275,0,0,0,SETTLED\n";

  const res = await runTradeImport(db, withExited);

  assert.ok(res.written!.securityStubs.includes("LDX"));
  assert.ok(tables.securities.some((s) => s.code === "LDX"));
});
