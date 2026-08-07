-- ============================================================================
-- Scheduling the morning ingest with pg_cron
-- ----------------------------------------------------------------------------
-- The job is a plain authenticated HTTP call, so *what* schedules it is
-- interchangeable. This uses Supabase's own `pg_cron` rather than the host's
-- scheduler for one practical reason: the Vercel Hobby plan allows a single
-- cron per day, and one fixed daily time cannot cover a mail that arrives at
-- 9am Sydney while UTC is what a scheduler speaks.
--
-- ── The daylight-saving problem, and why two entries ─────────────────────────
--   9:00 AEST  (UTC+10, ~Apr–Oct) = 23:00 UTC the previous day
--   9:00 AEDT  (UTC+11, ~Oct–Apr) = 22:00 UTC the previous day
--
-- Rather than track the changeover, the job runs at 00:00 and 01:00 UTC — which
-- is 10:00/11:00 in whichever offset is in force, comfortably after the mail in
-- both. The second entry is not a fallback for the first; it is a free retry,
-- because a run with nothing new to do costs almost nothing: attachments dedupe
-- on Graph's own ids and both importers are idempotent.
--
-- Weekday numbering is UTC, and that is correct here rather than an off-by-one:
-- 00:00 UTC Monday IS 10:00 Monday in Sydney, so Monday's mail (23:00 UTC
-- Sunday) is picked up by Monday's job.
--
-- ── Before running this ──────────────────────────────────────────────────────
-- Replace <APP_URL> and <CRON_SECRET> in the SQL editor. They are left as
-- placeholders on purpose: this file is committed, and a secret in git history
-- is far harder to rotate than one pasted into a query.
--
-- The secret does end up stored in the job definition, which is readable by
-- anyone who can read `cron.job`. That is the same trust boundary as the
-- service-role key, so it is consistent rather than a new exposure — but it is
-- worth knowing, and it is a reason not to reuse this secret anywhere else.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Idempotent: re-running this file replaces the schedules rather than stacking
-- duplicates on top of the old ones.
SELECT cron.unschedule('broker-ingest-a') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'broker-ingest-a'
);
SELECT cron.unschedule('broker-ingest-b') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'broker-ingest-b'
);

-- 00:00 UTC = 10:00 AEST / 11:00 AEDT, Mon–Fri.
SELECT cron.schedule(
  'broker-ingest-a',
  '0 0 * * 1-5',
  $$
  SELECT net.http_post(
    url     := '<APP_URL>/api/ingest/morning',
    headers := jsonb_build_object(
                 'Authorization', 'Bearer <CRON_SECRET>',
                 'Content-Type',  'application/json'
               ),
    body    := '{}'::jsonb,
    -- Just under the host's own request ceiling. pg_net giving up does not stop
    -- the work — the request has already reached the server — but a timeout
    -- here means `net._http_response` records no status, so keep it generous
    -- enough that the outcome is actually visible.
    timeout_milliseconds := 58000
  );
  $$
);

-- 01:00 UTC — the free retry. Covers a late-arriving mail, and re-attempts
-- anything the first run could not finish, without anyone having to think
-- about it.
SELECT cron.schedule(
  'broker-ingest-b',
  '0 1 * * 1-5',
  $$
  SELECT net.http_post(
    url     := '<APP_URL>/api/ingest/morning',
    headers := jsonb_build_object(
                 'Authorization', 'Bearer <CRON_SECRET>',
                 'Content-Type',  'application/json'
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 58000
  );
  $$
);

-- ----------------------------------------------------------------------------
-- Checking on it
-- ----------------------------------------------------------------------------
--   SELECT jobid, jobname, schedule, active FROM cron.job;
--
--   -- Did the scheduler fire, and did the HTTP call leave the database?
--   SELECT * FROM cron.job_run_details ORDER BY start_time DESC LIMIT 10;
--   SELECT id, status_code, created FROM net._http_response ORDER BY created DESC LIMIT 10;
--
--   -- What the ingest itself decided. THIS is the one that matters: pg_cron
--   -- reports whether the REQUEST succeeded, not whether the morning did. A run
--   -- that imported nothing and a run that never happened look identical from
--   -- cron's side and completely different from here.
--   SELECT started_at, status, messages_seen, imported, quarantined, error, notes
--   FROM ingest_runs ORDER BY started_at DESC LIMIT 10;
--
--   -- Per-file detail, including anything quarantined and why.
--   SELECT received_at, filename, kind, outcome, rows_parsed, error
--   FROM ingest_attachments ORDER BY received_at DESC LIMIT 20;
--
-- To pause without deleting:
--   UPDATE cron.job SET active = false WHERE jobname LIKE 'broker-ingest-%';
