-- ============================================================================
-- Vitti Capital — Client Dashboard schema (PostgreSQL)
-- ----------------------------------------------------------------------------
-- Portable DDL: runs identically on Supabase, Neon, and AWS Aurora Postgres.
-- Design goals (see scaling discussion):
--   1. Stay relational — integrity constraints ARE the product in finance.
--   2. Index every foreign key from day one.
--   3. Prices live once in `securities`, not duplicated per holding (cache-friendly).
--   4. `audit_log` is append-only and time-partitioned (fastest-growing table).
-- Money: numeric(18,2). Prices: numeric(18,4). Qty: numeric(20,4). %: numeric(8,4).
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()

-- ----------------------------------------------------------------------------
-- Enums
-- ----------------------------------------------------------------------------
CREATE TYPE option_type     AS ENUM ('Call', 'Put');
CREATE TYPE option_status   AS ENUM ('open', 'pending', 'expired');
CREATE TYPE placement_type  AS ENUM ('Placement', 'SPP', 'Pre-IPO', 'Rights');
CREATE TYPE placement_stage AS ENUM ('upcoming', 'open', 'closed', 'settled');
CREATE TYPE alert_kind      AS ENUM ('expiry', 'itm', 'window', 'price');
CREATE TYPE alert_severity  AS ENUM ('red', 'amber', 'green');
CREATE TYPE alert_direction AS ENUM ('above', 'below');
CREATE TYPE news_direction  AS ENUM ('up', 'dn');
CREATE TYPE signal_action   AS ENUM ('Add', 'Hold', 'Trim', 'Take profit', 'Watch');
CREATE TYPE risk_level      AS ENUM ('Low', 'Medium', 'High');

-- ----------------------------------------------------------------------------
-- updated_at helper
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- REFERENCE / MARKET MASTER DATA  (shared across all clients — cache these)
-- ============================================================================

