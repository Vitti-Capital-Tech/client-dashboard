// Rebuild `realized_pnl` from the stored ledger, without importing a file.
// ----------------------------------------------------------------------------
// Calls the SAME `rebuildRealizedPnl` the trade importer calls — see
// lib/import/run-trades.ts. Not a second implementation: the cost attribution
// in there is money code, and two copies of it is two answers.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// `realized_pnl` was only ever rebuilt as a side effect of importing a trade
// file, so it could go stale with no file to re-import. It did, on 10 Sep 2026:
// the reducer stopped letting an option sale draw cost from the ordinary's
// parcel (LLD §8.35), which moved 9 `(account, parent)` groups by +$38,013, and
// every stored row kept the old figure.
//
// "Rebuild all P&L" does NOT cover this. That rebuilds `pnl_summary` — the
// rendered rows the client's all-time table reads — which is a different table
// answering a different question. The dated views read the replay live and were
// already correct; this is the third reader, and the only stale one.
//
// Run:
//   npm run rebuild:realized              every account
//   npm run rebuild:realized -- --dry-run report what would change, write nothing
//
// The write is a delete-then-upsert of `realized_pnl` for the accounts covered,
// exactly as an import does. Nothing else is touched: not `trades`, not
// `pnl_summary`, not the workbooks.
// ----------------------------------------------------------------------------

import { adminClient, die } from "./_import-common.mjs";
import { rebuildRealizedPnl } from "../lib/import/run-trades.ts";
import { selectAll } from "../lib/import/runner.ts";

const dryRun = process.argv.includes("--dry-run");
const db = adminClient();

const accounts = await selectAll(db, "accounts", "id, client_id, external_ref");
if (accounts.length === 0) die("No accounts, so there is no ledger to replay.");

const money = (n) =>
  `${n < 0 ? "-" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-AU")}`;

// The current stored figures, PAGED. `selectAll` rather than a plain select
// because PostgREST caps a read at 1,000 rows and a truncated comparison would
// report every unread row as a difference — see README §4.10. That exact trap
// fired while diagnosing this, and produced 346 phantom mismatches.
const before = await selectAll(db, "realized_pnl", "account_id, parent_code, realized_pl");
const beforeBy = new Map(
  before.map((r) => [`${r.account_id}|${r.parent_code}`, Number(r.realized_pl)]),
);

console.log(`accounts        : ${accounts.length}`);
console.log(`realized_pnl now: ${before.length} rows, total ${money(
  [...beforeBy.values()].reduce((n, v) => n + v, 0),
)}`);

if (dryRun) {
  // Replay without writing: reuse the same function against a db whose writes
  // are refused, so the arithmetic is the real one and nothing lands.
  const readOnly = {
    from: (table) => {
      const real = db.from(table);
      return {
        ...real,
        select: (...a) => real.select(...a),
        delete: () => die(`--dry-run: refused a DELETE on ${table}`),
        upsert: () => die(`--dry-run: refused an UPSERT on ${table}`),
      };
    },
  };
  console.log("\n--dry-run: replaying, nothing will be written.\n");
  try {
    await rebuildRealizedPnl(readOnly, accounts);
  } catch (err) {
    console.log(`(stopped at the first write, as intended: ${err?.message ?? err})`);
  }
  process.exit(0);
}

console.log("\nReplaying every account's whole stored ledger…");
const { rollups, accountIds } = await rebuildRealizedPnl(db, accounts);

const after = await selectAll(db, "realized_pnl", "account_id, parent_code, realized_pl");
const afterBy = new Map(
  after.map((r) => [`${r.account_id}|${r.parent_code}`, Number(r.realized_pl)]),
);

const keys = new Set([...beforeBy.keys(), ...afterBy.keys()]);
const moved = [...keys]
  .map((k) => ({ k, from: beforeBy.get(k) ?? 0, to: afterBy.get(k) ?? 0 }))
  .filter((d) => Math.abs(d.to - d.from) > 0.5)
  .sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from));

console.log(`\naccounts replayed: ${accountIds.length}`);
console.log(`rows written     : ${rollups.length}`);
console.log(`realized_pnl now : ${after.length} rows, total ${money(
  [...afterBy.values()].reduce((n, v) => n + v, 0),
)}`);

console.log(`\ngroups whose realised figure moved: ${moved.length}`);
for (const d of moved.slice(0, 20)) {
  console.log(
    `   ${d.k.split("|")[1].padEnd(7)} ${money(d.from).padStart(12)} -> ${money(d.to).padStart(12)}` +
      `   (${money(d.to - d.from)})`,
  );
}
if (moved.length > 20) console.log(`   … and ${moved.length - 20} more`);
