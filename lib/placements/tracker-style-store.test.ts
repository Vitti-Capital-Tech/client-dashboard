import test from "node:test";
import assert from "node:assert/strict";

import { fakeDb } from "../test-support/fake-db.ts";
import {
  STYLE_PLAN_STALE_MS,
  readStylePlan,
  stylePlanKey,
  stylePlanNotes,
  writeStylePlan,
} from "./tracker-style-store.ts";
import type { TemplatePlan } from "./tracker-style.ts";

/**
 * Tests for Template's formatting, stored instead of re-learned per deal.
 *
 * The scan is ~18.5s and 1,210 Graph reads against a 60-second route already
 * spending most of that on the feed and the deal write. But the reason this
 * table exists is the other half: nothing recorded which Template a tab had been
 * shaded from, so a stale plan and an edited Template were indistinguishable —
 * which is how the column-width drift went unnoticed.
 *
 * So what is worth pinning here is not the storage. It is the three ways a stored
 * plan goes wrong WITHOUT anything failing: a missing row, a stale one and a
 * truncated one all have to speak.
 */

const ITEM = "/drives/d1/items/i1/workbook";

const plan = (over: Partial<TemplatePlan> = {}): TemplatePlan => ({
  shape: "A1:P30",
  widths: [{ column: "A", columnWidth: 120.75 }],
  fills: [{ rect: { r1: 1, c1: 1, r2: 1, c2: 17 }, value: "#FFFF00" }],
  fonts: [],
  borders: [],
  incomplete: [],
  ...over,
});

test("style plan: a stored plan round-trips as the paint consumes it", async () => {
  const { db, tables } = fakeDb({ placement_style_plans: [] });

  await writeStylePlan(db, ITEM, "Template", plan(), {
    label: "2026 Placements · Template",
    scanMs: 504_324,
    reads: 1207,
    now: new Date("2026-09-10T03:00:00Z"),
  });

  const saved = tables.placement_style_plans[0];
  assert.equal(saved.plan_key, stylePlanKey(ITEM, "Template"));
  assert.equal(saved.shape, "A1:P30", "the shape is stored beside the plan, not only inside it");
  assert.equal(saved.reads, 1207, "the read count is kept — it is why this table exists");

  const { stored, note } = await readStylePlan(db, ITEM, "Template");
  assert.equal(note, undefined);
  assert.deepEqual(stored?.plan, plan());
  assert.equal(stored?.scannedAt, "2026-09-10T03:00:00.000Z");
});

test("style plan: the key separates workbooks and sheets", () => {
  // Two years, two workbooks, two Templates — and they must not share a row.
  // The path carries drive and item ids for a link-shared workbook, which is why
  // it is hashed rather than stored; the property that matters here is only that
  // different inputs cannot collide.
  const a = stylePlanKey("/drives/d1/items/i1/workbook", "Template");
  const b = stylePlanKey("/drives/d1/items/i2/workbook", "Template");
  const c = stylePlanKey("/drives/d1/items/i1/workbook", "Template 2");

  assert.equal(new Set([a, b, c]).size, 3);
  assert.equal(a, stylePlanKey("  /drives/d1/items/i1/workbook  ", " Template "), "trimmed");
  assert.match(a, /^[0-9a-f]{64}$/, "a hash, not the path");
});

test("style plan: no row is not an error, and not silence either", async () => {
  const { db } = fakeDb({ placement_style_plans: [] });
  const { stored } = await readStylePlan(db, ITEM, "Template");

  // Null, so the caller falls back to scanning — a deployment that has never
  // seeded still gets a shaded tab if the budget happens to allow it, and a tab
  // shaded badly beats a deal not filed. The NOTE is the caller's job; what
  // matters here is that this does not throw and does not invent a plan.
  assert.equal(stored, null);
});

test("style plan: a missing migration names itself", async () => {
  // A stub narrow enough to name the one call under test, matching how
  // `tracker-state.test.ts` covers its own missing-column case: the fake db
  // models tables that exist, and the failure here is that one does not.
  const db = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: null,
              error: { message: 'relation "placement_style_plans" does not exist' },
            }),
        }),
      }),
    }),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above.
  const { stored, note } = await readStylePlan(db as any, ITEM, "Template");
  assert.equal(stored, null);
  // "No stored plan" and "the table does not exist" want opposite things done
  // about them, and the second reads as the first for as long as nobody looks.
  assert.match(note ?? "", /20260910030000_placement_style_plan\.sql/);
  assert.match(note ?? "", /60s/, "and says what it costs until then");
});

test("style plan: Template moving under the plan is reported", () => {
  // THE check. `IPT` and `IPT (b)` were both shaded from a plan scanned before
  // Template was widened, and all sixteen column widths came out ~20pt short.
  // Nothing anywhere said which Template the plan came from, so nobody could
  // have noticed. It costs nothing: the writer already holds the live shape.
  const stored = {
    plan: plan(),
    shape: "A1:P30",
    scannedAt: new Date().toISOString(),
    incomplete: [] as never[],
  };

  assert.deepEqual(stylePlanNotes(stored, "A1:P30"), [], "unchanged shape says nothing");

  const moved = stylePlanNotes(stored, "A1:T30");
  assert.equal(moved.length, 1);
  assert.match(moved[0], /A1:P30/);
  assert.match(moved[0], /A1:T30/);
  assert.match(moved[0], /tracker:plan/, "and says what to run about it");

  // An unknown live shape is not a mismatch. The ingest resolver has no shape to
  // offer, and inventing drift there would cry wolf on every run.
  assert.deepEqual(stylePlanNotes(stored, ""), []);
});

test("style plan: age and truncation each get their own line", () => {
  const now = new Date("2026-10-20T00:00:00Z");
  const old = new Date(now.getTime() - STYLE_PLAN_STALE_MS - 86_400_000).toISOString();

  const notes = stylePlanNotes(
    { plan: plan(), shape: "A1:P30", scannedAt: old, incomplete: ["fills", "fonts"] },
    "A1:P30",
    now,
  );

  assert.equal(notes.length, 2, "two different problems, two lines");
  assert.match(notes[0], /31 days old/);
  // A truncated plan leaves cells unshaded, which is a different fault to an
  // old one and is fixed by a bigger budget rather than by re-running as-is.
  assert.match(notes[1], /fills and fonts/);
  assert.match(notes[1], /unshaded/);

  // A fresh, complete plan is quiet — the common case must not be noisy or the
  // notes stop being read.
  assert.deepEqual(
    stylePlanNotes(
      { plan: plan(), shape: "A1:P30", scannedAt: now.toISOString(), incomplete: [] },
      "A1:P30",
      now,
    ),
    [],
  );
});
