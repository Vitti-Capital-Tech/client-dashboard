-- ---------------------------------------------------------------------------
-- Correction to `…_alert_dedupe.sql`: the dedupe index must not be partial.
--
-- That migration created:
--
--     CREATE UNIQUE INDEX alerts_client_key_uniq ON alerts (client_id, alert_key)
--       WHERE alert_key IS NOT NULL;
--
-- The predicate was there for a real reason — hand-written alerts
-- (`addCustomAlert`) carry no key, and two clients creating a custom alert on
-- the same code must both be allowed. But it makes the index unusable as an
-- ON CONFLICT target. Postgres can only infer a PARTIAL index if the statement
-- repeats its predicate:
--
--     ON CONFLICT (client_id, alert_key) WHERE alert_key IS NOT NULL
--
-- and PostgREST's `on_conflict` parameter takes column names only — it emits
-- the bare form, which matches no index and fails with "there is no unique or
-- exclusion constraint matching the ON CONFLICT specification". The scanner's
-- entire idempotence rests on that upsert, so it would have failed on its first
-- run against a database that already held one of its alerts.
--
-- The predicate turns out to be unnecessary. In a unique index Postgres treats
-- NULLs as DISTINCT by default, so a plain UNIQUE (client_id, alert_key)
-- already permits any number of rows with a NULL key for one client — exactly
-- what the WHERE clause was written to protect, obtained for free.
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS alerts_client_key_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS alerts_client_key_uniq
  ON alerts (client_id, alert_key);

COMMENT ON INDEX alerts_client_key_uniq IS
  'Scanner dedupe: one row per (client, event). NULL keys are distinct under the default NULLS DISTINCT, so hand-written alerts are unconstrained.';
