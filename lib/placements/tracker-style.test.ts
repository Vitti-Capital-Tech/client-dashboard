import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  CLIENT_INPUT_COLS,
  CLIENT_INPUT_LAST_ROW,
  addressOf,
  clampClientInputYellow,
  clearTemplatePlanCache,
  columnsOf,
  dressSheetLikeTemplate,
  bordersMergeable,
  mergeRegions,
  planTtlMs,
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

test("style: two boxed blocks are glued only when the join keeps its line", () => {
  const thin = { style: "Continuous", color: "#000000", weight: "Thin" };

  // A fully gridded table: the line between the two halves is the same thin
  // line as the edges it replaces, so putting them back together changes nothing.
  const grid = {
    EdgeTop: thin,
    EdgeBottom: thin,
    EdgeLeft: thin,
    EdgeRight: thin,
    InsideHorizontal: thin,
    InsideVertical: thin,
  };
  assert.equal(bordersMergeable(grid, "stacked"), true);
  assert.equal(bordersMergeable(grid, "beside"), true);

  // A box with a HOLLOW inside. Stacked, the two edges that met would become an
  // interior line — and the interior is blank, so the line would be erased.
  const hollow = { EdgeTop: thin, EdgeBottom: thin, EdgeLeft: thin, EdgeRight: thin };
  assert.equal(bordersMergeable(hollow, "stacked"), false, "the join would lose its line");
  assert.equal(bordersMergeable(hollow, "beside"), false);

  // The mirror error: an inside line where the edges are blank. Merging would
  // DRAW a line at the join that Template does not have.
  const ruledOnly = { InsideHorizontal: thin, InsideVertical: thin };
  assert.equal(bordersMergeable(ruledOnly, "stacked"), false, "the join would gain a line");
  assert.equal(bordersMergeable(ruledOnly, "beside"), false);

  // Each axis is judged on its own: rows may merge while columns may not.
  const ruledAcrossOnly = { EdgeTop: thin, EdgeBottom: thin, InsideHorizontal: thin };
  assert.equal(bordersMergeable(ruledAcrossOnly, "stacked"), true);
  assert.equal(bordersMergeable(ruledAcrossOnly, "beside"), true, "no vertical lines either way");

  // A heavier outer edge than the grid inside it — the classic table. Merging
  // would demote the inner blocks' outer edge to the thin interior rule.
  const boxedHeavy = { ...grid, EdgeTop: { ...thin, weight: "Thick" } };
  assert.equal(bordersMergeable(boxedHeavy, "stacked"), false);
  assert.equal(bordersMergeable(boxedHeavy, "beside"), true, "the columns are unaffected");
});

test("style: mergeRegions honours a refusal instead of gluing anyway", () => {
  const hollow = {
    EdgeTop: { style: "Continuous", color: "#000000", weight: "Thin" },
    EdgeBottom: { style: "Continuous", color: "#000000", weight: "Thin" },
  };

  const regions = [
    { rect: { r1: 5, c1: 1, r2: 8, c2: 16 }, value: hollow },
    { rect: { r1: 9, c1: 1, r2: 12, c2: 16 }, value: hollow },
  ];

  // Same value, touching, same columns — everything a fill would need.
  assert.equal(mergeRegions(regions).length, 1, "without a predicate they glue");
  assert.equal(
    mergeRegions(regions, bordersMergeable).length,
    2,
    "as borders they must stay apart, or row 8's underline is lost",
  );
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
  const notes = await dressSheetLikeTemplate(graph, ITEM, "Template", "PGF", "A1:P30", { budget: 400 });

  const reads = (kind: string) =>
    calls.filter((c) => c.method === "GET" && c.path.includes(`/format/${kind}`)).length;

  // The ceiling is per property now, and it is still a ceiling.
  assert.ok(reads("fill") <= 400, `fills overran their budget (${reads("fill")})`);
  assert.ok(reads("font") <= 400, `fonts overran their budget (${reads("font")})`);
  assert.match(notes.join(" "), /only partly readable/);
});

