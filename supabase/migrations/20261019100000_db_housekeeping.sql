-- ============================================================================
-- Housekeeping: read only the latest P&L run, and stop two logs growing forever
-- ============================================================================
-- Two tables only ever grow:
--
--   cron.job_run_details  pg_cron writes a row for every tick of every job — the
--                         10-minute alert tick alone is 144 a day — and nothing
--                         deletes them. At 3.5 MB on 19 October 2026 it was the
--                         second largest table in the database.
--   pnl_runs              one row per recompute, every morning for every account
--                         plus every manual edit. Only the latest per account is
--                         ever read; 2,605 rows against 1,865 summary rows.
--
-- And the one reader of pnl_runs fetched a client's ENTIRE history, `sources`
-- jsonb included, to keep one row per account — so the staff client page got
-- heavier every single day. `pnl_runs_latest` returns that one row per account
-- from the database instead.
--
-- ── Apply this BEFORE deploying the code that reads the view ─────────────────
-- ============================================================================

-- ----------------------------------------------------------------------------
-- The latest run per account
-- ----------------------------------------------------------------------------
-- `security_invoker` so the caller's RLS on pnl_runs applies — a plain view runs
-- as its owner and would hand every client every other client's runs.
--
-- `client_id` leads the DISTINCT ON although an account belongs to exactly one
-- client: a filter on a DISTINCT ON column can be pushed inside the view, so
-- `WHERE client_id = …` reads that client's rows through `idx_pnl_runs_client`
-- instead of de-duplicating the whole table first.
CREATE OR REPLACE VIEW pnl_runs_latest
WITH (security_invoker = true) AS
SELECT DISTINCT ON (client_id, account_id)
       id, account_id, client_id, computed_at, total_pnl, row_count,
       trigger, warnings, engine_version
  FROM pnl_runs
 ORDER BY client_id, account_id, computed_at DESC;

REVOKE ALL ON pnl_runs_latest FROM anon;
GRANT SELECT ON pnl_runs_latest TO authenticated, service_role;

COMMENT ON VIEW pnl_runs_latest IS
  'The most recent pnl_runs row per account. RLS of pnl_runs applies (security_invoker).';

-- ----------------------------------------------------------------------------
-- Daily cleanup
-- ----------------------------------------------------------------------------
-- 17:30 UTC is the small hours in Sydney, clear of the morning ingest and of
-- every market-hours job.
--
--   cron.job_run_details  7 days kept — enough to answer "did last night's job
--                         run?", which is all it is ever asked.
--   pnl_runs              90 days kept, and the LATEST run of every account is
--                         kept whatever its age: it is what the client page
--                         shows. pnl_summary.run_id is ON DELETE SET NULL, and
--                         the summary only ever points at the latest run anyway.
CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.unschedule('db-housekeeping') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'db-housekeeping'
);

SELECT cron.schedule(
  'db-housekeeping',
  '30 17 * * *',
  $$
  DELETE FROM cron.job_run_details
   WHERE end_time < now() - interval '7 days';

  DELETE FROM public.pnl_runs r
   WHERE r.computed_at < now() - interval '90 days'
     AND EXISTS (
       SELECT 1 FROM public.pnl_runs newer
        WHERE newer.account_id = r.account_id
          AND newer.computed_at > r.computed_at
     );
  $$
);

-- ----------------------------------------------------------------------------
-- Checking on it
-- ----------------------------------------------------------------------------
--   SELECT d.start_time, d.status, d.return_message
--     FROM cron.job_run_details d JOIN cron.job j USING (jobid)
--    WHERE j.jobname = 'db-housekeeping' ORDER BY d.start_time DESC LIMIT 5;
