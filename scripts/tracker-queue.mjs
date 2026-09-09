// What the Placement Tracker queue is holding, and why.
// ----------------------------------------------------------------------------
// READ-ONLY. It selects and prints; it writes nothing, retries nothing and
// marks nothing filed.
//
// `markTrackerFailed` has been recording why a deal did not reach the workbook
// since the queue was added, into `placement_candidates.tracker_error` — and
// nothing ever read it back. There is no screen for it and no query saved
// anywhere, so "the row was not created this morning" had no answer short of
// opening the Supabase console and remembering the column names. This is that
// answer, as a command.
//
// Run:
//   npm run tracker:queue                 owed deals, and anything that failed
//   npm run tracker:queue -- --all        every candidate, filed ones included
//   npm run tracker:queue -- --days 3     widen the window (default 7)
// ----------------------------------------------------------------------------

import { adminClient, die } from "./_import-common.mjs";

const argv = process.argv.slice(2);
const showAll = argv.includes("--all");
const days = Number(argv[argv.indexOf("--days") + 1]) || 7;

const db = adminClient();
const since = new Date(Date.now() - days * 86_400_000).toISOString();

const { data, error } = await db
  .from("placement_candidates")
  .select(
    "ticker,company,deal_type,received_at,subject," +
      "tracker_written_at,tracker_sheet,tracker_attempts,tracker_error," +
      "dismissed_at,dismiss_reason",
  )
  .gte("received_at", since)
  .order("received_at", { ascending: false });

if (error) die(error);
if (!data?.length) {
  console.log(`No placement candidates received in the last ${days} day(s).`);
  console.log(
    "That is itself the finding: the deal never became a candidate, so the tracker\n" +
      "was never asked to write it. Look at the mail classification, not the queue —\n" +
      "/portal/staff/placements shows what the inbox produced.",
  );
  process.exit(0);
}

const when = (iso) =>
  iso
    ? new Date(iso).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    : "—";

// Owed first, because that is the queue. A deal is owed until it has a tab —
// `tracker_written_at IS NULL` — and being owed with attempts on the clock is a
// different thing to know about than being owed and never yet tried.
const owed = data.filter((r) => !r.tracker_written_at && !r.dismissed_at);
const filed = data.filter((r) => r.tracker_written_at);
const dismissed = data.filter((r) => !r.tracker_written_at && r.dismissed_at);

console.log(`Placement tracker queue — last ${days} day(s), ${data.length} candidate(s)\n`);

if (owed.length === 0) {
  console.log("Nothing owed a tab. Every candidate in the window is filed or dismissed.\n");
} else {
  console.log(`── Owed a tab (${owed.length}) ──────────────────────────────────────\n`);
  for (const r of owed) {
    console.log(`${r.ticker.toUpperCase()}  ${r.company}`);
    console.log(`  received   ${when(r.received_at)}   ${r.deal_type}`);
    console.log(`  attempts   ${r.tracker_attempts}`);
    if (r.tracker_error) {
      console.log(`  last error ${r.tracker_error}`);
    } else if (r.tracker_attempts === 0) {
      // Never tried is not the same as tried and refused, and the two want
      // opposite things done about them.
      console.log(
        `  last error —  never attempted. The sweep has not reached it, or the deployment\n` +
          `             cannot write at all (no PLACEMENT_TRACKER_URL / no Graph credentials).`,
      );
    } else {
      console.log(`  last error —  attempted but no reason recorded.`);
    }
    console.log("");
  }
}

if (showAll && filed.length > 0) {
  console.log(`── Filed (${filed.length}) ─────────────────────────────────────────\n`);
  for (const r of filed) {
    console.log(
      `${r.ticker.toUpperCase().padEnd(8)} ${when(r.tracker_written_at).padEnd(20)} ` +
        `tab ${r.tracker_sheet ?? "— (filed by hand)"}`,
    );
  }
  console.log("");
}

if (dismissed.length > 0) {
  console.log(`── Dismissed, so never owed a tab (${dismissed.length}) ────────────\n`);
  for (const r of dismissed) {
    console.log(`${r.ticker.toUpperCase().padEnd(8)} ${r.dismiss_reason ?? "no reason given"}`);
  }
  console.log("");
}

if (!showAll) console.log(`${filed.length} filed deal(s) not shown — pass --all to list them.`);