-- One row per tradeable instrument. `last_price` is updated by the market feed
-- and read by every client's dashboard — store it ONCE here, never per-holding.
CREATE TABLE securities (
  code           text PRIMARY KEY,                 -- ASX code, e.g. 'BHP'
  name           text        NOT NULL,
  sector         text,
  listed         boolean     NOT NULL DEFAULT true,
  last_price     numeric(18,4),
  last_price_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_securities_updated BEFORE UPDATE ON securities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Market indices / FX / commodities strip (XJO, AUDUSD, gold, brent…).
CREATE TABLE market_indices (
  code            text PRIMARY KEY,
  name            text        NOT NULL,
  last            numeric(18,4) NOT NULL,
  chg             numeric(8,4)  NOT NULL,          -- % change
  decimal_places  smallint    NOT NULL DEFAULT 1,  -- display precision (was `dp`)
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- CLIENTS & ACCOUNTS
-- ============================================================================
CREATE TABLE clients (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref            text UNIQUE,                       -- legacy id, e.g. 'C1'
  display_name   text        NOT NULL,
  initials       text,                              -- avatar initials (was `av`)
  account_type   text        NOT NULL,             -- 'Individual · wholesale', 'SMSF · wholesale'…
  s708_expiry    date,                              -- wholesale certificate expiry
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_clients_updated BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Cash sits apart from holdings (can be multi-account / multi-currency later).
CREATE TABLE client_accounts (
  client_id      uuid PRIMARY KEY REFERENCES clients(id) ON DELETE CASCADE,
  cash_balance   numeric(18,2) NOT NULL DEFAULT 0,
  currency       char(3)       NOT NULL DEFAULT 'AUD',
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- HOLDINGS
-- ============================================================================

-- Equity positions. `name`/`sector`/`last` are NOT stored here — join securities.
CREATE TABLE positions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      uuid NOT NULL REFERENCES clients(id)    ON DELETE CASCADE,
  security_code  text NOT NULL REFERENCES securities(code),
  qty            numeric(20,4) NOT NULL,
  avg_cost       numeric(18,4) NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, security_code)
);
CREATE INDEX idx_positions_client   ON positions(client_id);
CREATE INDEX idx_positions_security ON positions(security_code);
CREATE TRIGGER trg_positions_updated BEFORE UPDATE ON positions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Option holdings. `dte` is computed from expiry_date at read time (never stale);
-- underlying price comes from securities via underlying_code.
CREATE TABLE option_holdings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref             text UNIQUE,                      -- legacy id, e.g. 'O1'
  client_id       uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  code            text NOT NULL,                    -- option code, e.g. 'VEXO'
  name            text NOT NULL,
  listed          boolean NOT NULL,
  option_type     option_type   NOT NULL,
  qty             numeric(20,4)  NOT NULL,
  strike          numeric(18,4)  NOT NULL,
  underlying_code text REFERENCES securities(code), -- for `under` (underlying px)
  expiry_date     date           NOT NULL,          -- dte = expiry_date - current_date
  source          text,
  status          option_status  NOT NULL DEFAULT 'open',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_options_client     ON option_holdings(client_id);
CREATE INDEX idx_options_underlying ON option_holdings(underlying_code);
CREATE INDEX idx_options_expiry     ON option_holdings(expiry_date) WHERE status = 'open';
CREATE TRIGGER trg_options_updated BEFORE UPDATE ON option_holdings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- PLACEMENTS / CAPITAL RAISINGS  &  BIDS
-- ============================================================================
CREATE TABLE placements (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref            text UNIQUE,                       -- legacy id, e.g. 'P1'
  code           text NOT NULL,
  name           text NOT NULL,
  type           placement_type  NOT NULL,
  price          numeric(18,4)   NOT NULL,
  last           numeric(18,4),                     -- null until listed/traded
  discount_pct   numeric(8,4),
  raise_millions numeric(12,2)   NOT NULL,
  min_bid        numeric(18,2)   NOT NULL,
  opts           text,                              -- attaching-option terms, e.g. '1 free option (1:2)'
  stage          placement_stage NOT NULL DEFAULT 'upcoming',
  close_date     date,
  alloc_date     date,
  settle_date    date,
  allot_date     date,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_placements_stage ON placements(stage);
CREATE TRIGGER trg_placements_updated BEFORE UPDATE ON placements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE bids (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  placement_id   uuid NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
  client_id      uuid NOT NULL REFERENCES clients(id)    ON DELETE CASCADE,
  amount         numeric(18,2) NOT NULL,
  alloc          numeric(18,2),                     -- null until scaled/allocated
  paid           boolean NOT NULL DEFAULT false,    -- BPAY received (was `_paid`)
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (placement_id, client_id)                  -- one bid per client per deal
);
CREATE INDEX idx_bids_placement ON bids(placement_id);
CREATE INDEX idx_bids_client    ON bids(client_id);
CREATE TRIGGER trg_bids_updated BEFORE UPDATE ON bids
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================================
-- WATCHLISTS & ALERTS
-- ============================================================================
CREATE TABLE watchlist_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  security_code    text,                            -- may be unlisted/pre-IPO (no FK)
  display_name     text NOT NULL,
  alert_threshold  numeric(18,4),
  alert_direction  alert_direction,
  unlisted         boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_id, security_code)
);
CREATE INDEX idx_watch_client ON watchlist_items(client_id);

CREATE TABLE alerts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id        uuid REFERENCES clients(id) ON DELETE CASCADE,   -- null = firm-wide
  option_id        uuid REFERENCES option_holdings(id) ON DELETE SET NULL,
  kind             alert_kind     NOT NULL,
  severity         alert_severity NOT NULL,
  title            text NOT NULL,
  subtitle         text,
  triggered_at     timestamptz NOT NULL DEFAULT now(),
  acknowledged     boolean NOT NULL DEFAULT false,
  acknowledged_by  text,
  acknowledged_at  timestamptz
);
CREATE INDEX idx_alerts_client ON alerts(client_id);
-- Hot query: unacknowledged, worst-severity first.
CREATE INDEX idx_alerts_open   ON alerts(severity, triggered_at DESC) WHERE NOT acknowledged;

