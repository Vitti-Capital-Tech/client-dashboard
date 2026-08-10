// CLI front door for the trade-ledger import.
// ----------------------------------------------------------------------------
// The import itself lives in lib/import/run-trades.ts — read that file for the
// idempotency rule and how `realized_pnl` is rebuilt. This script only reads
// argv and renders the result, so the terminal and the morning mail ingest can
// never disagree about what an import did.
//
// Run:
//   node --env-file=.env.local scripts/import-trades.mjs <trades.csv>
//   node --env-file=.env.local scripts/import-trades.mjs <trades.csv> --dry-run
// ----------------------------------------------------------------------------

import {
  adminClient,
  parseArgs,
  readCsv,
  reportRowErrors,
  fmtMoney,
  die,
} from "./_import-common.mjs";
import { runTradeImport } from "../lib/import/run-trades.ts";

const USAGE =
  "Usage: node --env-file=.env.local scripts/import-trades.mjs <trades.csv> [--dry-run]";

/**
 * Print the worklist of trades whose cost basis could not be established, with
 * the missing buy value suggested wherever the ledger itself contains it.
 */
function printExceptions(exceptions) {
  if (exceptions.length === 0) return;

  console.log(
    `\n  ── ${exceptions.length} transaction(s) need a cost basis ─────────────────────`,
  );

  for (const e of exceptions) {
    const head =
      `  ${e.accountRef}  ${e.parent.padEnd(5)} ` +
      `sold ${e.unitsSold.toLocaleString("en-AU").padStart(9)} units ` +
      `for ${fmtMoney(e.proceeds).padStart(11)}`;

    if (e.kind === "probable-ticker-change") {
      const s = e.suggestion;
      console.log(`${head}   ← TICKER CHANGE?`);
      console.log(
        `      bought as ${s.rawSecurity} on ${s.tradeDate} for ${fmtMoney(s.value)} ` +
          `(cnote ${s.cnote}, same ${s.units.toLocaleString("en-AU")} units)`,
      );
      console.log(
        `      realised ${fmtMoney(e.reportedRealized)} → ${fmtMoney(e.correctedRealized)} if adopted`,
      );
    } else if (e.kind === "unsold-option") {
      console.log(`${head}   ← OPTION, not auto-matched`);
    } else {
      console.log(`${head}   ← no buy in ledger; needs an earlier statement`);
    }
  }

  const overstated = exceptions.reduce((s, e) => s + (e.suggestion?.value ?? 0), 0);
  if (overstated > 0) {
    console.log(
      `\n  Adopting every suggestion above would reduce realised P&L by ${fmtMoney(overstated)}.`,
    );
  }
}

function printRollupTable(rollups) {
  console.log(
    "  ACCT     CODE   BOUGHT      SOLD      OPEN   PROCEEDS       COST     REALIZED",
  );
  for (const r of rollups) {
    console.log(
      `  ${r.accountRef.padEnd(8)} ${r.parent.padEnd(5)} ` +
        `${r.unitsBought.toLocaleString("en-AU").padStart(9)} ` +
        `${r.unitsSold.toLocaleString("en-AU").padStart(9)} ` +
        `${r.openUnits.toLocaleString("en-AU").padStart(9)} ` +
        `${fmtMoney(r.proceeds).padStart(11)} ` +
        `${fmtMoney(r.costOfSold).padStart(11)} ` +
        `${fmtMoney(r.realizedPl).padStart(12)}` +
        (r.shortHistory ? "  ⚠ no opening balance" : "") +
        (r.hasPartial ? "  ~ partial close (WAC)" : ""),
    );
  }
}

const { file, dryRun } = parseArgs(USAGE);
const sourceFile = file.split(/[\\/]/).pop();

// A dry run never touches the database, so it must not demand credentials
// either — it is the one command you can hand to someone without the key.
const supabase = dryRun ? null : adminClient();

let result;
try {
  result = await runTradeImport(supabase, readCsv(file), { sourceFile, dryRun });
} catch (err) {
  die(err);
}

reportRowErrors(result.rowErrors, "trade");

const { parsed } = result;

console.log(`\nParsed ${file}`);
console.log(
  `  ${parsed.trades} trades across ${parsed.accountRefs.length} account(s)`,
);
console.log(`  ${parsed.settled} settled, ${parsed.skipped} skipped for P&L`);
if (parsed.skipped > 0) {
  console.log(
    `    (${Object.entries(parsed.byStatus)
      .map(([s, n]) => `${n} ${s}`)
      .join(", ")} — stored, not counted)`,
  );
}
console.log(`  dates ${parsed.firstDate} → ${parsed.lastDate}`);

if (!result.applied) {
  console.log("\n--dry-run: nothing written. Realized P&L preview:\n");
  printRollupTable(result.rollups);
  console.log(`\n  TOTAL REALIZED: ${fmtMoney(result.totalRealized)}`);
  printExceptions(result.exceptions);
  process.exit(0);
}

const w = result.written;
if (w.securityStubs.length > 0) {
  console.log(
    `\n  securities: ${w.securityStubs.length} stub(s) created for ledger-only codes ` +
      `(${w.securityStubs.join(", ")})`,
  );
}
if (w.skippedAccounts.length > 0) {
  console.log(
    `
  ${w.skippedAccounts.length} account(s) skipped — their trades were NOT imported:`,
  );
  for (const a of w.skippedAccounts) console.log(`    ${a}`);
}
console.log(`  trades:     ${w.trades} upserted`);
console.log(`  realized:   ${w.realizedRows} rollup rows rebuilt`);
console.log(`\n  Total realized P&L: ${fmtMoney(result.totalRealized)}`);
if (result.partialCount > 0) {
  console.log(
    `  ${result.partialCount} position(s) closed partially — valued at weighted-average cost.`,
  );
}

// ---------------------------------------------------------------------------
// Reconciliation — the worklist of everything that needs a human
// ---------------------------------------------------------------------------
printExceptions(result.exceptions);

if (result.drift.length > 0) {
  console.log(
    `\n  ── ${result.drift.length} position(s) where the ledger and the snapshot disagree ──`,
  );
  for (const d of result.drift) {
    console.log(
      `  ${d.accountRef}  ${d.parent.padEnd(5)} ` +
        `ledger ${d.ledgerOpenUnits.toLocaleString("en-AU").padStart(9)} units, ` +
        `snapshot ${d.snapshotUnits.toLocaleString("en-AU").padStart(9)}` +
        (d.strandedCost > 0
          ? `   ${fmtMoney(d.strandedCost)} of cost stranded on a position that is no longer held`
          : ""),
    );
  }
  console.log(
    "\n    Either the snapshot predates these trades, or the holding was closed\n" +
      "    by something the ledger does not record (lapse, conversion, transfer).",
  );
}

console.log("\nDone. Trade ledger imported.");
