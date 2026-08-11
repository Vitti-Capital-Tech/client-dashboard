-- ============================================================================
-- placement_candidates — deals the broker mail told us about, before they are
-- deals we can take money against.
-- ============================================================================
-- The upstream pipeline (Placement_Email → placement_api.py on EC2) turns
-- placement emails into a per-ticker PROSE SUMMARY. It carries the ticker, the
-- deal type, the subject line and an LLM write-up. It does not carry a price, a
-- raise size, a minimum bid, a close date, or the attaching-option terms.
--
-- `placements` requires the first three as NOT NULL, for the obvious reason:
-- they are what a bid is measured against. So a summary CANNOT become a
-- placement on its own, and the tempting shortcut — default them to zero and
-- let someone fix it later — would put a biddable deal in front of the desk
-- with a $0 minimum. A wrong min_bid does not look wrong; it just quietly
-- accepts the wrong money.
--
-- Hence two tables rather than one. This is the inbox: what arrived, from whom,
-- when. Promoting a row into `placements` is a deliberate act by a human who
-- supplies the terms, and `placement_id` keeps the trail from the mail to the
-- deal it became.

CREATE TABLE IF NOT EXISTS placement_candidates (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Stable identity for a candidate across runs.
  --
  -- The API response carries no id of its own — `approval_token` exists in the
  -- upstream SQLite but is not returned — so identity has to be derived from
  -- the content. It is hashed from `ticker | subject | received_at` and
  -- deliberately NOT from `summary`: that text is LLM-generated and its upstream
  -- cache key includes the last close price, so the same deal legitimately
  -- re-summarises when the market moves. Hashing it would mint a new candidate
  -- every time the price ticked.
  fingerprint    text NOT NULL UNIQUE,

  ticker         text NOT NULL,
  -- Upstream sets this to the ticker today ("Could be improved with a lookup
  -- table" — placement_api.py). Kept separate so it can improve without a
  -- migration here.
  company        text NOT NULL DEFAULT '',
  -- 'Placement' | 'IPO', as classified upstream. Text rather than an enum: it is
  -- another system's vocabulary, and a new value there must not fail our write.
  deal_type      text NOT NULL DEFAULT 'Placement',
  subject        text NOT NULL DEFAULT '',
  summary        text NOT NULL DEFAULT '',
  received_at    timestamptz NOT NULL,
  -- Which market API it came from (see lib/markets.ts upstream: au | us).
  region         text NOT NULL DEFAULT 'au',

  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  -- Bumped on every re-fetch, so a candidate the feed has stopped mentioning is
  -- distinguishable from one it still carries.
  last_seen_at   timestamptz NOT NULL DEFAULT now(),

  -- Set once the desk turns this into a real deal. ON DELETE SET NULL rather
  -- than CASCADE: deleting a placement must not erase the record that the mail
  -- arrived.
  placement_id   uuid REFERENCES placements(id) ON DELETE SET NULL,
  promoted_at    timestamptz,
  promoted_by    text,

  -- Not every deal in the mail is one this desk will offer. Dismissing is
  -- recorded rather than deleting, so the same summary does not reappear as new
  -- work on the next sync.
  dismissed_at   timestamptz,
  dismissed_by   text,
  dismiss_reason text
);

CREATE INDEX IF NOT EXISTS idx_placement_candidates_received
  ON placement_candidates(received_at DESC);

-- The desk's actual query: what still needs a decision.
CREATE INDEX IF NOT EXISTS idx_placement_candidates_pending
  ON placement_candidates(received_at DESC)
  WHERE placement_id IS NULL AND dismissed_at IS NULL;

-- ----------------------------------------------------------------------------
-- RLS — staff only, like the ingest tables
-- ----------------------------------------------------------------------------
-- These rows belong to no client. A candidate is the desk's own deal flow:
-- which raises it was offered and which it passed on. There is deliberately no
-- client-readable policy at all. The sync runs as service_role and bypasses RLS.
ALTER TABLE placement_candidates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS placement_candidates_staff ON placement_candidates;
CREATE POLICY placement_candidates_staff ON placement_candidates FOR ALL TO authenticated
  USING (is_staff()) WITH CHECK (is_staff());

-- ============================================================================
-- bids.qty — what the adviser actually instructed
-- ============================================================================
-- A bid has always been stored in DOLLARS, and everything downstream depends on
-- that: `scaleBids` writes `alloc` in dollars, the scale-back percentages divide
-- by it, BPAY is settled against it. That does not change here.
--
-- But the desk books a placement in SHARES ("3,000 for this client"), and
-- dollars alone cannot record that faithfully. `amount = qty × price` rounds to
-- the cent, so reading the quantity back out gives 3,000.03 — close enough to
-- display and wrong enough that the instruction is no longer what the register
-- says it was.
--
-- So both are kept, with one of them authoritative: `amount` remains the money
-- truth, and `qty` records the number the adviser typed. NULL where it does not
-- apply — a client bidding through the portal enters an amount, and inventing a
-- quantity for them would put a share count in the register that nobody chose.
ALTER TABLE bids ADD COLUMN IF NOT EXISTS qty numeric(18,4);

COMMENT ON COLUMN bids.qty IS
  'Shares instructed, when the bid was booked by quantity. NULL for amount-entered bids. `amount` stays authoritative for scaling and settlement.';
