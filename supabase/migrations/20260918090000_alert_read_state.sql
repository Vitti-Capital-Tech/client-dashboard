-- ---------------------------------------------------------------------------
-- Read state for alerts, per audience.
--
-- ── The problem ────────────────────────────────────────────────────────────
-- `acknowledged` has been carrying two jobs that pull in opposite directions:
--
--   • "somebody has SEEN this"    — a UI fact. Should clear the moment the
--     bell is opened, the way every notification bell in the world works.
--   • "somebody has DEALT WITH this" — a desk fact. Must never clear because a
--     drawer slid open.
--
-- and it carried them for two audiences at once, on one shared boolean. So the
-- desk acknowledging a client's expiry alert also marked it read in that
-- client's portal — the client's badge dropped to zero for an alert nobody had
-- shown them. One row, one flag, two people who needed different answers.
--
-- That was survivable only because acknowledging was a deliberate per-item
-- click that rarely happened. The bell now marks things read on open, which is
-- the whole point of the change, and at that rate the collision stops being a
-- corner case: one staff member opening the drawer would silence the unread
-- badge for all 54 clients.
--
-- ── The fix ────────────────────────────────────────────────────────────────
-- Two nullable timestamps, one per audience. NULL means unread, which is the
-- correct default for a row that has just been inserted and is what every new
-- alert therefore gets for free — `lib/alerts/scan.ts` needs no change.
--
-- Timestamps rather than booleans because "when did the desk first see this"
-- is a question worth being able to answer later (how long an expiry warning
-- sat unread is a real service-quality measure), and a timestamp costs the same
-- as a boolean to store and nothing to read.
--
-- `acknowledged` is deliberately LEFT IN PLACE and left alone. It is history —
-- who acted on what, and when — and dropping a column to tidy up a UI change
-- would destroy that. Nothing in the app writes it any more; the read model
-- below is what the badge, the drawer and the alerts pages use.
-- ---------------------------------------------------------------------------

ALTER TABLE alerts
  ADD COLUMN IF NOT EXISTS read_at       timestamptz,
  ADD COLUMN IF NOT EXISTS staff_read_at timestamptz;

COMMENT ON COLUMN alerts.read_at IS
  'When the CLIENT this alert belongs to first saw it. NULL = unread in the client portal. Firm-wide alerts (client_id IS NULL) are never shown to a client and keep this NULL forever.';
COMMENT ON COLUMN alerts.staff_read_at IS
  'When the DESK first saw this alert. NULL = unread on the staff console. Independent of read_at: neither audience can mark the other''s notification as seen.';

-- ── Backfill ───────────────────────────────────────────────────────────────
-- An alert someone already acknowledged has self-evidently been seen, by both
-- sides — under the old shared flag that is precisely what acknowledging meant.
-- Carrying it across keeps the first load after this migration honest: the desk
-- sees its genuine backlog of unread alerts rather than every alert ever
-- written, and a client whose alerts were all cleared last month does not get a
-- badge telling them otherwise.
--
-- `acknowledged_at` is the truthful timestamp where one was recorded;
-- `triggered_at` is the floor for the older rows written before it was.
UPDATE alerts
   SET read_at       = coalesce(acknowledged_at, triggered_at),
       staff_read_at = coalesce(acknowledged_at, triggered_at)
 WHERE acknowledged
   AND read_at IS NULL
   AND staff_read_at IS NULL;

-- ── Indexes ────────────────────────────────────────────────────────────────
-- Both badges are read on EVERY portal request (app/portal/layout.tsx), so the
-- "how many unread" count is one of the hottest queries in the app. Partial, on
-- the unread rows only, because that is the side being counted and it is the
-- small side — the index stays tiny as the table grows, since a row leaves it
-- for good the first time it is read.
CREATE INDEX IF NOT EXISTS alerts_unread_client_idx
  ON alerts (client_id, triggered_at DESC)
  WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS alerts_unread_staff_idx
  ON alerts (triggered_at DESC)
  WHERE staff_read_at IS NULL;

-- ---------------------------------------------------------------------------
-- Marking read, without letting either audience mark the other's.
--
-- The obvious implementation is an UPDATE from the app, and it is the wrong
-- one: `alerts_update` (the RLS policy) is `is_staff() OR client_id =
-- current_client_id()`, which authorises a client to write ANY column on their
-- own rows — including `staff_read_at`. Nothing in our UI would do that, but
-- PostgREST is a public HTTP API and "our UI would not do that" is not an
-- access control. A client could clear the desk's backlog from the console.
--
-- So the column each caller may write is decided in the database, from the JWT,
-- rather than by the caller. SECURITY DEFINER to get past the revoked UPDATE
-- grant below — which means RLS no longer filters the rows for us, so BOTH
-- branches scope themselves explicitly. The client branch's `client_id =
-- current_client_id()` is the whole of that scoping and it is load-bearing:
-- without it this function marks every client's alerts read.
--
-- `up_to` is the newest alert the caller had actually been shown. An alert that
-- arrives between the page rendering and the drawer opening is therefore not
-- swallowed — it stays unread, and the badge is right on the next refresh.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_alerts_read(up_to timestamptz DEFAULT now())
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  marked integer;
BEGIN
  IF public.is_staff() THEN
    UPDATE alerts
       SET staff_read_at = now()
     WHERE staff_read_at IS NULL
       AND triggered_at <= up_to;
  ELSE
    UPDATE alerts
       SET read_at = now()
     WHERE read_at IS NULL
       AND triggered_at <= up_to
       AND client_id = public.current_client_id();
  END IF;

  GET DIAGNOSTICS marked = ROW_COUNT;
  RETURN marked;
END;
$$;

COMMENT ON FUNCTION public.mark_alerts_read(timestamptz) IS
  'Marks every alert the caller can see, triggered at or before `up_to`, as read for the caller''s own audience. Staff write staff_read_at, clients write read_at; neither can write the other''s.';

-- An anonymous caller has no audience — `is_staff()` is false and
-- `current_client_id()` is NULL, so the else-branch would match nothing — but
-- an endpoint that exists for no reason is still an endpoint.
REVOKE ALL ON FUNCTION public.mark_alerts_read(timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_alerts_read(timestamptz) TO authenticated;

-- The function is now the ONLY way a signed-in user changes an alert, which is
-- what makes the JWT-side column choice above worth anything. Read and insert
-- are untouched: `alerts_select` still scopes the drawer, and `addCustomAlert`
-- still writes its confirmation row.
--
-- The scan (`lib/alerts/scan.ts`) is unaffected — it connects as `service_role`,
-- a different grantee, and only inserts.
REVOKE UPDATE ON alerts FROM authenticated;
