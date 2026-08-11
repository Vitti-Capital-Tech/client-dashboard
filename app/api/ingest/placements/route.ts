import { NextResponse } from "next/server";
import { syncPlacementCandidates } from "@/lib/placements/candidates";
import { authorisedCronRequest } from "@/lib/ingest/cron-auth";

/**
 * Cron entry point for the deal-mail sync.
 *
 * Pulls the placement/IPO summaries the upstream pipeline built from the broker
 * mail into `placement_candidates`, where the Placements tab reads them. Nothing
 * here creates a deal: a candidate is the desk's inbox, and turning one into a
 * biddable `placements` row is a human act that supplies the terms the mail
 * never carried (see the migration for why that separation exists).
 *
 * ── Separate from the morning ingest, deliberately ────────────────────────────
 * That job is already tight against its ceiling — a real run recomputed 24 of 43
 * accounts and left 19 queued — and its work is the one that must not be
 * crowded out. A deal summary arriving an hour later costs nothing; a client's
 * P&L not rebuilding costs the morning.
 *
 * ── Auth ──────────────────────────────────────────────────────────────────────
 * `CRON_SECRET`, compared in constant time — the same boundary as the morning
 * ingest, and the same reason: no user session stands behind this.
 *
 * ── Repeating is free ─────────────────────────────────────────────────────────
 * Candidates upsert on a content fingerprint, so a re-run converges rather than
 * duplicating. `?days=N` widens the window for a manual backfill; the default is
 * deliberately small because each date costs the upstream a market-data lookup
 * per ticker and possibly an LLM call.
 */

export const dynamic = "force-dynamic";

/**
 * 60s — the Hobby-plan ceiling. Generous for this: the work is a handful of
 * HTTP calls and one upsert. The upstream is the slow part, and only on a cache
 * miss.
 */
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!authorisedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const days = Number(new URL(request.url).searchParams.get("days")) || undefined;
  const report = await syncPlacementCandidates({ days });

  // Non-200 on failure so the platform's cron monitoring shows it as failed
  // rather than as a quiet success with sad JSON inside.
  return NextResponse.json(report, { status: report.ok ? 200 : 500 });
}

// Cron issues GET; POST is here so the desk can trigger a catch-up with the
// same secret without pretending to be cron.
export const POST = GET;
