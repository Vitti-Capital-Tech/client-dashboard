import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  alreadyInOverview,
  dealSheetPlacement,
  excelSerialDate,
  formulaSheetRef,
  isBareTab,
  isDealSheet,
  nextOverviewSlot,
  nextSheetName,
  overviewRowFormulas,
  referencedSheetName,
  sheetLinkFormula,
  tabCellWrites,
  termsCell,
  unreferencedTabFor,
} from "./tracker-format.ts";
import { writeDealToTracker, type GraphCall } from "./tracker-writer.ts";
import { clearTemplatePlanCache, columnsOf, rectOf } from "./tracker-style.ts";
import { dealFromCandidate, syncTrackerRows } from "./tracker-sync.ts";
import type { CandidateFeedItem } from "./candidates.ts";

/**
 * Tests for writing a deal into the Placement Tracker.
 *
 * The workbook is the desk's live book and this code cannot be tried out on it,
 * so the fake Graph below is the only place the whole sequence runs. What is
 * worth covering is the order of operations and everything that must NOT happen
 * twice: the tab exists before the row that references it, a deal already in the
 * file is not written again, and a failure part-way says which half landed.
 *
 * The cell addresses and formulas are the ones read out of the real
 * `2026 Placements.xlsx`, not invented — see `tracker-format.ts`.
 */

const DEAL = {
  ticker: "PGF",
  issueDate: "2026-08-12",
  price: 3.07,
  settleDate: "2026-08-19",
  addOns: "1:2 free listed options",
};

/**
 * Two rows of Template, shaped as Graph returns them: literals and formulas in
 * one `formulas` array, empty cells as "".
 */
const TEMPLATE_FORMULAS = [
  ["ONLY EDIT FIELDS HIGHLIGHTED IN YELLOW", "", "Industry", "ASX CODE"],
  ["Date", "", "", ""],
  ["2 Tranche", "yes", "Ratio", "=D6/C6"],
];

/** The formats beside them — this is what makes a date read as a date. */
const TEMPLATE_NUMBER_FORMATS = [
  ["General", "General", "General", "General"],
  ["dd/mm/yyyy", "General", "General", "General"],
  ["General", "General", "General", "0.00%"],
];

const TEMPLATE_COLUMN_WIDTH = 14.5;

/**
 * Template's shading, as the real sheet is shaded: a yellow banner, a black
 * header band with white bold type under it, and plain cells below.
 *
 * Expressed as a function of the cell rather than a grid because that is how the
 * writer has to discover it — by asking Graph whether a rectangle is uniform and
 * splitting the ones that are not.
 */
const TEMPLATE_FILL = (row: number): string =>
  row <= 2 ? "#FFFF00" : row === 3 ? "#000000" : "#FFFFFF";

const TEMPLATE_FONT = (row: number) => ({
  name: "Calibri",
  size: 11,
  color: row === 3 ? "#FFFFFF" : "#000000",
  bold: row === 3,
  italic: false,
  underline: "None",
});

/** Graph's answer for a range: the value where the cells agree, null where not. */
function uniformOver<T>(address: string, at: (row: number) => T): T | null {
  const rect = rectOf(address);
  if (!rect) return null;

  let first: T | null = null;
  for (let row = rect.r1; row <= rect.r2; row++) {
    const value = at(row);
    if (first === null) first = value;
    else if (JSON.stringify(value) !== JSON.stringify(first)) return null;
  }
  return first;
}

/** A font nulls PER PROPERTY, which is why the reader insists on all six. */
function fontOver(address: string): Record<string, unknown> {
  const rect = rectOf(address);
  if (!rect) return {};

  const rows: ReturnType<typeof TEMPLATE_FONT>[] = [];
  for (let row = rect.r1; row <= rect.r2; row++) rows.push(TEMPLATE_FONT(row));

  const agreed = (key: keyof ReturnType<typeof TEMPLATE_FONT>) => {
    const seen = new Set(rows.map((f) => f[key]));
    return seen.size === 1 ? rows[0][key] : null;
  };

  return {
    name: agreed("name"),
    size: agreed("size"),
    color: agreed("color"),
    bold: agreed("bold"),
    italic: agreed("italic"),
    underline: agreed("underline"),
  };
}

/** Template's client table is boxed; nothing else on the sheet carries a line. */
const TEMPLATE_BOXED = (row: number) => row >= 5 && row <= 22;

const THIN = { style: "Continuous", color: "#000000", weight: "Thin" };
const NO_EDGE = { style: "None", color: "#000000", weight: "Thin" };

const BORDER_SIDES = [
  "EdgeTop",
  "EdgeBottom",
  "EdgeLeft",
  "EdgeRight",
  "InsideHorizontal",
  "InsideVertical",
];

/**
 * Borders come back as the whole COLLECTION in one read — which is what makes
 * them affordable — and each side nulls independently where the cells disagree.
 *
 * Note what a border read means: the four `Edge*` sides are the edges of the
 * RECTANGLE asked about, and `Inside*` are the lines between its cells. That is
 * why a range with no inside — a single row, a single column — reports its
 * inside lines as `None` rather than as the line it does have somewhere else.
 */
function bordersOver(address: string): { value: Record<string, unknown>[] } {
  const rect = rectOf(address);
  if (!rect) return { value: [] };

  const rows: boolean[] = [];
  for (let row = rect.r1; row <= rect.r2; row++) rows.push(TEMPLATE_BOXED(row));

  const all = rows.every(Boolean);
  const none = rows.every((b) => !b);

  return {
    value: BORDER_SIDES.map((sideIndex) => {
      // Boxed and unboxed rows in one rectangle: Graph cannot answer, so it nulls.
      if (!all && !none) return { sideIndex, style: null, color: null, weight: null };

      const hasInside =
        sideIndex === "InsideHorizontal"
          ? rect.r2 > rect.r1
          : sideIndex === "InsideVertical"
            ? rect.c2 > rect.c1
            : true;

      return { sideIndex, ...(all && hasInside ? THIN : NO_EDGE) };
    }),
  };
}

const addressIn = (path: string) => /range\(address='([^']+)'\)/.exec(path)?.[1] ?? "";

/** `…/worksheets('2026%20Overview')/range(…)` → `2026 Overview`. */
const sheetIn = (path: string) => {
  const m = /worksheets\('([^']+)'\)/.exec(path);
  return m ? decodeURIComponent(m[1]) : "";
};

/**
 * The Overview's D column, as the real sheet carries it.
 *
 * Every row's Date Issued is `='PGF'!B3`, and that formula is the ONLY record of
 * which sheet a row belongs to — column C's value is the friendly ticker, which
 * for a repeat issuer filed as `PGF (b)` is still `PGF`. The writer reads it to
 * tell a tab the Overview accounts for from one it does not, so the fake has to
 * answer with it or every existing tab would look like abandoned wreckage.
 *
 * A fixture row may name its sheet as a fourth element; otherwise the sheet is
 * the ticker, which is the normal case.
 */
function overviewFormulas(rows: (string | number)[][]): (string | number)[][] {
  return rows.map((r) => {
    const sheet = String(r[3] ?? r[1] ?? "").trim();
    return sheet === "" ? ["", "", ""] : ["", "", `='${sheet}'!B3`];
  });
}

/**
 * A Graph that records calls and answers from a literal workbook.
 *
 * `canCopy` is the interesting knob: `worksheets/{id}/copy` exists on some
 * tenants and answers `400 Resource not found for the segment 'copy'` on
 * others, and the writer has to produce a correct tab either way. Both branches
 * are exercised below.
 */
