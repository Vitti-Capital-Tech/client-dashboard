-- ============================================================================
-- Several login emails, one client
-- ----------------------------------------------------------------------------
-- Until now a client WAS an email address. `clients.email` is UNIQUE, and both
-- `current_client_id()` and lib/session.ts resolve the signed-in person by
-- matching the JWT claim against that one column. One column, one address, one
-- login — which is wrong for the cases the desk actually has:
--
--   • a couple who both want to see the family portfolio;
--   • an SMSF with two trustees;
--   • a family office where the principal and the accountant both log in.
--
-- Every one of those was previously answered with "share the password", which
-- is the same account with the audit trail removed.
--
-- ── Why a table and not `clients.email_2` ──────────────────────────────────
-- Two columns would need two entries in every uniqueness check, two branches in
-- `current_client_id()`, and a third column the first time somebody wants three
-- addresses. The relationship is one-to-many; it gets a table.
--
-- ── Why `clients.email` survives ───────────────────────────────────────────
-- It is now a MIRROR of the primary address, maintained by trigger, and no
-- longer the thing anything resolves a login against. It is kept because a
-- dozen readers want "the address for this client" as a plain column and would
-- otherwise all grow a join: the staff clients table, `getClients`, the claim
-- queue's `clientEmail`, and the rail in `approve_account_claim` that refuses to
-- move an account away from an owner who can log in.
--
-- That rail deserves a word, because its correctness now rests on this mirror.
-- It reads `prev_client.email IS NOT NULL` to mean "somebody can log in as this
-- client". That stays true precisely because a client with any login has a
-- primary one — `block_primary_client_email_delete` below is what guarantees it
-- — so the column is NULL exactly when `client_emails` is empty for that row.
--
-- The mirror is one-way and recomputed from this table on every write, so the
-- two cannot drift the way `clients.email` and `auth.users.email` could before
-- 20260907090000_client_settings.sql put a trigger between them.
--
-- ── What this does NOT do ──────────────────────────────────────────────────
-- Each address is still its own `auth.users` row with its own password. Nothing
-- here merges credentials; it merges what they resolve to. Two people signing in
-- at two addresses see one portfolio and appear in the audit log under the one
-- client, which is the point.
-- ============================================================================

CREATE TABLE client_emails (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,

  -- The login address. UNIQUE across the whole table, not per client: this is
  -- the column a JWT claim is matched against, so an address resolving to two
  -- clients would be a person seeing two portfolios depending on which row came
  -- back first. Stored lower-cased — `auth.users.email` is, the app lower-cases
  -- everything it accepts, and a case-sensitive comparison here would be a
  -- login that works on Monday and not on Tuesday.
  email      text NOT NULL UNIQUE,

  -- The address shown as "the" address for this client, mirrored into
  -- `clients.email`. Exactly one per client (see the index below).
  is_primary boolean NOT NULL DEFAULT false,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT client_email_lowercase CHECK (email = lower(email)),
  CONSTRAINT client_email_shaped    CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
);

COMMENT ON TABLE client_emails IS
  'Every address that can sign in as a given client. The login-to-client mapping; clients.email is a mirror of the primary row.';

CREATE INDEX idx_client_emails_client ON client_emails(client_id);

-- One primary per client. A partial unique index rather than a CHECK because
-- the rule is about the SET of rows for a client, which a row constraint cannot
-- see. Promoting a different address therefore demotes the old one first — see
-- `set_primary_client_email`.
CREATE UNIQUE INDEX uq_client_emails_primary
  ON client_emails(client_id) WHERE is_primary;

-- ----------------------------------------------------------------------------
-- Backfill — every existing login becomes its client's primary address
-- ----------------------------------------------------------------------------
-- `clients.email` is nullable and most rows are NULL: the 54 broker-imported
-- clients have no login at all. Those get no row here, and `clients.email`
-- stays NULL for them, which is what the claim rail reads.
INSERT INTO client_emails (client_id, email, is_primary)
SELECT id, lower(btrim(email)), true
  FROM clients
 WHERE email IS NOT NULL AND btrim(email) <> '';

