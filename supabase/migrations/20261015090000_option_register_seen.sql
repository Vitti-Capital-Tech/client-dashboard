-- ============================================================================
-- Memory for the new-option watch: every option the register has ever shown.
-- ----------------------------------------------------------------------------
-- `pnl_summary` is deleted and rewritten by every P&L recompute, so nothing on
-- it says when an option first appeared. This table does: one row per register
-- key (`pnl-<account_id>:<ticker>`, the id `optionsFromSources` gives a row),
-- inserted with ON CONFLICT DO NOTHING the first time the key is seen. The rows
-- that insert actually writes are the new options, and those are mailed.
--
-- The first run finds this table empty and records the whole register as the
-- baseline without mailing. A key is claimed before the mail is sent and
-- deleted again if the send fails, so the next run retries.
--
-- Service-role only. RLS on with no policies: no screen reads this.
-- ============================================================================

CREATE TABLE IF NOT EXISTS option_register_seen (
  option_key    text PRIMARY KEY,
  account_id    uuid,
  ticker        text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE option_register_seen IS
  'Every options-register key (pnl-<account>:<ticker>) ever seen, with when. The new-option watch mails the keys that are inserted here for the first time.';

ALTER TABLE option_register_seen ENABLE ROW LEVEL SECURITY;