-- ============================================================================
-- AUDIT LOG  — append-only, time-partitioned (compliance artifact)
-- ----------------------------------------------------------------------------
-- Partitioned monthly so cold months can be detached/archived to S3 without
-- touching the hot DB. Partition key (ts) must be part of the primary key.
-- Automate partition creation in production with pg_partman or a monthly cron.
-- ============================================================================
CREATE TABLE audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  ts          timestamptz NOT NULL DEFAULT now(),
  actor       text NOT NULL,                        -- 'S. Goyal (staff)', 'James Halloran', 'System'
  role        text NOT NULL,                        -- 'admin' | 'client' | 'system'
  action      text NOT NULL,
  detail      text,
  client_id   uuid REFERENCES clients(id) ON DELETE SET NULL,
  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);

CREATE INDEX idx_audit_ts     ON audit_log(ts DESC);
CREATE INDEX idx_audit_client ON audit_log(client_id);

-- Append-only: block UPDATE/DELETE (propagates to all partitions on PG 13+).
CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_audit_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

-- Initial partitions (create the next few months ahead in production).
CREATE TABLE audit_log_2026_06 PARTITION OF audit_log
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE audit_log_2026_07 PARTITION OF audit_log
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
-- Catch-all so inserts never fail if a partition is missing.
CREATE TABLE audit_log_default PARTITION OF audit_log DEFAULT;

-- ============================================================================
-- RESEARCH / CONTENT  (low-volume, shared — adviser-authored)
-- ============================================================================

-- Per-security trade signal shown on the client dashboard.
CREATE TABLE signals (
  security_code  text PRIMARY KEY REFERENCES securities(code),
  action         signal_action NOT NULL,
  headline       text NOT NULL,
  detail         text,
  target         numeric(18,4),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Analyst recommendations strip (adviser-authored). One row per covered security;
-- `name`/`sector` are NOT stored here — join securities (single source of truth).
CREATE TABLE recommendations (
  security_code  text PRIMARY KEY REFERENCES securities(code),
  rating         text NOT NULL,                     -- e.g. 'Buy', 'Hold', 'Reduce'
  target_price   numeric(18,4),                     -- was `tp`
  move           text,                              -- performance note, e.g. '+12% since call'
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sectors (
  name           text PRIMARY KEY,
  momentum       numeric(8,4) NOT NULL,             -- was `mom`
  drivers        text,
  beneficiaries  text[]        NOT NULL DEFAULT '{}'  -- security codes (was `benef`)
);

CREATE TABLE news (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ts          timestamptz NOT NULL DEFAULT now(),
  source      text NOT NULL,
  headline    text NOT NULL,
  impact      text,
  direction   news_direction NOT NULL,
  use_note    text                                  -- adviser "how to use this" (was `use`)
);
CREATE INDEX idx_news_ts ON news(ts DESC);

CREATE TABLE investment_ideas (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL,
  name         text NOT NULL,
  theme        text NOT NULL,
  risk         risk_level NOT NULL,
  horizon      text,
  conviction   smallint NOT NULL CHECK (conviction BETWEEN 1 AND 3),
  entry_lo     numeric(18,4),
  entry_hi     numeric(18,4),
  target       numeric(18,4),
  hook         text,
  thesis       text,
  placement_id uuid REFERENCES placements(id) ON DELETE SET NULL,  -- live deal link (was `deal`)
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE research_reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  kind        text NOT NULL,                        -- 'Sector note', 'Company note', 'Strategy'
  published   date NOT NULL,
  pages       smallint                              -- was `pp`
);

-- Free-text adviser research notes shown on the dashboard. The prototype held a
-- single `note`; here it's a table of dated notes (newest surfaced in the UI).
CREATE TABLE research_notes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  body        text NOT NULL,
  published   timestamptz NOT NULL DEFAULT now(),   -- was `time`
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_research_notes_published ON research_notes(published DESC);

-- ============================================================================
-- Notes for production hardening (not DDL — checklist):
--   • Enable Row-Level Security on clients/positions/option_holdings/bids/
--     watchlist_items/alerts so a client session only ever sees its own rows;
--     staff role bypasses. (Supabase: USING (client_id = auth.uid()).)
--   • Read replica + Redis cache for securities/market_indices (shared reads).
--   • Connection pooler (PgBouncer / platform pooler) for serverless Next.js.
--   • Automate monthly audit_log partition creation; archive cold ones to S3.
-- ============================================================================
