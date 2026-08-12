import {
  NON_DEAL_SHEETS,
  OVERVIEW_FIRST_DATA_ROW,
  TEMPLATE_SHEET,
  alreadyInOverview,
  nextOverviewSlot,
  nextSheetName,
  overviewRowAddress,
  overviewRowFormulas,
  tabCellWrites,
  type TrackerDeal,
} from "./tracker-format.ts";

/**
 * Writing a new deal into the Placement Tracker workbook.
 *
 * ── Why the Excel API and not "download, edit, upload" ───────────────────────
 * The tracker is 13 MB and ~190 sheets of formulas, formatting, validation and
 * conditional colouring, and it is the desk's live book. Round-tripping it
 * through a spreadsheet library to add one row would rewrite all 190 sheets to
 * change two, and every feature the library does not model — and there are
 * several — would be quietly dropped from a file people work in daily.
 *
 * Graph's Excel API edits the file in place instead: copy `Template`, patch five
 * cells, append one row. Nothing else in the workbook is touched, and a failure
 * halfway leaves the sheets it did not reach exactly as they were.
 *
 * ── Order matters ────────────────────────────────────────────────────────────
 * The tab is created BEFORE the Overview row, because every cell in that row is
 * a formula pointing at the tab. Written the other way round, a failure between
 * the two leaves a row of `#REF!` in the sheet the desk reads every morning.
 * This way the same failure leaves an unreferenced tab, which is invisible until
 * someone looks for it — and it is reported either way.
 *
 * Dependency-injected and free of `server-only` on purpose: the whole flow is
 * covered by tests against a fake Graph, with no network and no workbook.
 */

const GRAPH_API = "https://graph.microsoft.com/v1.0";

