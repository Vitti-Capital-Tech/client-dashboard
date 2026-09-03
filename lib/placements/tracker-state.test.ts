import test from "node:test";
import assert from "node:assert/strict";

import { fakeDb } from "../test-support/fake-db.ts";
import {
  DEFAULT_TRACKER_BATCH,
  markTrackerFailed,
  markTrackerWritten,
  orderTrackerQueue,
  owedTrackerCandidates,
} from "./tracker-state.ts";

/**
 * Tests for the queue of deals owed a tab in the Placement Tracker.
 *
 * What is worth pinning here is the property the old code did not have: a write
 * that failed must still be owed afterwards. Everything else in this file exists
 * to stop the obvious ways of getting that wrong — marking a deal written when
 * it was not, letting an unwritable deal starve a new one, or reading a missing
 * migration as an empty queue.
 */

const row = (over: Record<string, unknown> = {}) => ({
  id: "c1",
  ticker: "FBR",
  company: "FBR",
  deal_type: "Placement",
  subject: "[APPROVAL REQUIRED] FBR Limited",
  summary: "Price: $0.115/share",
  received_at: "2026-09-03T00:06:40+00:00",
  tracker_attempts: 0,
  tracker_written_at: null,
  dismissed_at: null,
  ...over,
});

test("tracker queue: a deal with no tab is owed one; a deal with a tab is not", async () => {
  const { db } = fakeDb({
    placement_candidates: [
      row({ id: "owed", ticker: "FBR" }),
      row({ id: "filed", ticker: "OWL", tracker_written_at: "2026-09-02T05:59:38Z" }),
    ],
  });

  const owed = await owedTrackerCandidates(db);
  assert.equal(owed.ok, true);
  assert.deepEqual(
    owed.items.map((i) => i.id),
    ["owed"],
  );
});

test("tracker queue: a dismissed deal stops being owed rather than being written", async () => {
  // The desk passing on a raise before the sync got to it is a reason not to
  // build the tab, not a write that succeeded. It must not be marked written
  // either — that would claim the workbook has something it does not.
  const { db, tables } = fakeDb({
    placement_candidates: [
      row({ id: "passed", dismissed_at: "2026-09-03T00:30:00Z" }),
      row({ id: "live", ticker: "NGY", received_at: "2026-09-02T23:25:13+00:00" }),
    ],
  });

  const owed = await owedTrackerCandidates(db);
  assert.deepEqual(
    owed.items.map((i) => i.id),
    ["live"],
  );
  assert.equal(
    tables.placement_candidates.find((r) => r.id === "passed")?.tracker_written_at,
    null,
  );
});

test("tracker queue: a candidate stored before this column existed reads as owed", async () => {
  // The migration backfills, but a fixture — or a row mid-deploy — may simply
  // not carry the column. Absent has to mean NULL, or the queue would silently
  // skip exactly the rows it exists for.
  const { db } = fakeDb({ placement_candidates: [{ id: "old", ticker: "PGF", received_at: "x" }] });
  const owed = await owedTrackerCandidates(db);
  assert.deepEqual(
    owed.items.map((i) => i.id),
    ["old"],
  );
});

