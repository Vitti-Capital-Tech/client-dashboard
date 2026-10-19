-- ============================================================================
-- placement_candidates.tracker_claimed_at — one run per deal at a time
-- ============================================================================
-- The tracker queue assumed two runs could never write the same deal at once.
-- The mail webhook breaks that: Graph routinely sends more than one notification
-- for one message, and every notification starts its own ingest. On 14 October
-- 2026 two runs took MCO together — the first created `MCO` and wrote its terms
-- and was killed before its Overview row, the second found that tab, read it as
-- somebody else's, and filed `MCO (b)`: a repeat placement that never happened.
--
-- A run now claims a deal before touching the workbook, with a conditional
-- UPDATE that only one caller can win. The claim expires, so a run killed while
-- holding it does not hold the deal forever — the next run after the expiry
-- simply takes it. Settling the deal (written or failed) releases it.
--
-- ── Apply this BEFORE deploying the code that reads it ───────────────────────
-- Until it lands the claim fails loudly and the tracker write is blocked for the
-- run, rather than racing silently.
-- ============================================================================

ALTER TABLE placement_candidates
  ADD COLUMN IF NOT EXISTS tracker_claimed_at timestamptz;

COMMENT ON COLUMN placement_candidates.tracker_claimed_at IS
  'When a run claimed this deal to write its tracker tab. A claim older than a few minutes is stale and may be taken over; settling the deal clears it.';
