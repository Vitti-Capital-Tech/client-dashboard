-- ---------------------------------------------------------------------------
-- Staff provisioning, third attempt — built from what GoTrue was OBSERVED doing.
--
-- Supersedes the INSERT guard in 20260918100000 and 20260924090000. Safe to run
-- whether or not either of those was applied.
--
-- ── What was observed, 24 Sep 2026 ─────────────────────────────────────────
-- Two throwaway users on @example.com (which no trigger here refuses) were
-- created through the admin API, then READ BACK from the database — the create
-- response is GoTrue's in-memory copy and does not show what triggers wrote:
--
--   createUser({ email_confirm: true })
--     stored app_metadata = {"provider","providers","role":"client"}
--
--   createUser({ email_confirm: true, app_metadata: { provisioned_by } })
--     stored app_metadata = {"provider","providers","provisioned_by"}   ← no role
--
-- So GoTrue INSERTs the row with only the provider keys, and writes the caller's
-- app_metadata in a SECOND statement, replacing the whole column from its own
-- in-memory copy. Two consequences:
--
--   1. A BEFORE INSERT trigger never sees caller-supplied app metadata. The
--      guard in 20260924090000 (refuse a staff INSERT without the marker) could
--      therefore never pass, for anybody.
--   2. The second statement wipes the `role` that `stamp_role_from_email` wrote
--      at INSERT, because that trigger fired only on INSERT or UPDATE OF email.
--      Any app_metadata passed to createUser silently strips the role.
--
-- Combined with the earlier finding (a passwordless create still arrives with a
-- non-empty `encrypted_password`, per the auth log), NOTHING on the INSERTed row
-- distinguishes our provisioning from a public signup. Blocking the INSERT was
-- the wrong shape of defence.
--
-- ── The new shape: let the row in, gate the ROLE ───────────────────────────
-- The danger was never an auth.users row for a vitti.capital address. It was
-- that such a row is stamped `admin` — a staff session over every client. So the
-- guard moves from "may this row exist" to "may this row be admin":
--
--   role = 'admin'  only if  the domain is vitti.capital
--                     AND raw_app_meta_data.provisioned_by = 'vitti-portal'
--   role = 'client' otherwise
--
-- App metadata is writable only through the service-role admin API; a public
-- `/auth/v1/signup` cannot set it. So a self-registered `ceo@vitti.capital` gets
-- `client` — with no `client_emails` row it resolves to no client, sees nothing,
-- and cannot sign in with its password anyway (`signInWithPassword` refuses the
-- staff domain). The worst it can do is squat an address, which the desk can
-- delete; it can never become staff.
--
-- And the stamp now also fires on UPDATE OF raw_app_meta_data, which is exactly
-- the second statement GoTrue issues — so the marker arriving late is when the
-- role becomes admin, and no metadata rewrite can strip the role again.
--
-- ── Existing staff ─────────────────────────────────────────────────────────
-- The five staff accounts predate the marker. They are backfilled with it below,
-- or the next time anything rewrote their app metadata they would be demoted to
-- client. Every existing vitti.capital row is treated as legitimate: all were
-- created by provisioning or the seed script (signups have been off throughout).
-- ---------------------------------------------------------------------------

-- 1. The INSERT guard goes. It could not tell the two paths apart (see above).
DROP TRIGGER IF EXISTS block_self_registered_staff ON auth.users;
DROP FUNCTION IF EXISTS public.block_self_registered_staff();

-- 2. The role stamp, gated on the marker.
CREATE OR REPLACE FUNCTION public.stamp_role_from_email()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  granted text;
BEGIN
  granted := CASE
    WHEN public.role_from_email_domain(NEW.email) = 'admin'
     AND coalesce(NEW.raw_app_meta_data ->> 'provisioned_by', '') = 'vitti-portal'
      THEN 'admin'
    ELSE 'client'
  END;

  -- Merged rather than assigned: the column also carries the provider list
  -- GoTrue maintains, and the marker itself, and replacing the object would
  -- drop both.
  NEW.raw_app_meta_data =
    coalesce(NEW.raw_app_meta_data, '{}'::jsonb) || jsonb_build_object('role', granted);
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.stamp_role_from_email() IS
  'Stamps app_metadata.role on every insert and on any change to email or app metadata: admin only for a vitti.capital address carrying app_metadata.provisioned_by = vitti-portal (settable only via the service-role admin API), client otherwise.';

