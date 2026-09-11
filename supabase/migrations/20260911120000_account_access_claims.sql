-- ============================================================================
-- A claim can now GRANT ACCESS instead of moving the account
-- ----------------------------------------------------------------------------
-- `approve_account_claim` had exactly one outcome: re-parent the account to the
-- claiming client. That is right when the account's current owner is a
-- broker-import stub with no login — the 54 rows that arrived 1:1 with an
-- account number, which nobody can sign in as.
--
-- It is wrong, and was refused outright, when the owner CAN sign in:
--
--   'Account 1102004 already belongs to …, who has a login (…).
--    Confirm the relationship and use a merge instead of a claim.'
--
-- The refusal was correct about the danger and wrong about the remedy. Moving
-- the account would take live data off one person's screen to put it on
-- another's — but the desk was never asking for that. The case is a wife
-- registering and naming her husband's account, an incoming SMSF trustee, an
-- accountant onboarded by the client's office. In every one of them BOTH people
-- should end up able to see it, and the account should not move at all.
--
-- There was no way to express that until 20260911090000_client_emails.sql,
-- because a client was an email address and two of them could not reach one
-- portfolio. Now they can, so the refusal becomes a second outcome:
--
--   owner has NO login  → move the account         (unchanged, `moved`)
--   owner HAS a login   → move the CLAIMANT to them (`joined`)
--
-- ── Why the claimant joins the owner, and not the reverse ──────────────────
-- The direction is the whole point. The account, its trades, its P&L and its
-- history stay exactly where they are, under the client row that has always
-- held them; what moves is the new person's login. Re-parenting the account to
-- the claimant and then adding the old owner as a second login would reach the
-- same access, through a re-parent of eight tables that nobody asked for, and
-- would silently make the newcomer the client of record.
--
-- So the claimant's `clients` row is retired the same way an emptied broker
-- stub is — `merged_into`, never deleted, for the reasons the original claim
-- migration gives.
--
-- ── Why the outcome is decided at approval and not at request ──────────────
-- Whether the owner has a login is a fact about the moment of approval, not of
-- the request: a stub can be linked (`npm run client:login`) in between. The
-- function reads it where the `FOR UPDATE` lock already is. `preview_account_claim`
-- below lets the queue SHOW the desk which outcome a Verify button will produce,
-- so it is a decision they make rather than one they discover.
-- ============================================================================

CREATE TYPE claim_outcome AS ENUM ('moved', 'joined');

-- Nullable: every claim decided before this migration has no recorded outcome,
-- and back-filling them as 'moved' would be inventing a fact. An approved claim
-- with a NULL outcome is simply one decided under the old single-outcome rule.
ALTER TABLE account_claim_requests ADD COLUMN outcome claim_outcome;

COMMENT ON COLUMN account_claim_requests.outcome IS
  'What an approval actually did: moved the account to the claimant, or joined the claimant''s login to the owner. NULL for claims decided before both outcomes existed.';

-- ----------------------------------------------------------------------------
-- client_has_login — one reading of "somebody can sign in as this client"
-- ----------------------------------------------------------------------------
-- Both functions below branch on it, and `clients.email IS NOT NULL` is the
-- same question asked of the mirror rather than of the table that owns the
-- answer. Written once so the preview and the approval cannot disagree — a
-- preview that promised `joined` and an approval that then moved an account
-- would be the worst possible bug in this file.
CREATE OR REPLACE FUNCTION public.client_has_login(p_client uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM public.client_emails WHERE client_id = p_client)
$$;

COMMENT ON FUNCTION public.client_has_login(uuid) IS
  'Whether any address can sign in as this client. The one reading of that question, shared by preview_account_claim and approve_account_claim.';

