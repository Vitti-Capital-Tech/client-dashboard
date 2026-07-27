// Import a broker TRADE LEDGER (contract notes) and rebuild realized P&L.
// ----------------------------------------------------------------------------
// The ledger is append-only history, so trades are UPSERTED on
// (cnote, raw_security, side) — re-running the same export, or a longer export
// that overlaps it, never double-counts a contract note.
//
// `realized_pnl` is then rebuilt from scratch for every account the file
// touches, by replaying that account's full settled ledger from the database
// (not just this file's rows) so a partial export still produces correct
// cumulative numbers.
//
// Only SETTLED trades are counted. CANCELLED / REVERSAL / REVERSED rows are
// still stored for the audit trail, but never reach the P&L reducer.
//
// Run:
//   node --env-file=.env.local scripts/import-trades.mjs <trades.csv>
//   node --env-file=.env.local scripts/import-trades.mjs <trades.csv> --dry-run
// ----------------------------------------------------------------------------

import {
  adminClient,
  parseArgs,
  readCsv,
  upsertChunked,
  reportRowErrors,
  fmtMoney,
} from "./_import-common.mjs";
import { parseTradeCsv, reduceTrades, SETTLED } from "../lib/import/trades.ts";
import { extractSecurities } from "../lib/import/holdings.ts";

const USAGE =
  "Usage: node --env-file=.env.local scripts/import-trades.mjs <trades.csv> [--dry-run]";

const { file, dryRun } = parseArgs(USAGE);
const sourceFile = file.split(/[\\/]/).pop();

// ---------------------------------------------------------------------------
// 1. Parse
// ---------------------------------------------------------------------------
const { trades, errors } = parseTradeCsv(readCsv(file));
reportRowErrors(errors, "trade");

if (trades.length === 0) {
  console.error("No parseable trade rows — nothing to do.");
  process.exit(1);
}

const settled = trades.filter((t) => t.status === SETTLED);
const skipped = trades.length - settled.length;
const accountRefs = [...new Set(trades.map((t) => t.accountRef))];

console.log(`\nParsed ${file}`);
console.log(`  ${trades.length} trades across ${accountRefs.length} account(s)`);
console.log(`  ${settled.length} settled, ${skipped} skipped for P&L`);
if (skipped > 0) {
  const byStatus = new Map();
  for (const t of trades) {
    if (t.status === SETTLED) continue;
    byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1);
  }
  console.log(
    `    (${[...byStatus].map(([s, n]) => `${n} ${s}`).join(", ")} — stored, not counted)`,
  );
}
console.log(
  `  dates ${settled.reduce((a, t) => (t.tradeDate < a ? t.tradeDate : a), "9999")}` +
    ` → ${settled.reduce((a, t) => (t.tradeDate > a ? t.tradeDate : a), "0000")}`,
);

