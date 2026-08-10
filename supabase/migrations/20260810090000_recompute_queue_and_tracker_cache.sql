-- ============================================================================
-- Two tables the first real scheduled run proved necessary
-- ----------------------------------------------------------------------------
-- The morning ingest was killed by the host at its 60s request ceiling, having
-- imported both files and then recomputed 13 of 43 accounts. Nothing was
-- corrupted — the importers are idempotent and the watermark only advances on a
-- clean run — but no `ingest_runs` row was written either, so the failure was
-- silent, and the recompute would have failed the same way every morning.
--
-- Measured breakdown of that run:
--     ~17s   downloading and parsing the Placement Tracker workbooks
--     ~40s   13 accounts recomputed  (~3s each)
--   ------
--    ~150s   what 43 accounts actually needs
--
-- Two fixes, one per table below. The first removes the 17s; the second makes
-- the remainder survive a ceiling rather than be lost to it.
--
-- Both tables may already exist from an earlier partial run of a superseded
-- migration, hence IF NOT EXISTS.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. pnl_recompute_queue — work a run could not finish
-- ----------------------------------------------------------------------------
-- Importing and recomputing are one logical morning but wildly unequal in cost,
-- and the recompute is worthless without the Placement Trackers. Coupling them
-- means one slow morning costs the day's import too.
--
-- So the ingest always imports, ENQUEUES the accounts it touched, and recomputes
-- as many as its time budget allows. Whatever is left stays here for the next
-- run or for the desk's Rebuild all P&L — visible, counted, and impossible to
-- mistake for finished work.
--
-- The ordering matters: accounts are queued BEFORE the recompute is attempted.
-- Enqueueing afterwards would lose exactly the case this exists for.
CREATE TABLE IF NOT EXISTS pnl_recompute_queue (
  account_id  uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  queued_at   timestamptz NOT NULL DEFAULT now(),
  -- Why it is waiting: 'ingest' | 'backfill' | 'manual'.
  reason      text NOT NULL DEFAULT 'ingest',
  -- Bumped each time a run tries and fails, so an account that is permanently
  -- broken stops looking like ordinary backlog.
  attempts    integer NOT NULL DEFAULT 0,
  last_error  text
);

CREATE INDEX IF NOT EXISTS idx_pnl_queue_queued ON pnl_recompute_queue(queued_at);

-- ----------------------------------------------------------------------------
-- 2. placement_tracker_cache — the slow parse, paid once
-- ----------------------------------------------------------------------------
-- The parsed trackers were cached in process memory with a 10-minute TTL. That
-- serves a warm server well and a scheduled job not at all: every cron
-- invocation is a cold function, so every one paid the full ~17s for a workbook
-- nobody had edited.
--
-- The output is only ~0.23 MB of JSON, so it is stored instead and the cost
-- becomes one row read. The parse now happens only when a human presses
-- "Refresh trackers" — which is the right cadence anyway, since placements are
-- issued occasionally rather than daily.
--
-- A stale cache is a real risk (a placement issued this morning is invisible
-- until refreshed), so `parsed_at` is surfaced everywhere the figures are and
-- an EMPTY cache stops the recompute outright rather than letting it store
-- rows missing every placement buy side.
CREATE TABLE IF NOT EXISTS placement_tracker_cache (
  -- sha256 of the URL, not the URL: for a link-shared sheet the URL *is* the
  -- credential, and this table is readable by every staff member.
  url_hash     text PRIMARY KEY,
  label        text NOT NULL,             -- the workbook's filename, for the UI
  ticker_count integer NOT NULL DEFAULT 0,
  -- The parsed `PlacementTickerInfo[]`, exactly as the merge consumes it.
  items        jsonb NOT NULL,
  parsed_at    timestamptz NOT NULL DEFAULT now(),
  parse_ms     integer
);

-- ----------------------------------------------------------------------------
-- RLS — staff only. Operational tables belonging to no client.
-- ----------------------------------------------------------------------------
ALTER TABLE pnl_recompute_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pnl_queue_staff ON pnl_recompute_queue;
CREATE POLICY pnl_queue_staff ON pnl_recompute_queue FOR ALL TO authenticated
  USING (is_staff()) WITH CHECK (is_staff());

ALTER TABLE placement_tracker_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tracker_cache_staff ON placement_tracker_cache;
CREATE POLICY tracker_cache_staff ON placement_tracker_cache FOR ALL TO authenticated
  USING (is_staff()) WITH CHECK (is_staff());
