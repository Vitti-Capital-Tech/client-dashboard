-- ============================================================================
-- Ledger for the manual-settlement watch: one row per ASX announcement mailed.
-- ----------------------------------------------------------------------------
-- The watch runs hourly (from the alert-live-tick job) and sees the same
-- "Proposed issue of securities" on every run for six months. The primary key
-- on the ASX document key (`idsId`) is what makes it mail once: the run claims the key with
-- ON CONFLICT DO NOTHING before sending, and deletes the claim if the send
-- fails so the next run retries.
--
-- Service-role only. RLS on with no policies: no screen reads this.
-- ============================================================================

CREATE TABLE IF NOT EXISTS manual_settlement_alerts (
  document_key    text PRIMARY KEY,
  ticker          text NOT NULL,
  settlement_date date NOT NULL,
  headline        text NOT NULL,
  released_on     date NOT NULL,
  url             text NOT NULL,
  sent_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE manual_settlement_alerts IS
  'ASX "Proposed issue of securities" announcements already mailed for Overview rows with Settlement Type = Manual. Keyed on the ASX document key so each is mailed once.';

ALTER TABLE manual_settlement_alerts ENABLE ROW LEVEL SECURITY;
