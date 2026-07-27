// Import a broker HOLDINGS SNAPSHOT into clients / accounts / securities / positions.
// ----------------------------------------------------------------------------
// The snapshot is the authoritative answer to "what is held right now", so this
// is a FULL REPLACE of `positions` for every account present in the file:
// anything the broker no longer reports has been sold, and must disappear.
// Accounts absent from the file are left completely untouched.
//
// It is also the platform's only price source today, so Market Price lands in
// securities.last_price on the way through.
//
// Idempotent: re-running the same file converges to the same rows.
//
// Run:
//   node --env-file=.env.local scripts/import-holdings.mjs <ClientHoldings…csv>
//   node --env-file=.env.local scripts/import-holdings.mjs <file.csv> --dry-run
// ----------------------------------------------------------------------------

import {
  adminClient,
  parseArgs,
  readCsv,
  upsertChunked,
  reportRowErrors,
  fmtMoney,
} from "./_import-common.mjs";
import {
  parseHoldingsCsv,
  extractAccounts,
  extractSecurities,
} from "../lib/import/holdings.ts";

const USAGE =
  "Usage: node --env-file=.env.local scripts/import-holdings.mjs <holdings.csv> [--dry-run]";

const { file, dryRun } = parseArgs(USAGE);

// ---------------------------------------------------------------------------
// 1. Parse
// ---------------------------------------------------------------------------
const { holdings, errors } = parseHoldingsCsv(readCsv(file));
reportRowErrors(errors, "holdings");

if (holdings.length === 0) {
  console.error("No parseable holdings rows — nothing to do.");
  process.exit(1);
}

const accounts = extractAccounts(holdings);
const securities = extractSecurities(holdings);

const totalMarketValue = holdings.reduce((s, h) => s + h.marketValue, 0);
const totalCostBase = holdings.reduce((s, h) => s + h.costBase, 0);

console.log(`\nParsed ${file}`);
console.log(`  ${holdings.length} holdings across ${accounts.length} accounts`);
console.log(`  ${securities.length} distinct securities`);
console.log(`  market value ${fmtMoney(totalMarketValue)}`);
console.log(`  cost base    ${fmtMoney(totalCostBase)}`);
console.log(
  `  unrealised   ${fmtMoney(totalMarketValue - totalCostBase)}` +
    ` (${(((totalMarketValue - totalCostBase) / totalCostBase) * 100).toFixed(1)}%)`,
);

if (dryRun) {
  console.log("\n--dry-run: nothing written.");
  const byClass = new Map();
  for (const s of securities)
    byClass.set(s.securityClass, (byClass.get(s.securityClass) ?? 0) + 1);
  console.log("  securities by class:", Object.fromEntries(byClass));
  console.log(
    "  derivative → parent samples:",
    securities
      .filter((s) => s.parent)
      .slice(0, 8)
      .map((s) => `${s.code}→${s.parent}`)
      .join(", "),
  );
  process.exit(0);
}

const supabase = adminClient();

// ---------------------------------------------------------------------------
// 2. Securities — two phase, because parent_code is a self-referencing FK.
//    Pass one writes every code with a null parent; pass two wires the links up
//    once every parent is guaranteed to exist.
// ---------------------------------------------------------------------------
await upsertChunked(
  supabase,
  "securities",
  securities.map((s) => ({
    code: s.code,
    name: s.name,
    description: s.description,
    security_class: s.securityClass,
    listed: true,
    last_price: s.lastPrice,
    last_price_at: s.lastPrice === null ? null : new Date().toISOString(),
  })),
  { onConflict: "code" },
);

const derivatives = securities.filter((s) => s.parent);
for (const s of derivatives) {
  const { error } = await supabase
    .from("securities")
    .update({ parent_code: s.parent })
    .eq("code", s.code);
  if (error) throw new Error(`link ${s.code}→${s.parent}: ${error.message}`);
}
console.log(
  `\n  securities: ${securities.length} upserted (${derivatives.length} linked to a parent)`,
);

// ---------------------------------------------------------------------------
// 3. Clients & accounts
// ---------------------------------------------------------------------------
// The broker models the entity and its account as one thing, so each Account
// Number becomes one client owning one account. The multi-account schema still
// applies — staff can merge two of these later with no migration.
await upsertChunked(
  supabase,
  "clients",
  accounts.map((a) => ({
    external_ref: a.externalRef,
    display_name: a.displayName,
    initials: a.initials,
    // No email in the broker export. Client logins stay disabled until one is
    // attached (lib/session.ts resolves the client row by JWT email).
  })),
  { onConflict: "external_ref" },
);

const { data: clientRows, error: clientErr } = await supabase
  .from("clients")
  .select("id, external_ref")
  .in(
    "external_ref",
    accounts.map((a) => a.externalRef),
  );
if (clientErr) throw clientErr;
const clientIdByRef = new Map(clientRows.map((c) => [c.external_ref, c.id]));

await upsertChunked(
  supabase,
  "accounts",
  accounts.map((a) => ({
    external_ref: a.externalRef,
    client_id: clientIdByRef.get(a.externalRef),
    label: a.displayName,
    account_type: "Wholesale",
    adviser_code: a.adviserCode,
    adviser_name: a.adviserName,
    status: a.status,
  })),
  { onConflict: "external_ref" },
);

const { data: accountRows, error: accountErr } = await supabase
  .from("accounts")
  .select("id, external_ref, client_id")
  .in(
    "external_ref",
    accounts.map((a) => a.externalRef),
  );
if (accountErr) throw accountErr;
const accountByRef = new Map(accountRows.map((a) => [a.external_ref, a]));

console.log(`  clients:    ${accounts.length} upserted`);
console.log(`  accounts:   ${accountRows.length} upserted`);

// ---------------------------------------------------------------------------
// 4. Positions — full replace, scoped to the accounts in this file
// ---------------------------------------------------------------------------
const accountIds = accountRows.map((a) => a.id);

const { error: delErr, count: deleted } = await supabase
  .from("positions")
  .delete({ count: "exact" })
  .in("account_id", accountIds);
if (delErr) throw delErr;

const positionRows = holdings.map((h) => ({
  account_id: accountByRef.get(h.accountRef).id,
  client_id: accountByRef.get(h.accountRef).client_id,
  security_code: h.rawSecurity,
  qty: h.qty,
  avg_cost: h.avgCost,
}));

await upsertChunked(supabase, "positions", positionRows, {
  onConflict: "account_id,security_code",
});

console.log(
  `  positions:  ${positionRows.length} written (${deleted ?? 0} stale rows removed)`,
);
console.log("\nDone. Holdings snapshot imported.");
