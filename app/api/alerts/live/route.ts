import { NextResponse } from "next/server";
import { runLiveTick } from "@/lib/alerts/live";
import { authorisedCronRequest } from "@/lib/ingest/cron-auth";

/**
 * Cron entry point for the intraday tick: fresh prices, then the alerts that
 * depend on them.
 *
 * ── Why this is separate from /api/alerts/scan ──────────────────────────────
 * They answer to different clocks, and conflating them would get one of them
 * wrong. The daily scan runs every calendar day including weekends, because an
 * expiry ladder crossing happens on the calendar. This one runs only while the
 * ASX is trading, because a price crossing cannot happen when the market is
 * shut — and `runLiveTick` returns immediately when `asxSession` says so, which
 * is why the schedule below can be a blunt every-ten-minutes without spending
 * anything overnight or at the weekend.
 *
 * The daily scan is still worth keeping even though this one re-runs it: if
 * Yahoo is down for a whole session, or the market is closed for a public
 * holiday, the expiry ladder still has to be walked.
 *
 * ── Why a failure here is cheap ─────────────────────────────────────────────
 * Every alert carries a key naming its event, so a rerun writes nothing it has
 * already written. A tick that dies after writing prices but before alerting
 * leaves the prices — which are an improvement on their own — and the next tick
 * ten minutes later finds the same crossing and reports it.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request) {
  if (!authorisedCronRequest(request)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const report = await runLiveTick();
    return NextResponse.json({ ok: true, ...report });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return handle(request);
}

/** Accepted so the tick can be triggered by hand while it is being set up. */
export async function GET(request: Request) {
  return handle(request);
}
