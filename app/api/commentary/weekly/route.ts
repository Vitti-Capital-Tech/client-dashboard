import { NextResponse } from "next/server";
import { runWeeklyCommentary } from "@/lib/commentary/run";
import { authorisedCronRequest } from "@/lib/ingest/cron-auth";

/**
 * Cron entry point for the weekly per-security commentary.
 *
 * ── Why this is scheduled to repeat ──────────────────────────────────────────
 * The work runs on the Message Batches API in two phases: one tick submits the
 * week's batch, a later tick collects it (see lib/commentary/run.ts for why it
 * cannot be one pass). So the schedule fires repeatedly from Friday evening
 * through Sunday and each tick is cheap: submitting happens once because
 * `commentary_runs` is keyed on the week, and every tick after that either
 * reports the batch still processing or collects it and stops.
 *
 * A run outside that window returns `outside-window` and does nothing, which is
 * checked here rather than trusted to the schedule — a mis-set cron entry and a
 * manual catch-up arrive as the same request, and neither should write a note
 * against a market that is still open. `?force=1` overrides it for the desk.
 *
 * ── Auth ─────────────────────────────────────────────────────────────────────
 * `CRON_SECRET`, compared in constant time — see lib/ingest/cron-auth.ts.
 */

export const dynamic = "force-dynamic";

/**
 * 60s — the Hobby-plan ceiling, as with the morning ingest.
 *
 * Both phases fit inside it comfortably, which is the entire reason for the
 * batch design: submitting is one HTTP call carrying 142 requests, and
 * collecting streams back 142 short results. Neither waits on generation.
 */
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!authorisedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const force = new URL(request.url).searchParams.get("force") === "1";
  const report = await runWeeklyCommentary({ force });

  return NextResponse.json(report, { status: report.ok ? 200 : 500 });
}

// Vercel Cron issues GET; POST lets the desk trigger a catch-up run with the
// same secret without pretending to be cron.
export const POST = GET;
