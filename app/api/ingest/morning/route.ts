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
// The Placement Tracker parse alone can take ~48s on a cold cache, before any
// import or recompute. The default serverless timeout would cut that off.
export const maxDuration = 300;

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