function fakeGraph(
  workbook: {
    sheets: string[];
    overview: (string | number)[][];
    /**
     * What individual deal tabs already hold, by sheet then address.
     *
     * Only the adoption path needs this: whether a leftover tab is bare, and
     * whether its `D3` shows somebody has claimed it, is the difference between
     * finishing that tab and filing a second one beside it.
     */
    cells?: Record<string, Record<string, string | number>>;
  },
  fail?: { path: RegExp; status: number; message?: string },
  opts: { canCopy?: boolean } = {},
) {
  const calls: { method: string; path: string; body?: unknown; session?: string }[] = [];

  const graph: GraphCall = async (path, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({
      method,
      path,
      body: init.body,
      session: init.headers?.["workbook-session-id"],
    });

    if (fail && fail.path.test(path) && method !== "GET") {
      return {
        ok: false,
        status: fail.status,
        body: { error: { code: "Failed", message: fail.message ?? "nope" } },
      };
    }

    if (method === "GET" && path.includes("/worksheets?")) {
      return {
        ok: true,
        status: 200,
        body: { value: workbook.sheets.map((name, position) => ({ name, position })) },
      };
    }
    if (method === "GET" && path.includes("usedRange")) {
      // Graph hands back the address, the formulas and the number formats together.
      return {
        ok: true,
        status: 200,
        body: {
          address: "Template!A1:P30",
          formulas: TEMPLATE_FORMULAS,
          numberFormat: TEMPLATE_NUMBER_FORMATS,
        },
      };
    }
    if (method === "GET" && path.includes("/format/fill")) {
      return { ok: true, status: 200, body: { color: uniformOver(addressIn(path), TEMPLATE_FILL) } };
    }
    if (method === "GET" && path.includes("/format/font")) {
      return { ok: true, status: 200, body: fontOver(addressIn(path)) };
    }
    // Before the bare `/format` arm below, which would otherwise answer a
    // border read with a column width.
    if (method === "GET" && path.includes("/format/borders")) {
      return { ok: true, status: 200, body: bordersOver(addressIn(path)) };
    }
    if (method === "GET" && path.includes("/format")) {
      return { ok: true, status: 200, body: { columnWidth: TEMPLATE_COLUMN_WIDTH } };
    }
    if (method === "GET" && path.includes("range(address=")) {
      const sheet = sheetIn(path);
      if (sheet === "" || /overview$/i.test(sheet)) {
        return {
          ok: true,
          status: 200,
          body: { values: workbook.overview, formulas: overviewFormulas(workbook.overview) },
        };
      }

      // A read of a deal tab's own cells — the terms block on the adoption path.
      // Answered as the rectangle Graph would return, so an absent fixture reads
      // as a bare tab rather than as an error.
      const held = workbook.cells?.[sheet] ?? {};
      const rect = rectOf(addressIn(path));
      if (!rect) return { ok: true, status: 200, body: { values: [[""]] } };

      // `rectOf` is 1-based on both axes, matching how a spreadsheet address reads.
      const values = Array.from({ length: rect.r2 - rect.r1 + 1 }, (_, r) =>
        Array.from({ length: rect.c2 - rect.c1 + 1 }, (_, c) => {
          const col = String.fromCharCode(64 + rect.c1 + c);
          return held[`${col}${rect.r1 + r}`] ?? "";
        }),
      );
      return { ok: true, status: 200, body: { values } };
    }
    // `$batch` carries twenty of the format reads per round trip. Replaying each
    // inner request through this same fake is what the real endpoint does, and it
    // means every assertion below can go on ignoring that batching exists.
    if (method === "POST" && path === "/$batch") {
      const inner = (
        init.body as {
          requests: {
            id: string;
            method: string;
            url: string;
            body?: unknown;
            headers?: Record<string, string>;
          }[];
        }
      ).requests;

      const responses = [];
      for (const r of inner) {
        // Headers and all: a batch is twenty independent requests, and the
        // session id has to be on each of them rather than on the envelope.
        const answer = await graph(r.url, { method: r.method, body: r.body, headers: r.headers });
        responses.push({ id: r.id, status: answer.status, body: answer.body });
      }
      return { ok: true, status: 200, body: { responses } };
    }
    if (method === "POST" && path.includes("/createSession")) {
      return { ok: true, status: 201, body: { id: "session-1" } };
    }
    if (method === "POST" && path.includes("/closeSession")) {
      return { ok: true, status: 204, body: null };
    }
    if (method === "POST" && path.endsWith("/copy")) {
      if (!opts.canCopy) {
        return {
          ok: false,
          status: 400,
          body: {
            error: {
              code: "InvalidRequest",
              message: "Resource not found for the segment 'copy'.",
            },
          },
        };
      }
      const body = init.body as { name: string; positionType?: string; relativeTo?: string };
      const at =
        body.positionType === "Before" && body.relativeTo
          ? workbook.sheets.indexOf(body.relativeTo)
          : -1;
      workbook.sheets.splice(at < 0 ? workbook.sheets.length : at, 0, body.name);
      return { ok: true, status: 201, body: { name: body.name } };
    }
    if (method === "POST" && path.includes("/worksheets/add")) {
      const name = (init.body as { name: string }).name;
      // Graph always appends — which is the whole reason a move follows.
      workbook.sheets.push(name);
      return { ok: true, status: 201, body: { name } };
    }
    if (method === "PATCH") {
      // A position PATCH really moves the tab, so tab ORDER can be asserted
      // rather than the fact that a request was sent.
      const named = /worksheets\('([^']+)'\)$/.exec(path);
      const body = init.body as { position?: number } | undefined;
      if (named && typeof body?.position === "number") {
        const name = decodeURIComponent(named[1]);
        const from = workbook.sheets.indexOf(name);
        if (from >= 0) {
          workbook.sheets.splice(from, 1);
          workbook.sheets.splice(body.position, 0, name);
        }
      }
      return { ok: true, status: 200, body: {} };
    }

    return { ok: false, status: 404, body: { error: { message: `unrouted ${method} ${path}` } } };
  };

  return { graph, calls };
}

/** The PATCHes that fill one cell — not the seed, the widths or the move. */
const cellWrites = (calls: { method: string; path: string; body?: unknown }[]) =>
  calls.filter((c) => c.method === "PATCH" && /range\(address='[A-Z]+\d+'\)$/.test(c.path));

const target = { driveId: "d", itemId: "i", overviewSheet: "2026 Overview" };

// Template's look is cached across deals — deliberately, so a morning's second
// placement pays for the paint and not the scan. Every case here has to start
// from cold or it would be asserting against the case before it.
beforeEach(() => clearTemplatePlanCache());

/** Two real rows from the file: LGF at counter 57, then blanks. */
const OVERVIEW = [
  [56, "TAM", 46000],
  [57, "LGF", 46020],
  ["", "", ""],
  ["", "", ""],
];

test("tracker: the tab is created BEFORE the Overview row that points at it", async () => {
  // Every cell of that row is a formula into the tab. Written the other way
  // round, a failure between the two leaves a row of #REF! in the sheet the desk
  // reads every morning.
  const { graph, calls } = fakeGraph({ sheets: ["Template", "Index", "LGF"], overview: OVERVIEW });

  const res = await writeDealToTracker(DEAL, { graph, target });
  assert.equal(res.ok, true);

  const addAt = calls.findIndex((c) => c.path.includes("/worksheets/add"));
  const rowAt = calls.findIndex((c) => c.method === "PATCH" && c.path.includes("2026%20Overview"));
  assert.ok(addAt >= 0 && rowAt >= 0);
  assert.ok(addAt < rowAt, "the tab must exist first");
});

test("tracker: the whole write happens inside one persisted workbook session", async () => {
  // Without a session, Graph answered a read issued straight after a write from
  // a STALE snapshot: a live test created a sheet, wrote five cells and read back
  // five empty ones while the file on disk had them. Everything reported success,
  // which is the worst way to be wrong. `persistChanges: true` is also what makes
  // it an edit of the file rather than of a scratch copy Graph discards.
  const { graph, calls } = fakeGraph({ sheets: ["Template"], overview: OVERVIEW });
  await writeDealToTracker(DEAL, { graph, target });

  const opened = calls.find((c) => c.path.includes("/createSession"));
  assert.deepEqual(opened?.body, { persistChanges: true });

  const work = calls.filter(
    (c) => !c.path.includes("Session") && (c.method !== "GET" || c.path.includes("range")),
  );
  assert.ok(work.length > 0);
  assert.ok(
    work.every((c) => c.session === "session-1"),
    "every call carries the session id",
  );

  assert.ok(calls.some((c) => c.path.includes("/closeSession")), "and it is closed");
});