-- ----------------------------------------------------------------------------
-- The staff domain is not addable here either
-- ----------------------------------------------------------------------------
-- `stamp_role_from_email` stamps `app_metadata.role = 'admin'` on any
-- vitti.capital address. An admin JWT that ALSO resolved through this table
-- would be a staff member who satisfies `current_client_id()` — staff powers
-- plus a client's own rows, which is the exact shape
-- 20260905090000_password_signup.sql and `block_email_change_to_staff_domain`
-- were written to prevent. Same refusal, third door.
CREATE OR REPLACE FUNCTION public.block_staff_domain_client_email()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF public.role_from_email_domain(NEW.email) = 'admin' THEN
    RAISE EXCEPTION
      'A vitti.capital address cannot be added as a client login. Staff accounts are created by the desk.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.block_staff_domain_client_email() IS
  'Refuses a staff-domain address as a client login, which would make an admin JWT also resolve through current_client_id().';

CREATE TRIGGER block_staff_domain_client_email
  BEFORE INSERT OR UPDATE OF email ON client_emails
  FOR EACH ROW EXECUTE FUNCTION public.block_staff_domain_client_email();

-- ----------------------------------------------------------------------------
-- A client never loses its last login by accident
-- ----------------------------------------------------------------------------
-- The hazard is a client who still has logins but no PRIMARY one. `clients.email`
-- mirrors the primary, so that state reads as NULL — and `approve_account_claim`
-- reads NULL as "nobody can sign in as this client" and will re-parent their
-- accounts to whoever typed the number. Deleting the primary out from under two
-- other addresses is how that state gets created.
--
-- So the rule is not "the primary is undeletable" but "the primary is deletable
-- only when it is the last one". Removing a client's final login is a real
-- operation — it is what `npm run client:login -- <id> --unlink` does — and it
-- leaves `clients.email` NULL with the table empty, which is precisely the
-- state the rail is right about.
--
-- The `clients` existence check is what lets a real client deletion through:
-- `ON DELETE CASCADE` removes these rows as part of the parent's delete, by
-- which point the parent is already gone. Without it, cascading a client who
-- held three addresses would hit this guard on whichever row Postgres removed
-- first and refuse the whole delete.
CREATE OR REPLACE FUNCTION public.block_primary_client_email_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.is_primary
     AND EXISTS (SELECT 1 FROM public.clients WHERE id = OLD.client_id)
     AND EXISTS (SELECT 1 FROM public.client_emails
                  WHERE client_id = OLD.client_id AND id <> OLD.id)
  THEN
    RAISE EXCEPTION
      'That is the primary login for this client. Make another address primary before removing it.'
      USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END
$$;

COMMENT ON FUNCTION public.block_primary_client_email_delete() IS
  'Refuses deleting a primary login while the client has others. Guarantees a client with any login has a primary one, so clients.email is NULL exactly when the client has none.';

CREATE TRIGGER block_primary_client_email_delete
  BEFORE DELETE ON client_emails
  FOR EACH ROW EXECUTE FUNCTION public.block_primary_client_email_delete();