if (dryRun) {
  const preview = reduceTrades(trades);
  const total = preview.reduce((s, r) => s + r.realizedPl, 0);
  console.log("\n--dry-run: nothing written. Realized P&L preview:\n");
  console.log(
    "  ACCT     CODE   BOUGHT      SOLD      OPEN   PROCEEDS       COST     REALIZED",
  );
  for (const r of preview) {
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
  console.log(`\n  TOTAL REALIZED: ${fmtMoney(total)}`);
  process.exit(0);
}

const supabase = adminClient();

// ---------------------------------------------------------------------------
// 2. Resolve accounts. The holdings snapshot creates them; a trade for an
//    unknown account is a hard error, because guessing an owner in a financial
//    system is never the right call.
// ---------------------------------------------------------------------------
const { data: accountRows, error: accountErr } = await supabase
  .from("accounts")
  .select("id, external_ref, client_id")
  .in("external_ref", accountRefs);
if (accountErr) throw accountErr;

const accountByRef = new Map(accountRows.map((a) => [a.external_ref, a]));
const unknown = accountRefs.filter((r) => !accountByRef.has(r));
if (unknown.length > 0) {
  console.error(
    `\nUnknown account number(s): ${unknown.join(", ")}\n` +
      "Import the holdings snapshot first (scripts/import-holdings.mjs), " +
      "or add these accounts manually.",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 3. Securities — a fully exited holding is absent from the snapshot but still
//    present in the ledger, and trades.security_code is a real FK. Create stubs
//    (no price) for anything missing so nothing is silently dropped.
// ---------------------------------------------------------------------------
const codesInFile = [
  ...new Map(trades.map((t) => [t.rawSecurity, t.company])).entries(),
].map(([code, name]) => ({ code, name }));

const { data: knownSecs, error: secErr } = await supabase
  .from("securities")
  .select("code");
if (secErr) throw secErr;
const known = new Set(knownSecs.map((s) => s.code));

const missing = extractSecurities(
  [],
  codesInFile.filter((c) => !known.has(c.code)),
).filter((s) => !known.has(s.code));

if (missing.length > 0) {
  await upsertChunked(
    supabase,
    "securities",
    missing.map((s) => ({
      code: s.code,
      name: s.name,
      security_class: s.securityClass,
      listed: true,
    })),
    { onConflict: "code" },
  );
  for (const s of missing.filter((s) => s.parent)) {
    const { error } = await supabase
      .from("securities")
      .update({ parent_code: s.parent })
      .eq("code", s.code);
    if (error) throw new Error(`link ${s.code}→${s.parent}: ${error.message}`);
  }
  console.log(
    `\n  securities: ${missing.length} stub(s) created for ledger-only codes ` +
      `(${missing.map((s) => s.code).join(", ")})`,
  );
}

// ---------------------------------------------------------------------------
// 4. Trades
// ---------------------------------------------------------------------------
await upsertChunked(
  supabase,
  "trades",
  trades.map((t) => {
    const acct = accountByRef.get(t.accountRef);
    return {
      cnote: t.cnote,
      account_id: acct.id,
      client_id: acct.client_id,
      raw_security: t.rawSecurity,
      security_code: t.rawSecurity,
      parent_code: t.parent,
      instrument: t.instrument,
      side: t.side,
      trade_date: t.tradeDate,
      units: t.units,
      avg_price: t.avgPrice,
      consideration: t.consideration,
      brokerage: t.brokerage,
      other_charges: t.otherCharges,
      gst: t.gst,
      value: t.value,
      brokerage_pct: t.brokeragePct,
      adviser: t.adviser,
      status: t.status,
      source_file: sourceFile,
    };
  }),
  { onConflict: "cnote,raw_security,side" },
);
console.log(`  trades:     ${trades.length} upserted`);

// ---------------------------------------------------------------------------
// 5. Rebuild realized_pnl from the FULL stored ledger for the affected accounts
// ---------------------------------------------------------------------------
const accountIds = accountRows.map((a) => a.id);

const { data: allTrades, error: ledgerErr } = await supabase
  .from("trades")
  .select(
    "cnote, raw_security, parent_code, side, trade_date, units, avg_price, " +
      "consideration, brokerage, other_charges, gst, value, status, account_id",
  )
  .in("account_id", accountIds);
if (ledgerErr) throw ledgerErr;

const refById = new Map(accountRows.map((a) => [a.id, a.external_ref]));

// Re-shape DB rows into the reducer's input type. Postgres returns numerics as
// strings over PostgREST when precision could be lost, so coerce explicitly.
const rollups = reduceTrades(
  allTrades.map((t) => ({
    cnote: t.cnote,
    accountRef: refById.get(t.account_id),
    side: t.side,
    rawSecurity: t.raw_security,
    parent: t.parent_code,
    company: "",
    instrument: null,
    tradeDate: t.trade_date,
    units: Number(t.units),
    avgPrice: Number(t.avg_price),
    consideration: Number(t.consideration),
    brokerage: Number(t.brokerage),
    otherCharges: Number(t.other_charges),
    gst: Number(t.gst),
    value: Number(t.value),
    brokeragePct: null,
    adviser: null,
    status: t.status,
  })),
);

const { error: purgeErr } = await supabase
  .from("realized_pnl")
  .delete()
  .in("account_id", accountIds);
if (purgeErr) throw purgeErr;

await upsertChunked(
  supabase,
  "realized_pnl",
  rollups.map((r) => {
    const acct = accountByRef.get(r.accountRef);
    return {
      account_id: acct.id,
      client_id: acct.client_id,
      parent_code: r.parent,
      units_bought: r.unitsBought,
      units_sold: r.unitsSold,
      open_units: r.openUnits,
      cost_total: r.costTotal,
      proceeds: r.proceeds,
      cost_of_sold: r.costOfSold,
      open_cost: r.openCost,
      realized_pl: r.realizedPl,
      fees: r.fees,
      trade_count: r.tradeCount,
      first_trade: r.firstTrade,
      last_trade: r.lastTrade,
      has_partial: r.hasPartial,
      short_history: r.shortHistory,
      computed_at: new Date().toISOString(),
    };
  }),
  { onConflict: "account_id,parent_code" },
);

const totalRealized = rollups.reduce((s, r) => s + r.realizedPl, 0);
const partials = rollups.filter((r) => r.hasPartial).length;
const shorts = rollups.filter((r) => r.shortHistory);

console.log(`  realized:   ${rollups.length} rollup rows rebuilt`);
console.log(`\n  Total realized P&L: ${fmtMoney(totalRealized)}`);
if (partials > 0) {
  console.log(
    `  ${partials} position(s) closed partially — valued at weighted-average cost.`,
  );
}
if (shorts.length > 0) {
  console.log(
    `  ⚠ ${shorts.length} position(s) sold units the ledger never saw bought ` +
      `(${shorts.map((r) => r.parent).join(", ")}).\n` +
      "    Their proceeds are counted with ZERO cost basis, so realized P&L is\n" +
      "    overstated until an opening balance or earlier export is loaded.",
  );
}
console.log("\nDone. Trade ledger imported.");
