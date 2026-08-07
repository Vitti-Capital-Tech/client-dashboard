import { NextResponse } from "next/server";
import { runMorningIngest } from "@/lib/ingest/morning";
import { authorisedCronRequest } from "@/lib/ingest/cron-auth";

/**
 * Cron entry point for the morning broker-mail ingest.
 *
 * ── Why several schedules ────────────────────────────────────────────────────
 * The mail arrives around 9am Sydney time and cron runs in UTC, but Sydney is
 * not a fixed offset: AEST is UTC+10 and AEDT is UTC+11, so a single UTC time
 * is an hour wrong for half the year. Rather than track the changeover, this is
 * scheduled to fire a few times across the window (see vercel.json) and made
 * cheap to repeat: the watermark plus the attachment table mean a run with no
 * new mail does almost nothing, and both importers are idempotent regardless.
 *
 * ── Auth ─────────────────────────────────────────────────────────────────────
 * `CRON_SECRET`, compared in constant time — see lib/ingest/cron-auth.ts.
 *
 * ── Before the first run ─────────────────────────────────────────────────────
 * `/api/ingest/health` walks the same mailbox path and stops short of importing
 * anything, so Azure and the mail rule can be verified without waiting for 9am
 * or letting a test run apply files.
 */

export const dynamic = "force-dynamic";

/**
 * 60s, because that is the Hobby-plan ceiling — asking for more is not honoured
 * and only hides the real limit.
 *
 * It is a tight fit and worth watching. A cold run pays ~17s to download and
 * parse the Placement Tracker workbooks before it does anything, then imports,
 * then recomputes every account the holdings file touched — which is all of
 * them, every day, since a snapshot covers the whole book.
 *
 * If a run is cut off, nothing is corrupted: the importers are idempotent, no
 * `ingest_runs` row is written so the watermark does not advance, and the next
 * schedule re-reads the same mail. But it will never finish either, and the
 * symptom is silence — `cron.job_run_details` shows a successful POST while
 * `ingest_runs` stays empty. That specific pair is what to look for.
 *
 * The fix, if it comes to that, is to stop re-parsing unchanged workbooks every
 * morning: cache the parsed trackers in Postgres and have the recompute read
 * them. That removes the ~17s entirely.
 */
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!authorisedCronRequest(request)) {
    // Deliberately terse: an unauthenticated caller learns nothing about
    // whether CRON_SECRET is set, only that it was not satisfied.
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const report = await runMorningIngest();

  // A failed ingest returns 500 so the platform's own cron monitoring shows it
  // as failed rather than as a quiet success with sad JSON inside.
  return NextResponse.json(report, { status: report.ok ? 200 : 500 });
}

// Vercel Cron issues GET; POST is here so the desk can trigger a catch-up run
// with the same secret without pretending to be cron.
export const POST = GET;