test("tracker queue: a read that fails is NOT an empty queue", async () => {
  // This is the whole point. "Nothing to write" and "I could not find out what
  // to write" reaching the caller as the same answer is how a month of deals
  // goes missing, so the missing-migration case names itself.
  const db = {
    from: () => ({
      select: () => ({
        is: () => ({
          is: () => ({
            order: () =>
              Promise.resolve({
                data: null,
                error: { message: 'column placement_candidates.tracker_written_at does not exist' },
              }),
          }),
        }),
      }),
    }),
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a stub narrow enough to name the one call under test.
  const owed = await owedTrackerCandidates(db as any);
  assert.equal(owed.ok, false);
  assert.equal(owed.items.length, 0);
  assert.match(owed.error ?? "", /20260903090000_placement_tracker_queue\.sql/);
});

test("tracker queue: oldest first, so the Overview reads in announcement order", () => {
  const q = orderTrackerQueue(
    [
      { attempts: 0, received_at: "2026-09-03T00:06:40Z" },
      { attempts: 0, received_at: "2026-09-02T23:25:13Z" },
    ],
    5,
  );
  assert.deepEqual(
    q.map((i) => i.received_at),
    ["2026-09-02T23:25:13Z", "2026-09-03T00:06:40Z"],
  );
});

test("tracker queue: a deal the workbook keeps refusing does not starve a new one", () => {
  // Ordering purely by date would put a deal that cannot be written — a year
  // with no configured file, a ticker already holding twenty-six tabs — at the
  // front of every batch forever, and this morning's placement would never be
  // reached. Attempts lead, so it goes last and is still retried.
  const q = orderTrackerQueue(
    [
      { attempts: 7, received_at: "2026-08-01T00:00:00Z" },
      { attempts: 0, received_at: "2026-09-03T00:06:40Z" },
    ],
    1,
  );
  assert.deepEqual(
    q.map((i) => i.attempts),
    [0],
  );
});

test("tracker queue: the batch is a bound, and it is small", () => {
  const many = Array.from({ length: 10 }, (_, i) => ({
    attempts: 0,
    received_at: `2026-09-0${i % 9}T00:00:00Z`,
  }));
  assert.equal(orderTrackerQueue(many).length, DEFAULT_TRACKER_BATCH);
  assert.equal(orderTrackerQueue(many, 0).length, 0);
});

test("tracker queue: a written deal stops being owed and drops its old error", async () => {
  const { db, tables } = fakeDb({
    placement_candidates: [row({ id: "c1", tracker_attempts: 2, tracker_error: "403 last time" })],
  });

  await markTrackerWritten(db, "c1", { sheet: "FBR", now: new Date("2026-09-03T01:00:00Z") });

  const [saved] = tables.placement_candidates;
  assert.equal(saved.tracker_written_at, "2026-09-03T01:00:00.000Z");
  assert.equal(saved.tracker_sheet, "FBR");
  assert.equal(saved.tracker_error, null, "a filed deal must not still carry a reason it was not");
  assert.deepEqual((await owedTrackerCandidates(db)).items, []);
});

test("tracker queue: a deal already in the workbook is filed, with no sheet of ours to name", async () => {
  const { db, tables } = fakeDb({ placement_candidates: [row()] });
  await markTrackerWritten(db, "c1", { sheet: null });

  assert.equal(tables.placement_candidates[0].tracker_sheet, null);
  assert.ok(tables.placement_candidates[0].tracker_written_at, "but it IS settled");
});

test("tracker queue: a failed write leaves the deal owed — this is the whole fix", async () => {
  // Before this, the tracker was handed the candidates one run had just stored,
  // and a candidate is fresh exactly once. A failure was therefore permanent:
  // the hourly sweep saw nothing fresh and wrote nothing, and on 3 September 2026
  // the desk built two tabs by hand.
  const { db, tables } = fakeDb({ placement_candidates: [row({ tracker_attempts: 1 })] });

  await markTrackerFailed(db, "c1", { attempts: 1, error: "Graph refused: 423 resourceLocked" });

  assert.equal(tables.placement_candidates[0].tracker_attempts, 2);
  assert.match(tables.placement_candidates[0].tracker_error, /resourceLocked/);

  const owed = await owedTrackerCandidates(db);
  assert.deepEqual(
    owed.items.map((i) => ({ id: i.id, attempts: i.attempts })),
    [{ id: "c1", attempts: 2 }],
    "still owed, and the next run knows how many times it has tried",
  );
});

test("tracker queue: a paragraph of Graph guidance is trimmed, not stored whole", async () => {
  const { db, tables } = fakeDb({ placement_candidates: [row()] });
  await markTrackerFailed(db, "c1", { attempts: 0, error: "x".repeat(2000) });
  assert.equal(tables.placement_candidates[0].tracker_error.length, 500);
});
