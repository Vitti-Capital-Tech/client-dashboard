-- ============================================================================
-- Widen trades.brokerage_pct — the broker's own percentage can be absurd
-- ----------------------------------------------------------------------------
-- `numeric(8,4)` assumed a brokerage rate, which is normally well under 1% and
-- never remotely near 9999%. But the column stores the broker's Brokerage %
-- verbatim, and the broker computes it as brokerage / consideration with no
-- guard: a $100 fee against a $0.03 consideration exports as 333333.3333.
--
-- (Real case: cnote 2403748, NHE, 0 units / $0.03 consideration / $100.00
-- brokerage. It is a CANCELLED row, so it never reaches the P&L reducer — but
-- cancelled trades are still stored verbatim for the audit trail, so the whole
-- import aborted with "numeric field overflow" on a row that does not even
-- affect a figure.)
--
-- The ratio is unbounded by construction, so widening is the fix rather than
-- clamping in the parser: the column is an audit copy of what the broker said,
-- and nothing in the app reads it for math. numeric(18,4) matches the money
-- columns' precision and ends the class of failure instead of raising the wall.
-- ============================================================================

ALTER TABLE trades ALTER COLUMN brokerage_pct TYPE numeric(18,4);

COMMENT ON COLUMN trades.brokerage_pct IS
  'Broker''s Brokerage % verbatim. Unbounded by construction — it is '
  'brokerage / consideration, so a near-zero consideration yields a huge '
  'percentage. Audit copy only; never used in P&L math (see `value`).';
