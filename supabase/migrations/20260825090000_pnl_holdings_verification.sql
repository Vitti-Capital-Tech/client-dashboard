-- ============================================================================
-- Verify a stored P&L row against the holdings snapshot
-- ----------------------------------------------------------------------------
-- `pnl_summary` already records where each side of a row came from. What it
-- could not record was an ABSENCE: the snapshot was consulted and carries no
-- parcel for this ticker.
--
-- Without that, `open_qty > 0` was the only evidence the status cell had, and
-- it was read as "still held". It is not. A row with 10,000 bought and 4,000
-- sold has an open quantity of 6,000 whether or not anybody holds those units —
-- and where the client's holdings show nothing, they do not. The 6,000 was
-- sold; the SELL contract notes simply never reached the ledger. Reported as
-- "Open", that row put a position on the client's P&L they had already
-- disposed of, and hid the missing transactions behind it.
--
-- ── Why a stored flag and not a read-time join ───────────────────────────────
-- The same reason every other provenance flag on this table is stored: the
-- recompute is the only place that holds the snapshot, the ledger and the
-- placement enrichment at once, and the registers that read these rows across
-- ALL clients (Mismatches, Options) never load positions at all. One writer,
-- every reader.
--
-- ── Reading it ───────────────────────────────────────────────────────────────
-- TRUE means "checked, and the snapshot holds nothing for this row".
-- FALSE means EITHER the snapshot backs the row OR no snapshot was consulted.
-- The asymmetry is deliberate: an unverified row must never be reported as
-- disposed of, so only a positive check can change what the status says.
-- Existing rows therefore default to FALSE and keep their current wording until
-- their account is recomputed.
-- ============================================================================

ALTER TABLE pnl_summary
  ADD COLUMN IF NOT EXISTS not_in_holdings boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN pnl_summary.not_in_holdings IS
  'The holdings snapshot was checked against this row and holds nothing for it. '
  'False also covers "no snapshot was consulted" — only a positive check may '
  'move a row from Open to Closed.';
