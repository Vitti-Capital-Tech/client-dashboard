-- ============================================================================
-- Morning mail ingest (Stage 14) — provenance for the unattended importer
-- ----------------------------------------------------------------------------
-- Every weekday the broker mails a holdings snapshot and a confirmations file.
-- A cron job reads that mailbox and runs the same importers the CLI runs.
--
-- Unattended imports need something an operator at a terminal does not: a
-- record of what was seen and what was done about it. Nobody is watching the
-- output, so the output has to be written down.
--
-- Two tables, answering two different questions:
--
--   ingest_runs        — "did the job run this morning, and how did it go?"
--   ingest_attachments — "what happened to THAT file?"
--
-- ── Why this is not just logging ─────────────────────────────────────────────
-- The holdings import is a FULL REPLACE of `positions`. A truncated export
-- would faithfully delete every position it fails to mention, so a file can be
-- QUARANTINED rather than applied — and a quarantined file has to be findable,
-- explainable and re-runnable by hand. That is a table, not a log line.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- ingest_runs — one row per cron invocation
-- ----------------------------------------------------------------------------
CREATE TABLE ingest_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,

  -- Only messages newer than this were considered. Stored so a run is
  -- reproducible, and so a gap in coverage is visible rather than inferred.
  watermark       timestamptz,

  messages_seen   integer NOT NULL DEFAULT 0,
  attachments     integer NOT NULL DEFAULT 0,
  imported        integer NOT NULL DEFAULT 0,
  quarantined     integer NOT NULL DEFAULT 0,

  -- 'ok' | 'partial' | 'failed'. A run that imported some files and choked on
  -- one is NOT ok, and must not be reported as such.
  status          text NOT NULL DEFAULT 'ok',
  error           text,
  -- Free-form detail for the desk: which accounts were recomputed, what the
  -- guardrail decided, why a file was skipped.
  notes           text[] NOT NULL DEFAULT '{}',

  -- Ties the run to the P&L batch it triggered (pnl_runs.batch_id).
  pnl_batch_id    uuid
);

CREATE INDEX idx_ingest_runs_started ON ingest_runs(started_at DESC);

-- ----------------------------------------------------------------------------
-- ingest_attachments — one row per attachment ever seen
-- ----------------------------------------------------------------------------
-- The idempotency key is (message_id, attachment_id): Graph's own identifiers,
-- exact and stable. `sha256` is recorded for the audit trail but deliberately
-- NOT made unique — the broker legitimately resends an identical file, and both
-- importers are idempotent, so a duplicate is cheap rather than dangerous.
CREATE TABLE ingest_attachments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid REFERENCES ingest_runs(id) ON DELETE SET NULL,

  message_id      text NOT NULL,
  attachment_id   text NOT NULL,
  received_at     timestamptz NOT NULL,
  sender          text,
  subject         text,
  filename        text NOT NULL,
  size_bytes      integer,
  sha256          text NOT NULL,

  -- What the HEADERS said it was: 'holdings' | 'trades' | 'unknown'. Never the
  -- filename — see lib/import/runner.ts `detectCsvKind`.
  kind            text NOT NULL,

  -- 'imported'    — applied to the database
  -- 'quarantined' — parsed fine, but the coverage guardrail refused it
  -- 'unrecognised'— headers matched neither export; nothing was attempted
  -- 'failed'      — the importer threw
  outcome         text NOT NULL,
  rows_parsed     integer,
  error           text,
  -- The accounts this file touched, so a P&L question can be traced to a file.
  account_refs    text[] NOT NULL DEFAULT '{}',

  processed_at    timestamptz NOT NULL DEFAULT now(),

  UNIQUE (message_id, attachment_id)
);

CREATE INDEX idx_ingest_att_received ON ingest_attachments(received_at DESC);
CREATE INDEX idx_ingest_att_outcome  ON ingest_attachments(outcome)
  WHERE outcome <> 'imported';

-- ----------------------------------------------------------------------------
-- RLS — staff only, both ways.
-- ----------------------------------------------------------------------------
-- Unlike positions or P&L these rows belong to no client: one attachment covers
-- every account in the book, and its subject line and sender are internal
-- operational detail. There is deliberately no client-readable policy at all.
-- The ingest itself runs as service_role and bypasses RLS.
ALTER TABLE ingest_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY ingest_runs_staff ON ingest_runs FOR ALL TO authenticated
  USING (is_staff()) WITH CHECK (is_staff());

ALTER TABLE ingest_attachments ENABLE ROW LEVEL SECURITY;
CREATE POLICY ingest_attachments_staff ON ingest_attachments FOR ALL TO authenticated
  USING (is_staff()) WITH CHECK (is_staff());
