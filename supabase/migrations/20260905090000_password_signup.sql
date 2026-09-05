-- ============================================================================
-- Self-registration with a password — and the door it must not open
-- ----------------------------------------------------------------------------
-- Until now there was no sign-up: `auth.users` rows existed because staff had
-- provisioned them with the service role (scripts/seed-auth-users.mjs,
-- scripts/link-client-login.mjs) or because `ensureStaffAccount` created one for
-- a Vitti address on first sign-in. The login form passed
-- `shouldCreateUser: false`, and app/actions/session.ts says in as many words
-- that the flag is load-bearing.
--
-- A public sign-up page changes that, and it collides with
-- 20260903140000_role_from_email_domain.sql in a way worth spelling out.
--
-- ── The collision ───────────────────────────────────────────────────────────
-- `stamp_role_from_email` stamps `app_metadata.role = 'admin'` onto ANY address
-- ending `@vitti.capital`, at INSERT time, with no other check. That was safe
-- while the only way to insert was the service role, and safe for the OTP path
-- for a second reason the code states: the code is EMAILED, so completing a
-- sign-in means reading mail at a vitti.capital mailbox, which only real staff
-- can do. The domain was never trusted as a claim — mail delivery proved it.
--
-- A password removes the proof. `signInWithPassword` mints a session from
-- something the caller chose themselves; no mailbox is involved. So if
-- `POST /auth/v1/signup` is reachable — and it is reachable by anyone, since it
-- takes only the anon key out of the browser bundle — then:
--
--     signUp({ email: 'ceo@vitti.capital', password: 'whatever' })
--
-- creates a row, the trigger stamps it `admin`, and the caller signs in to the
-- staff console holding every client's positions. Not a theoretical ordering
-- problem: supabase/config.toml shipped `enable_signup = true` with
-- `enable_confirmations = false`, so that sequence needed no mailbox and no
-- second step.
--
-- ── The fix, in two places ──────────────────────────────────────────────────
-- 1. Project-level signups go OFF (supabase/config.toml, and the same switch in
--    the hosted dashboard). Registration runs through `startSignUp`, a server
--    action holding the service role, which refuses staff addresses outright.
--    That alone closes it.
--
-- 2. This trigger, because (1) is a setting and settings get flipped back by
--    somebody who reads "Allow new users to sign up" and sees no reason not to.
--    The rule belongs next to the trigger that creates the exposure, in the one
--    place both the app and the dashboard have to go through.
--
-- ── What it keys on ─────────────────────────────────────────────────────────
-- A staff row arriving with a password ALREADY SET and its address unconfirmed
-- is the signature of `POST /auth/v1/signup`, and nothing else in this system
-- produces it:
--
--   • `ensureStaffAccount` and both provisioning scripts call `createUser` with
--     `email_confirm: true` and no password → confirmed, so not matched.
--   • A staff member who later sets a password does it through
--     `resetPassword`, after verifying an emailed code. That is an UPDATE of an
--     existing row, and this trigger is INSERT-only, so it stays allowed —
--     which is the point: proving the mailbox is what earns the password.
--
-- Clients are untouched: `role_from_email_domain` returns 'client' for them and
-- the first condition is false before the others are read.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.block_self_registered_staff()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.role_from_email_domain(NEW.email) = 'admin'
     AND NEW.encrypted_password IS NOT NULL
     AND NEW.email_confirmed_at IS NULL
  THEN
    -- 42501 = insufficient_privilege. GoTrue surfaces this as a failed signup;
    -- the message is written for whoever reads it in the auth logs, since the
    -- sign-up form refuses staff addresses long before reaching here and a
    -- caller who got this far went around it deliberately.
    RAISE EXCEPTION
      'A vitti.capital address cannot be self-registered with a password. Staff sign in with a one-time code.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.block_self_registered_staff() IS
  'Refuses a staff-domain auth.users INSERT that carries a password and an unconfirmed address — the signature of a public signup, which stamp_role_from_email would otherwise stamp as admin.';

-- Named to sort before `stamp_role_from_email`: same table, same timing, and
-- Postgres fires BEFORE triggers in name order. Refusing the row before
-- anything stamps a role on it is not required for correctness (the exception
-- unwinds either way) but it keeps the audit trail honest about what happened.
DROP TRIGGER IF EXISTS block_self_registered_staff ON auth.users;
CREATE TRIGGER block_self_registered_staff
  BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.block_self_registered_staff();

-- ----------------------------------------------------------------------------
-- Checking on it
-- ----------------------------------------------------------------------------
--   -- Should raise:
--   INSERT INTO auth.users (id, email, encrypted_password, aud, role)
--   VALUES (gen_random_uuid(), 'ceo@vitti.capital', 'x', 'authenticated', 'authenticated');
--
--   -- Should succeed (what ensureStaffAccount does — confirmed, no password):
--   INSERT INTO auth.users (id, email, email_confirmed_at, aud, role)
--   VALUES (gen_random_uuid(), 'someone@vitti.capital', now(), 'authenticated', 'authenticated');
--
--   -- Any staff account that already carries a password (should be none until
--   -- one of them deliberately sets it through the reset flow):
--   SELECT email FROM auth.users
--    WHERE role_from_email_domain(email) = 'admin' AND encrypted_password IS NOT NULL;
