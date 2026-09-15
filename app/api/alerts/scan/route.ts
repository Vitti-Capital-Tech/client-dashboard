import { NextResponse } from "next/server";
import { runAlertScan } from "@/lib/alerts/run";
import { authorisedCronRequest } from "@/lib/ingest/cron-auth";

/**
 * Cron entry point for the options alert scan.
 *
 * ── Why this is its own endpoint and not part of the morning ingest ─────────
 * The ingest is already a tight fit inside the 60s Hobby ceiling: a cold run
 * pays ~17s for the Placement Tracker workbooks before it imports anything,
 * then recomputes every account the holdings snapshot touched, which is all of
 * them. Adding a second full-book pass to that request would push it over, and
 * the symptom of going over is silence — a successful POST with no work done.
 *
 * Keeping the scan separate also lets it be scheduled where it belongs: AFTER
 * the ingest has refreshed holdings and prices, and after the market has opened
 * so `securities.last_price` is a price from today rather than yesterday's
 * close.
 *
 * ── Why a failed run is not a problem ──────────────────────────────────────
 * Every alert carries a key naming the event it reports, so a rerun inserts
 * nothing it has already inserted. A run cut off halfway leaves the alerts it
 * managed to write and no partial state that would confuse the next one — the
 * moneyness state is only written after the alerts are, so a crash between the
 * two makes the next run re-derive the same crossing and the unique index
 * swallow it.
 *
 * ── Auth ───────────────────────────────────────────────────────────────────
 * `CRON_SECRET`, compared in constant time, exactly as the ingest routes do.
 * This endpoint writes rows for every client as service_role; the secret is the
 * only thing standing in front of it.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request) {
  if (!authorisedCronRequest(request)) {
    // 404 rather than 401: an unauthenticated caller learns nothing about
    // whether this path exists, which is the same posture the ingest takes.
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const report = await runAlertScan();
    return NextResponse.json({ ok: true, ...report });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 500 with the message, because the only reader is a log and a person
    // debugging a silent morning.
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return handle(request);
}

/**
 * GET is accepted so the scan can be triggered from a browser or a curl with
 * the bearer token while it is being set up. pg_cron sends POST.
 */
export async function GET(request: Request) {
  return handle(request);
}
