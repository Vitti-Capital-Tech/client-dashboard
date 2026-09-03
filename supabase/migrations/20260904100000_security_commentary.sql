-- ============================================================================
-- Weekly per-security commentary
-- ----------------------------------------------------------------------------
-- A short note against each security a client holds, refreshed once a week
-- after the Friday close: why a position is where it is, given what has been
-- happening in the market.
--
-- ── Why the note is per SECURITY and not per position ───────────────────────
-- The obvious shape is one note per (client, position) — 662 of them across the
-- current book, and every one of them a separate model call every week, most
-- saying the same thing about the same stock. What actually differs between two
-- clients holding EOS is not the market; it is only whether THEY are up or down
-- on it, which the app already knows exactly.
--
-- So the market read is written once per security, and each row carries two
-- framings of it — one for a holder sitting on a loss, one for a holder sitting
-- on a gain. Serving picks by the sign of that client's own P&L. 142 held
-- securities instead of 662 notes, and, more importantly, two clients in the
-- same stock cannot be told contradictory things about that stock.
--
-- ── Why the week is a column and not an overwrite ───────────────────────────
-- Keeping the history costs nothing and buys two things: a client who reads a
-- note on Wednesday sees the same words they saw on Monday, and if a note ever
-- has to be answered for, what was actually shown that week is still on file.
-- `week_of` is the FRIDAY the note belongs to (see lib/commentary/week.ts).
--
-- ── This is general information, and the schema says so ─────────────────────
-- `profit_note` answers "hold or take profit", which is close enough to
-- personal advice to be worth being deliberate about: it is generated from
-- market conditions and the client's own figures, NOT from their objectives or
-- circumstances, and the portal labels it as general information. The columns
-- are named for what they are — a note, not a recommendation — and the desk can
-- overwrite any row by hand.
-- ============================================================================

CREATE TABLE security_commentary (
  security_code text NOT NULL REFERENCES securities(code) ON DELETE CASCADE,
  -- The Friday this note belongs to.
  week_of       date NOT NULL,

  -- Two framings of one market read. 2–4 sentences each, plain language.
  loss_note     text NOT NULL,
  profit_note   text NOT NULL,

  -- What the note leant on: `[{ "title": …, "url": … }]` from the web search.
  -- A market claim nobody can check is not worth showing a client, and this is
  -- what makes the note auditable after the week it described has passed.
  sources       jsonb NOT NULL DEFAULT '[]'::jsonb,

  model         text,
  /** A note the desk wrote or corrected by hand, rather than a generated one. */
  edited_by     text,
  generated_at  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (security_code, week_of)
);

CREATE INDEX idx_security_commentary_week ON security_commentary(week_of DESC);

-- ----------------------------------------------------------------------------
-- commentary_runs — one row per week, tracking the batch
-- ----------------------------------------------------------------------------
-- The generation runs on the Batch API rather than as 142 live calls, for a
-- reason the host imposes: the cron route has a 60-second ceiling (see
-- app/api/ingest/morning/route.ts), and 142 web-search-grounded generations do
-- not fit in it however they are ordered. Submitting is one HTTP call; the
-- results are collected by a later tick of the same schedule. It is also half
-- the price, which for a job whose answer nobody is waiting on is free money.
--
-- So the week's work has two states and this table is what remembers which one
-- it is in — without it, every weekend tick would submit another batch.
CREATE TYPE commentary_run_status AS ENUM ('submitted', 'collected', 'failed');

CREATE TABLE commentary_runs (
  -- One batch per week, enforced by the key rather than by the caller checking.
  week_of      date PRIMARY KEY,
  batch_id     text NOT NULL,
  status       commentary_run_status NOT NULL DEFAULT 'submitted',

  requested    integer NOT NULL DEFAULT 0,
  written      integer NOT NULL DEFAULT 0,
  errored      integer NOT NULL DEFAULT 0,

  model        text NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  collected_at timestamptz,
  /** Anything a human should know about this run, including per-item failures. */
  notes        text[] NOT NULL DEFAULT '{}'
);

-- ----------------------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------------------
-- The commentary is shared reference content, like `signals` and `news`: the
-- same note about EOS is shown to everyone holding EOS, so it carries no
-- client_id and needs no per-client policy. Any signed-in user may read it.
--
-- Writes are staff-only. The generation job runs as `service_role`, which
-- bypasses RLS entirely, so this policy exists to stop a CLIENT writing their
-- own commentary — not to permit the job.
ALTER TABLE security_commentary ENABLE ROW LEVEL SECURITY;
CREATE POLICY commentary_read ON security_commentary FOR SELECT TO authenticated
  USING (true);
CREATE POLICY commentary_write ON security_commentary FOR ALL TO authenticated
  USING (is_staff()) WITH CHECK (is_staff());

-- The run log is desk plumbing, not client-facing. A client has no business
-- knowing which batch is in flight, so there is no read policy for them at all
-- — with RLS on and no matching policy, a client's SELECT returns nothing.
ALTER TABLE commentary_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY commentary_runs_staff ON commentary_runs FOR ALL TO authenticated
  USING (is_staff()) WITH CHECK (is_staff());

-- ----------------------------------------------------------------------------
-- Checking on it
-- ----------------------------------------------------------------------------
--   -- This week's coverage against what is actually held:
--   SELECT count(DISTINCT p.security_code) AS held,
--          count(DISTINCT c.security_code) AS with_a_note
--     FROM positions p
--     LEFT JOIN security_commentary c
--            ON c.security_code = p.security_code
--           AND c.week_of = (SELECT max(week_of) FROM security_commentary)
--    WHERE p.qty > 0;
--
--   -- Runs that submitted a batch and never collected it:
--   SELECT * FROM commentary_runs WHERE status = 'submitted'
--    AND submitted_at < now() - interval '24 hours';
