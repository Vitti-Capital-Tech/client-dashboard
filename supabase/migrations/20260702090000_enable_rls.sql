-- ============================================================================
-- Row-Level Security (Stage 8)
-- ----------------------------------------------------------------------------
-- Enforces "a client sees/writes only their own rows; staff (admin) see/write
-- everything; shared market/research reference data is readable by any signed-in
-- user" AT THE DATABASE, not just in app code.
--
-- Identity model (interim, email-based — see lib/session.ts):
--   • role      → JWT app_metadata.role ('admin' | 'client')   [is_staff()]
--   • client id → clients.id matched by the JWT email           [current_client_id()]
-- When real Supabase Auth linkage by auth.uid() lands, only these two helpers
-- change; the policies below stay the same.
--
-- The `service_role` (used by scripts/seed-auth-users.mjs and any admin tooling)
-- bypasses RLS automatically, so seeding is unaffected.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Helper functions
-- ----------------------------------------------------------------------------

-- True when the caller's JWT carries app_metadata.role = 'admin'.
CREATE OR REPLACE FUNCTION public.is_staff()
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT coalesce(auth.jwt() -> 'app_metadata' ->> 'role', 'client') = 'admin'
$$;

-- The clients.id for the currently signed-in client, resolved by JWT email.
-- SECURITY DEFINER so it bypasses RLS on `clients` (prevents policy recursion
-- when other tables' policies call this from within a clients RLS context).
CREATE OR REPLACE FUNCTION public.current_client_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id FROM public.clients WHERE email = (auth.jwt() ->> 'email')
$$;

-- ----------------------------------------------------------------------------
-- Shared reference / market / research data — readable by any signed-in user.
-- Writes are staff-only (settlePlacement upserts securities/placements; the rest
-- are adviser-authored content managed out of band).
-- ----------------------------------------------------------------------------
ALTER TABLE securities        ENABLE ROW LEVEL SECURITY;
ALTER TABLE market_indices    ENABLE ROW LEVEL SECURITY;
ALTER TABLE placements        ENABLE ROW LEVEL SECURITY;
ALTER TABLE signals           ENABLE ROW LEVEL SECURITY;
ALTER TABLE sectors           ENABLE ROW LEVEL SECURITY;
ALTER TABLE news              ENABLE ROW LEVEL SECURITY;
ALTER TABLE investment_ideas  ENABLE ROW LEVEL SECURITY;
ALTER TABLE recommendations   ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_reports  ENABLE ROW LEVEL SECURITY;
ALTER TABLE research_notes    ENABLE ROW LEVEL SECURITY;

CREATE POLICY ref_read_securities       ON securities       FOR SELECT TO authenticated USING (true);
CREATE POLICY ref_read_market_indices   ON market_indices   FOR SELECT TO authenticated USING (true);
CREATE POLICY ref_read_placements       ON placements       FOR SELECT TO authenticated USING (true);
CREATE POLICY ref_read_signals          ON signals          FOR SELECT TO authenticated USING (true);
CREATE POLICY ref_read_sectors          ON sectors          FOR SELECT TO authenticated USING (true);
CREATE POLICY ref_read_news             ON news             FOR SELECT TO authenticated USING (true);
CREATE POLICY ref_read_investment_ideas ON investment_ideas FOR SELECT TO authenticated USING (true);
CREATE POLICY ref_read_recommendations  ON recommendations  FOR SELECT TO authenticated USING (true);
CREATE POLICY ref_read_research_reports ON research_reports FOR SELECT TO authenticated USING (true);
CREATE POLICY ref_read_research_notes   ON research_notes   FOR SELECT TO authenticated USING (true);

-- Staff-only writes on the two reference tables the settlement engine touches.
CREATE POLICY ref_write_securities ON securities FOR ALL TO authenticated
  USING (is_staff()) WITH CHECK (is_staff());
CREATE POLICY ref_write_placements ON placements FOR ALL TO authenticated
  USING (is_staff()) WITH CHECK (is_staff());

-- ----------------------------------------------------------------------------
-- CLIENTS — a client sees only their own row; staff see all. (No app writes.)
-- Uses the email claim directly to avoid recursing through current_client_id().
-- ----------------------------------------------------------------------------
ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
CREATE POLICY clients_select ON clients FOR SELECT TO authenticated
  USING (is_staff() OR email = (auth.jwt() ->> 'email'));

-- ----------------------------------------------------------------------------
-- CLIENT_ACCOUNTS (cash) — own row or staff.
-- ----------------------------------------------------------------------------
ALTER TABLE client_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY accounts_select ON client_accounts FOR SELECT TO authenticated
  USING (is_staff() OR client_id = current_client_id());

-- ----------------------------------------------------------------------------
-- POSITIONS / OPTION_HOLDINGS — read own or staff; inserts are staff-only
-- (issued by the settlement engine on behalf of clients).
-- ----------------------------------------------------------------------------
ALTER TABLE positions ENABLE ROW LEVEL SECURITY;
CREATE POLICY positions_select ON positions FOR SELECT TO authenticated
  USING (is_staff() OR client_id = current_client_id());
CREATE POLICY positions_write ON positions FOR ALL TO authenticated
  USING (is_staff()) WITH CHECK (is_staff());

ALTER TABLE option_holdings ENABLE ROW LEVEL SECURITY;
CREATE POLICY options_select ON option_holdings FOR SELECT TO authenticated
  USING (is_staff() OR client_id = current_client_id());
CREATE POLICY options_write ON option_holdings FOR ALL TO authenticated
  USING (is_staff()) WITH CHECK (is_staff());

-- ----------------------------------------------------------------------------
-- BIDS — a client may read/insert/update/delete only their own bid; staff any
-- (scaleBids updates allocations across all bidders).
-- ----------------------------------------------------------------------------
ALTER TABLE bids ENABLE ROW LEVEL SECURITY;
CREATE POLICY bids_select ON bids FOR SELECT TO authenticated
  USING (is_staff() OR client_id = current_client_id());
CREATE POLICY bids_insert ON bids FOR INSERT TO authenticated
  WITH CHECK (is_staff() OR client_id = current_client_id());
CREATE POLICY bids_update ON bids FOR UPDATE TO authenticated
  USING (is_staff() OR client_id = current_client_id())
  WITH CHECK (is_staff() OR client_id = current_client_id());
CREATE POLICY bids_delete ON bids FOR DELETE TO authenticated
  USING (is_staff() OR client_id = current_client_id());

-- ----------------------------------------------------------------------------
-- WATCHLIST_ITEMS — full CRUD on own rows; staff any (addCustomAlert may be run
-- by staff on behalf of a client).
-- ----------------------------------------------------------------------------
ALTER TABLE watchlist_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY watch_all ON watchlist_items FOR ALL TO authenticated
  USING (is_staff() OR client_id = current_client_id())
  WITH CHECK (is_staff() OR client_id = current_client_id());

-- ----------------------------------------------------------------------------
-- ALERTS — read/insert/update own; staff any. (Firm-wide alerts have a NULL
-- client_id and are therefore staff-visible only, matching getAlerts scoping.)
-- ----------------------------------------------------------------------------
ALTER TABLE alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY alerts_select ON alerts FOR SELECT TO authenticated
  USING (is_staff() OR client_id = current_client_id());
CREATE POLICY alerts_insert ON alerts FOR INSERT TO authenticated
  WITH CHECK (is_staff() OR client_id = current_client_id());
CREATE POLICY alerts_update ON alerts FOR UPDATE TO authenticated
  USING (is_staff() OR client_id = current_client_id())
  WITH CHECK (is_staff() OR client_id = current_client_id());

-- ----------------------------------------------------------------------------
-- AUDIT_LOG — read own (or staff); INSERT-only for authenticated users (the
-- append-only trigger from the init migration already blocks UPDATE/DELETE).
-- ----------------------------------------------------------------------------
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_select ON audit_log FOR SELECT TO authenticated
  USING (is_staff() OR client_id = current_client_id());
CREATE POLICY audit_insert ON audit_log FOR INSERT TO authenticated
  WITH CHECK (is_staff() OR client_id = current_client_id());
