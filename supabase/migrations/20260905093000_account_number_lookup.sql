-- ============================================================================
-- Checking an account number before claiming it
-- ----------------------------------------------------------------------------
-- The claim form (20260904090000_account_claims.sql) deliberately told the
-- client nothing: type a number, send it to the desk, wait. Its header says why
-- — a form that answers "does 1101163 exist here" is an oracle for the firm's
-- account numbers, answerable by anyone with a login and a loop.
--
-- The desk has asked for the answer anyway, and the reason is a good one: a
-- mistyped digit is currently invisible until a human works out days later that
-- the number matches nothing, and the client cannot tell a typo from a slow
-- queue. So there is now a Verify button, and this is the only thing that
-- answers it.
--
-- ── What is given up, and what is kept ─────────────────────────────────────
-- Given up: whether a number exists, and the account name if it does. That is
-- the feature; it cannot be delivered without disclosing it.
--
-- Kept, because the enumeration risk is real and unchanged:
--
--   • a HARD RATE LIMIT — LOOKUP_LIMIT checks per client per hour. A person
--     confirming the number on their statement needs one or two, and a few more
--     if they fat-finger it; a loop over the number space needs hundreds of
--     thousands and gets twenty an hour, which is centuries of walking.
--   • an AUDIT ROW PER CHECK, written before the answer is returned, so a
--     scrape is visible in the log rather than inferred afterwards. It is
--     written for hits and misses alike: only logging the hits would leave the
--     scraping itself invisible.
--   • nothing about the OWNER. The account's own name is returned and the
--     client who currently holds it is not — that would turn one number into a
--     name, an entity and a relationship.
--   • this function only READS. It is now also the gate on raising a claim at
--     all — `requestAccountClaim` refuses a number that does not resolve — but
--     resolving a number still decides nothing: approval goes through
--     `approve_account_claim` under staff authority, with its own refusal for
--     an account whose owner can log in.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.lookup_account_for_claim(p_number text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Set against the WORST honest case rather than the typical one: raising a
  -- claim now costs two checks (the Verify, then `requestAccountClaim` proving
  -- it again server-side), and a client working through a couple of mistyped
  -- numbers must not be locked out before they get to the right one — there is
  -- no "send it anyway" path left for them to fall back to.
  LOOKUP_LIMIT constant integer := 20;

  caller     uuid;
  normalised text;
  matches    integer;
  acct       accounts;
  recent     integer;
BEGIN
  caller := current_client_id();
  IF caller IS NULL THEN
    RAISE EXCEPTION 'No client for the signed-in user';
  END IF;

  normalised := normalise_account_number(p_number);
  IF normalised = '' THEN
    RAISE EXCEPTION 'Enter the account number from your broker statement.';
  END IF;

  -- Counted BEFORE this check is logged, so the limit is what it says: the
  -- eleventh check in an hour is the one that is refused.
  SELECT count(*) INTO recent
    FROM audit_log
   WHERE client_id = caller
     AND action = 'Checked account number'
     AND ts > now() - interval '1 hour';

  IF recent >= LOOKUP_LIMIT THEN
    -- Not "use the form instead": the form is gated on this function now, so
    -- the only thing left is a human. Saying so beats sending them in a circle.
    RAISE EXCEPTION
      'Too many account checks in the last hour. Try again later, or call the Vitti desk.';
  END IF;

  -- Ambiguity is possible and must not be guessed at: `external_ref` is unique
  -- but its NORMALISED form need not be, so '110-2004' and '1102004' are two
  -- accounts that reduce to one number. `approve_account_claim` refuses that
  -- case; this says the same thing rather than showing one of the two names.
  SELECT count(*) INTO matches
    FROM accounts
   WHERE normalise_account_number(external_ref) = normalised;

  IF matches = 1 THEN
    SELECT * INTO acct
      FROM accounts
     WHERE normalise_account_number(external_ref) = normalised;
  END IF;

  INSERT INTO audit_log (actor, role, action, detail, client_id)
  VALUES (
    coalesce((SELECT display_name FROM clients WHERE id = caller), 'Client'),
    'client',
    'Checked account number',
    format('%s — %s', normalised,
           CASE WHEN matches = 0 THEN 'no match'
                WHEN matches > 1 THEN 'ambiguous'
                ELSE 'matched' END),
    caller
  );

  RETURN jsonb_build_object(
    'found',     matches = 1,
    'ambiguous', matches > 1,
    -- Null unless exactly one account matched. The account's name; never its
    -- owner's.
    'name',      CASE WHEN matches = 1 THEN acct.label ELSE NULL END,
    -- Whether it is already on this login, so the form can say "you already
    -- have this" instead of inviting a claim that would be a no-op.
    'mine',      matches = 1 AND acct.client_id = caller,
    'checksLeft', LOOKUP_LIMIT - recent - 1
  );
END
$$;

COMMENT ON FUNCTION public.lookup_account_for_claim(text) IS
  'Resolves a broker account number to the account NAME for the claim form. Rate-limited per client per hour and audited on every call, including misses. Never returns the owning client.';

REVOKE ALL ON FUNCTION public.lookup_account_for_claim(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_account_for_claim(text) TO authenticated;

-- The rate limit reads the log by (client_id, action, ts) on every check, and
-- `idx_audit_client` alone makes that a scan of everything that client has ever
-- done. Partial, because this is the only action it is ever asked about.
CREATE INDEX IF NOT EXISTS idx_audit_account_checks
  ON audit_log (client_id, ts DESC)
  WHERE action = 'Checked account number';
