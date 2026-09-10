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
// test. Measured against the live workbook, same budget and same read count:
//
//   no session : 438,500 ms   1,210 format reads
//   session    :  18,500 ms   1,212 format reads   <- same plan, 24x faster
//   + borders  :  24,800 ms   1,691 format reads   <- borders read per cell
//   WRITES     :       113    16 widths, 16 fills, 39 fonts, 42 border edges
//
// The read COUNT is not the cost — the workbook is, reloaded on every request
// unless a session holds it open. This script opens one (below); the first
// version of it did not, and took 438s for the identical plan.
//
// ── Why this is still a script and not part of the ingest ────────────────────
// 18.5s is affordable on its own and not affordable there: the route has 60
// seconds for the upstream feed reads, the deal write AND the paint. A measured
// mail-hook run had ~20s left of its 60 after 39s of upstream reads, and that is
// the budget a tab write has to fit inside. Spending ~18s of it re-learning a
// plan that changes maybe twice a year is waste.
//
// The second reason is the one that actually bit. `IPT` and `IPT (b)` carry
// identical column widths, all sixteen ~20pt narrower than Template's — and
// nothing recorded which Template a tab was shaded from, so a stale plan and a
// Template edited afterwards were indistinguishable. A stored plan carries its
// `shape` and `scanned_at`, so that question has an answer.
//
// The plan is a pure function of Template, so it is scanned HERE, deliberately,
// with a generous budget, and read back by the ingest as one row.
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

// ── A workbook session, and it is worth 24x ─────────────────────────────────
// Without one, every format read makes Graph load a 13 MB workbook from
// scratch: 438s against 18.5s for the identical plan and the same ~1,210 reads.
// `writeDealToTracker` opens a session for a different reason — read-after-write
// consistency — and the style pass inherits it there, so the INGEST path was
// never paying this. The first version of this script was, which is why the
// 504s figure originally quoted everywhere was wrong about why it was slow.
//
// `persistChanges: false`: this reads and never writes, and a read-only session
// cannot leave the workbook altered if it is dropped. Closed at the end, though
// an unclosed one expires by itself.
const session = await graph(`${item}/createSession`, {
  method: "POST",
  body: { persistChanges: false },
});
const sessionId = session.ok ? (session.body?.id ?? null) : null;
if (!sessionId) {
  console.log(`(no workbook session — ${JSON.stringify(session.body).slice(0, 160)})`);
  console.log("(continuing without one; expect this to take considerably longer)");
}

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
console.log(`\nScanning with a per-property budget of ${budget}. ~20s with a session, minutes without.\n`);

clearTemplatePlanCache();
const startedAt = Date.now();
const plan = await readTemplatePlan(graph, item, TEMPLATE_SHEET, shape, { budget, sessionId });
const scanMs = Date.now() - startedAt;

// Best effort. A session left open expires on its own, and failing to close one
// is not a reason to throw away a scan that just took minutes.
if (sessionId) await graph(`${item}/closeSession`, { method: "POST", body: {} }).catch(() => {});

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