-- `raw_app_meta_data` is new in the column list: it is what GoTrue's second
-- statement writes, and without it that statement strips the role.
DROP TRIGGER IF EXISTS stamp_role_from_email ON auth.users;
CREATE TRIGGER stamp_role_from_email
  BEFORE INSERT OR UPDATE OF email, raw_app_meta_data ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.stamp_role_from_email();

-- 3. Backfill the marker onto existing staff. The UPDATE fires the stamp above,
--    so each comes out with role = admin as before.
UPDATE auth.users
   SET raw_app_meta_data =
         coalesce(raw_app_meta_data, '{}'::jsonb) || '{"provisioned_by":"vitti-portal"}'::jsonb
 WHERE public.role_from_email_domain(email) = 'admin'
   AND coalesce(raw_app_meta_data ->> 'provisioned_by', '') <> 'vitti-portal';

-- ---------------------------------------------------------------------------
-- Self-test. Replays the sequence GoTrue was observed to issue — INSERT with
-- provider keys only, then UPDATE of app metadata — rather than a row shaped by
-- what we hope it does. Every probe is removed; nothing is left and no mail is
-- sent. Non-fatal; read it in the SQL editor's Messages/Notices tab.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  staff_id uuid := gen_random_uuid();
  squat_id uuid := gen_random_uuid();
  outsider_id uuid := gen_random_uuid();
  r text;
  ok boolean := true;
BEGIN
  -- a) Portal provisioning: INSERT, then GoTrue's metadata UPDATE with the marker.
  INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password,
                          created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  VALUES ('00000000-0000-0000-0000-000000000000', staff_id, 'authenticated', 'authenticated',
          'zz-selftest-staff@vitti.capital', 'non-empty-hash', now(), now(),
          '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb);
  SELECT raw_app_meta_data ->> 'role' INTO r FROM auth.users WHERE id = staff_id;
  IF r IS DISTINCT FROM 'client' THEN
    ok := false; RAISE WARNING '[selftest] staff row before the marker should be client, was %', r;
  END IF;
  UPDATE auth.users
     SET raw_app_meta_data = '{"provider":"email","providers":["email"],"provisioned_by":"vitti-portal"}'::jsonb
   WHERE id = staff_id;
  SELECT raw_app_meta_data ->> 'role' INTO r FROM auth.users WHERE id = staff_id;
  IF r IS DISTINCT FROM 'admin' THEN
    ok := false; RAISE WARNING '[selftest] provisioned staff should be admin, was %', r;
  END IF;

  -- b) A public signup for a staff address: no marker, ever.
  INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password,
                          created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  VALUES ('00000000-0000-0000-0000-000000000000', squat_id, 'authenticated', 'authenticated',
          'zz-selftest-squat@vitti.capital', 'non-empty-hash', now(), now(),
          '{"provider":"email","providers":["email"]}'::jsonb, '{"role":"admin"}'::jsonb);
  SELECT raw_app_meta_data ->> 'role' INTO r FROM auth.users WHERE id = squat_id;
  IF r IS DISTINCT FROM 'client' THEN
    ok := false; RAISE WARNING '[selftest] an unmarked staff-domain row must be client, was %', r;
  END IF;

  -- c) The marker on a non-staff address grants nothing.
  INSERT INTO auth.users (instance_id, id, aud, role, email, encrypted_password,
                          created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  VALUES ('00000000-0000-0000-0000-000000000000', outsider_id, 'authenticated', 'authenticated',
          'zz-selftest-outsider@example.com', 'non-empty-hash', now(), now(),
          '{"provider":"email","providers":["email"],"provisioned_by":"vitti-portal"}'::jsonb, '{}'::jsonb);
  SELECT raw_app_meta_data ->> 'role' INTO r FROM auth.users WHERE id = outsider_id;
  IF r IS DISTINCT FROM 'client' THEN
    ok := false; RAISE WARNING '[selftest] a marked non-staff row must be client, was %', r;
  END IF;

  DELETE FROM auth.users WHERE id IN (staff_id, squat_id, outsider_id);

  -- d) Every real staff account kept admin through the backfill.
  IF EXISTS (
    SELECT 1 FROM auth.users
     WHERE public.role_from_email_domain(email) = 'admin'
       AND coalesce(raw_app_meta_data ->> 'role', '') <> 'admin'
  ) THEN
    ok := false; RAISE WARNING '[selftest] an existing staff account is no longer admin — check before signing out.';
  END IF;

  IF ok THEN
    RAISE NOTICE '[selftest] PASSED — provisioned staff become admin, unmarked staff-domain rows stay client, existing staff unchanged.';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '[selftest] could not run: % (SQLSTATE %)', SQLERRM, SQLSTATE;
END $$;
