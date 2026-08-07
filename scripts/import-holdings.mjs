// CLI front door for the holdings-snapshot import.
// ----------------------------------------------------------------------------
// The import itself lives in lib/import/run-holdings.ts — read that file for
// what the snapshot means and why `positions` is a full replace. This script
// only reads argv and renders the result, so the terminal and the morning mail
// ingest can never disagree about what an import did.
//
// Run:
//   node --env-file=.env.local scripts/import-holdings.mjs <ClientHoldings…csv>
//   node --env-file=.env.local scripts/import-holdings.mjs <file.csv> --dry-run
// ----------------------------------------------------------------------------

import {
  adminClient,
  parseArgs,
  readCsv,
  reportRowErrors,
  fmtMoney,
  die,
} from "./_import-common.mjs";
import { runHoldingsImport } from "../lib/import/run-holdings.ts";

const USAGE =
  "Usage: node --env-file=.env.local scripts/import-holdings.mjs <holdings.csv> [--dry-run]";

const { file, dryRun } = parseArgs(USAGE);

// A dry run never touches the database, so it must not demand credentials
// either — it is the one command you can hand to someone without the key.
const supabase = dryRun ? null : adminClient();

let result;
try {
  result = await runHoldingsImport(supabase, readCsv(file), { dryRun });
} catch (err) {
  die(err);
}

reportRowErrors(result.rowErrors, "holdings");

const { parsed } = result;
const unrealised = parsed.marketValue - parsed.costBase;

console.log(`\nParsed ${file}`);
console.log(`  ${parsed.holdings} holdings across ${parsed.accounts} accounts`);
console.log(`  ${parsed.securities} distinct securities`);
console.log(`  market value ${fmtMoney(parsed.marketValue)}`);
console.log(`  cost base    ${fmtMoney(parsed.costBase)}`);
console.log(
  `  unrealised   ${fmtMoney(unrealised)}` +
    // A snapshot whose every holding is priceless has a zero cost base; a
    // percentage of nothing is not a fact worth printing.
    (parsed.costBase > 0
      ? ` (${((unrealised / parsed.costBase) * 100).toFixed(1)}%)`
      : ""),
);

if (!result.applied) {
  console.log("\n--dry-run: nothing written.");
  console.log("  securities by class:", result.securitiesByClass);
  console.log(
    "  derivative → parent samples:",
    result.derivativeLinks.slice(0, 8).join(", "),
  );
  process.exit(0);
}

const w = result.written;
console.log(
  `\n  securities: ${w.securities} upserted (${w.derivativesLinked} linked to a parent)`,
);
console.log(`  clients:    ${w.clients} upserted`);
console.log(`  accounts:   ${w.accounts} upserted`);
console.log(
  `  positions:  ${w.positions} written (${w.staleRemoved} stale rows removed)`,
);
console.log("\nDone. Holdings snapshot imported.");
