-- ============================================================================
-- P&L overrides (Stage 12) — desk corrections to a derived summary row
-- ----------------------------------------------------------------------------
-- The P&L-by-company table is computed, not stored: quantities and the cost of
-- sold units come from the `trades` ledger, the held side from the `positions`
-- snapshot. When a source is incomplete the computed row is wrong, and no
-- amount of re-importing fixes it — the data simply is not in the export.
-- (Real case: EUR shows 115,385 units sold against zero cost, because the
-- ledger starts after they were bought.)
--
-- This table lets staff correct the four INPUTS of such a row. P&L itself is
-- never stored: it stays `sell − buy`, recomputed from whichever values are in
-- force. Each column is nullable and null means "keep the computed value", so
-- an override is a patch over the derivation, not a replacement of it — clear
-- one field and that field goes back to tracking the ledger.
--
-- Grain matches `realized_pnl`: one row per account × parent (ordinary) code.
-- ============================================================================

CREATE TABLE pnl_overrides (
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  client_id    uuid NOT NULL REFERENCES clients(id)  ON DELETE CASCADE,
  parent_code  text NOT NULL REFERENCES securities(code),

  -- All four are NULLABLE. NULL = fall through to the computed value.
  buy_qty      numeric(20,4) CHECK (buy_qty   IS NULL OR buy_qty   >= 0),
  sell_qty     numeric(20,4) CHECK (sell_qty  IS NULL OR sell_qty  >= 0),
  buy_price    numeric(18,2) CHECK (buy_price IS NULL OR buy_price >= 0),
  sell_price   numeric(18,2) CHECK (sell_price IS NULL OR sell_price >= 0),

  -- Why the correction was made. A financial figure that disagrees with its
  -- source should never be anonymous.
  note         text,
  updated_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  -- A row that overrides nothing is noise; the server action deletes instead.
  CONSTRAINT pnl_overrides_not_empty CHECK (
    buy_qty IS NOT NULL OR sell_qty IS NOT NULL
    OR buy_price IS NOT NULL OR sell_price IS NOT NULL
  ),

  PRIMARY KEY (account_id, parent_code)
);

CREATE INDEX idx_pnl_overrides_client ON pnl_overrides(client_id);

CREATE TRIGGER trg_pnl_overrides_updated BEFORE UPDATE ON pnl_overrides
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- RLS — mirrors positions/trades: a client reads only their own rows, staff
-- read all, and only staff may write. A client must never be able to author
-- their own P&L.
-- ----------------------------------------------------------------------------
ALTER TABLE pnl_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY pnl_overrides_select ON pnl_overrides FOR SELECT TO authenticated
  USING (is_staff() OR client_id = current_client_id());
CREATE POLICY pnl_overrides_write ON pnl_overrides FOR ALL TO authenticated
  USING (is_staff()) WITH CHECK (is_staff());
