// Compare two P&L exports ticker by ticker.
// ----------------------------------------------------------------------------
// The P&L Calculator and the client profile now run the SAME engine, one fed
// from an uploaded file and the other from the database. They should therefore
// agree — and this is how that gets checked, rather than eyeballing fifty rows
// in two spreadsheets.
//
// Both export formats are understood, so any pair works:
//
//   Calculator / "Preview CSV"  → Ticker · Buy Qty (Sum) · Sell Qty (Sum) ·
//                                 Buy Price · Sell Price · PnL Calculated
//   Client profile export       → Row Labels · Buy Qty · Sell Qty ·
//                                 Buy Price · Sell Price / Current Price · PnL
//
// Run:
//   node scripts/diff-pnl-csv.mjs <calculator.csv> <profile.csv>
//   node scripts/diff-pnl-csv.mjs a.csv b.csv --tolerance 0.05
// ----------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import { parseCsvRecords } from "../lib/import/csv.ts";
import { fmtMoney } from "./_import-common.mjs";

const USAGE =
  "Usage: node scripts/diff-pnl-csv.mjs <a.csv> <b.csv> [--tolerance 0.01]";

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const files = argv.filter((a) => !a.startsWith("--"));
const tolIdx = argv.indexOf("--tolerance");
// A cent. Both sides round money to 2dp, so anything at or under this is
// representation rather than disagreement.
const TOLERANCE = tolIdx >= 0 ? Number(argv[tolIdx + 1]) : 0.01;

if (files.length !== 2 || !Number.isFinite(TOLERANCE)) {
  console.error(USAGE);
  process.exit(1);
}

