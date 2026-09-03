-- ============================================================================
-- app_metadata.role, stamped from the email domain
-- ============================================================================
-- The rule the desk actually wants: anyone signing in with a `@vitti.capital`
-- address is staff; everyone else is a client.
--
-- ── Why a trigger, and not a check in the app or in is_staff() ───────────────
-- `is_staff()` already reads `app_metadata.role`, and around twenty RLS policies
-- call it. Two alternatives were considered and rejected:
--
--   • Read the domain in `is_staff()` directly. Correct, and it would make a
--     domain change take effect immediately — but it turns every policy
--     evaluation into a lookup against `auth.users`, on a function used
--     everywhere. Not worth paying on every query for a rule that changes when
--     somebody joins the firm.
--
--   • Derive the role in the app from `user.email`. This is the one that looks
--     easiest and is wrong: it puts an authorization decision in a place the
--     database cannot see, so RLS and the UI would answer to different rules.
--
-- Stamping the derived answer into `app_metadata` keeps ONE source of truth and
-- leaves `is_staff()`, every policy and lib/session.ts untouched.
--
-- ── Why `app_metadata` and never `user_metadata` ────────────────────────────
-- `raw_user_meta_data` is writable BY THE USER through `auth.updateUser()`. A
-- role kept there could be granted by the person it restricts. `app_metadata` is
-- writable only by the service role and by triggers like this one.
--
-- ── Why the domain cannot be claimed by an outsider ─────────────────────────
-- There is no public sign-up: users exist because staff provisioned them
-- (scripts/seed-auth-users.mjs, service role). The login form passes
-- `shouldCreateUser: false` precisely so that typing an address cannot mint an
-- account — without that flag this trigger would happily make a stranger who
-- typed `x@vitti.capital` into staff. The two belong together.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.role_from_email_domain(addr text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  -- Anchored to the end so `evil@vitti.capital.attacker.com` is a client, and
  -- `@` is included so a domain merely ENDING in the string cannot match either
  -- (`notvitti.capital`).
  SELECT CASE
    WHEN lower(coalesce(addr, '')) LIKE '%@vitti.capital' THEN 'admin'
    ELSE 'client'
  END
$$;

COMMENT ON FUNCTION public.role_from_email_domain(text) IS
  'The workspace an address belongs to: @vitti.capital is staff, everything else is a client.';

CREATE OR REPLACE FUNCTION public.stamp_role_from_email()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Merged rather than assigned: `raw_app_meta_data` also carries the provider
  -- list Supabase maintains (`provider`, `providers`), and replacing the object
  -- would drop it.
  NEW.raw_app_meta_data =
    coalesce(NEW.raw_app_meta_data, '{}'::jsonb)
    || jsonb_build_object('role', public.role_from_email_domain(NEW.email));
  RETURN NEW;
END
$$;

-- BEFORE, so the stamped value is what gets stored rather than a second write.
-- `UPDATE OF email` as well as INSERT: an address that changes changes the
-- workspace with it, which is the point of deriving it at all. The new role
-- reaches the JWT on the next token refresh.
DROP TRIGGER IF EXISTS stamp_role_from_email ON auth.users;
CREATE TRIGGER stamp_role_from_email
  BEFORE INSERT OR UPDATE OF email ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.stamp_role_from_email();

-- ----------------------------------------------------------------------------
-- Backfill
-- ----------------------------------------------------------------------------
-- The trigger only fires on writes, so existing users keep whatever the seed
-- script stamped until they are touched. Done explicitly here so the rule holds
-- for everyone from the moment this migration lands rather than gradually.
--
-- Written straight into the column instead of relying on the trigger, because
-- the trigger is scoped to `UPDATE OF email` and this update does not touch it.
UPDATE auth.users
   SET raw_app_meta_data =
         coalesce(raw_app_meta_data, '{}'::jsonb)
         || jsonb_build_object('role', public.role_from_email_domain(email))
 WHERE coalesce(raw_app_meta_data ->> 'role', '') <> public.role_from_email_domain(email);

-- ----------------------------------------------------------------------------
-- Checking on it
-- ----------------------------------------------------------------------------
--   SELECT email, raw_app_meta_data ->> 'role' AS role, email_confirmed_at
--     FROM auth.users ORDER BY email;
--
--   -- Anyone whose stamped role disagrees with their address (should be none):
--   SELECT email, raw_app_meta_data ->> 'role'
--     FROM auth.users
--    WHERE raw_app_meta_data ->> 'role' IS DISTINCT FROM role_from_email_domain(email);
