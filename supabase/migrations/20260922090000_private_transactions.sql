-- ============================================================================
-- Private transactions — what a client holds via us that the broker never sees
-- ----------------------------------------------------------------------------
-- The client portal answers "what do I have via Vitti" out of two sources, and
-- both of them are the broker's: the holdings snapshot (`positions`) and the
-- contract-note ledger (`trades`). Anything arranged off-market — an off-market
-- crossing, a transfer, shares in a private company, a convertible note — is
-- invisible to both, so a client who holds it via us cannot see it on the one
-- screen that is supposed to show everything.
--
-- The desk enters those by hand. This migration is what makes a hand-entered
-- holding survive and be recognisable.
--
-- ── Why a flag rather than a new table ──────────────────────────────────────
-- A separate `private_holdings` table would need its own path through
-- `loadDbHoldings`, `mergeDbHoldingsIntoSummary`, the staff Holdings table, the
-- client portfolio and both exports — five integration points, each a place for
-- the two kinds of holding to drift apart. A flag on the rows that already flow
-- through all of that inherits every one of those paths for free, and the only
-- code that has to care is the code that must treat them differently.
--
-- ── The one thing that had to change, or the feature does not work ──────────
-- `positions` is a FULL REPLACE: `run-holdings.ts` deletes every position for
-- each account in the snapshot and rebuilds from the file. A private holding is
-- by definition not in that file, so left alone it would be entered by the desk
-- and silently deleted by the next morning's 05:30 import — the entire feature
-- gone overnight with nothing in any log to say why. The importer now scopes
-- that delete to `is_private = false`, and this partial index is what keeps the
-- scoped delete cheap.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- trades — a hand-entered line is marked as one, in a column, not in prose
-- ----------------------------------------------------------------------------
-- `source_file` already records WHO entered a manual line ('Manual entry by …')
-- and that was enough while manual entry was a repair tool used inside the
-- mismatches workflow. It is not enough now: a client-facing badge cannot be
-- driven by a LIKE against a free-text audit string, and the desk needs to be
-- able to list, total and export private transactions as a class.
ALTER TABLE trades ADD COLUMN is_private boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN trades.is_private IS
  'True for a transaction arranged off-market and keyed by the desk. Never set by any broker import.';

-- The desk's own note about where the transaction came from — "Off-market
-- transfer from SMSF", "Series A, 2024". Free text, shown to staff only.
ALTER TABLE trades ADD COLUMN private_note text;

CREATE INDEX idx_trades_private ON trades(client_id, trade_date DESC)
  WHERE is_private;

-- ----------------------------------------------------------------------------
-- positions — the holding itself, and how to value it
-- ----------------------------------------------------------------------------
ALTER TABLE positions ADD COLUMN is_private boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN positions.is_private IS
  'True for a holding the broker does not custody. EXEMPT from the holdings-snapshot full replace — see run-holdings.ts.';

-- ── Valuing something with no market ────────────────────────────────────────
-- An off-market parcel of a LISTED security prices itself: the ASX feed already
-- carries the code, so `securities.last_price` values it like any other line
-- and these two columns stay null.
--
-- A genuinely unlisted asset has no feed and never will. Without a figure here
-- `loadDbHoldings` falls back to cost base, which marks the holding flat — the
-- honest default, and wrong the moment the asset is worth anything other than
-- what was paid. So the desk can state a valuation, and `manual_price_at` says
-- when — a private valuation with no date is a number of unknown age being read
-- as current, which is the specific way this kind of figure misleads.
ALTER TABLE positions ADD COLUMN manual_price    numeric(18,6);
ALTER TABLE positions ADD COLUMN manual_price_at date;

COMMENT ON COLUMN positions.manual_price IS
  'Desk-stated unit valuation for an asset with no price feed. Used only when there is no market price; see loadDbHoldings.';

-- A valuation must be dated, and a date must value something. Either both or
-- neither: a lone date says a valuation happened and withholds it, and a lone
-- price is the undated number the column above exists to prevent.
ALTER TABLE positions ADD CONSTRAINT positions_manual_price_dated
  CHECK ((manual_price IS NULL) = (manual_price_at IS NULL));

-- A stated valuation may be zero — a note that defaulted, a company wound up —
-- but it may not be negative. A holding cannot be worth less than nothing.
ALTER TABLE positions ADD CONSTRAINT positions_manual_price_not_negative
  CHECK (manual_price IS NULL OR manual_price >= 0);

-- The importer's delete reads `WHERE account_id IN (…) AND NOT is_private` on
-- every morning run, over every account in the file.
CREATE INDEX idx_positions_private ON positions(account_id)
  WHERE is_private;

-- ----------------------------------------------------------------------------
-- pnl_summary — so the badge survives the recompute
-- ----------------------------------------------------------------------------
-- `pnl_summary` is rebuilt from scratch by `lib/pnl/recompute.ts`, and it is
-- what the client portal actually renders. A flag that lives only on `trades`
-- would be correct in the ledger and absent from the one screen the client
-- reads, so the recompute carries it across onto the row.
--
-- It sits beside the other provenance flags (`is_db_only`, `is_enriched`,
-- `is_unlisted_option`) because it is the same kind of fact: where this figure
-- came from, and therefore how much weight it carries.
ALTER TABLE pnl_summary ADD COLUMN is_private boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN pnl_summary.is_private IS
  'True when the row is backed by desk-entered private transactions rather than broker data. Drives the client-facing badge.';

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------
-- Nothing to add. Every column here rides on an existing table whose policies
-- already say "staff read and write everything, a client reads only their own
-- rows" — trades_select/trades_write, positions', pnl_summary_select/_write.
-- A private transaction is the client's own data and is governed as such; the
-- desk-only parts (`private_note`) are withheld by the query layer, which is
-- where every other staff-only field on a client-readable row is withheld.
