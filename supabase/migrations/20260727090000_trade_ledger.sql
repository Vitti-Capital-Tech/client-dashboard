-- ============================================================================
-- Broker data pipeline (Stage 11) — real client holdings + trade ledger
-- ----------------------------------------------------------------------------
-- Two broker exports feed the platform, and they answer different questions:
--
--   1. Holdings snapshot  (ClientHoldings…csv)  — "what is held right now"
--      One row per account × security, with Holding Qty, Market Price and
--      Average Cost. This is the AUTHORITATIVE source for `positions` and for
--      `securities.last_price`. It is a full-replace import.
--
--   2. Trade ledger       (contract notes csv)  — "how we got here"
--      One row per contract note line (BUY/SELL, Units, Value). This is the
--      only source of REALIZED P&L. It is an append/upsert import keyed by
--      contract note, so re-running it never double-counts.
--
-- The two are deliberately NOT merged into one table. A snapshot cannot express
-- realized P&L, and a ledger that starts mid-history cannot reconstruct opening
-- balances. Keeping both, each owning its own table, means neither has to lie.
--
-- Security codes: ASX ordinary codes are exactly 3 characters ('ADN', 'AT4');
-- derivatives suffix them ('ADNOD', 'EOSXX', 'PC2ZZ'). Every raw code gets its
-- own `securities` row (they trade at different prices — ADN 0.006 vs ADNOD
-- 0.002, so summing their units would be meaningless), and `parent_code` links
-- the derivative back to the ordinary. Roll up by COALESCE(parent_code, code)
-- when you want one line per company; group by `code` when you want the detail.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- securities — derivative → ordinary linkage + instrument classification
-- ----------------------------------------------------------------------------
ALTER TABLE securities ADD COLUMN parent_code    text REFERENCES securities(code);
ALTER TABLE securities ADD COLUMN security_class text;   -- 'Ordinary' | 'Options' | 'Allocation Interest'
ALTER TABLE securities ADD COLUMN description    text;   -- broker's security description

CREATE INDEX idx_securities_parent ON securities(parent_code);

-- A derivative may not point at itself, and (enforced in the importer) parents
-- are always the 3-character ordinary code.
ALTER TABLE securities ADD CONSTRAINT securities_parent_not_self
  CHECK (parent_code IS DISTINCT FROM code);

-- ----------------------------------------------------------------------------
-- clients / accounts — broker identifiers
-- ----------------------------------------------------------------------------
-- `ref` holds the legacy demo ids (C1/A1). The broker's own numbers live in
-- `external_ref` so imports can resolve rows idempotently without colliding.
ALTER TABLE clients  ADD COLUMN external_ref text UNIQUE;
ALTER TABLE accounts ADD COLUMN external_ref text UNIQUE;  -- broker account no., e.g. '114716'
ALTER TABLE accounts ADD COLUMN adviser_code text;
ALTER TABLE accounts ADD COLUMN adviser_name text;
ALTER TABLE accounts ADD COLUMN status       text;         -- broker account status, e.g. 'ACTIVE'

-- ----------------------------------------------------------------------------
-- trades — immutable-ish ledger of contract note lines (source of truth)
-- ----------------------------------------------------------------------------
CREATE TYPE trade_side AS ENUM ('BUY', 'SELL');

CREATE TABLE trades (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cnote          text NOT NULL,                    -- broker contract note number
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  client_id      uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,

  raw_security   text NOT NULL,                    -- exactly as exported, e.g. 'EOSXX'
  security_code  text NOT NULL REFERENCES securities(code),
  parent_code    text NOT NULL REFERENCES securities(code),  -- rollup key, e.g. 'EOS'
  instrument     text,                             -- FPO | INSTPLAC | INSTOPLAC | IPO | PLACEMENT

  side           trade_side    NOT NULL,
  trade_date     date          NOT NULL,           -- Contract Date (DD/MM/YY in the export)
  -- Units are positive for a SETTLED trade, but CANCELLED rows export as 0 and
  -- a REVERSAL exports as the negative of the line it undoes. Both are kept
  -- verbatim for the audit trail, so the constraint is conditional on status.
  units          numeric(20,4) NOT NULL,
  avg_price      numeric(18,6) NOT NULL,

  -- Money. `value` is the NET cash flow and already carries the fees:
  --   BUY  → consideration + brokerage + other + GST   (cash out)
  --   SELL → consideration - brokerage - other - GST   (cash in)
  -- so P&L math can use `value` alone and stay fee-inclusive.
  consideration  numeric(18,2) NOT NULL DEFAULT 0,
  brokerage      numeric(18,2) NOT NULL DEFAULT 0,
  other_charges  numeric(18,2) NOT NULL DEFAULT 0,
  gst            numeric(18,2) NOT NULL DEFAULT 0,
  value          numeric(18,2) NOT NULL,
  brokerage_pct  numeric(8,4),

  adviser        text,
  status         text NOT NULL,                    -- SETTLED | CANCELLED | REVERSAL | REVERSED
  source_file    text,
  imported_at    timestamptz NOT NULL DEFAULT now(),

  -- Idempotency. One contract note can span several lines, so the note number
  -- alone is not unique — qualify it by the security and side.
  UNIQUE (cnote, raw_security, side),

  CONSTRAINT trades_settled_units_positive
    CHECK (status <> 'SETTLED' OR units > 0)
);

