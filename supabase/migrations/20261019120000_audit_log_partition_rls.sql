-- ============================================================================
-- Lock down audit_log's partitions
-- ============================================================================
-- RLS was enabled on `audit_log` itself (20260702090000_enable_rls.sql), but
-- audit_log is partitioned and its rows live in the partitions — and Postgres
-- does NOT carry a parent's RLS onto them. Each partition is an ordinary table
-- in `public`, so PostgREST served it directly: anyone holding the anon key,
-- which ships to every browser, could read or insert through
-- `/rest/v1/audit_log_default` and skip every audit policy. Supabase flagged
-- all three as UNRESTRICTED.
--
-- The fix leaves the app untouched. A query through the parent is checked
-- against the PARENT's policies and grants only, so reading and writing
-- `audit_log` works exactly as before. What changes is that the partitions,
-- addressed directly, now refuse everyone but the service role: RLS on with no
-- policies denies all, and the grants are withdrawn as well so the API does not
-- even offer them.
--
-- Done for every partition that exists rather than three names, so a monthly
-- partition somebody adds later is covered by re-running this file.
-- ============================================================================

DO $$
DECLARE
  part regclass;
BEGIN
  FOR part IN
    SELECT inhrelid::regclass
      FROM pg_inherits
     WHERE inhparent = 'public.audit_log'::regclass
  LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', part);
    EXECUTE format('REVOKE ALL ON %s FROM anon, authenticated', part);
  END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- Checking on it
-- ----------------------------------------------------------------------------
-- Every table in `public` without RLS — should return nothing:
--   SELECT c.relname
--     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
--      AND NOT c.relrowsecurity;
