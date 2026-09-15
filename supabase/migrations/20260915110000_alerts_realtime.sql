-- ---------------------------------------------------------------------------
-- Let the alerts bell hear about a row it did not cause.
--
-- Until now every alert was written by the client's own click, so the page that
-- caused it was already re-rendering. The scan changes that: a row appears in
-- Postgres while a page has been open for an hour, and the badge goes on saying
-- whatever it said at render. An alert about an exercise window closing is
-- worth very little if the client has to reload to be told.
--
-- Adding the table to `supabase_realtime` is what lets the browser subscribe.
-- `app/components/AlertsLive.tsx` listens for INSERT and calls
-- `router.refresh()` — it never reads the payload, so what travels over the
-- socket is only ever "something changed".
--
-- ── This does not widen who can see what ────────────────────────────────────
-- Supabase authorises `postgres_changes` against the same RLS policies as an
-- ordinary query, and `alerts_select` is already `is_staff() OR client_id =
-- current_client_id()`. A client's socket therefore carries only their own
-- rows, for the same reason their queries do, and firm-wide alerts (NULL
-- client_id) stay staff-only exactly as before.
--
-- REPLICA IDENTITY is left at its default. The subscriber is told an insert
-- happened and goes back to the server for the data, so there is nothing to be
-- gained from shipping full old-row images over the wire.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  -- Idempotent: adding a table already in the publication is an error, not a
  -- no-op, and this file should survive being run twice.
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'alerts'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.alerts;
  END IF;
END
$$;
