// CLI front door for the placement-alias suggester.
// ----------------------------------------------------------------------------
// READ-ONLY. It writes nothing, to any table, ever — it prints `UPDATE`
// statements for a person to read and run. That is the whole design: an alias
// moves a placement parcel onto a client's stored P&L, and the workbooks contain
// `PSG Capital Ltd` and `PSG Super` against two different clients. See
// lib/pnl/alias-suggest.ts for why the evidence is quantities rather than name
// similarity.
//
// Run:
//   node --env-file=.env.local scripts/suggest-placement-aliases.mjs
//   node --env-file=.env.local scripts/suggest-placement-aliases.mjs --all   (include low confidence)
// ----------------------------------------------------------------------------

import { adminClient, die } from "./_import-common.mjs";
import { loadCalculatorTrades } from "../lib/pnl/from-db.ts";
import { cachedPlacementMap } from "../lib/pnl/tracker-cache-store.ts";
import { aggregateTradesToSummary, getParentTicker } from "../lib/pnl-calculator.ts";
import { aliasUpdateSql, suggestPlacementAliases } from "../lib/pnl/alias-suggest.ts";

const showAll = process.argv.includes("--all");
const db = adminClient();

const qty = (n) => Number(n).toLocaleString("en-AU");

// ---------------------------------------------------------------------------
// 1. The tracker, from the cache — the same parse every recompute reads.
// ---------------------------------------------------------------------------
const cached = await cachedPlacementMap(db);
if (!cached) {
  die(
    "The Placement Tracker cache is empty, so there is nothing to match against.\n" +
      'Press "Refresh trackers" on /portal/staff/clients first.',
  );
}
console.log(
  `Placement Trackers: ${cached.labels.join(", ")} — ${cached.map.size} ticker(s), ` +
    `parsed ${cached.parsedAt}\n`,
);

// ---------------------------------------------------------------------------
// 2. Every client, and their ledger-only position in each stock.
// ---------------------------------------------------------------------------
// Ledger-only ON PURPOSE: `pnl_summary` is the stored result and already carries
// whatever the placement merge filled, so a row's buy side there would answer a
// question about the merge rather than about the contract notes. The aggregator
// below is the same one the engine runs, on the same trades.
const { data: clientRows, error: clientErr } = await db
  .from("clients")
  .select("id, display_name, placement_aliases");
if (clientErr) die(clientErr.message);

const { data: accountRows, error: accErr } = await db
  .from("accounts")
  .select("id, client_id");
if (accErr) die(accErr.message);

const accountsByClient = new Map();
for (const a of accountRows ?? []) {
  if (!a.client_id) continue;
  accountsByClient.set(a.client_id, [...(accountsByClient.get(a.client_id) ?? []), a.id]);
}

const clients = [];
for (const c of clientRows ?? []) {
  const accountIds = accountsByClient.get(c.id) ?? [];
  if (accountIds.length === 0) continue;

  const { trades } = await loadCalculatorTrades(db, accountIds);
  if (trades.length === 0) continue;

  const { summary } = aggregateTradesToSummary(trades);

  // Rolled up to the parent code, because that is how the placement sheets are
  // keyed: a parcel bought as ACMXX and sold as ACM is one position to them.
  const byParent = new Map();
  for (const row of summary) {
    const ticker = row.parentTicker || getParentTicker(row.ticker);
    const acc = byParent.get(ticker) ?? { ticker, buyQty: 0, sellQty: 0 };
    acc.buyQty += row.buyQty;
    acc.sellQty += row.sellQty;
    byParent.set(ticker, acc);
  }

  clients.push({
    clientId: c.id,
    displayName: c.display_name,
    aliases: c.placement_aliases ?? [],
    rows: [...byParent.values()],
  });
}

console.log(`Checked ${clients.length} client(s) with a stored ledger.\n`);

// ---------------------------------------------------------------------------
// 3. Propose.
// ---------------------------------------------------------------------------
const suggestions = suggestPlacementAliases(clients, cached.map);
const shown = showAll ? suggestions : suggestions.filter((s) => s.confidence !== "low");

if (shown.length === 0) {
  console.log(
    suggestions.length === 0
      ? "No unfilled row had a candidate. Nothing to propose."
      : `Only ${suggestions.length} name-similarity guess(es), which are never proposed. ` +
          "Re-run with --all to read them.",
  );
  process.exit(0);
}

const label = {
  high: "HIGH   (quantities agree AND the names share a word)",
  medium: "MEDIUM (quantities agree; the name says nothing either way)",
  low: "LOW    (the names look alike; the quantities do NOT agree)",
};

let lastClient = null;
for (const s of shown) {
  if (s.displayName !== lastClient) {
    console.log(`\n── ${s.displayName} ${"─".repeat(Math.max(0, 60 - s.displayName.length))}`);
    lastClient = s.displayName;
  }

  console.log(`\n  "${s.alias}"`);
  console.log(`     ${label[s.confidence]}`);
  if (s.conflict) {
    console.log(
      `     ⚠ ALSO proposed for: ${s.conflictWith.join(", ")}\n` +
        "       Excluded from the SQL below — two clients cannot both be this\n" +
        "       name, and picking one here would be a coin toss with their P&L.",
    );
  }
  for (const e of s.evidence) {
    console.log(
      `     ${e.ticker.padEnd(5)} ledger short ${qty(e.shortfall).padStart(10)} · ` +
        `sheet allocates ${qty(e.shares).padStart(10)}` +
        (e.quantityMatch ? "  ← exact match" : "") +
        (e.nameOverlap ? "  · shared word" : ""),
    );
  }
  if (s.weakerRows > 0) {
    console.log(
      `     (${s.weakerRows} other row(s) where these two names meet but the ` +
        "quantities do not — not counted.)",
    );
  }
}

// ---------------------------------------------------------------------------
// 4. The statements — to read, then run by hand.
// ---------------------------------------------------------------------------
const sql = aliasUpdateSql(suggestions);
if (sql.length > 0) {
  console.log(
    "\n\n── Ready to paste into the SQL editor ───────────────────────────\n" +
      "── Read every line first. Nothing above has been written.  ──────\n",
  );
  console.log(sql.join("\n\n"));
  console.log(
    "\nThen press Recalculate on each client — aliases are read live, so no\n" +
      "tracker refresh is needed.",
  );
} else {
  console.log("\nNothing confident enough to offer as SQL.");
}
