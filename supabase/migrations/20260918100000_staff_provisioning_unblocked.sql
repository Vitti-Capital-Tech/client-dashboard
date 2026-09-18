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

-- ---------------------------------------------------------------------------
-- Does it actually work now?
--
-- This asks the database rather than assuming, because the reasoning above is
-- an inference and the thing it infers from is deliberately hard to see: the
-- admin API reports ANY trigger raising on `auth.users` as an empty 500, so
-- from the application side "fixed" and "still broken for a different reason"
-- look identical. One unreadable failure has already cost a fortnight.
--
-- It inserts the exact row `provisionStaffAccount` causes — staff domain, no
-- password, unconfirmed at insert — and deletes it again. Nothing is left
-- behind and no mail is sent; `auth.users` is written directly, so GoTrue is
-- not involved at all.
--
-- Deliberately NON-fatal. A failure here means the fix above did not address
-- the real cause, and rolling the whole migration back on that would leave
-- nothing applied AND nothing learned. Instead it prints the exception that
-- the 500 has been hiding — which trigger, which message, which SQLSTATE — and
-- that is the one fact needed to fix it properly.
--
-- Read the output in the SQL editor's Notices/Messages, or in `db push`'s log:
--
--   [selftest] PASSED …   staff provisioning works; new staff can sign in.
--   [selftest] STILL BLOCKED: <the real error> … send that line back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  probe_id uuid := gen_random_uuid();
BEGIN
  BEGIN
    INSERT INTO auth.users (
      instance_id, id, aud, role, email,
      encrypted_password, email_confirmed_at,
      created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data
    ) VALUES (
      '00000000-0000-0000-0000-000000000000', probe_id, 'authenticated', 'authenticated',
      'zz-migration-selftest@vitti.capital',
      '',    -- what GoTrue writes for a user created without a password
      NULL,  -- and it confirms in a second statement, so this is NULL at INSERT
      now(), now(), '{}'::jsonb, '{}'::jsonb
    );

    DELETE FROM auth.users WHERE id = probe_id;

    RAISE NOTICE '[selftest] PASSED — a passwordless staff INSERT is accepted. New staff can now request a code.';
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[selftest] STILL BLOCKED: % (SQLSTATE %)', SQLERRM, SQLSTATE;
    RAISE WARNING '[selftest] The fix in this migration did not address the real cause. Send the line above back.';
  END;
END $$;

-- ----------------------------------------------------------------------------
-- Checking on it by hand
-- ----------------------------------------------------------------------------
--   -- Should still raise — a self-registration carrying a password:
--   INSERT INTO auth.users (id, email, encrypted_password, aud, role)
--   VALUES (gen_random_uuid(), 'ceo@vitti.capital', 'x', 'authenticated', 'authenticated');
--
--   -- Any staff account carrying a password (should be none):
--   SELECT email FROM auth.users
--    WHERE role_from_email_domain(email) = 'admin'
--      AND coalesce(encrypted_password, '') <> '';
--
--   -- Every trigger on auth.users, if the self-test points somewhere else:
--   SELECT tgname, pg_get_triggerdef(oid)
--     FROM pg_trigger
--    WHERE tgrelid = 'auth.users'::regclass AND NOT tgisinternal
--    ORDER BY tgname;
