import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  addressOf,
  clearTemplatePlanCache,
  columnsOf,
  dressSheetLikeTemplate,
  mergeRegions,
  rectOf,
  splitRect,
} from "./tracker-style.ts";
import type { GraphCall } from "./tracker-writer.ts";

/**
 * Tests for recovering Template's look through an API that will not hand it
 * over cell by cell.
 *
 * The whole method rests on one behaviour of Graph — a format read over a range
 * answers with the value where the cells agree and `null` where they do not —
 * so what is worth covering is the machinery built on top of it: that the
 * splitting converges on the right rectangles, that the pieces are glued back
 * together before they cost a write, and that neither a budget nor a tenant
 * without `$batch` turns a cosmetic step into a failed deal.
 */

const ITEM = "/drives/d/items/i/workbook";

beforeEach(() => clearTemplatePlanCache());

test("style: an address is a rectangle, and survives the round trip", () => {
  assert.deepEqual(rectOf("A1:P30"), { r1: 1, c1: 1, r2: 30, c2: 16 });
  assert.deepEqual(rectOf("C3"), { r1: 3, c1: 3, r2: 3, c2: 3 }, "a bare cell is a 1×1");
  // Past Z, because a template is allowed to grow.
  assert.deepEqual(rectOf("Y1:AB2"), { r1: 1, c1: 25, r2: 2, c2: 28 });

  assert.equal(addressOf({ r1: 1, c1: 1, r2: 30, c2: 16 }), "A1:P30");
  assert.equal(addressOf({ r1: 3, c1: 3, r2: 3, c2: 3 }), "C3:C3");

  // A sheet-qualified or backwards address is not a rectangle to scan.
  assert.equal(rectOf("Template!A1:P30"), null);
  assert.equal(rectOf("D30:A1"), null);
});

test("style: a used range names the columns whose widths have to be replayed", () => {
  assert.deepEqual(columnsOf("A1:D30"), ["A", "B", "C", "D"]);
  assert.equal(columnsOf("A1:P30")?.length, 16);
  assert.deepEqual(columnsOf("C3"), ["C"]);
  assert.deepEqual(columnsOf("Y1:AB1"), ["Y", "Z", "AA", "AB"]);
  assert.equal(columnsOf("Template!A1:P30"), null);
  assert.equal(columnsOf("D30:A1"), null);
});

test("style: a non-uniform rectangle is halved across the ROWS first", () => {
  // Sheets are formatted in bands — a black header row, a grey total row. Cutting
  // across the rows finds those whole; cutting down the columns would slice every
  // one of them in half and double the reads.
  assert.deepEqual(splitRect({ r1: 1, c1: 1, r2: 30, c2: 16 }), [
    { r1: 1, c1: 1, r2: 15, c2: 16 },
    { r1: 16, c1: 1, r2: 30, c2: 16 },
  ]);

  // Only once there is a single row left does the split turn sideways.
  assert.deepEqual(splitRect({ r1: 3, c1: 1, r2: 3, c2: 4 }), [
    { r1: 3, c1: 1, r2: 3, c2: 2 },
    { r1: 3, c1: 3, r2: 3, c2: 4 },
  ]);

  // And a single cell is uniform by definition: a null there means "no fill",
  // not "ask again", which is what stops the recursion.
  assert.equal(splitRect({ r1: 3, c1: 3, r2: 3, c2: 3 }), null);
});

test("style: rectangles split apart by the scan are glued back before they cost a write", () => {
  const merged = mergeRegions([
    { rect: { r1: 4, c1: 1, r2: 4, c2: 16 }, value: "#FFFFFF" },
    { rect: { r1: 5, c1: 1, r2: 8, c2: 16 }, value: "#FFFFFF" },
    { rect: { r1: 9, c1: 1, r2: 30, c2: 16 }, value: "#FFFFFF" },
    { rect: { r1: 3, c1: 1, r2: 3, c2: 16 }, value: "#000000" },
  ]);

  assert.equal(merged.length, 2, "three white bands are one write, not three");
  assert.deepEqual(
    merged.find((r) => r.value === "#FFFFFF")?.rect,
    { r1: 4, c1: 1, r2: 30, c2: 16 },
  );
});

