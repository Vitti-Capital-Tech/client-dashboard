-- ============================================================================
-- The intraday tick: every 10 minutes, all day, with the job itself deciding
-- whether the market is open.
-- ----------------------------------------------------------------------------
-- `…_alert_scan_cron.sql` and `…_ingest_cron_sydney_morning.sql` both guard on
-- the Sydney HOUR inside the cron command, because they want to fire once a day
-- at a particular local time and pg_cron speaks UTC.
--
-- This job wants something different — "whenever the ASX is trading" — and that
-- is not a set of hours. It is 10:00 to ~16:11 Sydney, on weekdays, excluding
-- eight exchange holidays a year, ending at 14:10 on the two half days, in an
-- offset that changes twice a year. Written as a cron expression and a SQL
-- guard, that would be a second implementation of the trading calendar, in a
-- language with no tests, drifting away from `lib/asx/session.ts`.
--
-- So the schedule is deliberately blunt: every ten minutes, always. The guard
-- lives in the application, where the calendar already lives and is tested —
-- `runLiveTick` asks `asxSession()` and returns `skipped: true` without
-- touching Yahoo or the database when the answer is no.
--
-- The cost of that choice is ~100 no-op HTTP requests a day. The benefit is one
-- trading calendar in the codebase rather than two, and a job that is already
-- correct on Good Friday and on Christmas Eve's 14:10 close.
--
-- ── What a run does ─────────────────────────────────────────────────────────
--   1. quotes every code a client holds (one batched Yahoo request)
--   2. writes changed prices to `securities.last_price` — so the Options tab
--      and the alert compute moneyness from the SAME number
--   3. alerts on material moves in held positions
--   4. re-runs the option scan against those fresh prices
--
-- Safe to repeat: every alert carries a key naming its event and the unique
-- index swallows a second copy, so the 40th tick of the day inserts nothing new.
--
-- ── Before running this ─────────────────────────────────────────────────────
-- Replace <APP_URL> and <CRON_SECRET> in the SQL editor. Placeholders on
-- purpose: this file is committed.
-- ============================================================================

SELECT cron.unschedule('alert-live-tick') WHERE EXISTS (
  SELECT 1 FROM cron.job WHERE jobname = 'alert-live-tick'
);

SELECT cron.schedule(
  'alert-live-tick',
  '*/10 * * * *',
  $$
  SELECT net.http_post(
    url     := '<APP_URL>/api/alerts/live',
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
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname = 'alert-live-tick';
--
--   -- The last few ticks. Outside market hours expect {"skipped":true}.
--   SELECT id, status_code, content FROM net._http_response
--    ORDER BY created DESC LIMIT 10;
--
--   -- Prices actually moving during a session:
--   SELECT code, last_price, updated_at FROM securities
--    ORDER BY updated_at DESC LIMIT 20;
--
--   -- What it has raised today:
--   SELECT triggered_at, kind, severity, title, alert_key
--     FROM alerts
--    WHERE alert_key IS NOT NULL
--      AND triggered_at > (now() - interval '1 day')
--    ORDER BY triggered_at DESC;
--
-- To run one tick by hand, right now:
--   SELECT net.http_post(
--     url := '<APP_URL>/api/alerts/live',
--     headers := jsonb_build_object('Authorization','Bearer <CRON_SECRET>',
--                                   'Content-Type','application/json'),
--     body := '{}'::jsonb);
--
-- Tuning the alert thresholds does NOT happen here — they are constants at the
-- top of `lib/alerts/moves.ts` (MOVE_BUCKETS, MIN_MATERIAL_VALUE,
-- DAILY_MOVE_BUDGET), so they are reviewed and tested with the rules they
-- belong to rather than buried in a schedule.
--
-- To pause without deleting:
--   UPDATE cron.job SET active = false WHERE jobname = 'alert-live-tick';
