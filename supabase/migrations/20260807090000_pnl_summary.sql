-- ============================================================================
-- Stored P&L (Stage 13) — the calculator's output, persisted per account
-- ----------------------------------------------------------------------------
-- Until now the client profile computed its P&L on every render, straight from
-- `trades` + `positions`. That is honest and self-correcting, and it is also
-- not enough for two reasons:
--
--   1. The full calculation is not a pure function of the database. Unlisted
--      placement options are valued with Black-Scholes off a LIVE spot price,
--      and the Placement Tracker workbooks cost ~48s to parse. A figure that
--      depends on the minute it was computed cannot be re-derived later, so if
--      it is ever shown to a client it has to be written down.
--
--   2. `realized_pnl` cannot answer this question. Its grain is the ordinary
--      (parent) code and its scope is the ledger alone — no placement
--      enrichment, no open-position valuation, no option rows. It remains the
--      cost-basis rollup it always was; this table is the desk's P&L view.
--
-- ── What is NOT stored ───────────────────────────────────────────────────────
-- Overrides. `pnl_overrides` is still applied at READ time, exactly as it is
-- today, so correcting a row keeps tracking the sources underneath it rather
-- than freezing a number into place. Baking an override in here would make it
-- permanent by accident.
--
-- ── Rebuild semantics ────────────────────────────────────────────────────────
-- One row per account × ticker, replaced wholesale for an account whenever
-- that account's inputs change. Never hand-edit: the recompute owns it.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- pnl_runs — one row per account per computation, so a figure is reproducible
-- ----------------------------------------------------------------------------
-- A P&L shown to a client on a Tuesday must still be explainable on a Friday,
-- by which time the spot prices behind it have moved. This records the inputs
-- that were in force; `pnl_summary.run_id` ties every row back to one.
CREATE TABLE pnl_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  client_id    uuid NOT NULL REFERENCES clients(id)  ON DELETE CASCADE,

  -- Groups the per-account runs that came from a single trigger — one morning
  -- ingest fans out across every account the file touched.
  batch_id     uuid,
  -- What caused it: 'ingest' (the morning mail), 'manual' (Recalculate), or
  -- 'backfill'. Kept as text so a new trigger needs no migration.
  trigger      text NOT NULL DEFAULT 'manual',

  computed_at  timestamptz NOT NULL DEFAULT now(),
  total_pnl    numeric(18,2) NOT NULL DEFAULT 0,
  row_count    integer       NOT NULL DEFAULT 0,

  -- Provenance for the parts that are not re-derivable from the database:
  -- which Placement Trackers were merged, and where each spot price came from
  -- (yahoo | asx | database). This is what makes a modelled option price
  -- auditable months later.
  sources      jsonb,
  -- Anything the desk should read before trusting the numbers — skipped
  -- tickers, unresolved placement years, securities with no quote.
  warnings     text[] NOT NULL DEFAULT '{}',

  -- Bumped when the engine's maths changes, so an old row is never silently
  -- compared against a new one.
  engine_version text NOT NULL DEFAULT 'v1'
);

CREATE INDEX idx_pnl_runs_account ON pnl_runs(account_id, computed_at DESC);
CREATE INDEX idx_pnl_runs_client  ON pnl_runs(client_id);
CREATE INDEX idx_pnl_runs_batch   ON pnl_runs(batch_id);

