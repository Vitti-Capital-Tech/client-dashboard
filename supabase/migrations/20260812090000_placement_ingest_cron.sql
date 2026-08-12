-- ============================================================================
-- Scheduling the deal-mail sync with pg_cron
-- ----------------------------------------------------------------------------
-- `/api/ingest/placements` has existed since the candidates migration and has
-- never been on a schedule — the route was there, and something had to call it.
-- That was survivable while promoting a candidate was a human act anyway: the
-- desk opened the Placements tab, and whoever had run the sync last had run it.
--
-- It stopped being survivable when the sync started writing into the Placement
-- Tracker. "As soon as a deal arrives" is a claim about a schedule, and without
-- one the honest version is "as soon as somebody remembers".
--
-- ── Why not fold it into the morning ingest ──────────────────────────────────
-- Deals are announced through the day, not at 9am with the broker exports, and
-- the morning job is already tight against the host's 60s ceiling — a real run
-- recomputed 24 of 43 accounts and left 19 queued. A deal summary an hour late
-- costs nothing; a P&L that does not rebuild costs the morning. So this is its
-- own entry, deliberately.
--
-- ── The cadence, and what it costs ───────────────────────────────────────────
-- Hourly across the Sydney trading day on weekdays. Each run asks the upstream
-- for 2 dates, and each date costs it a market-data lookup per ticker and, on a
-- cache miss, an LLM call to write the summary — so this is not free and it is
-- not a good candidate for every five minutes.
--
--   22:00–08:00 UTC covers 09:00–18:00 in both AEST (UTC+10) and AEDT (UTC+11)
--
-- The window is quoted in UTC and deliberately runs an hour wide at each end
-- rather than tracking the daylight-saving changeover, exactly as the morning
-- ingest does. A run with nothing new costs one upstream read and writes
-- nothing: candidates upsert on a content fingerprint, and the tracker write
-- checks the workbook before touching it.
--
-- ── Before running this ──────────────────────────────────────────────────────
-- Replace <APP_URL> and <CRON_SECRET> in the SQL editor. They are placeholders
-- for the same reason as in the morning ingest's file: this is committed, and a
-- secret in git history is far harder to rotate than one pasted into a query.
--
-- Unreplaced, this file SKIPS scheduling and says so, rather than registering a
-- job that POSTs to the literal string `<APP_URL>` every hour. `supabase db push`
-- applies every file in this directory without knowing which ones expect a human
-- to fill something in, so the check is here rather than in a runbook: a skipped
-- job with a notice is recoverable, and a junk job that fails hourly in a log
-- nobody reads is how this ends up looking scheduled when it is not.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Idempotent: re-running replaces the schedule rather than stacking duplicates.
SELECT cron.unschedule('placement-mail-sync') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'placement-mail-sync'
);

DO $do$
DECLARE
  app_url    text := '<APP_URL>';
  cron_token text := '<CRON_SECRET>';
BEGIN
  IF app_url LIKE '%<APP_URL>%' OR cron_token LIKE '%<CRON_SECRET>%' THEN
    RAISE NOTICE E'\n  placement-mail-sync was NOT scheduled: <APP_URL> / <CRON_SECRET> are still placeholders.\n  Paste this file into the Supabase SQL editor with both replaced to schedule it.';
    RETURN;
  END IF;

  PERFORM cron.schedule(
    'placement-mail-sync',
    -- Hourly, 22:00 UTC through 08:00 UTC, Monday to Friday in UTC terms. The
    -- 22:00 and 23:00 entries belong to the NEXT Sydney weekday, which is why
    -- the day range is 0-5 rather than 1-5: 22:00 UTC Sunday is Monday morning
    -- there.
    '0 22,23,0,1,2,3,4,5,6,7,8 * * 0-5',
    format(
      $job$
      SELECT net.http_post(
        url     := %L,
        headers := jsonb_build_object(
                     'Authorization', %L,
                     'Content-Type',  'application/json'
                   ),
        body    := '{}'::jsonb,
        -- Just under the route's own 60s ceiling. pg_net giving up does not stop
        -- the work — the request has already reached the server — but it does
        -- mean `net._http_response` records no status, so the outcome becomes
        -- invisible.
        timeout_milliseconds := 58000
      );
      $job$,
      app_url || '/api/ingest/placements',
      'Bearer ' || cron_token
    )
  );

  RAISE NOTICE 'placement-mail-sync scheduled.';
END
$do$;

-- ----------------------------------------------------------------------------
-- Checking on it
-- ----------------------------------------------------------------------------
--   SELECT jobid, jobname, schedule, active FROM cron.job;
--   SELECT * FROM cron.job_run_details WHERE jobname = 'placement-mail-sync'
--     ORDER BY start_time DESC LIMIT 10;
--
--   -- The response body carries the tracker's own report: how many rows were
--   -- written, how many were already there, and what stopped the rest.
--   SELECT id, status_code, content, created FROM net._http_response
--     ORDER BY created DESC LIMIT 5;
