-- ============================================================================
-- placement_candidates.tracker_* — the tracker write becomes a queue
-- ============================================================================
-- Until now the Placement Tracker write was a side effect of ONE run: the
-- ingest handed `syncTrackerRows` whatever `storeCandidates` had just reported
-- as fresh, and fresh means "this run saw it for the first time". A candidate is
-- fresh exactly once in its life, so a write that failed could never be tried
-- again — the hourly sweep that exists to be the backstop saw `fresh = 0` and
-- did nothing.
--
-- ── What that cost, on 3 September 2026 ──────────────────────────────────────
-- NGY's approval mail went out at 23:25 UTC on the 2nd, but the upstream feed
-- had not yet created its `2026-09-03` date bucket — the 00:00 cron read
-- `2026-09-02` and `2026-09-01` and could not see it. FBR's mail at 00:06:40
-- fired the webhook, by which time the bucket existed with BOTH deals in it, so
-- one run stored two candidates at 00:07:19 and then had to write two tabs into
-- a 13 MB workbook inside what was left of the route's 60 seconds. It got as far
-- as creating FBR's sheet and seeding it from Template, and was killed there:
-- the tab sat at the far end of the workbook, unformatted, its cells empty, with
-- no Overview row, and NGY was never attempted at all.
--
-- The 01:00 sweep then found `fresh = 0` — both candidates were already stored —
-- and wrote nothing. The desk built both tabs by hand.
--
-- ── The fix is to stop keying the write on freshness ─────────────────────────
-- `tracker_written_at` makes the table itself the queue. A candidate is owed a
-- tab until it has one, whoever stored it and however many runs ago; the sweep
-- picks up anything still owed. That removes the coupling completely — a killed
-- invocation, an upstream that lists a deal late, a Graph hiccup, a workbook
-- somebody had locked, all recover on the next run rather than needing a person
-- to notice.
--
-- `tracker_attempts` and `tracker_error` exist so a deal that CANNOT be written
-- does not quietly monopolise every run's small batch: the queue is ordered by
-- attempts first, so a repeatedly failing deal goes last and a newly arrived one
-- is never starved behind it. Nothing is ever given up on, because "we stopped
-- trying" is the failure mode this whole change exists to remove.
--
-- ── Apply this BEFORE deploying the code that reads it ───────────────────────
-- The reader treats a missing column as a loud, harmless note rather than a
-- crash, but until the migration lands nothing is written. The reverse order is
-- the risky one: a deal that arrives between the migration and the deploy is
-- backfilled below as already-written and will need a tab by hand.
-- ============================================================================

ALTER TABLE placement_candidates
  -- The tab this deal was filed under. `NULL` with `tracker_written_at` set
  -- means the workbook already had it when we looked (the duplicate guard in
  -- `writeDealToTracker` found the ticker and date on the Overview) — filed, but
  -- not by us, so there is no sheet name of ours to record.
  ADD COLUMN IF NOT EXISTS tracker_sheet      text,
  ADD COLUMN IF NOT EXISTS tracker_written_at timestamptz,
  ADD COLUMN IF NOT EXISTS tracker_attempts   integer NOT NULL DEFAULT 0,
  -- The last failure, kept rather than only logged: a cron log is where nobody
  -- is looking, and this is the one place a person can ask "why has this deal
  -- been waiting since Tuesday".
  ADD COLUMN IF NOT EXISTS tracker_error      text;

-- ----------------------------------------------------------------------------
-- Backfill: everything that already exists is settled
-- ----------------------------------------------------------------------------
-- Without this the first run after deploy would decide that every candidate ever
-- stored is owed a tab — 26 rows as this is written, back to 31 July 2026, when
-- the table started — and would start appending duplicates to the desk's live
-- workbook. (The workbook's other ~170 deal tabs predate the candidates table and
-- have no row here at all, so they are never in question.) The duplicate guard
-- reads the Overview by ticker AND issue date and would stop most of them, but
-- "most" is not a thing to rely on with a 13 MB book people work in daily, and
-- each check is two Graph calls besides.
--
-- `first_seen_at` rather than `now()` so the column reads as history rather than
-- as though every old deal was filed the moment this migration ran.
UPDATE placement_candidates
   SET tracker_written_at = first_seen_at
 WHERE tracker_written_at IS NULL;

-- ----------------------------------------------------------------------------
-- The queue's own index
-- ----------------------------------------------------------------------------
-- Partial, because the interesting set is nearly always empty and this keeps it
-- that size. `dismissed_at IS NULL` is part of the predicate for the same reason
-- it is part of the query: a deal the desk has already passed on does not need a
-- tab built for it an hour later.
CREATE INDEX IF NOT EXISTS idx_placement_candidates_tracker_owed
  ON placement_candidates(tracker_attempts, received_at)
  WHERE tracker_written_at IS NULL AND dismissed_at IS NULL;

COMMENT ON COLUMN placement_candidates.tracker_written_at IS
  'When this deal reached the Placement Tracker. NULL means it is still owed a tab; the hourly sync writes anything owed, however long ago it was stored.';
COMMENT ON COLUMN placement_candidates.tracker_sheet IS
  'The tab this deal was filed under. NULL alongside a set tracker_written_at means the workbook already had it.';
COMMENT ON COLUMN placement_candidates.tracker_attempts IS
  'Failed tracker writes so far. The queue is ordered by this first, so a deal that cannot be written never starves a newly arrived one.';
COMMENT ON COLUMN placement_candidates.tracker_error IS
  'The last tracker write failure for this deal, so the reason is readable without digging through a cron log.';

-- ----------------------------------------------------------------------------
-- Checking on it
-- ----------------------------------------------------------------------------
--   -- What is owed a tab right now, in the order the sync will take it:
--   SELECT ticker, received_at, tracker_attempts, tracker_error
--     FROM placement_candidates
--    WHERE tracker_written_at IS NULL AND dismissed_at IS NULL
--    ORDER BY tracker_attempts, received_at;
--
--   -- A deal that has been refused several times is the one worth reading:
--   SELECT ticker, tracker_attempts, tracker_error FROM placement_candidates
--    WHERE tracker_attempts > 1 ORDER BY tracker_attempts DESC LIMIT 10;