for (const f of files) {
  if (!fs.existsSync(f)) {
    console.error(`No such file: ${path.resolve(f)}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Column mapping
// ---------------------------------------------------------------------------
// The two exports name the same six quantities differently. Each field lists
// every spelling seen; the first one present in the header row wins.
const FIELDS = {
  ticker: ["Ticker", "Row Labels"],
  buyQty: ["Buy Qty (Sum)", "Buy Qty"],
  sellQty: ["Sell Qty (Sum)", "Sell Qty"],
  buyPrice: ["Buy Price"],
  sellPrice: ["Sell Price", "Sell Price / Current Price"],
  pnl: ["PnL Calculated", "PnL"],
};

const MONEY = new Set(["buyPrice", "sellPrice", "pnl"]);

function resolveColumns(headers, file) {
  const present = new Set(headers);
  const cols = {};
  for (const [field, names] of Object.entries(FIELDS)) {
    const hit = names.find((n) => present.has(n));
    if (!hit) {
      console.error(
        `${path.basename(file)} has no column for "${field}". Looked for: ${names.join(", ")}.\n` +
          `Found: ${headers.join(", ")}`,
      );
      process.exit(1);
    }
    cols[field] = hit;
  }
  return cols;
}

/** Money arrives bare, but a hand-edited file may carry $ and separators. */
const num = (v) => {
  const s = String(v ?? "").trim().replace(/[$,\s]/g, "");
  if (!s) return 0;
  // Accounting negatives: (1,234.56)
  const n = /^\(.*\)$/.test(s) ? -Number(s.slice(1, -1)) : Number(s);
  return Number.isFinite(n) ? n : 0;
};

function load(file) {
  const { headers, rows } = parseCsvRecords(fs.readFileSync(file, "utf8"));
  const cols = resolveColumns(headers, file);

  const byTicker = new Map();
  for (const row of rows) {
    const ticker = String(row[cols.ticker] ?? "").trim().toUpperCase();
    // Both formats end with a total line, which is not a position.
    if (!ticker || ticker === "GRAND TOTAL" || ticker === "TOTAL") continue;

    byTicker.set(ticker, {
      buyQty: num(row[cols.buyQty]),
      sellQty: num(row[cols.sellQty]),
      buyPrice: num(row[cols.buyPrice]),
      sellPrice: num(row[cols.sellPrice]),
      pnl: num(row[cols.pnl]),
    });
  }
  return byTicker;
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------
const [fileA, fileB] = files;
const a = load(fileA);
const b = load(fileB);

const nameA = path.basename(fileA);
const nameB = path.basename(fileB);

const onlyA = [...a.keys()].filter((t) => !b.has(t)).sort();
const onlyB = [...b.keys()].filter((t) => !a.has(t)).sort();
const shared = [...a.keys()].filter((t) => b.has(t)).sort();

const fmt = (field, v) => (MONEY.has(field) ? fmtMoney(v) : v.toLocaleString("en-AU"));

const mismatches = [];
for (const ticker of shared) {
  const ra = a.get(ticker);
  const rb = b.get(ticker);
  const diffs = [];
  for (const field of Object.keys(FIELDS)) {
    if (field === "ticker") continue;
    const delta = rb[field] - ra[field];
    if (Math.abs(delta) > TOLERANCE) diffs.push({ field, av: ra[field], bv: rb[field], delta });
  }
  if (diffs.length > 0) mismatches.push({ ticker, diffs });
}

const totalA = [...a.values()].reduce((s, r) => s + r.pnl, 0);
const totalB = [...b.values()].reduce((s, r) => s + r.pnl, 0);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log(`\n  A  ${nameA}  — ${a.size} rows`);
console.log(`  B  ${nameB}  — ${b.size} rows`);
console.log(`\n  Total P&L   A ${fmtMoney(totalA)}   B ${fmtMoney(totalB)}   Δ ${fmtMoney(totalB - totalA)}`);

if (onlyA.length > 0) {
  console.log(`\n  ── ${onlyA.length} ticker(s) only in A ──`);
  console.log(`  ${onlyA.join(", ")}`);
}
if (onlyB.length > 0) {
  console.log(`\n  ── ${onlyB.length} ticker(s) only in B ──`);
  console.log(`  ${onlyB.join(", ")}`);
}

if (mismatches.length > 0) {
  console.log(`\n  ── ${mismatches.length} ticker(s) differ (tolerance ${TOLERANCE}) ──`);
  for (const { ticker, diffs } of mismatches) {
    console.log(`\n  ${ticker}`);
    for (const d of diffs) {
      console.log(
        `    ${d.field.padEnd(10)} A ${fmt(d.field, d.av).padStart(14)}` +
          `   B ${fmt(d.field, d.bv).padStart(14)}` +
          `   Δ ${fmt(d.field, d.delta)}`,
      );
    }
  }
}

const clean = onlyA.length === 0 && onlyB.length === 0 && mismatches.length === 0;

if (clean) {
  console.log(`\n  ✓ Identical across ${shared.length} tickers.\n`);
} else {
  // Not every difference is a bug, and saying so beats a red exit code that
  // sends someone hunting for one. These are the legitimate causes, in the
  // order they actually occur.
  console.log(
    "\n  Before treating any of this as an engine bug, rule out the five things\n" +
      "  that legitimately differ between the two sides:\n" +
      "\n" +
      "    1. Different ledgers.  The calculator reads the uploaded FILE; the\n" +
      "       recompute reads the `trades` TABLE. If the database holds more or\n" +
      "       less history, every total moves. Check this first.\n" +
      "    2. Account scope.  One side filtered to a single account, the other\n" +
      "       aggregating all of the client's.\n" +
      "    3. Placement client hint.  The calculator resolves the account holder\n" +
      "       from the file; the recompute uses clients.display_name. A different\n" +
      "       name picks a different allocation row, so the BUY side moves.\n" +
      "    4. Spot prices.  Unlisted option rows are model prices off a live quote\n" +
      "       and will differ between two runs minutes apart.\n" +
      "    5. Overrides + reporting period.  pnl_overrides apply on the profile\n" +
      "       side only, and the calculator must have its From/To cleared.\n",
  );
}

process.exit(clean ? 0 : 1);