REVOKE ALL ON FUNCTION public.client_has_login(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.client_has_login(uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- preview_account_claim — what Verify would do, before it is pressed
-- ----------------------------------------------------------------------------
-- Staff-only, and deliberately so: it names the current owner of an account,
-- which `lookup_account_for_claim` refuses to tell a client for the enumeration
-- reason set out in 20260905093000_account_number_lookup.sql. The desk is
-- entitled to it; the queue is a staff page.
--
-- Returns the same refusals the approval would raise, as data rather than
-- exceptions, so an unresolvable claim can be shown as unresolvable instead of
-- offering a button that throws.
CREATE OR REPLACE FUNCTION public.preview_account_claim(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  req   account_claim_requests;
  acct  accounts;
  owner clients;
  n     integer;
  own_accounts integer;
BEGIN
  IF NOT is_staff() THEN
    RAISE EXCEPTION 'Only staff can preview an account claim';
  END IF;

  SELECT * INTO req FROM account_claim_requests WHERE id = p_request_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', null, 'problem', 'Claim not found');
  END IF;

  SELECT count(*) INTO n
    FROM accounts
   WHERE normalise_account_number(external_ref) = normalise_account_number(req.account_number);

  IF n = 0 THEN
    RETURN jsonb_build_object('outcome', null,
      'problem', 'No account with that number');
  END IF;
  IF n > 1 THEN
    RETURN jsonb_build_object('outcome', null,
      'problem', format('That number matches %s accounts', n));
  END IF;

  SELECT * INTO acct
    FROM accounts
   WHERE normalise_account_number(external_ref) = normalise_account_number(req.account_number);

  IF acct.client_id = req.client_id THEN
    RETURN jsonb_build_object('outcome', null,
      'problem', 'Already held by this client; nothing to do');
  END IF;

  SELECT * INTO owner FROM clients WHERE id = acct.client_id;

  IF NOT client_has_login(owner.id) THEN
    RETURN jsonb_build_object(
      'outcome',      'moved',
      'accountLabel', acct.label,
      'ownerName',    owner.display_name
    );
  END IF;

  -- The one refusal that only the join path has. A claimant who already holds
  -- accounts of their own cannot be folded into another client without those
  -- accounts going with them, which is a merge of two portfolios and a
  -- different decision entirely.
  SELECT count(*) INTO own_accounts FROM accounts WHERE client_id = req.client_id;
  IF own_accounts > 0 THEN
    RETURN jsonb_build_object('outcome', null,
      'problem', format(
        'The claimant already holds %s account(s) of their own. Folding them into %s would move those too — resolve by hand.',
        own_accounts, owner.display_name));
  END IF;

  IF NOT client_has_login(req.client_id) THEN
    RETURN jsonb_build_object('outcome', null,
      'problem', 'The claimant has no login to grant');
  END IF;

  RETURN jsonb_build_object(
    'outcome',      'joined',
    'accountLabel', acct.label,
    'ownerName',    owner.display_name
  );
END
$$;

COMMENT ON FUNCTION public.preview_account_claim(uuid) IS
  'Staff-only. What approving this claim would do — moved, joined, or the reason it cannot be approved — without doing it.';

REVOKE ALL ON FUNCTION public.preview_account_claim(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.preview_account_claim(uuid) TO authenticated;

-- ----------------------------------------------------------------------------
-- approve_account_claim — now with two outcomes
-- ----------------------------------------------------------------------------
-- Replaces the version in 20260904090000_account_claims.sql. Everything up to
-- the ownership test is unchanged and re-stated here rather than refactored,
-- because a `CREATE OR REPLACE` must carry the whole body and splitting the
-- resolution out would leave the lock and the resolution in different
-- functions.
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
  own_accounts   integer;
  n              integer;
  moved          jsonb;
BEGIN
  IF NOT is_staff() THEN
    RAISE EXCEPTION 'Only staff can approve an account claim';
  END IF;

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

  SELECT * INTO prev_client FROM clients WHERE id = acct.client_id FOR UPDATE;

  -- ══ Outcome 2: the owner can sign in — grant access, move nothing ════════
  IF client_has_login(prev_client.id) THEN

    -- The claimant must bring no accounts with them. Folding a client who holds
    -- their own into another is a merge of two portfolios, which is a decision
    -- about data and not about access, and belongs to a human with both
    -- statements in front of them.
    SELECT count(*) INTO own_accounts FROM accounts WHERE client_id = req.client_id;
    IF own_accounts > 0 THEN
      RAISE EXCEPTION
        'The claimant already holds % account(s) of their own. Folding them into % would move those accounts too — resolve this by hand.',
        own_accounts, prev_client.display_name;
    END IF;

    IF NOT client_has_login(req.client_id) THEN
      RAISE EXCEPTION
        'The claimant has no login, so there is nothing to grant. Link one first (npm run client:login).';
    END IF;

    -- The grant itself: the claimant's addresses re-parent to the owner.
    --
    -- `is_primary = false` without exception. The claimant's own address is
    -- primary on their row, and carrying that across would both violate
    -- `uq_client_emails_primary` and — worse if it somehow did not — hand the
    -- newcomer the address that `clients.email` mirrors and the claim rail
    -- reasons about. The owner's primary is not up for renegotiation here.
    UPDATE client_emails
       SET client_id = prev_client.id, is_primary = false
     WHERE client_id = req.client_id;

    -- Client-scoped rows with no account dimension, exactly as the move path
    -- treats an emptied row. A fresh sign-up has none of these; a claimant who
    -- had been watching tickers before joining keeps them.
    UPDATE watchlist_items SET client_id = prev_client.id WHERE client_id = req.client_id;
    UPDATE alerts          SET client_id = prev_client.id WHERE client_id = req.client_id;

    -- Retired, not deleted — `audit_log.client_id` is ON DELETE SET NULL, and
    -- deleting the row would anonymise the history of this very approval.
    UPDATE clients SET merged_into = prev_client.id WHERE id = req.client_id;

    UPDATE account_claim_requests
       SET status = 'approved',
           outcome = 'joined',
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
      'Granted account access',
      format('%s can now sign in to %s (account %s). The account did not move.',
             new_owner.display_name, prev_client.display_name, acct.external_ref),
      prev_client.id
    );

    RETURN jsonb_build_object(
      'accountId',     acct.id,
      'accountLabel',  acct.label,
      'accountNumber', acct.external_ref,
      'outcome',       'joined',
      'moved',         false,
      'joinedTo',      prev_client.display_name,
      'claimant',      new_owner.display_name
    );
  END IF;

  -- ══ Outcome 1: the owner is a stub — re-parent, as before ════════════════
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

  SELECT count(*) INTO remaining FROM accounts WHERE client_id = prev_client.id;

  IF remaining = 0 THEN
    UPDATE watchlist_items SET client_id = req.client_id WHERE client_id = prev_client.id;
    UPDATE alerts          SET client_id = req.client_id WHERE client_id = prev_client.id;

    UPDATE clients SET merged_into = req.client_id WHERE id = prev_client.id;
  END IF;

  UPDATE account_claim_requests
     SET status = 'approved',
         outcome = 'moved',
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
    'outcome',         'moved',
    'moved',           true,
    'previousClient',  prev_client.display_name,
    'retiredPrevious', remaining = 0,
    'rows',            moved
  );
END
$$;

COMMENT ON FUNCTION public.approve_account_claim(uuid, text, text) IS
  'Staff-only, one transaction. If the account''s owner cannot sign in, moves the account and everything denormalised against it to the claimant. If the owner CAN sign in, moves the claimant''s login to the owner instead and retires the claimant''s row — the account does not move and both people end up with access.';

REVOKE ALL ON FUNCTION public.approve_account_claim(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.approve_account_claim(uuid, text, text) TO authenticated;

-- ----------------------------------------------------------------------------
-- Checking on it
-- ----------------------------------------------------------------------------
--   -- What each decided claim did:
--   SELECT account_number, status, outcome, decided_by, decided_at
--     FROM account_claim_requests ORDER BY requested_at DESC;
--
--   -- Clients retired by a join, and who they joined (expect the survivor to
--   -- hold the retired row's addresses):
--   SELECT r.display_name AS retired, s.display_name AS survivor,
--          (SELECT array_agg(email) FROM client_emails WHERE client_id = s.id)
--     FROM clients r JOIN clients s ON s.id = r.merged_into
--    WHERE r.merged_into IS NOT NULL;
--
--   -- A retired row must own nothing and no longer be signable-in as:
--   SELECT c.id FROM clients c
--    WHERE c.merged_into IS NOT NULL
--      AND (EXISTS (SELECT 1 FROM accounts      WHERE client_id = c.id)
--        OR EXISTS (SELECT 1 FROM client_emails WHERE client_id = c.id));