test("tracker: the session is closed even when the deal was already there", async () => {
  const { graph, calls } = fakeGraph({
    sheets: ["Template", "PGF"],
    overview: [[57, "PGF", serial("2026-08-12")]],
  });
  await writeDealToTracker(DEAL, { graph, target });
  assert.ok(calls.some((c) => c.path.includes("/closeSession")), "the early return closes it too");
});

test("tracker: a real worksheet copy is tried FIRST, and carries the formatting", async () => {
  // Copy brings fills, borders, widths and validation across; nothing the
  // replay can do comes close. So it is always attempted, and when the tenant
  // has it, none of the rebuild runs at all.
  const workbook = { sheets: ["Template", "Index", "LGF"], overview: OVERVIEW };
  const { graph, calls } = fakeGraph(workbook, undefined, { canCopy: true });

  const res = await writeDealToTracker(DEAL, { graph, target });
  assert.equal(res.ok, true);
  assert.equal(res.via, "copy");

  const copy = calls.find((c) => c.method === "POST" && c.path.endsWith("/copy"));
  assert.ok(copy, "copy is attempted");
  assert.deepEqual(copy!.body, { name: "PGF", positionType: "Before", relativeTo: "LGF" });

  assert.ok(
    !calls.some((c) => c.path.includes("/worksheets/add")),
    "no empty sheet is created when the copy worked",
  );
  assert.ok(
    !calls.some((c) => c.method === "PATCH" && c.path.includes("A1:P30")),
    "and Template is not re-written into it",
  );
});

test("tracker: a tenant without copy falls back to REPLAYING Template", async () => {
  // `worksheets/{id}/copy` answers 400 "Resource not found for the segment
  // 'copy'" on some tenants. That is not a reason to fail the deal — a tab is
  // then an added sheet plus Template's own used range written into it at the
  // same addresses, where its sheet-relative formulas stay correct.
  const { graph, calls } = fakeGraph({ sheets: ["Template"], overview: OVERVIEW });
  const res = await writeDealToTracker(DEAL, { graph, target });
  assert.equal(res.via, "replay");

  const seed = calls.find((c) => c.method === "PATCH" && c.path.includes("A1:P30"));
  assert.ok(seed, "Template's shape is written in one call");
  assert.deepEqual((seed!.body as { formulas: unknown[][] }).formulas, TEMPLATE_FORMULAS);

  // The address comes from Template's own usedRange, so extending Template does
  // not silently start truncating new tabs.
  assert.ok(
    calls.some((c) => c.method === "GET" && c.path.includes("usedRange")),
    "Template's extent is read, not hardcoded",
  );
});

test("tracker: the replay carries Template's number formats, not just its formulas", async () => {
  // Without these the tab is arithmetically right and unreadable: `17/08/2026`
  // renders as `46251`, percentages as `0.075`, and every dollar column as a
  // bare number. It was the loudest thing wrong with a freshly written tab.
  const { graph, calls } = fakeGraph({ sheets: ["Template"], overview: OVERVIEW });
  await writeDealToTracker(DEAL, { graph, target });

  const seed = calls.find((c) => c.method === "PATCH" && c.path.includes("A1:P30"))!;
  assert.deepEqual(
    (seed.body as { numberFormat: unknown[][] }).numberFormat,
    TEMPLATE_NUMBER_FORMATS,
    "sent alongside the formulas, in the same call",
  );

  assert.ok(
    calls.some((c) => c.method === "GET" && c.path.includes("numberFormat")),
    "and asked for when Template is read",
  );
});

test("tracker: the replay carries Template's column widths", async () => {
  // A tab whose columns are all 8.43 wide does not look like the template even
  // when every cell in it is correct. Widths are a per-column property, so they
  // are their own pass — one batch of reads, one batch of writes.
  const { graph, calls } = fakeGraph({ sheets: ["Template"], overview: OVERVIEW });
  const res = await writeDealToTracker(DEAL, { graph, target });
  assert.equal(res.ok, true);
  assert.equal(res.notes, undefined, "nothing degraded, so nothing to report");

  const widths = calls.filter(
    (c) => c.method === "PATCH" && /\/format$/.test(c.path) && c.path.includes("PGF"),
  );
  // Template's used range is A1:P30 — sixteen columns, A through P.
  assert.equal(widths.length, 16);
  assert.deepEqual(widths[0].body, { columnWidth: TEMPLATE_COLUMN_WIDTH });
});

test("tracker: the rebuilt tab is shaded like Template", async () => {
  // The complaint this fixes: a new placement arrived as a plain white grid, so
  // nothing on it said which cells the desk is meant to type into. There is no
  // worksheet copy in Graph to bring the shading across, so it is read off
  // Template a rectangle at a time and painted back on.
  const { graph, calls } = fakeGraph({ sheets: ["Template", "LGF"], overview: OVERVIEW });
  const res = await writeDealToTracker(DEAL, { graph, target });
  assert.equal(res.ok, true);

  const painted = (kind: string) =>
    new Map(
      calls
        .filter((c) => c.method === "PATCH" && c.path.includes(`/format/${kind}`) && c.path.includes("PGF"))
        .map((c) => [addressIn(c.path), c.body]),
    );

  const fills = painted("fill");
  assert.deepEqual(fills.get("A1:P2"), { color: "#FFFF00" }, "the yellow banner, in one write");
  assert.deepEqual(fills.get("A3:P3"), { color: "#000000" }, "the black header band");
  // White is left alone: Graph reports an unfilled cell as #FFFFFF too, and a
  // white fill would hide the gridlines a plain area is meant to show.
  assert.equal(fills.has("A4:P30"), false, "the plain cells stay unfilled");

  const fonts = painted("font");
  assert.deepEqual(fonts.get("A3:P3"), {
    name: "Calibri",
    size: 11,
    color: "#FFFFFF",
    bold: true,
    italic: false,
    underline: "None",
  });

  // Read from Template, written to the new tab — never the other way round.
  const reads = calls.filter((c) => c.method === "GET" && c.path.includes("/format/"));
  assert.ok(reads.length > 0);
  assert.ok(reads.every((c) => c.path.includes("Template")), "Template is only ever read");
});

test("tracker: the rebuilt tab is BORDERED like Template", async () => {
  // Template's client table is boxed. Without this the new tab computed and was
  // shaded correctly and still did not look like the workbook it lives in.
  const { graph, calls } = fakeGraph({ sheets: ["Template", "LGF"], overview: OVERVIEW });
  const res = await writeDealToTracker(DEAL, { graph, target });
  assert.equal(res.ok, true);
  assert.equal(res.notes, undefined, "nothing degraded, so nothing to report");

  const edges = calls.filter(
    (c) => c.method === "PATCH" && c.path.includes("/format/borders/") && c.path.includes("PGF"),
  );

  assert.ok(edges.length > 0, "no borders were painted at all");

  // Asserted as COVERAGE rather than against one address: the scan halves a
  // rectangle at a time, so where its cuts fall is an implementation detail and
  // rows 5-22 are reached as however many pieces the halving produced. What has
  // to be true is that the pieces are exactly the boxed rows, no more and no less.
  const painted = new Set<number>();
  for (const c of edges) {
    const rect = rectOf(addressIn(c.path))!;
    for (let row = rect.r1; row <= rect.r2; row++) painted.add(row);

    assert.equal(rect.c1, 1, "a border region should span the used range's columns");
    assert.equal(rect.c2, 16);
    assert.deepEqual(c.body, { style: "Continuous", color: "#000000", weight: "Thin" });
  }

  const table = Array.from({ length: 18 }, (_, i) => i + 5); // rows 5-22
  assert.deepEqual(
    [...painted].sort((a, b) => a - b),
    table,
    "the boxed table, and nothing outside it",
  );

  // A side with no line is not a write — a new tab has no borders to clear —
  // so every region carries its four outer edges and nothing empty was sent.
  const sidesOf = (address: string) =>
    new Set(
      edges
        .filter((c) => addressIn(c.path) === address)
        .map((c) => c.path.slice(c.path.lastIndexOf("/") + 1)),
    );
  for (const address of new Set(edges.map((c) => addressIn(c.path)))) {
    const sides = sidesOf(address);
    for (const side of ["EdgeTop", "EdgeBottom", "EdgeLeft", "EdgeRight"]) {
      assert.ok(sides.has(side), `${address} is missing its ${side}`);
    }
  }

  const reads = calls.filter((c) => c.method === "GET" && c.path.includes("/format/borders"));
  assert.ok(reads.every((c) => c.path.includes("Template")), "Template is only ever read");
});

