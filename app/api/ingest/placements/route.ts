import { NextResponse } from "next/server";
import { syncPlacementCandidates } from "@/lib/placements/candidates";
import { authorisedCronRequest } from "@/lib/ingest/cron-auth";
import { getMicrosoftAccessToken } from "@/lib/remote-sheets";
import { syncTrackerRows } from "@/lib/placements/tracker-sync";
import { graphCaller, resolveTrackerTarget, trackerUrls } from "@/lib/placements/tracker-writer";

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

  // The tracker write runs on what actually arrived, and only after the
  // candidates are safely stored.
  const tracker = await writeFreshDealsToTracker(report.freshItems);

  // A BLOCKED tracker fails the run — a missing permission or a workbook that
  // cannot be found is the mechanism being broken, and the whole point of this
  // job is that nobody is watching it. Green cron runs while nothing is written
  // for three weeks is the exact failure this codebase already refuses to ship
  // elsewhere ("could not reach the feed" must not read as "no new deals").
  //
  // One deal failing is different and stays a 200: it is reported, and the next
  // run retries it, because the candidate is stored and the workbook check will
  // still say it is missing.
  const ok = report.ok && tracker?.ok !== false;

  return NextResponse.json(
    { ...report, tracker, notes: [...report.notes, ...(tracker?.notes ?? [])] },
    { status: ok ? 200 : 500 },
  );
}

/**
 * Fills the Placement Tracker for every deal this run brought in.
 *
 * Returns null when there is nothing to do or nothing to do it with — an absent
 * `PLACEMENT_TRACKER_URL` or absent Graph credentials is a deployment without
 * the tracker wired up, not an error to raise every ten minutes.
 */
async function writeFreshDealsToTracker(fresh: Parameters<typeof syncTrackerRows>[0]) {
  if (fresh.length === 0) return null;

  const urls = trackerUrls(process.env.PLACEMENT_TRACKER_URL);
  if (urls.length === 0) return null;

  const token = await getMicrosoftAccessToken();
  if (!token) return null;

  const graph = graphCaller(token);
  return syncTrackerRows(fresh, {
    graph,
    target: (year) => resolveTrackerTarget(urls, year, graph),
  });
}

// Cron issues GET; POST is here so the desk can trigger a catch-up with the
// same secret without pretending to be cron.
export const POST = GET;
