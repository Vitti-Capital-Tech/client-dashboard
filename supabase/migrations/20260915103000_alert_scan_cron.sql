-- ============================================================================
-- The options alert scan, at 10:30am Sydney, every day.
-- ----------------------------------------------------------------------------
-- Same DST net as `…_ingest_cron_sydney_morning.sql`, and for the same reason:
-- pg_cron speaks UTC, Sydney does not have a fixed offset, and 10:30 Sydney is
-- 23:30 UTC the previous day in AEST and 23:30 two hours earlier in AEDT. So
-- the schedule fires on every UTC hour that could be the wanted Sydney hour and
-- a WHERE clause lets exactly one through. Read that file's header for the full
-- argument; this one only notes where it differs.
--
-- ── Why 10:30 ───────────────────────────────────────────────────────────────
-- Two things have to have happened first.
--
--   1. The morning ingest (9:15, retry 10:15) must have refreshed the holdings
--      snapshot and `securities.last_price`. The scan reads prices from that
--      column, deliberately — an alert has to quote the same figure the client
--      will see on their Options tab, and a second price source is a second
--      answer.
--   2. The ASX must have opened (10:00), so the price is struck today rather
--      than being yesterday's close.
--
-- 10:30 clears both, and leaves the 10:15 retry room to finish.
--
-- ── Why EVERY day, and not Mon-Fri ──────────────────────────────────────────
-- The ingest guard says `isodow BETWEEN 1 AND 5` because there is no broker
-- mail on a weekend. This job has no such precondition: an expiry ladder
-- crossing is a CALENDAR event. A grant entering its 7-day window on a Saturday
-- should reach the client that morning and be waiting on Monday, rather than
-- being reported two days closer to lapsing.
--
-- A weekend run is nearly free. Prices have not moved, so no moneyness crossing
-- is found, and every expiry alert it would emit was already emitted — the
-- unique index on (client_id, alert_key) swallows them and the run inserts
-- nothing. Which is the same property that makes the three-tick net safe.
--
-- ── Before running this ─────────────────────────────────────────────────────
-- Replace <APP_URL> and <CRON_SECRET> in the SQL editor. Placeholders on
-- purpose: this file is committed, and a secret in git history is far harder to
-- rotate than one pasted into a query.
-- ============================================================================

SELECT cron.unschedule('alert-scan') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'alert-scan'
);

-- 10:30am Sydney, every day, in either offset.
SELECT cron.schedule(
  'alert-scan',
  '30 23,0,1 * * *',
  $$
  SELECT net.http_post(
    url     := '<APP_URL>/api/alerts/scan',
    headers := jsonb_build_object(
                 'Authorization', 'Bearer <CRON_SECRET>',
                 'Content-Type',  'application/json'
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 58000
  )
  WHERE to_char(now() AT TIME ZONE 'Australia/Sydney', 'HH24') = '10';
  $$
);

-- ----------------------------------------------------------------------------
-- Checking on it
-- ----------------------------------------------------------------------------
--   SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = 'alert-scan';
--
--   -- What the guard will decide, right now:
--   SELECT now() AT TIME ZONE 'Australia/Sydney'                 AS sydney_now,
--          to_char(now() AT TIME ZONE 'Australia/Sydney','HH24') AS guard_hour;
--
--   -- Did it fire, and was it its turn? "1 row" = posted, "0 rows" = declined.
--   SELECT j.jobname, d.start_time, d.status, d.return_message
--     FROM cron.job_run_details d JOIN cron.job j USING (jobid)
--    WHERE j.jobname = 'alert-scan' ORDER BY d.start_time DESC LIMIT 10;
--
--   -- What the scan actually did. `produced` well above `inserted` is normal
--   -- and healthy: it means the events were already reported. `inserted`
--   -- suddenly in the hundreds means the keys have stopped being stable.
--   SELECT id, status_code, content FROM net._http_response
--    ORDER BY created DESC LIMIT 5;
--
--   -- The alerts themselves:
--   SELECT triggered_at, kind, severity, title, alert_key
--     FROM alerts WHERE alert_key IS NOT NULL
--    ORDER BY triggered_at DESC LIMIT 20;
--
-- To run it once, by hand, right now (any hour — this bypasses the guard):
--   SELECT net.http_post(
--     url := '<APP_URL>/api/alerts/scan',
--     headers := jsonb_build_object('Authorization','Bearer <CRON_SECRET>',
--                                   'Content-Type','application/json'),
--     body := '{}'::jsonb);
--
-- To pause without deleting:
--   UPDATE cron.job SET active = false WHERE jobname = 'alert-scan';