test("tracker: a boxed block is put back together, and stays a partition", async () => {
  /**
   * Two things at once, because they pull against each other.
   *
   * The scan halves rectangles, so Template's boxed table arrives as five or six
   * pieces. Painting them piecemeal is correct but costs an edge write per piece
   * per side, so `bordersMergeable` glues back the ones where gluing cannot lose
   * the line at the join — a fully gridded table is exactly that case, and comes
   * back as ONE region.
   *
   * What must survive the gluing is that the regions still partition: no region
   * inside another, no two overlapping. A border write lands on the edges of
   * whatever rectangle it names, so an overlap is a line drawn in the wrong place.
   */
  const { graph, calls } = fakeGraph({ sheets: ["Template", "LGF"], overview: OVERVIEW });
  await writeDealToTracker(DEAL, { graph, target });

  const rects = [
    ...new Set(
      calls
        .filter((c) => c.method === "PATCH" && c.path.includes("/format/borders/"))
        .map((c) => addressIn(c.path)),
    ),
  ].map((a) => rectOf(a)!);

  // Rows 5-21 come back as ONE region — the halving cut them into four or five
  // pieces and every join was safe to undo.
  //
  // Row 22 stands alone, and that is correct rather than a missed merge: a
  // single-row rectangle HAS no inside, so Graph reports its `InsideHorizontal`
  // as `None` and its value is genuinely not the value the block above it has.
  // Refusing a merge on that costs five edge writes; assuming one would be the
  // class of guess this whole module exists to avoid.
  assert.deepEqual(rects, [
    { r1: 5, c1: 1, r2: 21, c2: 16 },
    { r1: 22, c1: 1, r2: 22, c2: 16 },
  ]);

  const overlaps = (a: (typeof rects)[number], b: typeof a) =>
    a.r1 <= b.r2 && b.r1 <= a.r2 && a.c1 <= b.c2 && b.c1 <= a.c2;

  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      assert.equal(overlaps(rects[i], rects[j]), false, "two border regions overlap");
    }
  }
});

test("tracker: the shading scan splits rather than walking every cell", async () => {
  // A1:P30 is 480 cells. Asking about each one would be 480 reads inside a cron
  // that has 60 seconds for the whole ingest. Asking about rectangles and only
  // splitting the ones that come back non-uniform costs a couple of dozen.
  const { graph, calls } = fakeGraph({ sheets: ["Template"], overview: OVERVIEW });
  await writeDealToTracker(DEAL, { graph, target });

  const reads = calls.filter((c) =>
    c.method === "GET" && /\/format\/(fill|font|borders)/.test(c.path),
  );
  assert.ok(reads.length < 90, `expected a few dozen format reads, got ${reads.length}`);

  // And they go out batched: twenty independent reads per HTTP request.
  const batches = calls.filter((c) => c.path === "/$batch");
  assert.ok(batches.length > 0, "the scan is batched");
  assert.ok(
    batches.length < reads.length,
    "fewer round trips than reads, which is the point of batching",
  );
});

test("tracker: Template's look is read once, not once per deal", async () => {
  // A morning can bring four deals. Re-scanning Template for each would spend
  // the ingest's budget four times over on an answer that did not change.
  const workbook = { sheets: ["Template", "LGF"], overview: OVERVIEW };
  const { graph, calls } = fakeGraph(workbook);

  await writeDealToTracker(DEAL, { graph, target });
  const afterFirst = calls.filter((c) => c.method === "GET" && c.path.includes("/format")).length;

  await writeDealToTracker({ ...DEAL, ticker: "KNI" }, { graph, target });
  const afterSecond = calls.filter((c) => c.method === "GET" && c.path.includes("/format")).length;

  assert.equal(afterSecond, afterFirst, "the second deal reads no formatting at all");
  assert.ok(
    calls.some((c) => c.method === "PATCH" && c.path.includes("/format/fill") && c.path.includes("KNI")),
    "but it is still painted",
  );
});

test("tracker: the shading goes on AFTER the deal is on the Overview", async () => {
  // It is the slowest step and nothing depends on it. A cron that runs out of
  // time part-way through it should leave a filed deal that is a bit plain, not
  // a beautiful tab no row points at.
  const { graph, calls } = fakeGraph({ sheets: ["Template"], overview: OVERVIEW });
  await writeDealToTracker(DEAL, { graph, target });

  const rowAt = calls.findIndex((c) => c.method === "PATCH" && c.path.includes("2026%20Overview"));
  const shadeAt = calls.findIndex((c) => c.method === "PATCH" && c.path.includes("/format/fill"));
  assert.ok(rowAt >= 0 && shadeAt >= 0);
  assert.ok(rowAt < shadeAt, "the row is written first");
});

test("tracker: refused formatting is a note, not a failed deal", async () => {
  // The deal is in the workbook and every figure on it is right. A protected
  // range or a missing format permission must not undo that.
  const { graph } = fakeGraph({ sheets: ["Template"], overview: OVERVIEW }, {
    path: /\/format/,
    status: 403,
    message: "range is protected",
  });

  const res = await writeDealToTracker(DEAL, { graph, target });
  assert.equal(res.ok, true, "the deal is still filed");
  assert.equal(res.sheet, "PGF");
  assert.match(res.notes?.join(" ") ?? "", /not shaded like Template/);
});

test("tracker: a new deal lands at the FRONT of the deal tabs, not the far right", async () => {
  // `worksheets/add` appends, so a new placement was landing past the point the
  // tab bar scrolls to — the desk stopped finding it. Template and Index stay
  // where they are; the newest deal goes ahead of the other deals.
  const workbook = { sheets: ["Template", "Index", "LGF", "TAM"], overview: OVERVIEW };
  const { graph, calls } = fakeGraph(workbook);

  const res = await writeDealToTracker(DEAL, { graph, target });
  assert.equal(res.ok, true);
  assert.deepEqual(workbook.sheets, ["Template", "Index", "PGF", "LGF", "TAM"]);

  const move = calls.find(
    (c) => c.method === "PATCH" && /worksheets\('PGF'\)$/.test(c.path),
  );
  assert.deepEqual(move?.body, { position: 2 }, "in front of LGF, behind the scaffolding");
});

test("tracker: the first deal of a fresh year goes after the scaffolding, not before it", async () => {
  const workbook = { sheets: ["Template", "Index"], overview: [] as (string | number)[][] };
  const { graph } = fakeGraph(workbook);

  await writeDealToTracker(DEAL, { graph, target });
  assert.deepEqual(workbook.sheets, ["Template", "Index", "PGF"]);
});

test("tracker: a tab that could not be moved is reported, not failed", async () => {
  // The deal is in the workbook and every figure on it is right. Refusing the
  // write over a tab being in the wrong place would be the worse outcome; a
  // note in the ingest log is a ten-second fix for a person.
  const { graph } = fakeGraph({ sheets: ["Template", "LGF"], overview: OVERVIEW }, {
    path: /worksheets\('PGF'\)$/,
    status: 400,
    message: "sheet is protected",
  });

  const res = await writeDealToTracker(DEAL, { graph, target });
  assert.equal(res.ok, true, "the deal is still filed");
  assert.equal(res.sheet, "PGF");
  assert.match(res.notes?.join(" ") ?? "", /end of the workbook/);
});

