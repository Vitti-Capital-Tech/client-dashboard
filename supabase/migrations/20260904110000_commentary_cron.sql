-- ============================================================================
-- Scheduling the weekly commentary with pg_cron
-- ----------------------------------------------------------------------------
-- Same shape as the morning ingest schedule (20260807170000): an authenticated
-- HTTP call to a route that decides for itself whether there is anything to do,
-- so a tick that lands on a week already written costs one request.
--
-- ── Why several ticks and not one ───────────────────────────────────────────
-- The job submits a Batch API job on one tick and collects it on a later one —
-- generation takes minutes to an hour and the route has 60 seconds (see
-- lib/commentary/run.ts). One weekly tick would therefore submit a batch and
-- never read it. So it fires every two hours across the window and each tick
-- either submits (once — `commentary_runs` is keyed on the week), reports the
-- batch still processing, or collects it and stops.
--
-- ── The window, in UTC ──────────────────────────────────────────────────────
--   Friday 17:00 AEST (UTC+10) = Friday 07:00 UTC
--   Friday 17:00 AEDT (UTC+11) = Friday 06:00 UTC
--
-- Starting at 06:00 UTC Friday covers the earlier of the two, and the route
-- itself refuses anything before the Sydney close, so the half of the year when
-- 06:00 UTC is still 16:00 in Sydney costs one no-op request rather than a note
-- written mid-session. Running through to Sunday 22:00 UTC keeps the whole
-- weekend available for the batch to finish and be collected.
--
-- ── Before running this ─────────────────────────────────────────────────────
-- Replace <APP_URL> and <CRON_SECRET> in the SQL editor. They are placeholders
-- on purpose: this file is committed, and a secret in git history is far harder
-- to rotate than one pasted into a query.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Idempotent: re-running this file replaces the schedule rather than stacking a
-- duplicate on top of the old one.
SELECT cron.unschedule('weekly-commentary') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'weekly-commentary'
);

-- Every two hours from 06:00 UTC Friday to 22:00 UTC Sunday.
SELECT cron.schedule(
  'weekly-commentary',
  '0 6-22/2 * * 5-7',
  $$
  SELECT net.http_post(
    url     := '<APP_URL>/api/commentary/weekly',
    headers := jsonb_build_object(
                 'Authorization', 'Bearer <CRON_SECRET>',
                 'Content-Type',  'application/json'
               ),
    body    := '{}'::jsonb,
    -- Just under the host's request ceiling, so the outcome is recorded in
    -- `net._http_response` rather than lost to a client-side timeout.
    timeout_milliseconds := 58000
  );
  $$
);

-- ----------------------------------------------------------------------------
-- Checking on it
-- ----------------------------------------------------------------------------
--   SELECT jobid, jobname, schedule, active FROM cron.job;
--   SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 10;
--
--   -- What the job itself decided. As with the ingest, this is the one that
--   -- matters: cron reports whether the REQUEST succeeded, not whether the
--   -- week's commentary was written.
--   SELECT week_of, status, requested, written, errored, submitted_at, collected_at, notes
--     FROM commentary_runs ORDER BY week_of DESC LIMIT 8;
--
--   -- A batch that was submitted and never collected (the failure mode to
--   -- watch for — it looks like success from cron's side):
--   SELECT * FROM commentary_runs
--    WHERE status = 'submitted' AND submitted_at < now() - interval '24 hours';
--
-- To force a run outside the window (the route refuses otherwise):
--   curl -X POST '<APP_URL>/api/commentary/weekly?force=1' \
--     -H 'Authorization: Bearer <CRON_SECRET>'
--
-- To pause without deleting:
--   UPDATE cron.job SET active = false WHERE jobname = 'weekly-commentary';
