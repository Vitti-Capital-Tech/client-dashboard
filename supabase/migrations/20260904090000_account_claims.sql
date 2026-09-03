-- ============================================================================
-- Claiming an existing account by its broker account number
-- ----------------------------------------------------------------------------
-- One login, several accounts. The schema has allowed that since
-- 20260702120000_multi_account.sql — what was missing is how a person GETS
-- their second account onto their login.
--
-- ── Why a claim, and not the self-serve create we already have ──────────────
-- `createAccount` (Stage 10) opens an EMPTY account and needs no approval,
-- which is right for "I am starting an SMSF". It is the wrong instrument for
-- the case the desk actually has: the account already exists, it already holds
-- 1,650 trades, and it arrived through the broker import under its own
-- auto-created `clients` row — because the export models the entity and its
-- account as one thing (see lib/import/holdings.ts::extractAccounts). Today
-- every one of the 54 accounts sits under its own client row, 1:1.
--
-- So the operation is not "create" but "the account numbered 1102004 is also
-- mine" — a claim over existing data, which is exactly why it cannot be
-- self-serve. Approving one MOVES another client row's holdings, so it is
-- staff-verified, like a merge.
--
-- ── Why the request does not resolve the account when it is made ────────────
-- The client types a number into a box. If the request told them whether that
-- number matched anything, the box would be an oracle for "does account
-- 1101163 exist at this firm", answerable by anyone with a login and a loop.
-- So a request records the STRING and nothing else, every request is accepted
-- the same way, and resolution happens once — inside `approve_account_claim`,
-- under staff authority.
--
-- ── Why approval is an RPC and not a sequence of writes in the action ───────
-- `decideAccountMerge` does its work as sequential PostgREST calls and says so
-- in a NOTE: a production version belongs in a SECURITY DEFINER RPC. A claim is
-- the case that makes that non-optional. Re-parenting one account rewrites
-- `client_id` across EIGHT tables (positions, option_holdings, bids, trades,
-- realized_pnl, pnl_overrides, pnl_summary, pnl_runs), and a failure halfway
-- leaves the account under one client and its P&L under another — a client
-- reading someone else's figures, which is the worst outcome this schema has.
-- One function, one transaction, all or nothing.
-- ============================================================================

CREATE TYPE claim_status AS ENUM ('pending', 'approved', 'rejected');

-- ----------------------------------------------------------------------------
-- clients.merged_into — a client row that has been emptied by a claim
-- ----------------------------------------------------------------------------
-- When the last account leaves a broker-created client row, that row is left
-- behind holding nothing. It is NOT deleted:
--
--   • `audit_log.client_id` is ON DELETE SET NULL, so deleting the row would
--     quietly anonymise the history of the very operation that emptied it;
--   • `clients.external_ref` is UNIQUE and the next broker import re-creates
--     any ref it does not find, so a deleted row comes back as a fresh empty
--     client every morning;
--   • a claim approved in error is recoverable while both rows still exist.
--
-- So it is marked instead, and read as "this entity is now part of that one".
ALTER TABLE clients ADD COLUMN merged_into uuid REFERENCES clients(id) ON DELETE SET NULL;

COMMENT ON COLUMN clients.merged_into IS
  'Set when a claim moved this row''s last account to another client. The row is kept for the audit trail and for import idempotency; it owns nothing and must not be offered as a client.';

CREATE INDEX idx_clients_merged_into ON clients(merged_into) WHERE merged_into IS NOT NULL;