test("tracker: a new deal lands on the first empty row, continuing the counter", async () => {
  const { graph, calls } = fakeGraph({ sheets: ["Template", "LGF"], overview: OVERVIEW });
  const res = await writeDealToTracker(DEAL, { graph, target });

  // Data starts at row 4, two rows are used, so the third slot is row 6.
  assert.equal(res.overviewRow, 6);
  assert.equal(res.counter, 58);

  const row = calls.find((c) => c.method === "PATCH" && c.path.includes("B6:T6"));
  assert.ok(row, "the row is written as one range");
  const formulas = (row!.body as { formulas: string[][] }).formulas[0];
  assert.equal(formulas[0], 58, "counter");
  assert.equal(
    formulas[1],
    `=HYPERLINK("#'PGF'!A1","PGF")`,
    "the Counter column links to the tab it was written for",
  );
  assert.equal(formulas[2], "='PGF'!B3", "Date Issued reads the tab");
  assert.equal(formulas[4], "", "T2 Settlement is left for the desk");
  assert.equal(formulas[12], "=M6*(1.1)", "GST grosses up this row, not row 5");
  assert.equal(formulas[18], "=O6+P6+Q6+R6+S6", "All Fees totals this row");
});

test("tracker: a deal already in the Overview is skipped, not written twice", async () => {
  // The ingest runs on a schedule and sees the same candidates every time. This
  // is the guard that stops the tracker growing a tab per run.
  const { graph, calls } = fakeGraph({
    sheets: ["Template", "PGF"],
    overview: [[57, "PGF", serial("2026-08-12")]],
  });

  const res = await writeDealToTracker(DEAL, { graph, target });
  assert.equal(res.ok, true);
  assert.equal(res.skipped, true);
  // Opening and closing the session are POSTs but change nothing in the sheets.
  const mutations = calls.filter((c) => c.method !== "GET" && !c.path.includes("Session"));
  assert.equal(mutations.length, 0, "nothing was written");
});

test("tracker: the SAME stock placed on a different date is a new deal, not a duplicate", async () => {
  // A repeat issuer is normal and gets its own tab — that is what `(b)` is for.
  const { graph } = fakeGraph({
    sheets: ["Template", "PGF"],
    overview: [[57, "PGF", serial("2026-02-18")]],
  });

  const res = await writeDealToTracker(DEAL, { graph, target });
  assert.equal(res.skipped, undefined);
  assert.equal(res.sheet, "PGF (b)", "the bare name is taken, so the next letter is used");
});

test("tracker: only the terms the mail carried are written to the tab", async () => {
  const { graph, calls } = fakeGraph({ sheets: ["Template"], overview: OVERVIEW });
  await writeDealToTracker(DEAL, { graph, target });

  const written = new Map(
    cellWrites(calls).map((c) => [
      /address='([^']+)'/.exec(c.path)![1],
      (c.body as { values: unknown[][] }).values[0][0],
    ]),
  );

  assert.equal(written.get("D3"), "PGF");
  assert.equal(written.get("F3"), 3.07);
  assert.equal(written.get("B2"), "1:2 free listed options");
  assert.equal(written.get("B3"), excelSerialDate("2026-08-12"));
  assert.equal(written.get("L3"), excelSerialDate("2026-08-19"));

  // Lead Manager and Industry are NOT written: E3 feeds the fee split in rows
  // 23-30, and a guessed lead manager becomes money someone reconciles later.
  assert.equal(written.has("E3"), false);
  assert.equal(written.has("C3"), false);
  assert.equal(written.has("J3"), false);
});

test("tracker: a deal with only a ticker still writes a usable tab", async () => {
  const { graph, calls } = fakeGraph({ sheets: ["Template"], overview: OVERVIEW });
  const res = await writeDealToTracker({ ticker: "abc" }, { graph, target });

  assert.equal(res.ok, true);
  assert.equal(res.sheet, "ABC");
  assert.equal(cellWrites(calls).length, 1, "just the ASX code");
});

test("tracker: a failed row write reports the tab that was left behind", async () => {
  // The tab exists and nothing references it. Silence here means someone finds
  // an orphan tab in three weeks and cannot tell what it was for.
  const { graph } = fakeGraph({ sheets: ["Template"], overview: OVERVIEW }, {
    path: /2026%20Overview/,
    status: 400,
    message: "range is locked",
  });

  const res = await writeDealToTracker(DEAL, { graph, target });
  assert.equal(res.ok, false);
  assert.equal(res.sheet, "PGF", "says which tab is orphaned");
  assert.match(res.error ?? "", /range is locked/);
  assert.match(res.hint ?? "", /by hand|retry/);
});

test("tracker: a 403 creating the sheet names the missing permission", async () => {
  // The single most likely failure in production, and the one whose fix is a
  // consent screen rather than a code change. Graph's own words are "Contact the
  // workbook owner to request edit access", which does not tell a developer
  // which application permission to grant.
  const { graph } = fakeGraph({ sheets: ["Template"], overview: OVERVIEW }, {
    path: /worksheets\/add/,
    status: 403,
    message: "Contact the workbook owner to request edit access.",
  });

  const res = await writeDealToTracker(DEAL, { graph, target });
  assert.equal(res.ok, false);
  assert.match(res.hint ?? "", /Files\.ReadWrite\.All/);
});

test("tracker: a workbook with no Template is refused, not improvised", async () => {
  const { graph } = fakeGraph({ sheets: ["Index", "LGF"], overview: OVERVIEW });
  const res = await writeDealToTracker(DEAL, { graph, target });
  assert.equal(res.ok, false);
  assert.match(res.error ?? "", /no "Template" sheet/);
});

/* ---------------------------------------------------------------- */
/* The pure pieces                                                   */
/* ---------------------------------------------------------------- */

test("tracker: Excel serial dates are UTC and use the 1899-12-30 epoch", () => {
  // Written as text, "2026-08-12" lands in the cell as a string and every date
  // comparison against it silently stops working.
  assert.equal(excelSerialDate("2026-08-12"), 46246);
  assert.equal(excelSerialDate("1900-03-01"), 61, "past Excel's phantom leap day");
  assert.equal(excelSerialDate(""), null);
  assert.equal(excelSerialDate("not a date"), null);
  assert.equal(excelSerialDate(null), null);
});

test("tracker: sheet names are always quoted in formulas", () => {
  // The workbook really contains tabs called BM1, AR3, PC2 and MC2 — each of
  // which is also a valid cell reference. Quoting unconditionally removes the
  // judgement call.
  assert.equal(formulaSheetRef("PGF"), "'PGF'");
  assert.equal(formulaSheetRef("BM1"), "'BM1'");
  assert.equal(formulaSheetRef("CBE (a)"), "'CBE (a)'");
  assert.equal(formulaSheetRef("O'Brien"), "'O''Brien'");
});

test("tracker: the suffix walks b, c, d — and gives up rather than inventing", () => {
  assert.equal(nextSheetName("KNI", ["PGF"]), "KNI");
  assert.equal(nextSheetName("KNI", ["KNI"]), "KNI (b)");
  assert.equal(nextSheetName("KNI", ["KNI", "KNI (b)"]), "KNI (c)");
  assert.equal(nextSheetName("kni", ["KNI"]), "KNI (b)", "case does not make a new tab");

  const all = ["KNI", ...Array.from({ length: 25 }, (_, i) => `KNI (${String.fromCharCode(98 + i)})`)];
  assert.equal(nextSheetName("KNI", all), null);
});

test("tracker: the next slot is the first EMPTY row, not the last row plus one", () => {
  // The Overview is 335 rows of pre-formatted emptiness; its used range extends
  // far past the data, so counting rows would land the deal in the middle of
  // nowhere.
  assert.deepEqual(nextOverviewSlot([[57, "LGF", 1]].map(toRow)), { row: 5, counter: 58 });
  assert.deepEqual(nextOverviewSlot(OVERVIEW.map(toRow)), { row: 6, counter: 58 });
  assert.deepEqual(nextOverviewSlot([]), { row: 4, counter: 1 }, "an empty year starts at row 4");
});

test("tracker: the counter follows the last DEAL, not the highest number in column B", () => {
  // The real sheet pre-numbers column B all the way down: row 188 says 185 with
  // nothing beside it, and rows below it count on to 216. Taking the highest
  // number jumped the sequence from 185 to 218 — caught by a dry run against the
  // live file, which is the only place this shape exists.
  const preNumbered = [
    [183, "SEG", 46246],
    [184, "NMD", 46246],
    [185, "", ""],
    [186, "", ""],
    [187, "", ""],
  ].map(toRow);

  const slot = nextOverviewSlot(preNumbered);
  assert.equal(slot.counter, 185, "one past NMD, not one past the scaffolding");
  assert.equal(slot.row, 6, "the first row with no ticker");
});

