-- ---------------------------------------------------------------------------
-- Staff have not been able to sign in for the first time since 5 Sep 2026.
--
-- ── The symptom ────────────────────────────────────────────────────────────
-- A new Vitti address asks for a one-time code and gets "Could not send the
-- code just now. Please try again." Trying again does not help, because nothing
-- about the attempt was transient: `provisionStaffAccount` fails, so there is no
-- `auth.users` row, so `signInWithOtp({ shouldCreateUser: false })` has nobody
-- to send to.
--
-- The admin API answers that failure with a bare HTTP 500 and an empty body —
-- GoTrue's way of saying a database trigger raised — which is why the server log
-- read `login: could not provision … — {}` and said nothing useful.
--
-- ── What is actually raising ───────────────────────────────────────────────
-- `block_self_registered_staff`, from 20260905090000_password_signup.sql. It is
-- meant to refuse ONE thing: a staff-domain address self-registered through
-- `POST /auth/v1/signup`, which would arrive carrying a password and get stamped
-- `admin` by `stamp_role_from_email`. Its condition was:
--
--     role_from_email_domain(NEW.email) = 'admin'
--     AND NEW.encrypted_password IS NOT NULL
--     AND NEW.email_confirmed_at IS NULL
--
-- and that migration's own comment explains why the legitimate path was
-- supposed to slip past it: "`ensureStaffAccount` and both provisioning scripts
-- call `createUser` with `email_confirm: true` and no password → confirmed, so
-- not matched."
--
-- Both halves of that sentence are wrong about what GoTrue writes.
--
--   • "no password" does not mean `encrypted_password IS NULL`. GoTrue stores
--     the EMPTY STRING for a user created without one, and `'' IS NOT NULL` is
--     true.
--   • `email_confirm: true` does not confirm the address in the INSERT. The row
--     goes in unconfirmed and a second statement sets `email_confirmed_at`, so
--     the third condition is true as well at the moment the trigger runs.
--
-- All three conditions hold, and the passwordless admin create — the only way a
-- staff account has ever come into existence — is refused by the trigger written
-- to protect it.
--
-- ── How that was established ───────────────────────────────────────────────
-- Against the live project, before writing this:
--
--   • All five existing staff rows were created 3–4 Sep 2026. The trigger landed
--     on the 5th. Nobody has been provisioned since, and nobody could have been.
--   • `createUser({ email: 'zz-…@vitti.capital', email_confirm: true })` → 500.
--   • The same call on an `@example.com` address → succeeds. So the failure is
--     specific to the staff domain, which is the only thing this trigger keys on.
--
-- The trigger firing is itself the proof of the two claims above: it cannot fire
-- unless `encrypted_password IS NOT NULL` and `email_confirmed_at IS NULL` were
-- both true for a row created with neither a password nor a confirmation
-- pending.
--
-- ── The fix ────────────────────────────────────────────────────────────────
-- Test for a USABLE password rather than for a non-NULL column, and stop keying
-- on confirmation at all.
--
-- The confirmation check is dropped rather than repaired because it never
-- distinguished anything: every INSERT is unconfirmed at trigger time, so it was
-- always true and only ever looked like a second safeguard. What is left states
-- the rule exactly as the original migration described it in prose — a
-- staff-domain address may not be INSERTed carrying a password — and it is
-- STRICTER than before, since an admin create that passes a password for a Vitti
-- address is now refused too. Nothing legitimate does that: the two provisioning
-- scripts and `provisionStaffAccount` all create without one, and `startSignUp`
-- refuses staff addresses outright.
--
-- A public signup still carries a real bcrypt hash, so it is still refused,
-- which is the whole point of the trigger. `resetPassword` is an UPDATE of an
-- existing row and this trigger is INSERT-only, so that path is untouched —
-- though `requestPasswordResetCode` refuses staff before it can be reached.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.block_self_registered_staff()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- `coalesce(…, '') <> ''` and not `IS NOT NULL`: GoTrue writes the empty
  -- string, not NULL, for a user created without a password, and reading that as
  -- "has a password" is what blocked every staff sign-in for a fortnight.
  IF public.role_from_email_domain(NEW.email) = 'admin'
     AND coalesce(NEW.encrypted_password, '') <> ''
  THEN
    -- 42501 = insufficient_privilege. GoTrue surfaces this as a failed signup;
    -- the message is written for whoever reads it in the auth logs, since the
    -- sign-up form refuses staff addresses long before reaching here and a
    -- caller who got this far went around it deliberately.
    RAISE EXCEPTION
      'A vitti.capital address cannot be registered with a password. Staff sign in with a one-time code.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.block_self_registered_staff() IS
  'Refuses a staff-domain auth.users INSERT that carries a password — the signature of a public signup, which stamp_role_from_email would otherwise stamp as admin. Passwordless creates (provisionStaffAccount, the seed scripts) are the legitimate path and must pass.';

-- The trigger itself is unchanged and is left in place; only the function it
-- calls is replaced. Recreated anyway so the migration is self-contained if it
-- is ever replayed against a database that predates 20260905090000.
DROP TRIGGER IF EXISTS block_self_registered_staff ON auth.users;
CREATE TRIGGER block_self_registered_staff
  BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.block_self_registered_staff();

-- ----------------------------------------------------------------------------
-- Checking on it
-- ----------------------------------------------------------------------------
--   -- Should SUCCEED now — this is what provisionStaffAccount does:
--   --   admin.auth.admin.createUser({ email: 'new.hire@vitti.capital',
--   --                                 email_confirm: true })
--
--   -- Should still raise:
--   INSERT INTO auth.users (id, email, encrypted_password, aud, role)
--   VALUES (gen_random_uuid(), 'ceo@vitti.capital', 'x', 'authenticated', 'authenticated');
--
--   -- Any staff account carrying a password (should be none):
--   SELECT email FROM auth.users
--    WHERE role_from_email_domain(email) = 'admin'
--      AND coalesce(encrypted_password, '') <> '';
