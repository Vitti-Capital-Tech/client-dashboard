-- ============================================================================
-- Held units are their own quantity, not a sale
-- ----------------------------------------------------------------------------
-- `mergeDbHoldingsIntoSummary` used to fold the holdings snapshot's units into
-- `sell_qty`. A client who bought 500 and then another 2,000 holds 2,500 and
-- has sold NOTHING — and the P&L reported:
--
--     Buy Qty 2,500 | Sell Qty 2,500 | Status: Matched
--
-- A completed round trip, on a parcel the client still owns. The same fold ran
-- on a part-sale: 2,500 bought, 500 sold, 2,000 held came out as 2,500 sold.
--
-- ── What the fold was FOR, and how it is kept ────────────────────────────────
-- It was not careless. Folding held units into the sell side gave two derived
-- figures their meaning:
--
--     open_qty   units the ledger claims that NOTHING accounts for — not
--                simply "not sold". Where the snapshot disagrees with the
--                ledger's gap, what is left over is the disagreement, and that
--                is the number the Mismatches page exists to show.
--     is_matched every unit is accounted for, by a sale or by a holding.
--
-- Both are kept exactly as they were, restated on an honest sell side:
--
--     open_qty   = buy_qty - sell_qty - held_qty
--     is_matched = buy_qty = sell_qty + held_qty  (and buy_qty > 0)
--
-- So nothing downstream loses a meaning; the sell quantity simply stops
-- carrying two of them at once.
--
-- `sell_price` is a different matter and is UNTOUCHED: that column is shown as
-- `Sell Price / Current Price` and is meant to carry proceeds or market value.
-- No P&L figure moves in this migration.
--
-- ── Why `pnl_overrides` gets one too ─────────────────────────────────────────
-- The desk's `Mark Open` writes an override saying "this parcel is held". Under
-- the old model it said so by setting both quantities equal — the very shape
-- being removed here. It needs a leg that means HELD, or the assertion cannot
-- be written down at all where it matters most: a position the snapshot has not
-- caught up with, which is exactly when a human overrides it.
-- ============================================================================

ALTER TABLE pnl_summary
  ADD COLUMN IF NOT EXISTS held_qty numeric(20,4) NOT NULL DEFAULT 0;

COMMENT ON COLUMN pnl_summary.held_qty IS
  'Units the holdings snapshot says are still held. A row reconciles when '
  'buy_qty = sell_qty + held_qty; open_qty is what neither accounts for.';

ALTER TABLE pnl_overrides
  ADD COLUMN IF NOT EXISTS held_qty numeric(20,4);

COMMENT ON COLUMN pnl_overrides.held_qty IS
  'Desk correction to held units. NULL means "keep the computed value", like '
  'every other column here — it is a patch to the derivation, not a replacement.';
