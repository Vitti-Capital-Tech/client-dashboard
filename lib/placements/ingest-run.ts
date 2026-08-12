import "server-only";
import { syncPlacementCandidates, type CandidateFeedItem } from "./candidates.ts";
import { syncTrackerRows, type TrackerSyncReport } from "./tracker-sync.ts";
import { graphCaller, resolveTrackerTarget, trackerUrls } from "./tracker-writer.ts";
import { getMicrosoftAccessToken } from "../remote-sheets.ts";

/**
 * One deal-mail ingest: pull the candidates, then write the new ones into the
 * Placement Tracker.
 *
 * Extracted because there are two triggers and they must do the same thing. The
 * schedule calls it hourly; the mail webhook calls it seconds after the upstream
 * finishes classifying a deal. If they ran different code the fast path would
 * eventually stop matching the slow one, and the difference would only show up as
 * a deal that reached the inbox but never the tracker.
 */

export type PlacementIngestResult = {
  /** False when the mechanism is broken — not when one deal failed. */
  ok: boolean;
  candidates: Awaited<ReturnType<typeof syncPlacementCandidates>>;
  tracker: TrackerSyncReport | null;
};

export async function runPlacementIngest(
  opts: { days?: number } = {},
): Promise<PlacementIngestResult> {
  const candidates = await syncPlacementCandidates({ days: opts.days });
  const tracker = await writeFreshDealsToTracker(candidates.freshItems);
  return { ok: candidates.ok && tracker?.ok !== false, candidates, tracker };
}

/**
 * Fills the tracker for every deal this run brought in.
 *
 * Null when there is nothing to do or nothing to do it with: an absent
 * `PLACEMENT_TRACKER_URL` or absent Graph credentials is a deployment without the
 * tracker wired up, not an error worth raising on every run.
 */
export async function writeFreshDealsToTracker(
  fresh: CandidateFeedItem[],
): Promise<TrackerSyncReport | null> {
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
