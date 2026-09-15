-- ---------------------------------------------------------------------------
-- What the last alert scan saw, so this one can tell a crossing from a
-- continuation.
--
-- Expiry alerts need no memory: the ladder rung a grant sits in is a function
-- of the date alone, so `expiry:<id>:7` is stable for as long as the grant is
-- in the 7-day window and becomes a different key on its own when it drops to
-- the 3-day one.
--
-- Moneyness is not like that. Whether today's "in the money" is news depends
-- entirely on yesterday, and nothing in the schema records yesterday — the
-- broker's holdings import replaces `option_holdings` wholesale every morning,
-- so there is no row that survives to carry the answer. Without this table the
-- scan can only choose between alerting every single day a grant is in the
-- money, or alerting once ever and staying silent the second time it crosses.
--
-- `spell` is what keeps repeat crossings distinct: it increments each time a
-- grant goes from not-in-the-money to in-the-money, so the alert key
-- `itm:<option_id>:<spell>` is unique per crossing while being stable across
-- reruns of the same day. A grant that goes in, falls out, and goes in again
-- produces two alerts, which is correct — they are two events.
--
-- Deliberately keyed on `option_id` alone and NOT client-scoped: an option
-- belongs to exactly one client, and duplicating the ownership here would
-- create a second place for it to be wrong.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS alert_scan_state (
  option_id   uuid PRIMARY KEY REFERENCES option_holdings(id) ON DELETE CASCADE,
  -- 'ITM' | 'ATM' | 'OTM' | 'unknown'. Text rather than an enum: this is the
  -- scanner's private bookkeeping, not a value any screen renders, and an enum
  -- would need a migration every time lib/options/moneyness.ts grew a case.
  moneyness   text NOT NULL,
  spell       integer NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE alert_scan_state IS
  'Per-option memory for the alert scanner: what moneyness it last saw, and how many times the grant has crossed into the money. Not read by any screen.';

-- ---------------------------------------------------------------------------
-- RLS: nobody reads this but the scanner.
--
-- The scan runs as service_role, which bypasses RLS entirely. Enabling RLS with
-- no policy therefore leaves the job working and denies every signed-in user,
-- which is exactly right — this is bookkeeping, it names no figure a client
-- needs, and a table left un-enabled is a table that quietly answers `select *`
-- for any authenticated session.
-- ---------------------------------------------------------------------------
ALTER TABLE alert_scan_state ENABLE ROW LEVEL SECURITY;