test("tracker: a hand-deleted row is filled without rewinding the sequence", () => {
  const rows = [[57, "LGF", 1], ["", "", ""], [59, "TAM", 1]].map(toRow);
  assert.equal(nextOverviewSlot(rows).counter, 60, "TAM is the last deal");
  assert.equal(nextOverviewSlot(rows).row, 5, "the gap is still filled");
});

test("tracker: duplicate detection needs ticker AND date", () => {
  const rows = [{ ticker: "PGF", issued: excelSerialDate("2026-08-12") }];
  assert.equal(alreadyInOverview(rows, DEAL), true);
  assert.equal(alreadyInOverview(rows, { ...DEAL, issueDate: "2026-02-18" }), false);
  assert.equal(alreadyInOverview(rows, { ...DEAL, ticker: "KNI" }), false);

  // With no date to compare, the ticker alone has to do: writing a second tab
  // for a deal we cannot date is the worse mistake.
  assert.equal(alreadyInOverview(rows, { ticker: "PGF" }), true);
});

test("tracker: the Overview row is 19 cells, B through T", () => {
  const row = overviewRowFormulas("PGF", "PGF", 61, 58);
  assert.equal(row.length, 19, "B..T inclusive — matches the header on row 3");
});

test("tracker: the Counter cell is a link to the deal's own tab", () => {
  // The Overview is the index of ~190 tabs and this column is how the desk
  // navigates it. `#` makes the target a place in this workbook rather than a
  // URL; the friendly name is what every reader of the column still sees.
  assert.equal(sheetLinkFormula("PGF", "PGF"), `=HYPERLINK("#'PGF'!A1","PGF")`);

  // A repeat issuer's tab has a space in it, which is exactly why the sheet ref
  // is quoted — and an apostrophe in a name is doubled, Excel's own rule.
  assert.equal(sheetLinkFormula("CBE (b)", "CBE"), `=HYPERLINK("#'CBE (b)'!A1","CBE")`);
  assert.equal(sheetLinkFormula("O'Brien", "OBR"), `=HYPERLINK("#'O''Brien'!A1","OBR")`);

  // The row still reads as the ticker: HYPERLINK's value IS the friendly name,
  // so the duplicate guard and the P&L engine's lookup are unaffected.
  const row = overviewRowFormulas("KNI (b)", "kni", 61, 58);
  assert.equal(row[1], `=HYPERLINK("#'KNI (b)'!A1","KNI")`);
});

test("tracker: a new tab goes in front of the deals, behind the scaffolding", () => {
  const slots = [
    { name: "Template", position: 0 },
    { name: "Index", position: 1 },
    { name: "2026 Overview", position: 2 },
    { name: "LGF", position: 3 },
    { name: "TAM", position: 4 },
  ];
  assert.deepEqual(dealSheetPlacement(slots), { position: 3, before: "LGF" });

  // Order in the array is not order in the workbook — `position` is.
  assert.deepEqual(
    dealSheetPlacement([...slots].reverse()),
    { position: 3, before: "LGF" },
    "the first deal is the lowest position, not the first element",
  );

  // A fresh year has no deals yet; Template must not be pushed right.
  assert.deepEqual(
    dealSheetPlacement([
      { name: "Template", position: 0 },
      { name: "Index", position: 1 },
    ]),
    { position: 2, before: null },
  );

  assert.deepEqual(dealSheetPlacement([]), { position: 0, before: null });
});

test("tracker: Overview, Template, Index and Invoice are not deals", () => {
  // `Options` and `Invoice` look exactly like tickers, which is why the list is
  // explicit rather than a pattern.
  for (const name of ["Template", "Index", "Invoice", "Options", "2026 Overview", "2025 Overview"]) {
    assert.equal(isDealSheet(name), false, name);
  }
  for (const name of ["LGF", "CBE (a)", "BM1", "L1M(T2)"]) {
    assert.equal(isDealSheet(name), true, name);
  }
});

test("tracker: a used range names the columns whose widths have to be replayed", () => {
  assert.deepEqual(columnsOf("A1:D30"), ["A", "B", "C", "D"]);
  assert.equal(columnsOf("A1:P30")?.length, 16);
  assert.deepEqual(columnsOf("C3"), ["C"]);
  // Past Z, because a template is allowed to grow.
  assert.deepEqual(columnsOf("Y1:AB1"), ["Y", "Z", "AA", "AB"]);
  // Anything not shaped like a range skips the width replay rather than
  // guessing at the whole sheet.
  assert.equal(columnsOf("Template!A1:P30"), null);
  assert.equal(columnsOf("D30:A1"), null);
});

test("tracker: a price of zero is not written as an issue price", () => {
  const writes = tabCellWrites({ ticker: "ABC", price: 0 });
  assert.equal(writes.some((w) => w.address === "F3"), false);
});

/* ---------------------------------------------------------------- */
/* The unattended run                                                */
/* ---------------------------------------------------------------- */

const CANDIDATE: CandidateFeedItem = {
  ticker: "pgf",
  company: "PM Capital Global Opportunities Fund",
  deal_type: "Placement",
  subject: "PGF — wholesale placement",
  summary: `Company: PM Capital Global Opportunities Fund (PGF:ASX)
Deal Type: Placement
Raise: $175M
Price: $3.07/share (10.8% disc)
Bids Close: 12pm AEST 12 August 2026
Settlement: 19 August 2026`,
  received_at: "2026-08-11T02:31:38+00:00",
};

test("tracker sync: a mail becomes a deal without anyone typing anything", () => {
  // The summary's header carries exactly what a tab needs. Date Issued is the
  // mail's own timestamp — the header has Bids Close and Settlement, not an
  // issue date, and the day it arrived is what the desk types today.
  assert.deepEqual(dealFromCandidate(CANDIDATE), {
    ticker: "PGF",
    issueDate: "2026-08-11",
    price: 3.07,
    settleDate: "2026-08-19",
    addOns: null,
    twoTranche: false,
  });
});

test("tracker sync: a missing permission is reported once, not once per deal", () => {
  // Forty identical 403s in a cron log is noise that buries the one line saying
  // what to do about it.
  const graph: GraphCall = async (path, init = {}) => {
    if ((init.method ?? "GET") === "GET") {
      if (path.includes("/worksheets?")) {
        return { ok: true, status: 200, body: { value: [{ name: "Template" }] } };
      }
      if (path.includes("usedRange")) {
        return { ok: true, status: 200, body: { address: "Template!A1:P30", formulas: [["x"]] } };
      }
      return { ok: true, status: 200, body: { values: [["", "", ""]] } };
    }
    return {
      ok: false,
      status: 403,
      body: { error: { message: "Contact the workbook owner to request edit access." } },
    };
  };

  return syncTrackerRows(
    [CANDIDATE, { ...CANDIDATE, ticker: "KNI" }, { ...CANDIDATE, ticker: "AXR" }],
    { graph, target: async () => target },
  ).then((report) => {
    assert.equal(report.ok, false);
    assert.equal(report.failed.length, 3, "every deal is accounted for");
    assert.match(report.failed[0].error, /Files\.ReadWrite\.All/);
    // The second and third were not attempted — they carry the same reason.
    assert.equal(report.failed[1].error, report.failed[0].error);
  });
});

test("tracker sync: nothing owed means nothing is touched", async () => {
  const graph: GraphCall = async () => {
    throw new Error("the tracker must not be opened for an empty run");
  };
  const report = await syncTrackerRows([], { graph, target: async () => target });
  assert.deepEqual(report, { ok: true, written: [], skipped: 0, failed: [], notes: [] });
});

/* ---------------------------------------------------------------- */
/* Reporting each deal as it settles                                 */
/* ---------------------------------------------------------------- */

