-- ============================================================================
-- Moving the morning ingest to 9am Sydney, and making it MEAN 9am Sydney
-- ----------------------------------------------------------------------------
-- 20260807170000_ingest_cron.sql ran the job at 00:00 and 01:00 UTC and said
-- why: pg_cron speaks UTC, Sydney does not have a fixed offset, and rather than
-- track the changeover it picked a pair of UTC times that land safely after the
-- mail in both. That is 10:00/11:00 Sydney in AEST and 11:00/12:00 in AEDT —
-- correct, but it drifts an hour twice a year and it is later than the desk
-- wants the figures.
--
-- The desk has asked for 9am Sydney. That cannot be written as a UTC cron
-- expression at all:
--
--     9:00 AEST  (UTC+10, ~Apr–Oct) = 23:00 UTC the previous day
--     9:00 AEDT  (UTC+11, ~Oct–Apr) = 22:00 UTC the previous day
--
-- ── How this is done ────────────────────────────────────────────────────────
-- Fire on every UTC hour that could BE the wanted Sydney hour, and let the job
-- itself decide. The schedule is the net; the WHERE clause is the filter:
--
--     22:15 / 23:15 / 00:15 UTC          <- three ticks, every day
--     WHERE Sydney hour = '09'           <- exactly one of them passes
--
--   AEST:  22:15→08:15 no · 23:15→09:15 YES · 00:15→10:15 no
--   AEDT:  22:15→09:15 YES · 23:15→10:15 no  · 00:15→11:15 no
--
-- One firing a day in either offset, on the day the changeover happens too, and
-- nothing to remember in October and April. `broker-ingest-b` is the same net
-- with the guard set to '10' — the free retry an hour later, unchanged in
-- purpose from the original file.
--
-- ── Why the weekday moved into the guard ────────────────────────────────────
-- The old expression said `1-5` and noted that UTC weekday numbering was
-- correct *because* the job ran at 00:00 UTC, the same calendar day as Sydney.
-- At 23:15 UTC that stops being true: Monday 9:15am Sydney is SUNDAY 23:15 UTC,
-- so a UTC `1-5` would run Tue–Sat Sydney and silently skip every Monday. The
-- day-of-week is therefore evaluated in Sydney time alongside the hour, where
-- it cannot disagree with it.
--
-- ── Why a WHERE and not an IF inside a DO block ─────────────────────────────
-- Both work; this one stays observable. `cron.job_run_details.return_message`
-- reads "1 row" when the POST was queued and "0 rows" when the guard declined,
-- so the log distinguishes "ran" from "was not its turn" — a DO block reports
-- "DO" either way, and the two mornings documented in LLD §8.42 were expensive
-- precisely because the scheduler's log could not tell those apart.
--
-- Postgres does not evaluate the target list when a one-time filter is false —
-- verified against this database, `SELECT pg_sleep(5) WHERE false` returns in
-- 0.00s — so the guarded ticks cost a planner round trip and make no request.
--
-- ── Why :15 and not :00 ─────────────────────────────────────────────────────
-- Because the mail has not arrived at 9:00:00. Every `received_at` on record
-- sits between 09:00:11 and 09:06:55 Sydney, the broker's own send being a few
-- seconds to a few minutes past the hour. A job at 9:00 sharp would fire BEFORE
-- the mail on every day observed so far, find nothing, and leave the real work
-- to the 10am retry — which is the schedule this file replaced, arrived at by
-- accident. :15 clears the latest send seen by ~8 minutes.
--
-- To make it 9:00 exactly, change the minute in both schedules from 15 to 0.
-- The guards do not move: they match on the HOUR, so the minute is free.
--
-- ── Before running this ─────────────────────────────────────────────────────
-- Replace <APP_URL> and <CRON_SECRET> in the SQL editor. They are placeholders
-- on purpose — this file is committed, and a secret in git history is far
-- harder to rotate than one pasted into a query. Same argument, same secret and
-- same trust boundary as the original file; see its header.
-- ============================================================================

-- Idempotent, and it also retires the old UTC-anchored pair: same job names, so
-- re-running this replaces rather than stacking a second schedule on top.
SELECT cron.unschedule('broker-ingest-a') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'broker-ingest-a'
);
SELECT cron.unschedule('broker-ingest-b') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'broker-ingest-b'
);

-- 9:15am Sydney, Mon–Fri Sydney, in either offset.
SELECT cron.schedule(
  'broker-ingest-a',
  '15 22,23,0 * * *',
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
  )
  WHERE to_char(now() AT TIME ZONE 'Australia/Sydney', 'HH24') = '09'
    AND extract(isodow FROM (now() AT TIME ZONE 'Australia/Sydney')) BETWEEN 1 AND 5;
  $$
);

-- 10:15am Sydney — the free retry. Covers a late send, and re-attempts anything
-- the first run could not finish, without anyone having to think about it.
SELECT cron.schedule(
  'broker-ingest-b',
  '15 22,23,0 * * *',
  $$
  SELECT net.http_post(
    url     := '<APP_URL>/api/ingest/morning',
    headers := jsonb_build_object(
                 'Authorization', 'Bearer <CRON_SECRET>',
                 'Content-Type',  'application/json'
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 58000
  )
  WHERE to_char(now() AT TIME ZONE 'Australia/Sydney', 'HH24') = '10'
    AND extract(isodow FROM (now() AT TIME ZONE 'Australia/Sydney')) BETWEEN 1 AND 5;
  $$
);

-- ----------------------------------------------------------------------------
-- Checking on it
-- ----------------------------------------------------------------------------
--   SELECT jobid, jobname, schedule, active FROM cron.job
--    WHERE jobname LIKE 'broker-ingest-%';
--
--   -- What the guard will decide, right now:
--   SELECT now() AT TIME ZONE 'Australia/Sydney'                  AS sydney_now,
--          to_char(now() AT TIME ZONE 'Australia/Sydney','HH24')  AS guard_hour,
--          extract(isodow FROM (now() AT TIME ZONE 'Australia/Sydney')) AS sydney_isodow;
--
--   -- Did it fire, and was it its turn? "1 row" = posted, "0 rows" = declined.
--   SELECT j.jobname, d.start_time, d.status, d.return_message
--     FROM cron.job_run_details d JOIN cron.job j USING (jobid)
--    WHERE j.jobname LIKE 'broker-ingest-%'
--    ORDER BY d.start_time DESC LIMIT 10;
--
--   -- Did the request come back? status_code NULL + timed_out means it did not.
--   SELECT id, status_code, timed_out, error_msg, created
--     FROM net._http_response ORDER BY created DESC LIMIT 10;
--
--   -- What the ingest itself decided. THIS is the one that matters.
--   SELECT started_at, status, messages_seen, imported, watermark, notes
--     FROM ingest_runs ORDER BY started_at DESC LIMIT 10;
--
-- To pause without deleting:
--   UPDATE cron.job SET active = false WHERE jobname LIKE 'broker-ingest-%';
