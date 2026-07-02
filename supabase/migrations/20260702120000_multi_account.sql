-- ============================================================================
-- Multi-account model (Stage 9)
-- ----------------------------------------------------------------------------
-- One client (person/login) can now hold MULTIPLE investment accounts
-- (e.g. Personal, SMSF, Family Trust). Holdings become account-scoped:
--   positions / option_holdings / bids gain an `account_id`, and cash +
--   account_type + s708_expiry move onto the account.
--
-- Deliberate denormalization: holdings KEEP `client_id` (the owning person,
-- which never changes) alongside the new `account_id`. RLS therefore stays
-- client-level and unchanged (a client owns all their accounts, so "sees only
-- their own rows" is already correct); the account dimension is a view filter,
-- not a security boundary.
--
-- `account_id` ships nullable and is repopulated by supabase/seed.sql; a later
-- migration can SET NOT NULL once all rows carry one.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- accounts — replaces the 1:1 client_accounts; absorbs account_type/s708_expiry
-- (previously on clients) and cash (previously on client_accounts).
-- ----------------------------------------------------------------------------
CREATE TABLE accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref           text UNIQUE,                       -- legacy-style id, e.g. 'A1'
  client_id     uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  label         text        NOT NULL,              -- 'Personal', 'SMSF', 'Family Trust'
  account_type  text        NOT NULL,              -- 'Individual · wholesale', 'SMSF · wholesale'…
  s708_expiry   date,                              -- wholesale certificate expiry (per account)
  cash_balance  numeric(18,2) NOT NULL DEFAULT 0,
  currency      char(3)       NOT NULL DEFAULT 'AUD',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_accounts_client ON accounts(client_id);
CREATE TRIGGER trg_accounts_updated BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Account attributes no longer live on the person.
ALTER TABLE clients DROP COLUMN IF EXISTS account_type;
ALTER TABLE clients DROP COLUMN IF EXISTS s708_expiry;

-- Cash is now an account attribute; drop the old 1:1 cash table.
DROP TABLE IF EXISTS client_accounts;

-- ----------------------------------------------------------------------------
-- Holdings gain account_id (kept alongside client_id). Uniqueness moves to the
-- account grain so the same security can be held in two accounts of one client.
-- ----------------------------------------------------------------------------
ALTER TABLE positions ADD COLUMN account_id uuid REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_client_id_security_code_key;
ALTER TABLE positions ADD CONSTRAINT positions_account_id_security_code_key UNIQUE (account_id, security_code);
CREATE INDEX idx_positions_account ON positions(account_id);

ALTER TABLE option_holdings ADD COLUMN account_id uuid REFERENCES accounts(id) ON DELETE CASCADE;
CREATE INDEX idx_options_account ON option_holdings(account_id);

ALTER TABLE bids ADD COLUMN account_id uuid REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE bids DROP CONSTRAINT IF EXISTS bids_placement_id_client_id_key;
ALTER TABLE bids ADD CONSTRAINT bids_placement_id_account_id_key UNIQUE (placement_id, account_id);
CREATE INDEX idx_bids_account ON bids(account_id);

-- ----------------------------------------------------------------------------
-- RLS — only the accounts table changes (client_accounts' policy dropped with
-- the table). Holdings/bids/watchlist/alerts/audit policies are unchanged: they
-- remain client_id-based (see 20260702090000_enable_rls.sql).
-- ----------------------------------------------------------------------------
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY accounts_select ON accounts FOR SELECT TO authenticated
  USING (is_staff() OR client_id = current_client_id());
CREATE POLICY accounts_write ON accounts FOR ALL TO authenticated
  USING (is_staff()) WITH CHECK (is_staff());
