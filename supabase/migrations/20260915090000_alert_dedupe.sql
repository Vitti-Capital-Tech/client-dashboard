-- ---------------------------------------------------------------------------
-- Alerts that a scanner can write without repeating itself.
--
-- The alerts table has only ever been written by hand — `addCustomAlert` is the
-- single INSERT in the codebase, and the row it writes is a confirmation that a
-- threshold was saved, not a triggered alert. Nothing has ever generated one.
--
-- A scanner changes that, and introduces the problem a scanner always has:
-- conditions are durable, alerts are events. "MRD is in the money" stays true
-- for months. A job that inserts a row whenever the condition holds produces a
-- hundred identical alerts, and a bell carrying a hundred alerts is a bell
-- nobody reads — which loses the one alert that mattered.
--
-- `alert_key` is the fix. It identifies the EVENT rather than the condition:
--
--   expiry:<option_id>:14    crossing into the 14-day window, once, ever
--   itm:<option_id>:<spell>  crossing OTM → ITM, not each day it stays there
--   window:<option_id>:7     unlisted + exercisable + 7 days left
--
-- With the unique index below and ON CONFLICT DO NOTHING, the scan becomes
-- idempotent: run it once an hour or twenty times an hour and it stays silent
-- after the first. That is the same property the morning ingest gets from its
-- attachment dedupe, and it is what makes a cron net (rather than a cron time)
-- safe to schedule.
-- ---------------------------------------------------------------------------

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS alert_key text;

COMMENT ON COLUMN alerts.alert_key IS
  'Stable identity of the EVENT this alert reports, for scanner dedupe. NULL for hand-written alerts (addCustomAlert), which are one-per-action already.';

-- Partial, because hand-written alerts have no key and must not collide: two
-- clients creating a custom alert on the same code are two genuine rows, and a
-- NOT NULL default would have forced a fake key on both.
CREATE UNIQUE INDEX IF NOT EXISTS alerts_client_key_uniq
  ON alerts (client_id, alert_key)
  WHERE alert_key IS NOT NULL;

-- The scan reads "which of this client's alerts already exist" on every run,
-- and the unread badge reads unacknowledged rows on every page load.
CREATE INDEX IF NOT EXISTS alerts_client_unack_idx
  ON alerts (client_id, acknowledged, triggered_at DESC);