-- ----------------------------------------------------------------------------
-- normalise_account_number — one spelling of a number, in the DB
-- ----------------------------------------------------------------------------
-- Broker refs are digits ('1102004'), but people type '1102004 ', '1-102-004'
-- or 'A/c 1102004'. Normalising in the app alone would mean the uniqueness
-- index below and the lookup in `approve_account_claim` could disagree with it,
-- so the rule lives here, both of them are written in terms of it, and
-- lib/accounts/account-number.ts mirrors it for the form.
--
-- Non-alphanumerics are dropped rather than just whitespace, and the result is
-- upper-cased, because not every ref is numeric: 'PLACEVITT' is a real account
-- in this data set.
CREATE OR REPLACE FUNCTION public.normalise_account_number(raw text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT upper(regexp_replace(coalesce(raw, ''), '[^A-Za-z0-9]', '', 'g'))
$$;

COMMENT ON FUNCTION public.normalise_account_number(text) IS
  'The one spelling of a broker account number: alphanumerics only, upper-cased.';

-- ----------------------------------------------------------------------------
-- account_claim_requests
-- ----------------------------------------------------------------------------
CREATE TABLE account_claim_requests (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The client making the claim: the login that will own the account.
  client_id       uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,

  -- What the person typed, normalised (see `normalise_account_number`). Held as
  -- text and NOT as a FK: at request time nobody has established that it refers
  -- to anything, and a FK would answer that question by accepting or rejecting
  -- the insert.
  account_number  text NOT NULL,

  note            text,
  status          claim_status NOT NULL DEFAULT 'pending',
  requested_at    timestamptz NOT NULL DEFAULT now(),

  -- Filled by the decision. `matched_account_id` and `previous_client_id`
  -- record what an approval actually did, which is what makes it reversible;
  -- both are SET NULL rather than CASCADE so the decided row outlives them.
  matched_account_id uuid REFERENCES accounts(id) ON DELETE SET NULL,
  previous_client_id uuid REFERENCES clients(id)  ON DELETE SET NULL,
  decided_by      text,
  decided_at      timestamptz,
  decision_note   text,

  CONSTRAINT claim_number_not_blank CHECK (btrim(account_number) <> '')
);

CREATE INDEX idx_claim_requests_status ON account_claim_requests(status);
CREATE INDEX idx_claim_requests_client ON account_claim_requests(client_id);

-- One live claim per client per number.
--
-- Indexed on the NORMALISED value, not the raw column: the app normalises
-- before inserting, but an index on the raw text would only be equivalent for
-- as long as that stays true, and '1102004' vs '1-102-004' would then be two
-- live claims on one account. Expressed here, the rule holds whatever writes
-- the row.
--
-- Partial, so a rejected claim can be retried after the client sorts out
-- whatever was wrong with it, and an approved one does not block a later
-- re-claim if staff reverse one.
CREATE UNIQUE INDEX idx_claim_requests_one_pending
  ON account_claim_requests(client_id, normalise_account_number(account_number))
  WHERE status = 'pending';

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------
ALTER TABLE account_claim_requests ENABLE ROW LEVEL SECURITY;

-- A client sees only their own claims. Deliberately: seeing another client's
-- claim would reveal both that the account number exists and who wants it.
CREATE POLICY claim_select ON account_claim_requests FOR SELECT TO authenticated
  USING (is_staff() OR client_id = current_client_id());

-- A client raises claims only in their own name. The number is not checked
-- here — that is the whole point (see the header).
CREATE POLICY claim_insert ON account_claim_requests FOR INSERT TO authenticated
  WITH CHECK (client_id = current_client_id());

-- Only staff decide. A client cannot withdraw a claim by updating it either;
-- that is intentional, since a claim is a statement to the desk.
CREATE POLICY claim_decide ON account_claim_requests FOR UPDATE TO authenticated
  USING (is_staff()) WITH CHECK (is_staff());

-- ----------------------------------------------------------------------------
-- approve_account_claim — the re-parent, atomically
-- ----------------------------------------------------------------------------
-- SECURITY DEFINER because the work spans a dozen tables whose policies are
-- written for the OWNING client, and the caller is staff acting on someone
-- else's rows. `is_staff()` is therefore checked first and explicitly: a
-- definer function that forgot that check would be an open re-parent endpoint
-- for any authenticated user.
--
-- Raises rather than returning a status on every refusal, so the transaction
-- unwinds and the action layer has one thing to catch. The messages are written
-- to be shown to staff.
CREATE OR REPLACE FUNCTION public.approve_account_claim(
  p_request_id    uuid,
  p_actor         text,
  p_decision_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  req            account_claim_requests;
  acct           accounts;
  prev_client    clients;
  new_owner      clients;
  remaining      integer;
  n              integer;
  moved          jsonb;
BEGIN
  IF NOT is_staff() THEN
    RAISE EXCEPTION 'Only staff can approve an account claim';
  END IF;

  -- FOR UPDATE: two staff approving the same claim in parallel would otherwise
  -- both pass the status check and re-parent twice.
  SELECT * INTO req FROM account_claim_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Claim not found';
  END IF;
  IF req.status <> 'pending' THEN
    RAISE EXCEPTION 'This claim was already %', req.status;
  END IF;

  SELECT * INTO new_owner FROM clients WHERE id = req.client_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'The client who raised this claim no longer exists';
  END IF;
  IF new_owner.merged_into IS NOT NULL THEN
    RAISE EXCEPTION 'That client row has itself been merged away; claim on the surviving client instead';
  END IF;

  -- Resolution happens HERE and nowhere earlier — see the file header.
  --
  -- `external_ref` is UNIQUE, but NORMALISED refs need not be: '110-2004' and
  -- '1102004' are two distinct refs that both reduce to '1102004'. A plain
  -- `SELECT INTO` would silently take whichever came first and re-parent the
  -- wrong account, so an ambiguous number is refused instead of guessed.
  SELECT count(*) INTO n
    FROM accounts
   WHERE normalise_account_number(external_ref) = normalise_account_number(req.account_number);
  IF n = 0 THEN
    RAISE EXCEPTION 'No account with number % — check it against the broker record before approving', req.account_number;
  END IF;
  IF n > 1 THEN
    RAISE EXCEPTION 'Number % matches % accounts. Resolve it against the broker record by hand.', req.account_number, n;
  END IF;

  SELECT * INTO acct
    FROM accounts
   WHERE normalise_account_number(external_ref) = normalise_account_number(req.account_number)
   FOR UPDATE;

  -- Already theirs: an approval that moves nothing. Recorded as approved rather
  -- than refused, because the client's statement was true.
  IF acct.client_id = req.client_id THEN
    UPDATE account_claim_requests
       SET status = 'approved',
           matched_account_id = acct.id,
           previous_client_id = acct.client_id,
           decided_by = p_actor,
           decided_at = now(),
           decision_note = coalesce(p_decision_note, 'Already held by this client; nothing to move.')
     WHERE id = p_request_id;
    RETURN jsonb_build_object('accountId', acct.id, 'moved', false);
  END IF;

  SELECT * INTO prev_client FROM clients WHERE id = acct.client_id;

  -- ── The rail that matters ────────────────────────────────────────────────
  -- An account whose current owner has an email is an account somebody can log
  -- in and see. Moving it would take live data off one person's screen and put
  -- it on another's, on the strength of a typed number. That is a decision for
  -- a human with the broker record in front of them, through a deliberate
  -- merge, and never a side effect of approving a claim.
  IF prev_client.email IS NOT NULL THEN
    RAISE EXCEPTION
      'Account % already belongs to %, who has a login (%). Confirm the relationship and use a merge instead of a claim.',
      acct.external_ref, prev_client.display_name, prev_client.email;
  END IF;

  -- ── Re-parent: the account, then every row denormalised against it ───────
  -- All eight of these carry BOTH account_id and client_id (the denormalization
  -- is deliberate — see 20260702120000_multi_account.sql), so each is a single
  -- update keyed on the account. Missing one would leave a client reading rows
  -- that are no longer theirs, or unable to read rows that are.
  --
  -- Sequential, and atomic for free: a plpgsql function body runs inside the
  -- caller's transaction, so a failure on the seventh table unwinds the first
  -- six. The row counts are collected only to report what the approval did.
  UPDATE accounts SET client_id = req.client_id WHERE id = acct.id;

  moved := '{}'::jsonb;

  UPDATE positions       SET client_id = req.client_id WHERE account_id = acct.id;
  GET DIAGNOSTICS n = ROW_COUNT; moved := moved || jsonb_build_object('positions', n);
  UPDATE option_holdings SET client_id = req.client_id WHERE account_id = acct.id;
  GET DIAGNOSTICS n = ROW_COUNT; moved := moved || jsonb_build_object('optionHoldings', n);
  UPDATE bids            SET client_id = req.client_id WHERE account_id = acct.id;
  GET DIAGNOSTICS n = ROW_COUNT; moved := moved || jsonb_build_object('bids', n);
  UPDATE trades          SET client_id = req.client_id WHERE account_id = acct.id;
  GET DIAGNOSTICS n = ROW_COUNT; moved := moved || jsonb_build_object('trades', n);
  UPDATE realized_pnl    SET client_id = req.client_id WHERE account_id = acct.id;
  GET DIAGNOSTICS n = ROW_COUNT; moved := moved || jsonb_build_object('realizedPnl', n);
  UPDATE pnl_overrides   SET client_id = req.client_id WHERE account_id = acct.id;
  GET DIAGNOSTICS n = ROW_COUNT; moved := moved || jsonb_build_object('pnlOverrides', n);
  UPDATE pnl_summary     SET client_id = req.client_id WHERE account_id = acct.id;
  GET DIAGNOSTICS n = ROW_COUNT; moved := moved || jsonb_build_object('pnlSummary', n);
  UPDATE pnl_runs        SET client_id = req.client_id WHERE account_id = acct.id;
  GET DIAGNOSTICS n = ROW_COUNT; moved := moved || jsonb_build_object('pnlRuns', n);

  -- ── The emptied client row ───────────────────────────────────────────────
  -- `prev_client.id` rather than `acct.client_id`: `acct` is the record as it
  -- was READ, so its client_id still holds the old owner even though the table
  -- now says otherwise. Correct either way, but only one of them says so.
  SELECT count(*) INTO remaining FROM accounts WHERE client_id = prev_client.id;

  IF remaining = 0 THEN
    -- Client-scoped rows with no account dimension. The old row owned exactly
    -- one account, so there is no ambiguity about who they belong to now.
    -- `research_notes` is deliberately excluded: those are adviser-authored
    -- reference content, readable firm-wide, not the client's own data.
    UPDATE watchlist_items SET client_id = req.client_id WHERE client_id = prev_client.id;
    UPDATE alerts          SET client_id = req.client_id WHERE client_id = prev_client.id;

    UPDATE clients SET merged_into = req.client_id WHERE id = prev_client.id;
  END IF;

  UPDATE account_claim_requests
     SET status = 'approved',
         matched_account_id = acct.id,
         previous_client_id = prev_client.id,
         decided_by = p_actor,
         decided_at = now(),
         decision_note = p_decision_note
   WHERE id = p_request_id;

  INSERT INTO audit_log (actor, role, action, detail, client_id)
  VALUES (
    p_actor,
    'admin',
    'Approved account claim',
    format('Account %s (%s) moved from %s to %s',
           acct.external_ref, acct.label, prev_client.display_name, new_owner.display_name),
    req.client_id
  );

  RETURN jsonb_build_object(
    'accountId',       acct.id,
    'accountLabel',    acct.label,
    'accountNumber',   acct.external_ref,
    'moved',           true,
    'previousClient',  prev_client.display_name,
    'retiredPrevious', remaining = 0,
    'rows',            moved
  );
END
$$;

COMMENT ON FUNCTION public.approve_account_claim(uuid, text, text) IS
  'Staff-only. Moves the claimed account and every row denormalised against it to the claiming client, in one transaction.';

-- `authenticated` may call it; `is_staff()` inside is what actually authorises.
REVOKE ALL ON FUNCTION public.approve_account_claim(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_account_claim(uuid, text, text) TO authenticated;

-- ----------------------------------------------------------------------------
-- Checking on it
-- ----------------------------------------------------------------------------
--   -- Accounts still 1:1 with a client row (i.e. never claimed):
--   SELECT c.display_name, count(a.id)
--     FROM clients c LEFT JOIN accounts a ON a.client_id = c.id
--    WHERE c.merged_into IS NULL
--    GROUP BY 1 HAVING count(a.id) > 1;
--
--   -- A client_id that disagrees with its account's owner (should be none):
--   SELECT 'positions' AS t, count(*) FROM positions p
--     JOIN accounts a ON a.id = p.account_id WHERE p.client_id <> a.client_id
--   UNION ALL SELECT 'trades', count(*) FROM trades p
--     JOIN accounts a ON a.id = p.account_id WHERE p.client_id <> a.client_id
--   UNION ALL SELECT 'pnl_summary', count(*) FROM pnl_summary p
--     JOIN accounts a ON a.id = p.account_id WHERE p.client_id <> a.client_id;
