import test from "node:test";
import assert from "node:assert/strict";

import {
  alreadyInOverview,
  excelSerialDate,
  formulaSheetRef,
  nextOverviewSlot,
  nextSheetName,
  overviewRowFormulas,
  tabCellWrites,
} from "./tracker-format.ts";
import { writeDealToTracker, type GraphCall } from "./tracker-writer.ts";
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

/** A Graph that records calls and answers from a literal workbook. */
function fakeGraph(
  workbook: { sheets: string[]; overview: (string | number)[][] },
  fail?: { path: RegExp; status: number; message?: string },
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
      return { ok: true, status: 200, body: { value: workbook.sheets.map((name) => ({ name })) } };
    }
    if (method === "GET" && path.includes("usedRange")) {
      // Graph hands back the address and the formulas together.
      return {
        ok: true,
        status: 200,
        body: { address: "Template!A1:P30", formulas: TEMPLATE_FORMULAS },
      };
    }
    if (method === "GET" && path.includes("range(address=")) {
      return { ok: true, status: 200, body: { values: workbook.overview } };
    }
    if (method === "POST" && path.includes("/createSession")) {
      return { ok: true, status: 201, body: { id: "session-1" } };
    }
    if (method === "POST" && path.includes("/closeSession")) {
      return { ok: true, status: 204, body: null };
    }
    if (method === "POST" && path.includes("/worksheets/add")) {
      const name = (init.body as { name: string }).name;
      workbook.sheets.push(name);
      return { ok: true, status: 201, body: { name } };
    }
    if (method === "PATCH") return { ok: true, status: 200, body: {} };

    return { ok: false, status: 404, body: { error: { message: `unrouted ${method} ${path}` } } };
  };

  return { graph, calls };
}

const target = { driveId: "d", itemId: "i", overviewSheet: "2026 Overview" };

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

test("tracker: Template is REPLAYED into the new sheet, because Graph cannot copy one", async () => {
  // `worksheets/{id}/copy` answers 400 "Resource not found for the segment
  // 'copy'" on both v1.0 and beta, and so does `range/copyFrom` — probed against
  // the real workbook with `tables/add` as a control. So a tab is an added sheet
  // plus Template's own used range written into it at the same addresses, where
  // its sheet-relative formulas stay correct.
  const { graph, calls } = fakeGraph({ sheets: ["Template"], overview: OVERVIEW });
  await writeDealToTracker(DEAL, { graph, target });

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
  assert.equal(formulas[1], "PGF", "the Counter column holds the plain ticker");
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

  // The Template seed is a PATCH too; the deal's own cells are the rest.
  const patches = calls.filter(
    (c) => c.method === "PATCH" && !c.path.includes("Overview") && !c.path.includes("A1:P30"),
  );
  const written = new Map(
    patches.map((c) => [
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
  // The Template seed is a PATCH too; the deal's own cells are the rest.
  const patches = calls.filter(
    (c) => c.method === "PATCH" && !c.path.includes("Overview") && !c.path.includes("A1:P30"),
  );
  assert.equal(patches.length, 1, "just the ASX code");
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

test("tracker sync: nothing fresh means nothing is touched", async () => {
  const graph: GraphCall = async () => {
    throw new Error("the tracker must not be opened for an empty run");
  };
  const report = await syncTrackerRows([], { graph, target: async () => target });
  assert.deepEqual(report, { ok: true, written: [], skipped: 0, failed: [], notes: [] });
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
