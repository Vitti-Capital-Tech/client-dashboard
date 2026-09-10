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
-- `null`, and asking again. It works, and it is expensive:
--
--   SCAN  : 504,324 ms  (1,207 format reads in 69 batches)   measured, complete
--   WRITES:        73   (16 widths, 16 fills, 39 fonts, 2 border edges)
--
-- Eight and a half minutes to learn the plan; four batches to apply it. The
-- reads are the whole cost and the writes are nothing.
--
-- ── Why in-process caching could not fix that ────────────────────────────────
-- The plan was cached in a module-scope Map with a 6-hour TTL. That serves a
-- warm server and a serverless one not at all: every route here has a 60-second
-- ceiling, so a cold instance cannot finish the scan at all, let alone inside
-- the budget it shares with the deal write. Whether a tab came out shaded was
-- therefore a question of which instance happened to answer.
--
-- It showed up in the workbook. `IPT` and `IPT (b)`, written at different times,
-- carry identical column widths — and all sixteen differ from Template's, each
-- about 20pt narrower. Two tabs replayed from the same stale plan long after
-- Template had been widened, with nothing anywhere recording which Template the
-- plan came from.
--
-- ── What this table changes ──────────────────────────────────────────────────
-- The plan is a pure function of Template: same sheet, same answer. So it is
-- scanned deliberately — by `npm run tracker:plan`, where no 60-second ceiling
-- applies and the read budget can be generous — and stored. A tab write becomes
-- one row read plus the 73 writes, which fits the budget with room to spare.
--
-- `shape` and `scanned_at` are stored beside the plan so the staleness that
-- caused the width drift is visible rather than inferred: the writer already
-- reads Template's used range for the cell seed, so a plan whose `shape` no
-- longer matches is caught for free and reported.
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
  'Template''s replayed formatting, scanned out-of-band. See the migration header: the scan is ~8.5 minutes of Graph reads and the routes have 60 seconds.';

-- ----------------------------------------------------------------------------
-- RLS — staff only. An operational table belonging to no client.
-- ----------------------------------------------------------------------------
ALTER TABLE placement_style_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS placement_style_plans_staff ON placement_style_plans;
CREATE POLICY placement_style_plans_staff ON placement_style_plans FOR ALL TO authenticated
  USING (is_staff()) WITH CHECK (is_staff());