test("style: an expensive fill scan cannot spend the font scan's budget", async () => {
  /**
   * The bug this pins, which reached the desk as a real tab.
   *
   * Both scans used to share ONE allowance, spent in order. Fills go first and
   * on a real template cost most of a budget that size, so fonts were handed
   * nothing — and Template's header band is black with WHITE type on it, so the
   * tab arrived with the band painted and its headings invisible inside it.
   *
   * This Graph is the extreme of that: a fill scan that never resolves, so it
   * consumes its whole budget. The font scan must still run.
   */
  const { graph, calls } = fakeGraph();
  await dressSheetLikeTemplate(graph, ITEM, "Template", "PGF", "A1:P30");

  const fontReads = calls.filter((c) => c.method === "GET" && c.path.includes("/format/font"));
  assert.ok(
    fontReads.length > 0,
    "the fill scan exhausted the budget and the fonts were never read at all",
  );
});

test("style: a truncated plan is not held for the day", () => {
  // A complete plan is cached for hours — Template does not change between two
  // deals in a run. A TRUNCATED one may only be truncated because a read failed
  // in passing (an unanswered read counts as non-uniform, so a flaky batch
  // inflates the count), and holding that as the truth for six hours would
  // leave every deal of the morning half painted.
  const complete = planTtlMs({ incomplete: [] });
  const partial = planTtlMs({ incomplete: ["fonts"] });

  assert.ok(partial < complete, "a half-read Template outlives a fully-read one");
  // Long enough to serve the rest of an ingest run — re-scanning is deterministic
  // and would buy the same half-answer — and short enough that a transient does
  // not outlive it.
  assert.ok(partial <= 15 * 60 * 1000, `a truncated plan is held too long (${partial}ms)`);
  assert.ok(partial >= 60 * 1000, `a truncated plan is dropped too eagerly (${partial}ms)`);
});