CREATE INDEX idx_trades_account ON trades(account_id);
CREATE INDEX idx_trades_client  ON trades(client_id);
CREATE INDEX idx_trades_parent  ON trades(account_id, parent_code);
CREATE INDEX idx_trades_date    ON trades(trade_date DESC);
-- Hot path: the reducer replays only settled trades, oldest first.
CREATE INDEX idx_trades_settled ON trades(account_id, parent_code, trade_date)
  WHERE status = 'SETTLED';

-- ----------------------------------------------------------------------------
-- realized_pnl — derived rollup, rebuilt from `trades` on every import
-- ----------------------------------------------------------------------------
-- Grain is (account, parent_code): EOS and EOSXX collapse to one EOS row, so a
-- placement bought as EOSXX and sold as EOS nets out as the single round trip
-- it actually was. Never hand-edit — scripts/import-trades.mjs owns this table.
CREATE TABLE realized_pnl (
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  client_id      uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  parent_code    text NOT NULL REFERENCES securities(code),

  units_bought   numeric(20,4) NOT NULL DEFAULT 0,
  units_sold     numeric(20,4) NOT NULL DEFAULT 0,
  open_units     numeric(20,4) NOT NULL DEFAULT 0,  -- per the ledger, not the snapshot

  cost_total     numeric(18,2) NOT NULL DEFAULT 0,  -- cash paid on all BUYs
  proceeds       numeric(18,2) NOT NULL DEFAULT 0,  -- cash received on all SELLs
  cost_of_sold   numeric(18,2) NOT NULL DEFAULT 0,  -- WAC cost attributed to sold units
  open_cost      numeric(18,2) NOT NULL DEFAULT 0,  -- remaining cost base
  realized_pl    numeric(18,2) NOT NULL DEFAULT 0,  -- proceeds - cost_of_sold
  fees           numeric(18,2) NOT NULL DEFAULT 0,  -- brokerage + other + GST

  trade_count    integer NOT NULL DEFAULT 0,
  first_trade    date,
  last_trade     date,
  -- True only when a SELL closed part of a parcel that had been assembled at
  -- two or more different prices — the one case where weighted-average cost is
  -- an approximation rather than the exact answer. A partial sale out of a
  -- single-price parcel, or any full close, is exact and is NOT flagged.
  has_partial    boolean NOT NULL DEFAULT false,
  -- True when the ledger sold more units than it ever bought — i.e. history
  -- starts mid-stream and an opening balance is missing.
  short_history  boolean NOT NULL DEFAULT false,

  computed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, parent_code)
);

CREATE INDEX idx_realized_client ON realized_pnl(client_id);

-- ----------------------------------------------------------------------------
-- RLS — mirrors positions: a client reads only their own rows, staff read all,
-- and all writes are staff-only (the importer runs as service_role, which
-- bypasses RLS entirely).
-- ----------------------------------------------------------------------------
ALTER TABLE trades ENABLE ROW LEVEL SECURITY;
CREATE POLICY trades_select ON trades FOR SELECT TO authenticated
  USING (is_staff() OR client_id = current_client_id());
CREATE POLICY trades_write ON trades FOR ALL TO authenticated
  USING (is_staff()) WITH CHECK (is_staff());

ALTER TABLE realized_pnl ENABLE ROW LEVEL SECURITY;
CREATE POLICY realized_select ON realized_pnl FOR SELECT TO authenticated
  USING (is_staff() OR client_id = current_client_id());
CREATE POLICY realized_write ON realized_pnl FOR ALL TO authenticated
  USING (is_staff()) WITH CHECK (is_staff());