-- ----------------------------------------------------------------------------
-- pnl_summary — the rows the client profile renders and exports
-- ----------------------------------------------------------------------------
-- Grain is (account, ticker) and NOT (account, parent_code), because an option
-- line is a position in its own right: EOS and EOSXX have different prices, and
-- a free unlisted option has no parent trade at all. Roll up by `parent_ticker`
-- when one line per company is wanted.
CREATE TABLE pnl_summary (
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  client_id      uuid NOT NULL REFERENCES clients(id)  ON DELETE CASCADE,
  ticker         text NOT NULL,

  run_id         uuid REFERENCES pnl_runs(id) ON DELETE SET NULL,

  parent_ticker  text,
  company        text NOT NULL DEFAULT '',
  instrument     text,

  -- Quantities, and the VALUE sums either side of them. `buy_price` /
  -- `sell_price` are totals, not per-unit prices — the calculator's naming is
  -- kept so the stored row and the on-screen row cannot drift apart.
  buy_qty        numeric(20,4) NOT NULL DEFAULT 0,
  sell_qty       numeric(20,4) NOT NULL DEFAULT 0,
  open_qty       numeric(20,4) NOT NULL DEFAULT 0,
  buy_price      numeric(18,2) NOT NULL DEFAULT 0,
  sell_price     numeric(18,2) NOT NULL DEFAULT 0,
  pnl            numeric(18,2) NOT NULL DEFAULT 0,

  trade_count    integer NOT NULL DEFAULT 0,

  -- ── Provenance flags ──────────────────────────────────────────────────────
  -- Where each side of the row came from. These are not cosmetic: they decide
  -- whether a figure is realised cash, a mark to a snapshot, or a model price,
  -- and both exports print them as the row's Comments.
  is_matched              boolean NOT NULL DEFAULT false,
  is_option               boolean NOT NULL DEFAULT false,
  is_enriched             boolean NOT NULL DEFAULT false,
  is_db_market_valued     boolean NOT NULL DEFAULT false,
  is_db_open_valued       boolean NOT NULL DEFAULT false,
  is_db_only              boolean NOT NULL DEFAULT false,
  is_partial_exit         boolean NOT NULL DEFAULT false,
  is_partial_buy          boolean NOT NULL DEFAULT false,
  is_unlisted_option      boolean NOT NULL DEFAULT false,

  -- The ticker was placed in more than one tracker year and the trade dates
  -- singled out none of them, so NOTHING was filled from the placement.
  placement_year_unresolved boolean NOT NULL DEFAULT false,
  placement_year_note       text,

  -- The buy side is genuinely UNKNOWN rather than zero. A zero here would read
  -- as "bought for nothing" and hand the row a P&L equal to its whole proceeds,
  -- so these rows are shown blank and left OUT of the grand total.
  buy_side_unknown          boolean NOT NULL DEFAULT false,

  -- Every input behind a Black-Scholes option price: spot and its source,
  -- strike, expiry, volatility, rate, entitlement ratio. A modelled number that
  -- cannot be traced back to its assumptions is not auditable.
  unlisted_option jsonb,

  -- The human-readable explanation the table and both exports show.
  comment        text,

  computed_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (account_id, ticker)
);

CREATE INDEX idx_pnl_summary_client ON pnl_summary(client_id);
CREATE INDEX idx_pnl_summary_run    ON pnl_summary(run_id);
CREATE INDEX idx_pnl_summary_parent ON pnl_summary(account_id, parent_ticker);

-- ----------------------------------------------------------------------------
-- RLS — mirrors positions / trades / realized_pnl: a client reads only their
-- own rows, staff read all, and all writes are staff-only. The recompute runs
-- as service_role, which bypasses RLS entirely.
-- ----------------------------------------------------------------------------
ALTER TABLE pnl_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY pnl_runs_select ON pnl_runs FOR SELECT TO authenticated
  USING (is_staff() OR client_id = current_client_id());
CREATE POLICY pnl_runs_write ON pnl_runs FOR ALL TO authenticated
  USING (is_staff()) WITH CHECK (is_staff());

ALTER TABLE pnl_summary ENABLE ROW LEVEL SECURITY;
CREATE POLICY pnl_summary_select ON pnl_summary FOR SELECT TO authenticated
  USING (is_staff() OR client_id = current_client_id());
CREATE POLICY pnl_summary_write ON pnl_summary FOR ALL TO authenticated
  USING (is_staff()) WITH CHECK (is_staff());