test("style: a plan is reused within a run rather than re-scanned per deal", async () => {
  const { graph, calls } = fakeGraph();
  const reads = () => calls.filter((c) => c.method === "GET" && c.path.includes("/format/")).length;

  await dressSheetLikeTemplate(graph, ITEM, "Template", "PGF", "A1:P30");
  const afterFirst = reads();
  assert.ok(afterFirst > 0);

  // The second placement of a morning pays for the paint alone.
  await dressSheetLikeTemplate(graph, ITEM, "Template", "PGG", "A1:P30");
  assert.equal(reads(), afterFirst, "a second deal in the same run re-scanned Template");
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

/**
 * Yellow on a deal tab means "read this cell", and Template shades the client
 * inputs down to row 21 — eight rows further than any placement fills. These
 * cover the trim, and cover it in the plan rather than in a corrective write,
 * because `$batch` does not promise the order the writes go out in.
 */

test("style: Template's client-input yellow is trimmed to the rows the desk uses", () => {
  const trimmed = clampClientInputYellow([
    { rect: { r1: 5, c1: 6, r2: 21, c2: 7 }, value: "#FFFF00" },
  ]);

  assert.deepEqual(trimmed, [{ rect: { r1: 5, c1: 6, r2: CLIENT_INPUT_LAST_ROW, c2: 7 }, value: "#FFFF00" }]);

  // Rows 5 and 6 survive: the headings and the Total are what the columns are
  // read by, and they are not inputs to be trimmed alongside them.
  assert.equal(trimmed[0].rect.r1, 5);
});

test("style: trimming F and G leaves every other column its full height", () => {
  // The scan merges by colour, so a yellow block is not guaranteed to stop at
  // column F — the banner row's fill runs A to Q. Only the F-to-G slice is cut.
  const trimmed = clampClientInputYellow([
    { rect: { r1: 5, c1: 1, r2: 21, c2: 9 }, value: "#FFFF00" },
  ]);

  assert.deepEqual(trimmed, [
    { rect: { r1: 5, c1: 1, r2: 21, c2: 5 }, value: "#FFFF00" }, // A:E, untouched
    { rect: { r1: 5, c1: 8, r2: 21, c2: 9 }, value: "#FFFF00" }, // H:I, untouched
    { rect: { r1: 5, c1: 6, r2: CLIENT_INPUT_LAST_ROW, c2: 7 }, value: "#FFFF00" }, // F:G, clamped
  ]);
});

test("style: yellow that starts below the cutoff is dropped, and other colours are not touched", () => {
  const trimmed = clampClientInputYellow([
    { rect: { r1: CLIENT_INPUT_LAST_ROW + 1, c1: 6, r2: 21, c2: 7 }, value: "#ffff00" },
    { rect: { r1: 5, c1: 6, r2: 21, c2: 7 }, value: "#000000" },
    { rect: { r1: 1, c1: 1, r2: 1, c2: 17 }, value: "#FFFF00" },
  ]);

  // A region entirely past the cutoff loses its only surviving slice, so it
  // contributes nothing rather than a zero-height rectangle. Lower case is
  // still yellow; black is not, whatever rows it covers; row 1 is above the
  // cutoff and never had anything to lose.
  assert.deepEqual(trimmed, [
    { rect: { r1: 5, c1: 6, r2: 21, c2: 7 }, value: "#000000" },
    { rect: { r1: 1, c1: 1, r2: 1, c2: 17 }, value: "#FFFF00" },
  ]);
});

test("style: no yellow is painted below the cutoff on a real replay", async () => {
  const calls: { method: string; path: string; body?: unknown }[] = [];

  // A Template shaded exactly like the desk's: F5:G21 yellow, the rest plain.
  const graph: GraphCall = async (path, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, path, body: init.body });

    if (path === "/$batch") {
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
      const rect = rectOf(/range\(address='([^']+)'\)/.exec(path)?.[1] ?? "");
      if (!rect) return { ok: true, status: 200, body: { color: null } };
      const inside = (r: number, c: number) => r >= 5 && r <= 21 && c >= 6 && c <= 7;
      const all = inside(rect.r1, rect.c1) && inside(rect.r2, rect.c2);
      const none =
        rect.r2 < 5 || rect.r1 > 21 || rect.c2 < 6 || rect.c1 > 7;
      // Uniform where the rectangle sits wholly in or wholly out; null on the
      // straddle, which is the signal the scan splits on.
      return {
        ok: true,
        status: 200,
        body: { color: all ? "#FFFF00" : none ? "#FFFFFF" : null },
      };
    }
    if (method === "GET" && path.includes("/format/font")) {
      return { ok: true, status: 200, body: { name: "Calibri", size: 11, color: "#000000", bold: false, italic: false, underline: "None" } };
    }
    if (method === "GET" && path.includes("/format")) {
      return { ok: true, status: 200, body: { columnWidth: 14.5 } };
    }
    return { ok: true, status: 200, body: {} };
  };

  await dressSheetLikeTemplate(graph, ITEM, "Template", "W2V", "A1:J21");

  const yellowWrites = calls.filter(
    (c) =>
      c.method === "PATCH" &&
      c.path.includes("/format/fill") &&
      String((c.body as { color?: string }).color).toUpperCase() === "#FFFF00",
  );

  assert.ok(yellowWrites.length > 0, "the client inputs are still shaded");

  for (const w of yellowWrites) {
    const rect = rectOf(/range\(address='([^']+)'\)/.exec(w.path)?.[1] ?? "");
    if (!rect || rect.c2 < CLIENT_INPUT_COLS.c1 || rect.c1 > CLIENT_INPUT_COLS.c2) continue;
    assert.ok(
      rect.r2 <= CLIENT_INPUT_LAST_ROW,
      `yellow reaches row ${rect.r2} in F:G — the cutoff is ${CLIENT_INPUT_LAST_ROW}`,
    );
  }
});