-- ----------------------------------------------------------------------------
-- clients.email mirrors the primary row
-- ----------------------------------------------------------------------------
-- Recomputed from the table rather than copied from the row that changed, so
-- the demote-then-promote pair a primary change is made of cannot leave the
-- mirror holding the losing address if the two statements arrive in the other
-- order. `IS DISTINCT FROM` keeps a no-op write from bumping `updated_at` on
-- every insert of an additional address.
CREATE OR REPLACE FUNCTION public.resync_primary_client_email(p_client uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  primary_email text;
BEGIN
  SELECT e.email INTO primary_email
    FROM public.client_emails e
   WHERE e.client_id = p_client AND e.is_primary;

  UPDATE public.clients
     SET email = primary_email
   WHERE id = p_client
     AND email IS DISTINCT FROM primary_email;
END
$$;

CREATE OR REPLACE FUNCTION public.mirror_primary_client_email()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Both sides on an UPDATE that re-parents an address: the client losing it
  -- needs its mirror recomputed just as much as the one gaining it.
  IF TG_OP <> 'INSERT' THEN
    PERFORM public.resync_primary_client_email(OLD.client_id);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM public.resync_primary_client_email(NEW.client_id);
  END IF;
  RETURN NULL;
END
$$;

COMMENT ON FUNCTION public.mirror_primary_client_email() IS
  'Keeps clients.email equal to the client primary client_emails row. One-way: this table is the source of truth.';

CREATE TRIGGER mirror_primary_client_email
  AFTER INSERT OR UPDATE OR DELETE ON client_emails
  FOR EACH ROW EXECUTE FUNCTION public.mirror_primary_client_email();

-- ----------------------------------------------------------------------------
-- Promoting an address, as one statement
-- ----------------------------------------------------------------------------
-- `uq_client_emails_primary` means the old primary must be demoted before the
-- new one is promoted, and doing that as two round trips from the app leaves a
-- window where the client has no primary and `clients.email` is NULL — long
-- enough for a concurrent read to see a client who cannot be signed in as.
-- One function, one transaction, and the app cannot get the order wrong.
--
-- SECURITY DEFINER with its own authorisation check, in the pattern
-- `approve_account_claim` established: `client_emails` has no write policy, so
-- this is the only way a client changes their own primary.
CREATE OR REPLACE FUNCTION public.set_primary_client_email(p_email text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  addr   text := lower(btrim(coalesce(p_email, '')));
  caller uuid := public.current_client_id();
  owner  uuid;
BEGIN
  IF caller IS NULL THEN
    RAISE EXCEPTION 'No client is signed in.' USING ERRCODE = '42501';
  END IF;

  SELECT client_id INTO owner FROM public.client_emails WHERE email = addr;

  -- One message for "no such address" and "somebody else's address". The caller
  -- may only ever name their own, so distinguishing the two would answer
  -- "is this address registered here" for any address they care to type.
  IF owner IS NULL OR owner <> caller THEN
    RAISE EXCEPTION 'That address is not one of your logins.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.client_emails
     SET is_primary = false
   WHERE client_id = caller AND is_primary AND email <> addr;

  UPDATE public.client_emails
     SET is_primary = true
   WHERE email = addr;
END
$$;

COMMENT ON FUNCTION public.set_primary_client_email(text) IS
  'Promotes one of the caller own login addresses to primary, demoting the previous one in the same transaction.';

REVOKE ALL ON FUNCTION public.set_primary_client_email(text) FROM public;
GRANT EXECUTE ON FUNCTION public.set_primary_client_email(text) TO authenticated;

-- ----------------------------------------------------------------------------
-- current_client_id — resolved through the table now
-- ----------------------------------------------------------------------------
-- The one line this whole migration exists to change. Still SECURITY DEFINER,
-- and now for a second reason: it reads `client_emails`, whose own policy calls
-- it, and bypassing RLS is what stops that being a recursion.
--
-- `lower()` on the claim to match the column's stored form. GoTrue lower-cases
-- addresses on the way in, so this is belt and braces rather than a fix.
CREATE OR REPLACE FUNCTION public.current_client_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT client_id FROM public.client_emails
   WHERE email = lower(auth.jwt() ->> 'email')
$$;

COMMENT ON FUNCTION public.current_client_id() IS
  'The clients.id the signed-in address resolves to, via client_emails. Several addresses may return the same id.';

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------
-- Readable by the client it belongs to (they are shown their own list on the
-- Settings page) and by staff. No write policies at all, matching `clients`:
-- additions run through the service role after an emailed code is verified, and
-- promotion through `set_primary_client_email` above. An INSERT policy here
-- would have to read "any authenticated user may attach an address to some
-- client", which is the whole security question, not an answer to it.
ALTER TABLE client_emails ENABLE ROW LEVEL SECURITY;

CREATE POLICY client_emails_select ON client_emails FOR SELECT TO authenticated
  USING (is_staff() OR client_id = current_client_id());

-- `clients` no longer compares the claim itself — there may be several claims
-- that reach one row. `current_client_id()` reads `client_emails` and not
-- `clients`, so calling it from a `clients` policy is not the recursion the
-- original comment here was avoiding.
DROP POLICY IF EXISTS clients_select ON clients;
CREATE POLICY clients_select ON clients FOR SELECT TO authenticated
  USING (is_staff() OR id = current_client_id());

-- ----------------------------------------------------------------------------
-- An email change moves the row it is a change OF
-- ----------------------------------------------------------------------------
-- `sync_client_email_from_auth` (20260907090000_client_settings.sql) kept
-- `clients.email` in step with `auth.users.email`. That column is now a mirror,
-- so writing to it directly would be overwritten by the next resync — and worse,
-- it would move the PRIMARY address even when the person changed a secondary
-- one, silently swapping which of their two logins is "the" one.
--
-- Matched on OLD.email for the same reason as before: `client_emails` has no FK
-- to `auth.users` and the two are joined by address. Staff have no row here, so
-- this updates nothing for them.
CREATE OR REPLACE FUNCTION public.sync_client_email_from_auth()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    UPDATE public.client_emails
       SET email = lower(NEW.email)
     WHERE email = lower(OLD.email);
  END IF;
  RETURN NEW;
END
$$;

COMMENT ON FUNCTION public.sync_client_email_from_auth() IS
  'Keeps client_emails in lockstep with auth.users.email. Without it a confirmed email change leaves the person authenticated and attached to no client row.';

-- ----------------------------------------------------------------------------
-- auth_user_id_for_email — because the admin API has no "get user by email"
-- ----------------------------------------------------------------------------
-- Removing a login deletes the `auth.users` row behind it, and `deleteUser`
-- needs an id. The admin API only offers `listUsers`, which is paginated, so
-- finding one address means walking pages of every user in the project — slow,
-- and wrong the moment the project outgrows the page size somebody chose.
--
-- ── Why this is not an enumeration oracle ──────────────────────────────────
-- It would be a fine one — "does this address have an account here" for any
-- address typed — which is why EXECUTE is granted to `service_role` alone and
-- revoked from everyone else, `authenticated` included. There is no path to it
-- from a browser: the only caller is a server action already holding the
-- service key, which could read `auth.users` regardless. This narrows what that
-- key is used for; it does not widen who may ask.
CREATE OR REPLACE FUNCTION public.auth_user_id_for_email(addr text)
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM auth.users WHERE lower(email) = lower(btrim(coalesce(addr, '')))
$$;

COMMENT ON FUNCTION public.auth_user_id_for_email(text) IS
  'The auth.users id for an address. service_role only — it answers "is this address registered here" for any address asked.';

REVOKE ALL ON FUNCTION public.auth_user_id_for_email(text) FROM public;
REVOKE ALL ON FUNCTION public.auth_user_id_for_email(text) FROM authenticated, anon;
GRANT EXECUTE ON FUNCTION public.auth_user_id_for_email(text) TO service_role;

-- ----------------------------------------------------------------------------
-- Checking on it
-- ----------------------------------------------------------------------------
--   -- Clients with more than one login:
--   SELECT c.display_name, count(*), array_agg(e.email ORDER BY e.is_primary DESC)
--     FROM client_emails e JOIN clients c ON c.id = e.client_id
--    GROUP BY c.id, c.display_name HAVING count(*) > 1;
--
--   -- The mirror should never disagree (expect no rows):
--   SELECT c.id, c.email, e.email
--     FROM clients c
--     LEFT JOIN client_emails e ON e.client_id = c.id AND e.is_primary
--    WHERE c.email IS DISTINCT FROM e.email;
--
--   -- A login with no auth user behind it (expect no rows):
--   SELECT e.email FROM client_emails e
--    WHERE NOT EXISTS (SELECT 1 FROM auth.users u WHERE lower(u.email) = e.email);
