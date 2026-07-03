-- ============================================================================
-- Account lifecycle (Stage 10) — client self-service create + approved merge
-- ----------------------------------------------------------------------------
-- 1. A client can OPEN a new account themselves (no approval).
-- 2. A client can REQUEST merging one of their accounts into another; the merge
--    only executes after STAFF approval. Requests live in account_merge_requests
--    and are actioned by app/actions/accounts.ts::decideAccountMerge.
-- ============================================================================

CREATE TYPE merge_status AS ENUM ('pending', 'approved', 'rejected');

-- ----------------------------------------------------------------------------
-- account_merge_requests — a client asks to merge source → target; staff decide.
-- source/target FKs are ON DELETE SET NULL so an approved row survives after the
-- source account is deleted; source_label/target_label snapshot the names so the
-- history stays readable regardless.
-- ----------------------------------------------------------------------------
CREATE TABLE account_merge_requests (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id          uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  source_account_id  uuid REFERENCES accounts(id) ON DELETE SET NULL,
  target_account_id  uuid REFERENCES accounts(id) ON DELETE SET NULL,
  source_label       text NOT NULL,
  target_label       text NOT NULL,
  note               text,
  status             merge_status NOT NULL DEFAULT 'pending',
  requested_at       timestamptz NOT NULL DEFAULT now(),
  decided_by         text,
  decided_at         timestamptz,
  CONSTRAINT merge_distinct_accounts CHECK (source_account_id IS DISTINCT FROM target_account_id)
);
CREATE INDEX idx_merge_requests_status ON account_merge_requests(status);
CREATE INDEX idx_merge_requests_client ON account_merge_requests(client_id);

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------

-- Clients may now INSERT their own accounts (self-service create). Staff writes
-- (update/delete, incl. the merge) stay covered by the existing accounts_write
-- policy from 20260702120000_multi_account.sql.
CREATE POLICY accounts_insert_own ON accounts FOR INSERT TO authenticated
  WITH CHECK (client_id = current_client_id());

ALTER TABLE account_merge_requests ENABLE ROW LEVEL SECURITY;
-- A client sees/creates only their own requests; staff see and decide all.
CREATE POLICY merge_select ON account_merge_requests FOR SELECT TO authenticated
  USING (is_staff() OR client_id = current_client_id());
CREATE POLICY merge_insert ON account_merge_requests FOR INSERT TO authenticated
  WITH CHECK (client_id = current_client_id());
CREATE POLICY merge_decide ON account_merge_requests FOR UPDATE TO authenticated
  USING (is_staff()) WITH CHECK (is_staff());
