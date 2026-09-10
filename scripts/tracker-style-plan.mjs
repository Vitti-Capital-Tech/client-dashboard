// Scan Template's formatting once, and store it.
// ----------------------------------------------------------------------------
// The only WRITE here is one row in `placement_style_plans`. The workbook itself
// is read and never touched.
//
// ── Why this is a script and not part of the ingest ──────────────────────────
// Graph offers no way to copy a worksheet's formatting — both actions that would
// were probed against this tenant and neither exists, in v1.0 or beta:
//
//   POST .../worksheets('Template')/copy       -> "Resource not found for the
//   POST .../range(address='A100')/copyFrom       segment '…'"
//
// So `tracker-style.ts` reconstructs it by treating a range read as a uniformity
// test. Measured against the live workbook:
//
//   SCAN  : 504,324 ms   1,207 format reads in 69 batches   (plan complete)
//   WRITES:        73    16 widths, 16 fills, 39 fonts, 2 border edges
//
// Eight and a half minutes to learn it; four batches to apply it. Every ingest
// route is capped at 60 seconds, so the scan can only ever have finished on an
// instance that had already paid for it — and when it had not, the tab came out
// plain. Worse, silently: `IPT` and `IPT (b)` both carry column widths ~20pt
// narrower than Template's, replayed from a plan scanned before Template was
// widened, with nothing recording which Template it came from.
//
// The plan is a pure function of Template, so it is scanned HERE, deliberately,
// with no ceiling and a generous budget, and read back by the ingest as one row.
//
// Run:
//   npm run tracker:plan                  every configured workbook, this year
//   npm run tracker:plan -- --year 2025   a different year's workbook
//   npm run tracker:plan -- --budget 4000 raise the per-property read budget
//   npm run tracker:plan -- --dry-run     scan and report, store nothing
//
// Re-run it whenever Template is edited. The ingest says so when it notices —
// on a shape change, or a plan older than 30 days.
// ----------------------------------------------------------------------------

import { adminClient, die } from "./_import-common.mjs";
import {
  clearTemplatePlanCache,
  readTemplatePlan,
} from "../lib/placements/tracker-style.ts";
import {
  graphCaller,
  resolveTrackerTarget,
  trackerUrls,
  workbookItemPath,
} from "../lib/placements/tracker-writer.ts";
import { TEMPLATE_SHEET } from "../lib/placements/tracker-format.ts";
import { readStylePlan, writeStylePlan } from "../lib/placements/tracker-style-store.ts";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const dryRun = argv.includes("--dry-run");
const year = Number(flag("year", new Date().getFullYear()));
const budget = Number(flag("budget", 4000));

const urls = trackerUrls(process.env.PLACEMENT_TRACKER_URL);
if (urls.length === 0) die("No PLACEMENT_TRACKER_URL is set, so there is no Template to scan.");

// The scan needs Graph application credentials, the same ones the ingest writes
// with. `lib/remote-sheets.ts` is `server-only`, so the token is minted here.
const tokenRes = await fetch(
  `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT_ID}/oauth2/v2.0/token`,
  {
    method: "POST",
    body: new URLSearchParams({
      client_id: process.env.MICROSOFT_CLIENT_ID,
      client_secret: process.env.MICROSOFT_CLIENT_SECRET,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
    }),
  },
);
const token = (await tokenRes.json())?.access_token;
if (!token) die("Could not get a Graph token. Check MICROSOFT_CLIENT_ID / _SECRET / _TENANT_ID.");

const db = adminClient();

// Counted rather than estimated, because the read count is the number that
// decides whether any of this could ever move back into a request.
let reads = 0;
const raw = graphCaller(token);
const graph = async (path, init = {}) => {
  if (path === "/$batch") reads += (init.body?.requests ?? []).length;
  else reads++;
  if (reads % 200 === 0) process.stdout.write(`   … ${reads} format reads\n`);
  return raw(path, init);
};

const target = await resolveTrackerTarget(urls, year, graph);
if (!target) {
  die(
    `No configured workbook has a "${year} Overview" sheet. ` +
      `Pass --year for a different one, or check PLACEMENT_TRACKER_URL.`,
  );
}

const item = workbookItemPath(target);

const used = await graph(`${item}/worksheets('${TEMPLATE_SHEET}')/usedRange?$select=address`);
if (!used.ok) die(`Could not read ${TEMPLATE_SHEET}'s used range: ${JSON.stringify(used.body)}`);
const shape = String(used.body.address).split("!").pop();

const existing = (await readStylePlan(db, item, TEMPLATE_SHEET)).stored;
console.log(`Workbook : ${target.overviewSheet.replace(/ Overview$/, "")} (${target.itemId})`);
console.log(`Template : ${shape}`);
console.log(
  existing
    ? `Stored   : ${existing.shape}, scanned ${existing.scannedAt}` +
        (existing.shape !== shape ? "   <-- Template has changed shape since" : "")
    : "Stored   : nothing yet",
);
console.log(`\nScanning with a per-property budget of ${budget}. This takes minutes, not seconds.\n`);

clearTemplatePlanCache();
const startedAt = Date.now();
const plan = await readTemplatePlan(graph, item, TEMPLATE_SHEET, shape, { budget });
const scanMs = Date.now() - startedAt;

if (!plan) die("The scan returned no plan at all — check the Graph permissions on the workbook.");

const borderWrites = plan.borders.reduce((n, b) => n + Object.keys(b.value).length, 0);
const writes = plan.widths.length + plan.fills.length + plan.fonts.length + borderWrites;

console.log(`\nScanned in ${(scanMs / 1000).toFixed(1)}s, ${reads} format reads.`);
console.log(`  widths  ${String(plan.widths.length).padStart(4)}`);
console.log(`  fills   ${String(plan.fills.length).padStart(4)}`);
console.log(`  fonts   ${String(plan.fonts.length).padStart(4)}`);
console.log(`  borders ${String(borderWrites).padStart(4)}  (${plan.borders.length} regions)`);
console.log(`  ---`);
console.log(`  writes  ${String(writes).padStart(4)}  -> ${Math.ceil(writes / 20)} batches per tab`);

if (plan.incomplete.length > 0) {
  // Stored anyway — it is better than nothing and better than what a live scan
  // manages — but said loudly, because parts of every tab will go unshaded.
  console.log(
    `\n!! INCOMPLETE: ${plan.incomplete.join(" and ")} ran short of ${budget} reads.\n` +
      `   Parts of every new tab will not be shaded. Re-run with a larger --budget.`,
  );
}

if (dryRun) {
  console.log("\n--dry-run: nothing was stored.");
  process.exit(0);
}

await writeStylePlan(db, item, TEMPLATE_SHEET, plan, {
  label: `${target.overviewSheet.replace(/ Overview$/, "")} Placements · ${TEMPLATE_SHEET}`,
  scanMs,
  reads,
});

console.log(`\nStored. Every new tab now costs one row read plus ${writes} format writes.`);
