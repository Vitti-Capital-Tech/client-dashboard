import "server-only";
import { syncPlacementCandidates } from "./candidates.ts";
import { syncTrackerRows, type TrackerSyncReport } from "./tracker-sync.ts";
import { graphCaller, resolveTrackerTarget, trackerUrls } from "./tracker-writer.ts";
import { getMicrosoftAccessToken } from "../remote-sheets.ts";
import {
  DEFAULT_TRACKER_BATCH,
  markTrackerFailed,
  markTrackerWritten,
  orderTrackerQueue,
  owedTrackerCandidates,
  type OwedCandidate,
} from "./tracker-state.ts";
import type { AdminDb } from "../import/runner.ts";

/**
 * One deal-mail ingest: pull the candidates, then write whatever is still owed a
 * tab into the Placement Tracker.
 *
 * Extracted because there are two triggers and they must do the same thing. The
 * schedule calls it hourly; the mail webhook calls it seconds after the upstream
 * finishes classifying a deal. If they ran different code the fast path would
 * eventually stop matching the slow one, and the difference would only show up as
 * a deal that reached the inbox but never the tracker.
 *
 * ── The two halves are no longer joined ──────────────────────────────────────
 * This used to hand the tracker `candidates.freshItems` — the deals THIS run saw
 * for the first time. That is what made a failed write permanent: a candidate is
 * fresh exactly once, so the hourly sweep whose whole job is to be the backstop
 * found `fresh = 0` and did nothing. On 3 September 2026 an invocation was killed
 * part-way through a tab and both that morning's deals ended up being built by
 * hand.
 *
 * Now the pull stores candidates and the write works the queue, and neither
 * knows what the other did this run. A deal is owed a tab until it has one.
 */

export type PlacementIngestResult = {
  /** False when the mechanism is broken — not when one deal failed. */
  ok: boolean;
  candidates: Awaited<ReturnType<typeof syncPlacementCandidates>>;
  tracker: TrackerSyncReport | null;
};

export async function runPlacementIngest(
  opts: { days?: number; trackerLimit?: number } = {},
): Promise<PlacementIngestResult> {
  const candidates = await syncPlacementCandidates({ days: opts.days });
  const tracker = await writeOwedDealsToTracker({ limit: opts.trackerLimit });
  return { ok: candidates.ok && tracker?.ok !== false, candidates, tracker };
}

/**
 * Fills the tracker for every deal that still needs a tab.
 *
 * Null only when there is genuinely nothing to do: an empty queue. The cases
 * that used to return null and say nothing — no `PLACEMENT_TRACKER_URL`, no
 * Graph credentials — now come back as a report with a note, because "nothing to
 * write" and "deals are waiting and this deployment cannot write them" are not
 * the same answer and silence between them is how three weeks go by.
 *
 * Those two stay `ok: true` deliberately: a deployment without the tracker wired
 * up is a dev environment, not a fault, and failing the cron hourly over it
 * would train everyone to ignore a red run.
 */
export async function writeOwedDealsToTracker(
  opts: { limit?: number; db?: AdminDb } = {},
): Promise<TrackerSyncReport | null> {
  const db = opts.db ?? (await import("../supabase/admin.ts")).createAdminClient();

  const owed = await owedTrackerCandidates(db);
  if (!owed.ok) {
    return {
      ok: false,
      written: [],
      skipped: 0,
      failed: [],
      notes: [owed.error ?? "The tracker queue could not be read."],
    };
  }
  if (owed.items.length === 0) return null;

  const waiting = (batch: number) =>
    owed.items.length > batch
      ? [
          `${owed.items.length - batch} more deal(s) still owed a tab — this run takes ${batch}. ` +
            `A tab is minutes of Graph calls and the route has 60 seconds; the rest keep their place in the queue.`,
        ]
      : [];

  const urls = trackerUrls(process.env.PLACEMENT_TRACKER_URL);
  if (urls.length === 0) {
    return {
      ok: true,
      written: [],
      skipped: 0,
      failed: [],
      notes: [
        `${owed.items.length} deal(s) owed a tracker tab, but no PLACEMENT_TRACKER_URL is set. ` +
          `They stay queued.`,
      ],
    };
  }

  const token = await getMicrosoftAccessToken();
  if (!token) {
    return {
      ok: true,
      written: [],
      skipped: 0,
      failed: [],
      notes: [
        `${owed.items.length} deal(s) owed a tracker tab, but there are no Graph credentials to ` +
          `write with. They stay queued.`,
      ],
    };
  }

  const limit = opts.limit ?? DEFAULT_TRACKER_BATCH;
  const batch = orderTrackerQueue(owed.items, limit);

  const graph = graphCaller(token);
  const report = await syncTrackerRows<OwedCandidate>(batch, {
    graph,
    target: (year) => resolveTrackerTarget(urls, year, graph),
    // Recorded per deal, as it settles. A run that dies on its second tab keeps
    // the first — which is the whole point of the queue.
    onSettled: async (item, outcome) => {
      if (outcome.state === "failed") {
        await markTrackerFailed(db, item.id, { attempts: item.attempts, error: outcome.error });
        return;
      }
      await markTrackerWritten(db, item.id, {
        sheet: outcome.state === "written" ? outcome.sheet : null,
      });
    },
  });

  report.notes.push(...waiting(batch.length));
  return report;
}
