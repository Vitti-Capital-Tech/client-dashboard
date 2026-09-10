-- ============================================================================
-- placement_style_plans — Template's look, scanned once instead of per deal
-- ----------------------------------------------------------------------------
-- Graph offers no way to copy a worksheet's formatting. Both actions that would
-- do it were probed against this tenant on 10 Sep 2026 and neither exists, in
-- v1.0 or in beta:
--
--   POST .../worksheets('Template')/copy              -> "Resource not found
--   POST .../range(address='A100')/copyFrom              for the segment ..."
--
-- So `tracker-style.ts` reconstructs the formatting by treating a range read as
-- a uniformity test — asking about a rectangle, halving whatever comes back
-- `null`, and asking again. Measured against the live workbook, at the same
-- budget and the same read count both times:
--
--   no workbook session : 438,500 ms   1,210 format reads
--   with a session      :  18,500 ms   1,212 format reads
--   applying the plan   :        73 writes (16 widths, 16 fills, 39 fonts,
--                                           2 border edges) — four batches
--
-- The read COUNT is not the cost. The workbook is: 13 MB, reloaded on every
-- request unless a session holds it open. The ingest path always opened one
-- (`writeDealToTracker` does, for read-after-write consistency, and the style
-- pass inherits it), so it was never paying the 24x — an early version of the
-- seed script was, and the 504s figure first quoted here came from there.
-- Corrected in place, because that number made this table look necessary rather
-- than merely right, and the difference matters to whoever reads this next.
--
-- ── Why store it, at 18.5s ───────────────────────────────────────────────────
-- Two reasons.
--
-- **The 60 seconds are shared.** A route spends them on two upstream feed reads,
-- the deal write and the paint together. A measured mail-hook run had ~20s left
-- of its 60 after 39s of upstream reads — that is the budget a tab write fits
-- into, and BMN on 9 Sep 2026 did not fit it: stored at 05:15:03, never
-- attempted, picked up by the 06:00 sweep. ~18s of that spent re-learning a plan
-- that changes maybe twice a year is waste, however affordable it is alone.
--
-- **Nothing recorded which Template a tab was shaded from**, and that is the one
-- that bit. `IPT` and `IPT (b)`, written at different times, carry identical
-- column widths — all sixteen about 20pt narrower than Template's. A stale
-- in-process plan and a Template edited afterwards were indistinguishable,
-- because neither fact was written down anywhere.
--
-- ── What this table changes ──────────────────────────────────────────────────
-- The plan is a pure function of Template: same sheet, same answer. So it is
-- scanned deliberately, by `npm run tracker:plan`, with a generous budget and a
-- session, and stored. A tab write becomes one row read plus the 73 writes.
--
-- `shape` and `scanned_at` are stored beside the plan so the question nobody
-- could answer has an answer: the writer already reads Template's used range for
-- the cell seed, so a plan whose `shape` no longer matches is caught for free
-- and reported.
--
-- Not a source of truth. Template is; this is a materialisation of it, and a
-- stale one is a real risk — which is exactly the failure it exists to make
-- visible. An ABSENT plan is not fatal: the writer falls back to scanning, and
-- the deal is filed either way, because shading was never worth failing a deal
-- over.
-- ============================================================================

CREATE TABLE IF NOT EXISTS placement_style_plans (
  -- sha256 of the workbook item path + the template sheet name, not the path:
  -- it carries drive and item ids for a link-shared workbook, and this table is
  -- readable by every staff member. Same reasoning as placement_tracker_cache.
  plan_key    text PRIMARY KEY,
  -- The workbook's filename and sheet, for whoever reads this table by hand.
  label       text NOT NULL,
  -- Template's used range as at the scan (`A1:P30`). Compared against the live
  -- one on every write; a mismatch means Template moved under the plan.
  shape       text NOT NULL,
  -- The TemplatePlan, exactly as `paintSheetLikeTemplate` consumes it.
  plan        jsonb NOT NULL,
  -- Which scans ran short of their read budget, if any. A plan that is
  -- incomplete is still worth storing — it is what a live run would have used —
  -- but it should be re-scanned with a larger budget rather than trusted.
  incomplete  text[] NOT NULL DEFAULT '{}',
  scanned_at  timestamptz NOT NULL DEFAULT now(),
  scan_ms     integer,
  -- Format reads the scan spent. Recorded because it is the number that decides
  -- whether this can ever move back into a request.
  reads       integer
);

COMMENT ON TABLE placement_style_plans IS
  'Template''s replayed formatting, scanned out-of-band. See the migration header: ~18.5s and 1,210 Graph reads, against a 60s route budget already spent on the feed and the deal write.';

-- ----------------------------------------------------------------------------
-- RLS — staff only. An operational table belonging to no client.
-- ----------------------------------------------------------------------------
ALTER TABLE placement_style_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS placement_style_plans_staff ON placement_style_plans;
CREATE POLICY placement_style_plans_staff ON placement_style_plans FOR ALL TO authenticated
  USING (is_staff()) WITH CHECK (is_staff());