test("tracker sync: each deal is reported the moment it settles, not at the end", async () => {
  // This is what makes a killed invocation survivable, and it is the exact shape
  // of the 3 September 2026 failure: the run created FBR's tab and died before it
  // reached NGY. A caller told only at the end keeps nothing; a caller told per
  // deal keeps the tab that landed and re-queues the one that did not.
  const { graph } = fakeGraph({ sheets: ["Template", "LGF"], overview: OVERVIEW });

  const order: string[] = [];
  await syncTrackerRows([{ ...CANDIDATE, ticker: "NGY" }, { ...CANDIDATE, ticker: "FBR" }], {
    graph,
    target: async () => target,
    onSettled: async (item, outcome) => {
      order.push(`settled:${item.ticker}:${outcome.state}`);
    },
  });

  // Interleaved with the writes, in queue order — NGY is recorded before FBR is
  // begun, so a death between the two loses only the one not yet attempted.
  assert.deepEqual(order, ["settled:NGY:written", "settled:FBR:written"]);
});

test("tracker sync: the outcome carries the tab's name, so the queue can record it", async () => {
  // A repeat issuer: `PGF` is already filed under an earlier date, so this deal
  // becomes `PGF (b)` — and that, not the ticker, is what the row must remember,
  // because it is the only way back to the tab afterwards.
  const { graph } = fakeGraph({
    sheets: ["Template", "PGF"],
    overview: [[57, "PGF", serial("2026-07-02")]],
  });

  const seen: unknown[] = [];
  await syncTrackerRows([CANDIDATE], {
    graph,
    target: async () => target,
    onSettled: async (_item, outcome) => void seen.push(outcome),
  });

  assert.deepEqual(seen, [{ state: "written", sheet: "PGF (b)" }]);
});

test("tracker sync: a deal already on the Overview settles as skipped, which is filed", async () => {
  // Filed, but not by us. A caller keeping a queue must stop owing it — leaving
  // it owed would mean re-reading the workbook for it every hour forever.
  const { graph } = fakeGraph({
    sheets: ["Template", "PGF"],
    overview: [[57, "PGF", serial("2026-08-11")]],
  });

  const seen: unknown[] = [];
  await syncTrackerRows([CANDIDATE], {
    graph,
    target: async () => target,
    onSettled: async (_item, outcome) => void seen.push(outcome),
  });

  assert.deepEqual(seen, [{ state: "skipped" }]);
});

test("tracker sync: a blocked run settles every deal as failed, so none is lost", async () => {
  // A missing permission stops the run after the first deal, and the rest are
  // deliberately not attempted. They still have to be reported: a deal nobody
  // reports is a deal nobody retries.
  const graph: GraphCall = async (path, init = {}) => {
    if ((init.method ?? "GET") === "GET") {
      if (path.includes("/worksheets?")) {
        return { ok: true, status: 200, body: { value: [{ name: "Template" }] } };
      }
      if (path.includes("usedRange")) {
        return { ok: true, status: 200, body: { address: "Template!A1:P30", formulas: [["x"]] } };
      }
      return { ok: true, status: 200, body: { values: [["", "", ""]] } };
    }
    return { ok: false, status: 403, body: { error: { message: "no edit access" } } };
  };

  const states: string[] = [];
  await syncTrackerRows([CANDIDATE, { ...CANDIDATE, ticker: "KNI" }], {
    graph,
    target: async () => target,
    onSettled: async (item, outcome) => {
      states.push(`${item.ticker}:${outcome.state}`);
    },
  });

  assert.deepEqual(states, ["pgf:failed", "KNI:failed"]);
});

test("tracker sync: a queue that cannot be updated is a note, not an abandoned batch", async () => {
  // The tab is already in the workbook by the time this is called. Throwing here
  // would trade one redundant duplicate check on the next run for the rest of
  // the batch going unwritten.
  const { graph } = fakeGraph({ sheets: ["Template", "LGF"], overview: OVERVIEW });

  const report = await syncTrackerRows([CANDIDATE, { ...CANDIDATE, ticker: "KNI" }], {
    graph,
    target: async () => target,
    onSettled: async () => {
      throw new Error("database unreachable");
    },
  });

  assert.equal(report.written.length, 2, "both tabs were still written");
  assert.ok(report.notes.some((n) => /recording that failed/.test(n)));
  assert.ok(report.notes.some((n) => /database unreachable/.test(n)));
});

function toRow(r: (string | number)[]) {
  return { counter: r[0], ticker: r[1], issued: r[2] };
}

/** `excelSerialDate` narrowed for fixtures, where the date is always valid. */
function serial(iso: string): number {
  const n = excelSerialDate(iso);
  assert.ok(n !== null, `${iso} should be a date`);
  return n;
}

/* ---------------------------------------------------------------- */
/* Finishing a tab an earlier attempt left behind                    */
/* ---------------------------------------------------------------- */

/**
 * These cover the regression the retry queue introduced.
 *
 * Every failure after `worksheets/add` leaves the tab — that order is chosen so
 * the wreckage is an unreferenced tab rather than a row of `#REF!`. It was
 * harmless while nothing retried on its own. Now the queue retries hourly, and
 * without adoption the second attempt would find `PGF` taken, file the deal as
 * `PGF (b)` — asserting a repeat placement that never happened — and leave the
 * unformatted `PGF` at the end of the workbook for good.
 */

/** An Overview that accounts for LGF and nothing else. */
const ONLY_LGF = [[57, "LGF", serial("2026-08-01")]];

test("tracker: a leftover tab is FINISHED, not filed beside", async () => {
  // `PGF` exists, no Overview row points at it, and its ASX code is blank —
  // the signature of a run that was killed after creating the tab.
  const { graph, calls } = fakeGraph({
    sheets: ["Template", "LGF", "PGF"],
    overview: ONLY_LGF,
    cells: { PGF: { A2: "Options", A3: "Date", A4: "2 Tranche" } },
  });

  const res = await writeDealToTracker(DEAL, { graph, target });

  assert.equal(res.ok, true);
  assert.equal(res.sheet, "PGF", "the deal goes INTO the leftover, not next to it");
  assert.equal(res.via, "adopted");
  assert.equal(
    calls.some((c) => c.path.includes("/worksheets/add")),
    false,
    "no second tab is created",
  );
  assert.ok(res.notes?.some((n) => /left behind by an earlier attempt/.test(n)));
});

test("tracker: a leftover tab is dragged back to the front of the deal tabs", async () => {
  // It sat wherever `worksheets/add` put it — the far end of ~200 tabs, which is
  // the position the desk stopped finding. That was half of the original report.
  const workbook = {
    sheets: ["Template", "LGF", "TAM", "PGF"],
    overview: ONLY_LGF,
    cells: { PGF: { A3: "Date" } },
  };
  const { graph } = fakeGraph(workbook);

  await writeDealToTracker(DEAL, { graph, target });
  assert.deepEqual(workbook.sheets, ["Template", "PGF", "LGF", "TAM"]);
});

test("tracker: a leftover tab is SHADED, which is what it was missing", async () => {
  // The killed run never reached the shading — it runs last, after the Overview
  // row — so the leftover reads as a plain grid of #DIV/0! with no bands and no
  // yellow input cells. Finishing it has to include painting it.
  const { graph, calls } = fakeGraph({
    sheets: ["Template", "LGF", "PGF"],
    overview: ONLY_LGF,
    cells: { PGF: { A3: "Date" } },
  });

  await writeDealToTracker(DEAL, { graph, target });

  const fills = calls.filter(
    (c) => c.method === "PATCH" && c.path.includes("/format/fill") && c.path.includes("PGF"),
  );
  assert.ok(fills.length > 0, "the adopted tab is painted like a new one");
});

test("tracker: a leftover tab with nothing in it at all is seeded from Template", async () => {
  // The narrow window: killed between `worksheets/add` and the seed, so there
  // are no formulas either. An adopted tab that computes nothing is no use.
  const { graph, calls } = fakeGraph({
    sheets: ["Template", "LGF", "PGF"],
    overview: ONLY_LGF,
    // no `cells` entry — the tab is bare
  });

  const res = await writeDealToTracker(DEAL, { graph, target });
  assert.equal(res.ok, true);

  const seed = calls.find(
    (c) =>
      c.method === "PATCH" && c.path.includes("PGF") && /range\(address='A1:P30'\)/.test(c.path),
  );
  assert.ok(seed, "Template is replayed into it");
  assert.deepEqual((seed!.body as { formulas: unknown }).formulas, TEMPLATE_FORMULAS);
  assert.ok(res.notes?.some((n) => /was empty, so Template was replayed/.test(n)));
});

