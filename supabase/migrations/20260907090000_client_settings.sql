-- ============================================================================
-- Client settings: knowing whether you have a password, and changing your login
-- ----------------------------------------------------------------------------
-- Three things a self-service Settings page needs that the app cannot do on its
-- own, because all three are facts about `auth.users` — a table PostgREST does
-- not expose and the anon key cannot read.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. user_has_password — does the caller sign in with a password at all?
-- ----------------------------------------------------------------------------
-- The Settings page has to ask for the CURRENT password before changing it, and
-- that question is wrong for most of this firm's clients: every login the broker
-- import or `scripts/link-client-login.mjs` created has no password and signs in
-- with an emailed code (§8.32). Asking them for a current password would answer
-- "that password is incorrect", which is both untrue and unactionable.
--
-- So the page asks the database first and shows the right form: "change your
-- password" for those who have one, "set a password" — through the code flow —
-- for those who do not.
--
-- SECURITY DEFINER, and scoped to `auth.uid()` with no parameter. There is
-- deliberately no way to ask this about somebody else: a function taking an
-- address would report which of the firm's clients hold passwords, and one
-- taking a user id would do the same to anyone who could guess one.
CREATE OR REPLACE FUNCTION public.user_has_password()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, auth
AS $$
  SELECT coalesce(encrypted_password, '') <> ''
    FROM auth.users
   WHERE id = auth.uid()
$$;

COMMENT ON FUNCTION public.user_has_password() IS
  'True when the calling user has a password set. Scoped to auth.uid() on purpose — it must not be answerable about anyone else.';

REVOKE ALL ON FUNCTION public.user_has_password() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_has_password() TO authenticated;

-- ----------------------------------------------------------------------------
-- 2. A client must not be able to rename themselves into staff
-- ----------------------------------------------------------------------------
-- `stamp_role_from_email` (20260903140000) fires on `UPDATE OF email` as well as
-- INSERT — deliberately, so that an address which changes changes the workspace
-- with it. That was safe while only the service role could change an address.
--
-- A Settings page that lets a client change their own login email turns it into
-- a privilege escalation: change it to `anything@vitti.capital`, the trigger
-- stamps `app_metadata.role = 'admin'`, and the next token refresh lands them in
-- the desk console reading every client's positions.
--
-- Supabase's own confirmation flow is not the answer either. It proves the
-- person can read mail at the new address, and nobody outside the firm can read
-- a vitti.capital mailbox — but `double_confirm_changes` is a project setting,
-- and a rule this consequential should not rest on a checkbox.
--
-- Refused outright instead: an existing login is never moved onto the staff
-- domain. Somebody who joins the firm gets a staff account created for them
-- (`provisionStaffAccount`), which is a different act by a different person.
CREATE OR REPLACE FUNCTION public.block_email_change_to_staff_domain()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email
     AND public.role_from_email_domain(NEW.email) = 'admin'
     AND public.role_from_email_domain(OLD.email) <> 'admin'
  THEN
    RAISE EXCEPTION
      'A login cannot be moved onto a vitti.capital address. Staff accounts are created by the desk.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.block_email_change_to_staff_domain() IS
  'Refuses changing an existing login onto the staff domain, which stamp_role_from_email would otherwise promote to admin.';

-- Named to sort before `stamp_role_from_email`: same table, same timing, and
-- Postgres fires BEFORE triggers in name order, so the refusal happens before
-- anything stamps a role on the row.
DROP TRIGGER IF EXISTS block_email_change_to_staff_domain ON auth.users;
CREATE TRIGGER block_email_change_to_staff_domain
  BEFORE UPDATE OF email ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.block_email_change_to_staff_domain();

-- ----------------------------------------------------------------------------
-- 3. clients.email follows auth.users.email, in the same transaction
-- ----------------------------------------------------------------------------
-- A client login is two halves in two places, and `scripts/link-client-login.mjs`
-- exists precisely because doing them separately goes wrong. An email CHANGE is
-- the same problem with worse timing:
--
--   • `lib/session.ts` resolves the client row by the JWT email, and so does the
--     RLS helper `current_client_id()`. If `auth.users.email` moves and
--     `clients.email` does not, the person is authenticated and attached to
--     NOTHING — every policy denies them, and the portal is empty rather than
--     broken-looking.
--   • The change lands asynchronously. `updateUser({ email })` does not move the
--     address; confirming the emailed link does, possibly days later and
--     possibly from a device the app never sees. There is no request in flight
--     at that moment for the app to hook.
--
-- A trigger is the only place that observes the actual change. It runs inside the
-- same transaction as the auth update, so the two halves cannot drift.
--
-- This also closes a hazard that predates the Settings page: changing an address
-- by hand in the Supabase dashboard (Authentication → Users) silently detached
-- the client. It now follows.
CREATE OR REPLACE FUNCTION public.sync_client_email_from_auth()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    -- Matched on OLD.email rather than a user id, because `clients` has no FK to
    -- `auth.users` — the two are joined by address, which is the whole reason
    -- this trigger has to exist. Staff have no `clients` row, so this updates
    -- nothing for them, which is correct.
    UPDATE public.clients
       SET email = NEW.email
     WHERE email = OLD.email;
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.sync_client_email_from_auth() IS
  'Keeps clients.email in lockstep with auth.users.email. Without it a confirmed email change leaves the client authenticated and attached to no client row.';

DROP TRIGGER IF EXISTS sync_client_email_from_auth ON auth.users;
CREATE TRIGGER sync_client_email_from_auth
  AFTER UPDATE OF email ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.sync_client_email_from_auth();

-- ----------------------------------------------------------------------------
-- Checking on it
-- ----------------------------------------------------------------------------
--   -- Any client whose login has drifted from its auth row (should be none):
--   SELECT c.id, c.display_name, c.email
--     FROM clients c
--    WHERE c.email IS NOT NULL
--      AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.email = c.email);
--
--   -- Should raise (a client renaming into staff):
--   UPDATE auth.users SET email = 'x@vitti.capital'
--    WHERE email = 'someone@example.com';