/** The thin slice of Graph this module needs. Faked wholesale in tests. */
export type GraphCall = (
  path: string,
  init?: { method?: string; body?: unknown; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; body: unknown }>;

export type TrackerTarget = {
  /** Drive and item ids for the workbook — resolved once from the share URL. */
  driveId: string;
  itemId: string;
  /** `2026 Overview`. */
  overviewSheet: string;
};

export type TrackerWriteResult = {
  ok: boolean;
  /** True when the deal was already in the workbook and nothing was written. */
  skipped?: boolean;
  sheet?: string;
  overviewRow?: number;
  counter?: number;
  error?: string;
  /** What a person has to do about it — a missing permission, a half-write. */
  hint?: string;
};

/* ------------------------------------------------------------------ */
/* Graph plumbing                                                      */
/* ------------------------------------------------------------------ */

/** Wraps `fetch` into a `GraphCall`, so production and tests share one path. */
export function graphCaller(accessToken: string, sessionId?: string): GraphCall {
  return async (path, init = {}) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(sessionId ? { "workbook-session-id": sessionId } : {}),
      ...(init.headers ?? {}),
    };

    const res = await fetch(`${GRAPH_API}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
    });

    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { ok: res.ok, status: res.status, body };
  };
}

/**
 * Turns a SharePoint share link into the drive/item pair the Excel API needs.
 *
 * `/shares/{id}/driveItem/workbook` answers 400 — "no addressUrl for
 * Microsoft.Excel" — so the share link can only be used to LOOK UP the ids, and
 * every workbook call has to go through `/drives/{driveId}/items/{itemId}`.
 * That is not documented anywhere near the Excel API; it cost a confusing
 * afternoon, hence this note.
 *
 * The year picks the workbook: the tracker is one file per year, and the sheet
 * named `2026 Overview` is what identifies which. A link whose workbook has no
 * such sheet is simply not this year's file.
 */
export async function resolveTrackerTarget(
  shareUrls: string[],
  year: number,
  graph: GraphCall,
): Promise<TrackerTarget | null> {
  const overviewSheet = `${year} Overview`;

  for (const raw of shareUrls) {
    const url = raw.trim();
    if (!url) continue;

    const shareId = `u!${Buffer.from(url)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")}`;

    const meta = await graph(`/shares/${shareId}/driveItem?$select=id,parentReference`);
    if (!meta.ok) continue;

    const item = meta.body as { id?: string; parentReference?: { driveId?: string } } | null;
    const itemId = item?.id;
    const driveId = item?.parentReference?.driveId;
    if (!itemId || !driveId) continue;

    const candidate: TrackerTarget = { driveId, itemId, overviewSheet };
    const names = await sheetNames(graph, candidate);
    if (names?.includes(overviewSheet)) return candidate;
  }

  return null;
}

/** `PLACEMENT_TRACKER_URL` holds one link per year, separated loosely. */
export function trackerUrls(configured: string | undefined): string[] {
  return (configured ?? "")
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function graphError(body: unknown): string {
  const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
  if (!err) return "Microsoft Graph returned an unexpected response.";
  return err.message?.trim() || err.code || "Microsoft Graph rejected the request.";
}

/**
 * A 403 here means one specific thing, and saying so saves an afternoon: the
 * app registration reads the workbook but cannot write to it. That is a consent
 * step in Entra ID, not a bug in this code.
 */
function permissionHint(status: number): string | undefined {
  if (status !== 401 && status !== 403) return undefined;
  return (
    "The Graph app registration needs the Files.ReadWrite.All application " +
    "permission (and Sites.ReadWrite.All for SharePoint) with admin consent. " +
    "It currently holds read-only roles, so the workbook can be read but not written."
  );
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

type NamedSheet = { name?: string };

async function sheetNames(graph: GraphCall, t: TrackerTarget): Promise<string[] | null> {
  const res = await graph(
    `/drives/${t.driveId}/items/${t.itemId}/workbook/worksheets?$select=name`,
  );
  if (!res.ok) return null;
  const value = (res.body as { value?: NamedSheet[] } | null)?.value ?? [];
  return value.map((s) => s.name ?? "").filter(Boolean);
}

/**
 * The Overview's B (counter), C (ticker) and D (date issued) columns.
 *
 * Read as one range rather than row by row: it is a single call whatever the
 * sheet's length, and the whole point of reading it is to answer two questions
 * — where does the next row go, and is this deal already here.
 */
async function overviewIndex(
  graph: GraphCall,
  t: TrackerTarget,
  lastRow: number,
): Promise<{ counter: unknown; ticker: unknown; issued: unknown }[] | null> {
  const address = `B${OVERVIEW_FIRST_DATA_ROW}:D${lastRow}`;
  const res = await graph(
    `/drives/${t.driveId}/items/${t.itemId}/workbook/worksheets('${encodeURIComponent(
      t.overviewSheet,
    )}')/range(address='${address}')?$select=values`,
  );
  if (!res.ok) return null;

  const values = (res.body as { values?: unknown[][] } | null)?.values ?? [];
  return values.map((row) => ({
    counter: row?.[0] ?? "",
    ticker: row?.[1] ?? "",
    issued: row?.[2] ?? "",
  }));
}

/* ------------------------------------------------------------------ */
/* The write                                                           */
/* ------------------------------------------------------------------ */

export type TrackerWriteDeps = {
  graph: GraphCall;
  target: TrackerTarget;
  /** How far down the Overview to look. Generous; it is one range read. */
  scanToRow?: number;
};

/**
 * Adds one deal to the workbook: a tab copied from Template, then its row.
 *
 * Never throws — a tracker that cannot be written must not take down the thing
 * that was writing to it, which is a scheduled ingest.
 */
export async function writeDealToTracker(
  deal: TrackerDeal,
  deps: TrackerWriteDeps,
): Promise<TrackerWriteResult> {
  const { graph, target } = deps;
  const scanToRow = deps.scanToRow ?? 400;
  const item = `/drives/${target.driveId}/items/${target.itemId}/workbook`;

  if (!deal.ticker?.trim()) {
    return { ok: false, error: "A deal with no ticker cannot be written to the tracker." };
  }

  try {
    // ── Is it already there? ────────────────────────────────────────────────
    const rows = await overviewIndex(graph, target, scanToRow);
    if (!rows) {
      return {
        ok: false,
        error: `Could not read the ${target.overviewSheet} sheet.`,
      };
    }
    if (alreadyInOverview(rows, deal)) {
      return { ok: true, skipped: true };
    }

    // ── Name the tab ────────────────────────────────────────────────────────
    const names = await sheetNames(graph, target);
    if (!names) return { ok: false, error: "Could not list the workbook's sheets." };

    if (!names.includes(TEMPLATE_SHEET)) {
      return {
        ok: false,
        error: `The workbook has no "${TEMPLATE_SHEET}" sheet to copy.`,
        hint: "A deal tab is a copy of Template — without it there is nothing to base one on.",
      };
    }

    const deals = names.filter((n) => !NON_DEAL_SHEETS.has(n) && !/overview$/i.test(n));
    const sheet = nextSheetName(deal.ticker, [...deals, ...NON_DEAL_SHEETS]);
    if (!sheet) {
      return {
        ok: false,
        error: `${deal.ticker.toUpperCase()} already has 26 tabs in this workbook.`,
      };
    }

    // ── The tab, before the row that points at it ───────────────────────────
    const copied = await graph(
      `${item}/worksheets('${encodeURIComponent(TEMPLATE_SHEET)}')/copy`,
      { method: "POST", body: { name: sheet, positionType: "End" } },
    );
    if (!copied.ok) {
      return {
        ok: false,
        error: `Could not copy ${TEMPLATE_SHEET} to "${sheet}": ${graphError(copied.body)}`,
        hint: permissionHint(copied.status),
      };
    }

    // ── The deal's own terms ────────────────────────────────────────────────
    for (const cell of tabCellWrites(deal)) {
      const patch = await graph(
        `${item}/worksheets('${encodeURIComponent(sheet)}')/range(address='${cell.address}')`,
        {
          method: "PATCH",
          body: {
            values: [[cell.value]],
            ...(cell.numberFormat ? { numberFormat: [[cell.numberFormat]] } : {}),
          },
        },
      );
      if (!patch.ok) {
        return {
          ok: false,
          sheet,
          error: `Sheet "${sheet}" was created but ${cell.address} could not be filled: ${graphError(patch.body)}`,
          hint:
            permissionHint(patch.status) ??
            `Finish "${sheet}" by hand, or delete it and retry — it is not yet on the Overview.`,
        };
      }
    }

    // ── The Overview row ────────────────────────────────────────────────────
    const slot = nextOverviewSlot(rows);
    const written = await graph(
      `${item}/worksheets('${encodeURIComponent(
        target.overviewSheet,
      )}')/range(address='B${slot.row}:T${slot.row}')`,
      {
        method: "PATCH",
        body: { formulas: [overviewRowFormulas(sheet, deal.ticker, slot.row, slot.counter)] },
      },
    );
    if (!written.ok) {
      return {
        ok: false,
        sheet,
        error: `Sheet "${sheet}" was created but its ${target.overviewSheet} row was not: ${graphError(written.body)}`,
        hint: `Add a row for "${sheet}" at ${overviewRowAddress(target.overviewSheet, slot.row)} by hand, or delete the tab and retry.`,
      };
    }

    return { ok: true, sheet, overviewRow: slot.row, counter: slot.counter };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "The tracker write failed.",
    };
  }
}