test("style: only touching rectangles of the same colour are glued", () => {
  const apart = mergeRegions([
    { rect: { r1: 1, c1: 1, r2: 1, c2: 4 }, value: "#FFFF00" },
    { rect: { r1: 3, c1: 1, r2: 3, c2: 4 }, value: "#FFFF00" },
  ]);
  assert.equal(apart.length, 2, "row 2 sits between them");

  const beside = mergeRegions([
    { rect: { r1: 1, c1: 1, r2: 4, c2: 2 }, value: "#FFFF00" },
    { rect: { r1: 1, c1: 3, r2: 4, c2: 6 }, value: "#FFFF00" },
  ]);
  assert.deepEqual(beside, [{ rect: { r1: 1, c1: 1, r2: 4, c2: 6 }, value: "#FFFF00" }]);

  const different = mergeRegions([
    { rect: { r1: 1, c1: 1, r2: 1, c2: 4 }, value: "#FFFF00" },
    { rect: { r1: 2, c1: 1, r2: 2, c2: 4 }, value: "#000000" },
  ]);
  assert.equal(different.length, 2);
});

/* ---------------------------------------------------------------- */
/* Against a Graph                                                   */
/* ---------------------------------------------------------------- */

/**
 * A Graph whose Template is shaded a different colour in every single cell.
 *
 * Nothing real looks like this — it is the case where the splitting never
 * resolves, and the point of it is that the scan gives up on a budget rather
 * than spending an ingest's whole allowance on shading.
 */
function fakeGraph(opts: { canBatch?: boolean } = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];

  const graph: GraphCall = async (path, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, path, body: init.body });

    if (path === "/$batch") {
      if (opts.canBatch === false) {
        return { ok: false, status: 400, body: { error: { message: "batching is off" } } };
      }
      const inner = (init.body as { requests: { id: string; method: string; url: string; body?: unknown }[] })
        .requests;
      const responses = [];
      for (const r of inner) {
        const answer = await graph(r.url, { method: r.method, body: r.body });
        responses.push({ id: r.id, status: answer.status, body: answer.body });
      }
      return { ok: true, status: 200, body: { responses } };
    }

    if (method === "GET" && path.includes("/format/fill")) {
      const address = /range\(address='([^']+)'\)/.exec(path)?.[1] ?? "";
      const rect = rectOf(address);
      const single = rect && rect.r1 === rect.r2 && rect.c1 === rect.c2;
      return { ok: true, status: 200, body: { color: single ? "#123456" : null } };
    }
    if (method === "GET" && path.includes("/format/font")) {
      return { ok: true, status: 200, body: { name: null, size: null } };
    }
    if (method === "GET" && path.includes("/format")) {
      return { ok: true, status: 200, body: { columnWidth: 14.5 } };
    }

    return { ok: true, status: 200, body: {} };
  };

  return { graph, calls };
}

test("style: a template that never resolves stops at the budget and says so", async () => {
  const { graph, calls } = fakeGraph();
  const notes = await dressSheetLikeTemplate(graph, ITEM, "Template", "PGF", "A1:P30");

  const reads = calls.filter((c) => c.method === "GET" && /\/format\/(fill|font)/.test(c.path));
  assert.ok(reads.length <= 240, `the budget is a ceiling, not a suggestion (${reads.length})`);
  assert.match(notes.join(" "), /only partly readable/);
});

test("style: a tenant without $batch still gets its tab painted", async () => {
  // Batching is what keeps the scan inside the cron's 60 seconds, but a workbook
  // whose endpoint refuses it should end up with a shaded tab and a slow ingest,
  // not a white tab and a fast one.
  const { graph, calls } = fakeGraph({ canBatch: false });
  await dressSheetLikeTemplate(graph, ITEM, "Template", "PGF", "A1:B2");

  assert.ok(
    calls.some((c) => c.method === "PATCH" && c.path.includes("/format/fill") && c.path.includes("PGF")),
    "the fills were sent one at a time",
  );
  assert.ok(
    calls.some((c) => c.method === "GET" && c.path.includes("/format/fill") && c.path.includes("Template")),
    "and read the same way",
  );
});

test("style: nothing about shading can fail a deal", async () => {
  // By the time this runs the deal is already on the Overview. A Graph that
  // throws mid-paint has to come back as a note.
  const graph: GraphCall = async () => {
    throw new Error("connection reset");
  };

  const notes = await dressSheetLikeTemplate(graph, ITEM, "Template", "PGF", "A1:P30");
  assert.match(notes.join(" "), /connection reset/);
});