test("tracker: a leftover tab that already has its formulas is NOT re-seeded", async () => {
  // The common case, and the 3 September one: the seed landed, the run died
  // after it. Rewriting Template over the top would be pointless work against a
  // 13 MB book, and would undo anything already correct on the tab.
  const { graph, calls } = fakeGraph({
    sheets: ["Template", "LGF", "PGF"],
    overview: ONLY_LGF,
    cells: { PGF: { A2: "Options", A3: "Date", A4: "2 Tranche" } },
  });

  await writeDealToTracker(DEAL, { graph, target });

  const seed = calls.find(
    (c) =>
      c.method === "PATCH" && c.path.includes("PGF") && /range\(address='A1:P30'\)/.test(c.path),
  );
  assert.equal(seed, undefined);
});

test("tracker: a tab somebody has claimed is left alone, and SAID so", async () => {
  // An ASX code in D3 means either a previous attempt got that far or a person
  // is part way through building the tab by hand. Adopting it would overwrite
  // the terms they typed — including a date they had corrected. So the deal is
  // filed beside it, and the run names the tab rather than leaving it to be
  // discovered.
  const { graph, calls } = fakeGraph({
    sheets: ["Template", "LGF", "PGF"],
    overview: ONLY_LGF,
    cells: { PGF: { A3: "Date", D3: "PGF", B3: 46251 } },
  });

  const res = await writeDealToTracker(DEAL, { graph, target });

  assert.equal(res.ok, true);
  assert.equal(res.sheet, "PGF (b)", "filed beside it");
  assert.ok(calls.some((c) => c.path.includes("/worksheets/add")));
  assert.ok(
    res.notes?.some((n) => /its ASX code already reads "PGF"/.test(n)),
    "and the leftover is reported",
  );
  assert.ok(res.notes?.some((n) => /whether "PGF" should be deleted/.test(n)));
});

test("tracker: a tab the Overview DOES account for is never adopted", async () => {
  // A genuine repeat issuer. `PGF` is filed under an earlier date, so this deal
  // is a second placement and belongs in its own tab — adopting the first one
  // would overwrite a deal the desk has already worked.
  const { graph } = fakeGraph({
    sheets: ["Template", "PGF"],
    overview: [[57, "PGF", serial("2026-07-02")]],
    cells: { PGF: { A3: "Date", D3: "PGF" } },
  });

  const res = await writeDealToTracker(DEAL, { graph, target });
  assert.equal(res.sheet, "PGF (b)");
  assert.notEqual(res.via, "adopted");
});

test("tracker: an Overview row is matched to its tab by FORMULA, not by ticker", async () => {
  // Column C's value is the friendly ticker, so a row for `PGF (b)` still reads
  // `PGF`. Only the Date Issued formula (`='PGF (b)'!B3`) says which tab a row
  // belongs to — without reading it, the real `PGF` would look unaccounted for.
  const { graph } = fakeGraph({
    sheets: ["Template", "PGF", "PGF (b)"],
    // One row, showing PGF, pointing at `PGF (b)`.
    overview: [[57, "PGF", serial("2026-07-02"), "PGF (b)"]],
    cells: { PGF: { A3: "Date" }, "PGF (b)": { A3: "Date", D3: "PGF" } },
  });

  const res = await writeDealToTracker(DEAL, { graph, target });
  // `PGF` is the unaccounted tab and its terms are blank, so it is the leftover.
  assert.equal(res.sheet, "PGF");
  assert.equal(res.via, "adopted");
});

test("tracker: an Overview formula names its sheet whether Excel quoted it or not", () => {
  // The write sends `='PGF'!B3`; Excel reads it back as `=PGF!B3`, dropping
  // quotes it does not need. Both have to resolve to the same tab.
  assert.equal(referencedSheetName("='PGF'!B3"), "PGF");
  assert.equal(referencedSheetName("=PGF!B3"), "PGF");
  assert.equal(referencedSheetName("='CBE (a)'!B3"), "CBE (a)");
  assert.equal(referencedSheetName("=M199*(1.1)"), null, "a self-reference names no sheet");
  assert.equal(referencedSheetName(46251), null);
  assert.equal(referencedSheetName(""), null);
});

test("tracker: the leftover search matches the ticker and its suffixed forms", () => {
  const referenced = new Set(["LGF"]);
  assert.equal(unreferencedTabFor("PGF", ["LGF", "PGF"], referenced), "PGF");
  assert.equal(unreferencedTabFor("PGF", ["LGF", "PGF (b)"], referenced), "PGF (b)");
  // Accounted for, so not wreckage.
  assert.equal(unreferencedTabFor("LGF", ["LGF"], referenced), null);
  // A different stock is not this deal's leftover.
  assert.equal(unreferencedTabFor("PGF", ["LGF", "PGX"], referenced), null);
  // Scaffolding is never a deal tab, whatever it is called.
  assert.equal(unreferencedTabFor("Index", ["Index"], new Set()), null);
});

test("tracker: the terms block is read as a rectangle, and an empty one is bare", () => {
  const seeded = [
    ["Options", "1:2 free", "Industry", "ASX CODE"],
    ["Date", 46251, "", ""],
    ["2 Tranche", "yes", "", ""],
  ];
  assert.equal(termsCell(seeded, "A2"), "Options");
  assert.equal(termsCell(seeded, "B3"), 46251);
  assert.equal(termsCell(seeded, "D2"), "ASX CODE");
  assert.equal(termsCell(seeded, "D3"), "", "blank ASX code — nobody has claimed it");
  assert.equal(termsCell(seeded, "Z9"), "", "outside the block reads as empty, not as a throw");

  assert.equal(isBareTab(seeded), false);
  assert.equal(
    isBareTab([
      ["", ""],
      ["", ""],
    ]),
    true,
  );
  assert.equal(isBareTab([]), true);
});

/* ---------------------------------------------------------------- */
/* Date Issued is a SYDNEY date                                      */
/* ---------------------------------------------------------------- */

const dated = (received_at: string) => dealFromCandidate({ ...CANDIDATE, received_at }).issueDate;

test("tracker sync: a pre-open announcement is dated the Sydney day, not the UTC one", () => {
  // NGY, 3 September 2026. The mail went out at 23:25:13Z, which is 09:25 the
  // next morning in Sydney — before the open, which is when a raise with a
  // trading halt is normally announced. Taking the UTC prefix filed it as the
  // 2nd, the upstream filed it under the 3rd, and the desk typed the 3rd.
  assert.equal(dated("2026-09-02T23:25:13+00:00"), "2026-09-03");
});

test("tracker sync: an intraday announcement is unchanged", () => {
  // FBR, the same morning: 00:06:40Z is 10:06 in Sydney, so UTC and Sydney agree
  // and always will for anything announced after the open.
  assert.equal(dated("2026-09-03T00:06:40+00:00"), "2026-09-03");
  assert.equal(dated("2026-08-11T02:31:38+00:00"), "2026-08-11");
});

test("tracker sync: the offset follows daylight saving, rather than being assumed", () => {
  // 13:30Z is the hour that tells AEDT from AEST: +11 makes it 00:30 the next
  // day, +10 makes it 23:30 the same day. A fixed offset gets one of these wrong,
  // and the changeover falls mid-year here.
  assert.equal(dated("2026-01-15T13:30:00Z"), "2026-01-16", "AEDT, +11");
  assert.equal(dated("2026-06-15T13:30:00Z"), "2026-06-15", "AEST, +10");
});

test("tracker sync: an unreadable timestamp keeps its literal day rather than none", () => {
  // No date at all is a reported failure, because there is no year to choose a
  // workbook by. The literal prefix is worse than a real conversion and much
  // better than that.
  assert.equal(dated("2026-08-11 not a timestamp"), "2026-08-11");
  assert.equal(dated(""), null);
});
