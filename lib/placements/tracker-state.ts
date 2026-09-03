import type { AdminDb } from "../import/runner.ts";
import type { CandidateFeedItem } from "./candidates.ts";

/**
 * The queue of deals still owed a tab in the Placement Tracker.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * The tracker write used to be handed `storeCandidates`' own `freshItems` — the
 * deals THAT run saw for the first time. A candidate is fresh exactly once, so a
 * write that failed was never tried again: the hourly sweep, which the design
 * calls the backstop, read `fresh = 0` and did nothing. On 3 September 2026 that
 * turned one killed invocation into two tabs the desk had to build by hand (the
 * migration tells the story).
 *
 * So the table is the queue instead. `tracker_written_at IS NULL` means owed,
 * whoever stored the row and however long ago, and the sweep works that set.
 * Freshness no longer decides anything.
 *
 * Deliberately free of `server-only` and of `createAdminClient`: the database is
 * injected, so the ordering and the marking are covered by tests against the
 * fake db rather than by hoping.
 */

/** A deal owed a tab, in the shape the tracker writer already understands. */
export type OwedCandidate = CandidateFeedItem & {
  id: string;
  /** Failed writes so far — what orders the queue. */
  attempts: number;
};

/**
 * How many owed deals one run will attempt.
 *
 * Small because the route's ceiling is 60 seconds and a single tab is minutes of
 * Graph calls against a 13 MB workbook — a measured one finished about two and a
 * half minutes after its candidate landed. The batch is not what makes the work
 * safe, though: each deal is marked the moment it settles, so a run killed
 * part-way keeps what it finished and the rest stays owed. The batch only stops
 * one run from starting work it has no chance of completing.
 *
 * The real answer is to give each tab its own invocation. Until then this is a
 * bound, not a fix, and a backlog says so in the run's notes.
 */
export const DEFAULT_TRACKER_BATCH = 2;

/** The columns `dealFromCandidate` and the marking below need. */
const OWED_COLUMNS =
  "id,ticker,company,deal_type,subject,summary,received_at,tracker_attempts";

export type OwedRead = {
  /**
   * False only when the queue could not be READ — a missing column because the
   * migration has not been applied, or the database being unreachable. Never
   * false for an empty queue, which is the normal state.
   */
  ok: boolean;
  items: OwedCandidate[];
  error?: string;
};

/**
 * Everything still owed a tab, oldest first.
 *
 * No `limit` on the query on purpose. The batch is applied afterwards, by
 * `orderTrackerQueue`, because a `LIMIT` on the database side would have to pick
 * an order first — and ordering by `received_at` there would let a handful of
 * permanently unwritable old deals fill every batch forever, while ordering by
 * attempts would need a composite index for no gain. The owed set is normally
 * zero or one row; a set big enough for the difference to matter is itself the
 * thing to go and look at, which is why the caller reports its size.
 *
 * Dismissed candidates are excluded rather than marked: the desk passing on a
 * deal before we got to it is a reason not to build the tab, not a write that
 * succeeded. They simply stop being owed.
 */
export async function owedTrackerCandidates(db: AdminDb): Promise<OwedRead> {
  const { data, error } = await db
    .from("placement_candidates")
    .select(OWED_COLUMNS)
    .is("tracker_written_at", null)
    .is("dismissed_at", null)
    .order("received_at", { ascending: true });

  if (error) {
    // A missing column here means the code shipped ahead of its migration. That
    // is worth saying in those words, because the symptom otherwise is the exact
    // silence this module was written to remove.
    const message = error.message ?? String(error);
    return {
      ok: false,
      items: [],
      error: /tracker_written_at|column/i.test(message)
        ? `Could not read the tracker queue (${message}). Apply ` +
          `supabase/migrations/20260903090000_placement_tracker_queue.sql — until then no ` +
          `deal can be filed.`
        : `Could not read the tracker queue: ${message}`,
    };
  }

  const rows = (data ?? []) as unknown as Record<string, unknown>[];
  return {
    ok: true,
    items: rows.map((r) => ({
      id: String(r.id),
      ticker: String(r.ticker ?? ""),
      company: String(r.company ?? ""),
      deal_type: String(r.deal_type ?? "Placement"),
      subject: String(r.subject ?? ""),
      summary: String(r.summary ?? ""),
      received_at: String(r.received_at ?? ""),
      attempts: Number(r.tracker_attempts ?? 0) || 0,
    })),
  };
}

/**
 * The order one run takes the queue in: fewest attempts first, then oldest.
 *
 * Attempts lead so that a deal the workbook keeps refusing — a year with no
 * configured file, a ticker that already has twenty-six tabs — cannot sit at the
 * front of every batch and starve the deal that arrived this morning. Nothing is
 * dropped for having failed often; it just goes last, and keeps being retried,
 * because giving up silently is the failure this replaced.
 *
 * Oldest-first within that keeps the Overview in the order the deals were
 * announced, which is how the desk reads it.
 */
export function orderTrackerQueue<T extends { attempts: number; received_at: string }>(
  items: T[],
  limit = DEFAULT_TRACKER_BATCH,
): T[] {
  return [...items]
    .sort((a, b) => a.attempts - b.attempts || a.received_at.localeCompare(b.received_at))
    .slice(0, Math.max(0, limit));
}

/**
 * This deal is in the workbook — stop owing it.
 *
 * `sheet` is null when the duplicate guard found it already on the Overview:
 * filed, but not by us, so there is no tab of ours to name. `tracker_error` is
 * cleared because a deal that has landed should not still carry the reason an
 * earlier attempt did not.
 */
export async function markTrackerWritten(
  db: AdminDb,
  id: string,
  opts: { sheet?: string | null; now?: Date } = {},
): Promise<void> {
  const { error } = await db
    .from("placement_candidates")
    .update({
      tracker_written_at: (opts.now ?? new Date()).toISOString(),
      tracker_sheet: opts.sheet ?? null,
      tracker_error: null,
    })
    .eq("id", id);

  // Worth a line rather than a throw: the tab IS in the workbook, and losing the
  // record of that costs one skipped duplicate check on the next run, not a deal.
  if (error) {
    console.error("tracker queue: could not mark %s written:", id, error.message ?? error);
  }
}

/**
 * This deal is still owed, and here is why it was not written this time.
 *
 * The attempt count is incremented from the value the run read rather than in
 * the database, because two runs writing the same deal at once is not a thing
 * this schedule can do — and a read-modify-write that is wrong by one under a
 * race it cannot have is not worth an RPC to avoid.
 */
export async function markTrackerFailed(
  db: AdminDb,
  id: string,
  opts: { attempts: number; error: string },
): Promise<void> {
  const { error } = await db
    .from("placement_candidates")
    .update({
      tracker_attempts: opts.attempts + 1,
      // Trimmed: a Graph error message can carry a paragraph of guidance, and
      // this column is read at a glance.
      tracker_error: opts.error.slice(0, 500),
    })
    .eq("id", id);

  if (error) {
    console.error("tracker queue: could not record %s's failure:", id, error.message ?? error);
  }
}
