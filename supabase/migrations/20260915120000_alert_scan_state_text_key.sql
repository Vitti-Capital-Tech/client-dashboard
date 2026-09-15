-- ---------------------------------------------------------------------------
-- Correction to `…_alert_scan_state.sql`: the scan key is not an option_holdings
-- uuid, because the options the portal shows do not come from that table.
--
-- `alert_scan_state.option_id` was declared as
--
--     uuid PRIMARY KEY REFERENCES option_holdings(id) ON DELETE CASCADE
--
-- on the assumption that `option_holdings` is where option positions live. It
-- is not, and has never been. LLD §8.33: that table was demo-seed data, nothing
-- in the broker import or the Placement Tracker pipeline writes it, and the
-- client Options tab was empty for every client until both screens were moved
-- onto `pnl_summary` via `lib/options/from-stored-pnl.ts`.
--
-- The scanner inherited the wrong assumption and so scanned an empty table: its
-- first production run reported `scanned: 0` and wrote nothing, on a book that
-- has 33 option series and one of them in the money. It now reads the same
-- source the screens read.
--
-- Those rows are identified by a derived key rather than a uuid —
-- `pnl-<account_id>:<ticker>` for a stored-P&L row, `opt-<uuid>` for the
-- option_holdings row that is still read so anything ever entered there is not
-- silently dropped. Hence text, and hence no foreign key: there is no single
-- table to point at.
--
-- The table is empty at this point (nothing has ever scanned successfully), so
-- it is simply rebuilt rather than migrated.
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS alert_scan_state;

CREATE TABLE alert_scan_state (
  -- The register's own id for the option: `pnl-<account>:<ticker>` or
  -- `opt-<uuid>`. Stable across runs because it is derived from the account and
  -- the ticker, which is what survives the holdings snapshot being replaced
  -- wholesale every morning.
  option_key  text PRIMARY KEY,
  -- 'ITM' | 'ATM' | 'OTM' | 'unknown'. Text rather than an enum: this is the
  -- scanner's private bookkeeping, not a value any screen renders, and an enum
  -- would need a migration every time lib/options/moneyness.ts grew a case.
  moneyness   text NOT NULL,
  spell       integer NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE alert_scan_state IS
  'Per-option memory for the alert scanner: the moneyness it last saw, and how many times the grant has crossed into the money. Keyed by the register''s derived option key, not by option_holdings.id. Not read by any screen.';

-- Nobody reads this but the scanner, which runs as service_role and bypasses
-- RLS. Enabling it with no policy denies every signed-in session, which is
-- right: a table left un-enabled answers `select *` for any authenticated user.
ALTER TABLE alert_scan_state ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- `alerts.option_id` stays a uuid FK to option_holdings and the scanner leaves
-- it NULL. Nothing in the UI reads it — the column is not referenced in any
-- component — and the alert's identity is carried by `alert_key`, which names
-- the event rather than the row. Writing a derived key into a uuid column would
-- mean either dropping a foreign key that is still correct for hand-written
-- alerts, or storing something that is not an option_holdings id in a column
-- that says it is.
-- ---------------------------------------------------------------------------
