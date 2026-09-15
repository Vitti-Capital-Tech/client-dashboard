-- ---------------------------------------------------------------------------
-- Hysteresis for the in-the-money alert.
--
-- The first production run raised this, correctly by its own rules and useless
-- in practice:
--
--     OD6-UO is in the money · underlying $0.11 vs strike $0.10
--
-- One cent above the strike, on a stock whose ordinary day is one cent, with
-- 345 days still to run. It would have crossed out and back in within the week,
-- and each crossing is a genuinely new spell — so the client would have
-- collected the same alert five times a fortnight about a grant that had not
-- really done anything, and the red exercise-window alerts would have been
-- buried underneath.
--
-- A single threshold cannot fix this. Whatever line is drawn, a price sitting
-- on it oscillates across it. Two thresholds can: report when the grant is 5%
-- in the money, and do not report again until it has fallen back BELOW the
-- strike. The gap between the two is silent by construction.
--
-- That needs one more piece of memory than `moneyness` carries. "Is it in the
-- money" is a fact about today; "have we already told them about this spell" is
-- not derivable from it, because a grant at +2% could be either a spell we have
-- reported that has drifted down, or one we have not reported that is drifting
-- up. `in_spell` is the difference.
--
-- Defaults to false, which means every grant starts un-armed and the first
-- qualifying crossing is reported. Existing rows are from runs that used the
-- old rule, so re-arming them all is the correct migration: anything genuinely
-- 5% in the money will be reported once more, and nothing will be missed.
-- ---------------------------------------------------------------------------

ALTER TABLE alert_scan_state
  ADD COLUMN IF NOT EXISTS in_spell boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN alert_scan_state.in_spell IS
  'Inside a reported in-the-money spell. Set when an ITM alert fires at +5% of strike; cleared only when the grant falls back below the strike. The gap is the hysteresis that stops a grant near its strike from chattering.';
