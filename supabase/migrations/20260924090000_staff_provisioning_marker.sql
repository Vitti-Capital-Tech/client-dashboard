-- ===========================================================================
-- SUPERSEDED by 20260924100000_staff_role_requires_marker.sql — do not rely on
-- this one. Its guard checks app metadata at INSERT, but GoTrue writes caller
-- app metadata in a SECOND statement, so the guard refused every staff account.
-- The later migration drops this trigger. Kept for the history it records.
-- ===========================================================================
-- ---------------------------------------------------------------------------
-- New staff still cannot sign in. The previous fix was built on a wrong fact.
--
-- ── What the live log says ─────────────────────────────────────────────────
-- 24 Sep 2026, provisioning `garg.d@vitti.capital` through the admin API — the
-- exact call `provisionStaffAccount` makes, with no password — returned 500.
-- The auth log carried the database error the 500 hides:
--
--   ERROR: A vitti.capital address cannot be registered with a password.
--          Staff sign in with a one-time code. (SQLSTATE 42501)
--
-- That wording ("registered", not "self-registered") is the function from
-- 20260918100000, so that migration WAS applied and its trigger is what raised.
-- Its condition is `coalesce(NEW.encrypted_password, '') <> ''`, which can only
-- be true if the column is non-empty. So:
--
--   GoTrue writes a NON-EMPTY `encrypted_password` even for a user created
--   through the admin API with no password at all.
--
-- 20260918100000 assumed the opposite — that a passwordless create stores the
-- empty string — and its self-test "proved" it by inserting `''` by hand. The
-- test checked the assumption against itself, never against GoTrue, which is why
-- it printed PASSED while every real staff sign-in went on failing.
--
-- ── Why the password column cannot be the test at all ──────────────────────
-- If a passwordless admin create and a public signup both arrive with a hash in
-- `encrypted_password`, that column no longer tells them apart, whatever the
-- condition. Nor does the database role: both come through GoTrue as
-- `supabase_auth_admin`. The trigger needs a signal the two paths genuinely
-- differ on.
--
-- ── The signal: app metadata ───────────────────────────────────────────────
-- `raw_app_meta_data` can be written only through the admin API, which needs
-- the service-role key. A public `POST /auth/v1/signup` cannot set it — user-
-- supplied `data` lands in `raw_user_meta_data` — and GoTrue fills app metadata
-- itself with nothing but the provider list. So a marker there is something only
-- our own server code can put on a row:
--
--   raw_app_meta_data ->> 'provisioned_by' = 'vitti-portal'
--
-- `provisionStaffAccount` (app/actions/session.ts) and `scripts/seed-auth-users.mjs`
-- now pass it. The marker is not a secret and does not need to be: its value is
-- that setting it requires the service role, and whoever holds that can already
-- do anything to `auth.users`.
--
-- The rule is now stated positively and is stricter than before: a staff-domain
-- address may be INSERTed only by the portal's own provisioning, whatever the
-- password column says. A public signup for `ceo@vitti.capital` carries no marker
-- and is refused — the one thing this trigger exists to stop.
--
-- ── What happens to the "staff have no passwords" rule ─────────────────────
-- It stands, but it was never really enforced here. The hash GoTrue writes on a
-- passwordless create is random and known to nobody, so it is not a credential.
-- The rule is enforced where a password would be USED: `signInWithPassword` and
-- `requestPasswordResetCode` both refuse staff addresses (app/actions/session.ts).
--
-- ── Trigger order ──────────────────────────────────────────────────────────
-- Both BEFORE INSERT triggers on `auth.users` fire in name order, so this one
-- (`block_…`) runs before `stamp_role_from_email` (`stamp_…`). That one merges
-- the role into app metadata rather than replacing it, so the marker survives
-- either way; the order is noted so nobody has to work it out again.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.block_self_registered_staff()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.role_from_email_domain(NEW.email) = 'admin'
     AND coalesce(NEW.raw_app_meta_data ->> 'provisioned_by', '') <> 'vitti-portal'
  THEN
    -- 42501 = insufficient_privilege. Worded for whoever reads the auth log:
    -- the sign-up form refuses staff addresses long before this, so a caller who
    -- got here either went around it deliberately or is provisioning code that
    -- forgot the marker — and the message says which to check.
    RAISE EXCEPTION
      'A vitti.capital account can only be created by the portal''s own staff provisioning (app_metadata.provisioned_by = vitti-portal). Staff sign in with a one-time code.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.block_self_registered_staff() IS
  'Refuses any staff-domain auth.users INSERT that does not carry app_metadata.provisioned_by = vitti-portal. Only the service-role admin API can set app metadata, so a public signup — which stamp_role_from_email would otherwise stamp as admin — can never carry it.';

-- The trigger is unchanged; recreated so this file is self-contained.
DROP TRIGGER IF EXISTS block_self_registered_staff ON auth.users;
CREATE TRIGGER block_self_registered_staff
  BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.block_self_registered_staff();

-- ---------------------------------------------------------------------------
-- Self-test — against what GoTrue ACTUALLY writes this time.
--
-- The last self-test inserted an empty password because that is what it
-- believed GoTrue does, so it could only ever agree with itself. These two rows
-- carry a non-empty password hash, which the live log proves is what arrives:
--
--   1. staff address + hash + marker    → must be ACCEPTED (portal provisioning)
--   2. staff address + hash + no marker → must be REFUSED  (a public signup)
--
-- Both run in their own sub-transactions and are removed or rolled back;
-- nothing is left in `auth.users` and no mail is sent. Non-fatal, and it says
-- which half failed. Read it in the SQL editor's Messages/Notices tab.
--
-- This still is not GoTrue itself. The real proof is the next staff sign-in —
-- or, before anyone tries, creating one staff user through the admin API.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  -- Any non-empty value stands in for GoTrue's hash; only non-emptiness matters.
  hash text := 'selftest-non-empty-hash';
  ok_id uuid := gen_random_uuid();
  bad_id uuid := gen_random_uuid();
  accepted boolean := false;
  refused boolean := false;
BEGIN
  BEGIN
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      created_at, updated_at, raw_app_meta_data, raw_user_meta_data
    ) VALUES (
      '00000000-0000-0000-0000-000000000000', ok_id, 'authenticated', 'authenticated',
      'zz-selftest-portal@vitti.capital', hash, NULL, now(), now(),
      '{"provider":"email","providers":["email"],"provisioned_by":"vitti-portal"}'::jsonb, '{}'::jsonb
    );
    DELETE FROM auth.users WHERE id = ok_id;
    accepted := true;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING '[selftest] portal provisioning was REFUSED: % (SQLSTATE %)', SQLERRM, SQLSTATE;
  END;

  BEGIN
    INSERT INTO auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      created_at, updated_at, raw_app_meta_data, raw_user_meta_data
    ) VALUES (
      '00000000-0000-0000-0000-000000000000', bad_id, 'authenticated', 'authenticated',
      'zz-selftest-signup@vitti.capital', hash, NULL, now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb
    );
    DELETE FROM auth.users WHERE id = bad_id;
    RAISE WARNING '[selftest] a public-signup-shaped staff row was ACCEPTED — the guard is not working.';
  EXCEPTION WHEN insufficient_privilege THEN
    refused := true;
  WHEN OTHERS THEN
    RAISE WARNING '[selftest] public-signup row failed for an unexpected reason: % (SQLSTATE %)', SQLERRM, SQLSTATE;
  END;

  IF accepted AND refused THEN
    RAISE NOTICE '[selftest] PASSED — portal provisioning is accepted and a public staff signup is refused.';
  END IF;
END $$;
