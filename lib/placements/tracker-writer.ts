import {
  NON_DEAL_SHEETS,
  OVERVIEW_FIRST_DATA_ROW,
  TEMPLATE_SHEET,
  TERMS_RANGE,
  alreadyInOverview,
  dealSheetPlacement,
  isBareTab,
  isDealSheet,
  nextOverviewSlot,
  nextSheetName,
  overviewRowAddress,
  overviewRowFormulas,
  referencedSheetName,
  tabCellWrites,
  termsCell,
  unreferencedTabFor,
  type SheetSlot,
  type TrackerDeal,
} from "./tracker-format.ts";
import { dressSheetLikeTemplate } from "./tracker-style.ts";

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
 * Graph's Excel API edits the file in place instead: add a sheet, replay
 * `Template` into it, patch five cells, append one row. Nothing else in the
 * workbook is touched, and a failure halfway leaves the sheets it did not reach
 * exactly as they were.
 *
 * ── There is no worksheet copy, so the tab is rebuilt ────────────────────────
 * A real `worksheets/{id}/copy` would bring everything across in one call. It
 * does not exist: `copy` is an Office.js method, and the Graph reference gives a
 * worksheet `add`, `get`, `update` and `delete` and nothing else, in v1.0 and in
 * beta. The `400 Resource not found for the segment 'copy'` this code once read
 * as a tenant quirk is simply the API saying so.
 *
 * The call is still made first, and costs one request per deal. If Graph ever
 * ships the action the workbook gets a true copy — validation, conditional
 * formatting and all — the moment it does, and `via` in the result says which
 * path ran.
 *
 * ── The rebuild ──────────────────────────────────────────────────────────────
 * `worksheets/add`, then Template's own used range written in at the same
 * addresses, where its sheet-relative formulas (`=D6/C6`, `=SUM(C7:C21)`) and its
 * `Index` lookups stay correct. Carried with it:
 *
 *   formulas      the whole point — the tab computes
 *   numberFormat  per cell, so dates read `17/08/2026` rather than `46251`, and
 *                 money reads as money instead of a bare number
 *   fills, fonts  the black header bands, the yellow input cells the desk's
 *   borders       "ONLY EDIT FIELDS HIGHLIGHTED IN YELLOW" convention is written
 *   and widths    in, and the boxes around the tables — read off Template rather
 *                 than guessed at, by `tracker-style.ts`, which explains how
 *
 * Still not carried: data validation and conditional formatting, which have no
 * range-level read to recover them from.
 *
 * ── Order matters ────────────────────────────────────────────────────────────
 * The tab is created BEFORE the Overview row, because every cell in that row is
 * a formula pointing at the tab. Written the other way round, a failure between
 * the two leaves a row of `#REF!` in the sheet the desk reads every morning.
 * This way the same failure leaves an unreferenced tab, which is invisible until
 * someone looks for it — and it is reported either way.
 *
 * The shading goes on LAST, after the row — it is the slowest step and the only
 * one nothing depends on. A cron that runs out of its 60 seconds part-way
 * through it leaves a deal that is filed, correct and a bit plain, rather than a
 * beautifully formatted tab no row points at.
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
  /**
   * How the tab was made. `copy` is a true worksheet copy and carries
   * everything; `replay` rebuilds it and recovers all of it except data
   * validation and conditional formatting. Reported so one glance at an ingest
   * log answers which the workbook is getting, rather than someone inferring it
   * from how a tab looks.
   *
   * `adopted` is a tab an earlier attempt created and did not finish — the deal
   * is filed into it rather than beside it. Worth its own value because a run
   * reporting `adopted` is a run cleaning up after a previous failure, which is
   * a different thing to know about than a normal write.
   */
  via?: "copy" | "replay" | "adopted";
  error?: string;
  /** What a person has to do about it — a missing permission, a half-write. */
  hint?: string;
  /**
   * Things that did not stop the write but a person should know: a tab left in
   * the wrong position, widths that did not replay. The deal is IN the workbook
   * in every one of these cases, so they are not failures.
   */
  notes?: string[];
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
    const slots = await sheetSlots(graph, candidate);
    if (slots?.some((s) => s.name === overviewSheet)) return candidate;
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

/** `Template!A1:P30` → `A1:P30`, for writing the same shape on another sheet. */
function localAddress(address: string | undefined): string | null {
  if (!address) return null;
  const local = address.includes("!") ? address.slice(address.lastIndexOf("!") + 1) : address;
  return /^[A-Z]+\d+(:[A-Z]+\d+)?$/i.test(local) ? local : null;
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

type NamedSheet = { name?: string; position?: number };

/**
 * Every tab, with the position that decides where it sits along the bottom.
 *
 * `position` is asked for because a new deal has to land at the front of the
 * deal tabs and `worksheets/add` always appends. Graph returns them in order,
 * so the index is a sound fallback for a workbook that answers without one.
 */
async function sheetSlots(graph: GraphCall, t: TrackerTarget): Promise<SheetSlot[] | null> {
  const res = await graph(
    `/drives/${t.driveId}/items/${t.itemId}/workbook/worksheets?$select=name,position`,
  );
  if (!res.ok) return null;
  const value = (res.body as { value?: NamedSheet[] } | null)?.value ?? [];

  return value
    .map((s, i) => ({
      name: s.name ?? "",
      position: typeof s.position === "number" ? s.position : i,
    }))
    .filter((s) => s.name !== "");
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
): Promise<OverviewRow[] | null> {
  const address = `B${OVERVIEW_FIRST_DATA_ROW}:D${lastRow}`;
  const res = await graph(
    `/drives/${t.driveId}/items/${t.itemId}/workbook/worksheets('${encodeURIComponent(
      t.overviewSheet,
    )}')/range(address='${address}')?$select=values,formulas`,
  );
  if (!res.ok) return null;

  const body = res.body as { values?: unknown[][]; formulas?: unknown[][] } | null;
  const values = body?.values ?? [];
  const formulas = body?.formulas ?? [];

  return values.map((row, i) => ({
    counter: row?.[0] ?? "",
    ticker: row?.[1] ?? "",
    issued: row?.[2] ?? "",
    // `formulas` costs nothing here — it is the same range read — and it is the
    // only way to learn which SHEET a row belongs to. Column C's value is the
    // friendly ticker, which for a repeat issuer filed as `FBR (b)` is `FBR`.
    refSheet: referencedSheetName(formulas[i]?.[2]),
  }));
}

type OverviewRow = {
  counter: unknown;
  ticker: unknown;
  issued: unknown;
  /** The tab this row's Date Issued formula points at, or null. */
  refSheet: string | null;
};

/** Every tab the Overview accounts for, so an unaccounted one can be spotted. */
function overviewSheetRefs(rows: OverviewRow[]): Set<string> {
  const named = new Set<string>();
  for (const r of rows) if (r.refSheet) named.add(r.refSheet);
  return named;
}

/* ------------------------------------------------------------------ */
/* Making the tab                                                      */
/* ------------------------------------------------------------------ */

type SheetPlacement = { position: number; before: string | null };

type MadeSheet = {
  ok: boolean;
  via?: "copy" | "replay" | "adopted";
  sheet?: string;
  /**
   * Template's used range, when the tab was rebuilt from it. The shading pass
   * needs the same address, and reading `usedRange` twice for one tab would be
   * a wasted call.
   */
  shape?: string;
  error?: string;
  hint?: string;
  notes?: string[];
};

const sheetPath = (item: string, name: string) =>
  `${item}/worksheets('${encodeURIComponent(name)}')`;

/**
 * Create the deal's tab, in the right place, looking as much like Template as
 * the API allows.
 *
 * Copy first — it would carry the formatting and position the tab in one call,
 * and it is one request to find out. Graph has no such action today, so the 400
 * falls through to the rebuild; a 403 would mean the action existed and was not
 * permitted, and retrying that as an `add` would fail identically, so it is
 * reported rather than retried.
 */
async function createDealSheet(
  graph: GraphCall,
  item: string,
  sheet: string,
  placement: SheetPlacement,
): Promise<MadeSheet> {
  const copied = await graph(`${sheetPath(item, TEMPLATE_SHEET)}/copy`, {
    method: "POST",
    body: placement.before
      ? { name: sheet, positionType: "Before", relativeTo: placement.before }
      : { name: sheet, positionType: "End" },
  });

  if (copied.ok) {
    const notes: string[] = [];
    // Excel has been known to answer a requested name with `Template (2)` when
    // it does not like it. `nextSheetName` has already guaranteed the name is
    // free, so a mismatch is Excel's doing and is simply corrected.
    const got = (copied.body as { name?: string } | null)?.name;
    if (got && got !== sheet) {
      const renamed = await graph(sheetPath(item, got), {
        method: "PATCH",
        body: { name: sheet },
      });
      if (!renamed.ok) {
        return {
          ok: false,
          sheet: got,
          error: `Template was copied but the tab could not be renamed from "${got}" to "${sheet}": ${graphError(renamed.body)}`,
          hint: `Rename "${got}" to "${sheet}" by hand — it is not yet on the Overview.`,
        };
      }
    }
    return { ok: true, via: "copy", sheet, notes };
  }

  if (copied.status === 401 || copied.status === 403) {
    return {
      ok: false,
      error: `Could not copy ${TEMPLATE_SHEET} to "${sheet}": ${graphError(copied.body)}`,
      hint: permissionHint(copied.status),
    };
  }

  return replayTemplate(graph, item, sheet, placement);
}

/**
 * The fallback: an empty sheet with Template's used range written into it.
 *
 * Template's extent is READ rather than hardcoded, so a tab stays a faithful
 * copy if the desk ever extends the template. `usedRange` hands back the
 * address, the formulas and the number formats together — one call for all
 * three, and the number formats are what make a date read as a date.
 */
async function replayTemplate(
  graph: GraphCall,
  item: string,
  sheet: string,
  placement: SheetPlacement,
): Promise<MadeSheet> {
  const template = await graph(
    `${sheetPath(item, TEMPLATE_SHEET)}/usedRange?$select=address,formulas,numberFormat`,
  );
  if (!template.ok) {
    return { ok: false, error: `Could not read ${TEMPLATE_SHEET}: ${graphError(template.body)}` };
  }

  const blueprint = template.body as {
    address?: string;
    formulas?: unknown[][];
    numberFormat?: unknown[][];
  };
  const shape = localAddress(blueprint.address);
  if (!shape || !blueprint.formulas?.length) {
    return { ok: false, error: `${TEMPLATE_SHEET} appears to be empty.` };
  }

  const added = await graph(`${item}/worksheets/add`, { method: "POST", body: { name: sheet } });
  if (!added.ok) {
    return {
      ok: false,
      error: `Could not create the sheet "${sheet}": ${graphError(added.body)}`,
      hint: permissionHint(added.status),
    };
  }

  const seeded = await graph(`${sheetPath(item, sheet)}/range(address='${shape}')`, {
    method: "PATCH",
    body: {
      formulas: blueprint.formulas,
      // Sent alongside the formulas, the way the per-cell writes below already
      // do it. Without this the tab's dates render as five-digit serials and
      // every dollar column as a bare number — the tab is right and reads wrong.
      ...(blueprint.numberFormat?.length ? { numberFormat: blueprint.numberFormat } : {}),
    },
  });
  if (!seeded.ok) {
    return {
      ok: false,
      sheet,
      error: `Sheet "${sheet}" was created but ${TEMPLATE_SHEET} could not be written into it: ${graphError(seeded.body)}`,
      hint:
        permissionHint(seeded.status) ??
        `Delete the empty "${sheet}" tab and retry — it is not yet on the Overview.`,
    };
  }

  // Not worth failing a deal over: the tab is complete and correct, and a tab in
  // the wrong place is something a person can fix in seconds once told.
  const notes: string[] = [];

  const moved = await graph(sheetPath(item, sheet), {
    method: "PATCH",
    body: { position: placement.position },
  });
  if (!moved.ok) {
    notes.push(
      `"${sheet}" was added at the end of the workbook — moving it to the front of the deal tabs failed: ${graphError(moved.body)}`,
    );
  }

  return { ok: true, via: "replay", sheet, shape, notes };
}

/**
 * Finish the tab a previous attempt left behind, instead of filing beside it.
 *
 * Every failure after `worksheets/add` leaves the tab: a refused seed, a refused
 * cell write, a refused Overview row, or — the 3 September 2026 case — the whole
 * invocation being killed. The tab-before-row order makes that the wreckage on
 * purpose, and it was harmless while nothing retried on its own.
 *
 * It is not harmless now. A retry that ignored the leftover would find `FBR`
 * taken, file the deal as `FBR (b)` — asserting a repeat placement that never
 * happened — and leave an unformatted `FBR` at the end of the workbook for good.
 *
 * ── Only a tab nobody has claimed ────────────────────────────────────────────
 * The caller has already established that no Overview row points here. This adds
 * the second condition: `D3`, the ASX code, must be EMPTY. That is the tightest
 * available signal that the tab is ours and unfinished — Template ships `D3`
 * blank, it is the first cell `tabCellWrites` fills, and it is the first thing a
 * person building a tab by hand types. A tab with an ASX code in it may be
 * somebody's work in progress, and adopting it would overwrite the terms they
 * typed, including a date they had corrected.
 *
 * ── Bare versus seeded ───────────────────────────────────────────────────────
 * If the kill landed between `add` and the seed there are no formulas at all, and
 * the tab has to be seeded before it is worth anything. If the seed had already
 * run — the common case, and today's — the formulas are there and are left
 * exactly alone. One range read answers both, since a seeded tab carries
 * Template's own row labels in `A2:A4`.
 */
async function adoptOrphanSheet(
  graph: GraphCall,
  item: string,
  sheet: string,
  ticker: string,
): Promise<MadeSheet & { adoptable?: boolean }> {
  const terms = await graph(
    `${sheetPath(item, sheet)}/range(address='${TERMS_RANGE}')?$select=values`,
  );
  if (!terms.ok) {
    // Cannot tell whether it is claimed, so it is not adopted — the caller falls
    // back to a suffixed name, which is wasteful but never destructive.
    return { ok: false, adoptable: false, error: `Could not read "${sheet}": ${graphError(terms.body)}` };
  }

  const values = (terms.body as { values?: unknown[][] } | null)?.values ?? [];
  const claimedBy = String(termsCell(values, "D3") ?? "").trim();
  if (claimedBy !== "") {
    return {
      ok: false,
      adoptable: false,
      notes: [
        `"${sheet}" exists, no Overview row points at it, and its ASX code already reads ` +
          `"${claimedBy}" — so it was left by a previous attempt or is somebody's work in ` +
          `progress. It was NOT reused, and ${ticker.toUpperCase()} was filed beside it. Check ` +
          `whether "${sheet}" should be deleted.`,
      ],
    };
  }

  const template = await graph(
    `${sheetPath(item, TEMPLATE_SHEET)}/usedRange?$select=address,formulas,numberFormat`,
  );
  if (!template.ok) {
    return { ok: false, adoptable: true, error: `Could not read ${TEMPLATE_SHEET}: ${graphError(template.body)}` };
  }

  const blueprint = template.body as {
    address?: string;
    formulas?: unknown[][];
    numberFormat?: unknown[][];
  };
  const shape = localAddress(blueprint.address);
  if (!shape || !blueprint.formulas?.length) {
    return { ok: false, adoptable: true, error: `${TEMPLATE_SHEET} appears to be empty.` };
  }

  const notes = [
    `"${sheet}" was left behind by an earlier attempt and has been finished rather than ` +
      `filed beside — no Overview row pointed at it and its terms were blank.`,
  ];

  if (isBareTab(values)) {
    const seeded = await graph(`${sheetPath(item, sheet)}/range(address='${shape}')`, {
      method: "PATCH",
      body: {
        formulas: blueprint.formulas,
        ...(blueprint.numberFormat?.length ? { numberFormat: blueprint.numberFormat } : {}),
      },
    });
    if (!seeded.ok) {
      return {
        ok: false,
        adoptable: true,
        error: `"${sheet}" was adopted but ${TEMPLATE_SHEET} could not be written into it: ${graphError(seeded.body)}`,
        hint: permissionHint(seeded.status),
      };
    }
    notes.push(`"${sheet}" was empty, so ${TEMPLATE_SHEET} was replayed into it.`);
  }

  return { ok: true, via: "adopted", sheet, shape, notes, adoptable: true };
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
  const { target } = deps;
  const scanToRow = deps.scanToRow ?? 400;
  const item = `/drives/${target.driveId}/items/${target.itemId}/workbook`;

  if (!deal.ticker?.trim()) {
    return { ok: false, error: "A deal with no ticker cannot be written to the tracker." };
  }

  // ── Everything happens inside one workbook session ──────────────────────────
  // Not for speed. Without a session, Graph answers a read issued straight after
  // a write from a stale snapshot: a live test created a sheet, wrote five cells
  // and read back five empty ones — while the workbook on disk had them. The
  // writes were fine; the reads were lying, which is a far worse way to be wrong
  // than an error, because everything reports success.
  //
  // `persistChanges: true` is the difference between editing the file and
  // editing a scratch copy Graph throws away. Session creation is allowed to
  // fail — an unsessioned write still lands — so this degrades rather than
  // blocks, and the duplicate guard is what stops a retry doubling up.
  const session = await deps.graph(`${item}/createSession`, {
    method: "POST",
    body: { persistChanges: true },
  });
  const sessionId = session.ok
    ? ((session.body as { id?: string } | null)?.id ?? null)
    : null;

  const graph: GraphCall = (path, init = {}) =>
    deps.graph(path, {
      ...init,
      headers: { ...(init.headers ?? {}), ...(sessionId ? { "workbook-session-id": sessionId } : {}) },
    });

  const closeSession = async () => {
    if (!sessionId) return;
    // Best effort: an unclosed session expires on its own, and failing to close
    // one is not a reason to report a completed write as failed.
    await graph(`${item}/closeSession`, { method: "POST", body: {} }).catch(() => undefined);
  };

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
    const slots = await sheetSlots(graph, target);
    if (!slots) return { ok: false, error: "Could not list the workbook's sheets." };

    const names = slots.map((s) => s.name);
    if (!names.includes(TEMPLATE_SHEET)) {
      return {
        ok: false,
        error: `The workbook has no "${TEMPLATE_SHEET}" sheet to copy.`,
        hint: "A deal tab is a copy of Template — without it there is nothing to base one on.",
      };
    }

    const deals = names.filter(isDealSheet);
    const placement = dealSheetPlacement(slots);

    // ── Finish a leftover tab before making another one ─────────────────────
    // A tab this ticker owns that no Overview row points at is the wreckage of an
    // earlier attempt, and adopting it is what stops an automatic retry from
    // filing `FBR (b)` next to an unformatted `FBR` forever. `adoptOrphanSheet`
    // refuses anything that looks claimed, and `adoptable: false` means exactly
    // that — fall through and name a new tab, carrying its note.
    const leftover = unreferencedTabFor(deal.ticker, deals, overviewSheetRefs(rows));
    const adoption = leftover
      ? await adoptOrphanSheet(graph, item, leftover, deal.ticker)
      : null;

    if (adoption && !adoption.ok && adoption.adoptable) {
      // It IS ours and unfinished, and finishing it failed. Reported rather than
      // worked around: a second tab would be the thing this branch exists to
      // prevent, and the queue will offer the deal again.
      return {
        ok: false,
        sheet: leftover ?? undefined,
        error: adoption.error,
        hint: adoption.hint,
        notes: adoption.notes,
      };
    }

    // Whatever the adoption declined to do has to travel with the deal that gets
    // written instead. Both shapes are carried: the "somebody has claimed it"
    // note, and — the case easy to drop — an error from not being able to READ
    // the leftover at all, which otherwise disappears entirely and leaves a
    // second tab with no explanation for why it exists.
    const carried =
      adoption && !adoption.ok
        ? (adoption.notes ?? []).concat(
            adoption.error
              ? [`The leftover "${leftover}" could not be inspected: ${adoption.error}`]
              : [],
          )
        : [];

    let sheet: string;
    let made: MadeSheet;

    if (adoption?.ok) {
      sheet = leftover as string;
      made = adoption;
      // The leftover sat wherever `worksheets/add` put it, which is the far end
      // of ~200 tabs — the position the desk stopped finding. Moved now for the
      // same reason a new tab is, and a failure to move stays a note.
      if (placement.before && placement.before !== sheet) {
        const moved = await graph(sheetPath(item, sheet), {
          method: "PATCH",
          body: { position: placement.position },
        });
        if (!moved.ok) {
          made.notes = [
            ...(made.notes ?? []),
            `"${sheet}" was finished where it stood — moving it to the front of the deal tabs failed: ${graphError(moved.body)}`,
          ];
        }
      }
    } else {
      const named = nextSheetName(deal.ticker, [...deals, ...NON_DEAL_SHEETS]);
      if (!named) {
        return {
          ok: false,
          error: `${deal.ticker.toUpperCase()} already has 26 tabs in this workbook.`,
          notes: carried.length > 0 ? carried : undefined,
        };
      }
      sheet = named;

      // ── The tab, before the row that points at it ─────────────────────────
      made = await createDealSheet(graph, item, sheet, placement);
      if (!made.ok) return { ...made, ok: false, notes: [...carried, ...(made.notes ?? [])] };
    }

    const notes = [...carried, ...(made.notes ?? [])];

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

    // ── Last: make it look like Template ────────────────────────────────────
    // The deal is filed as of the line above. Everything from here is shading,
    // which is why it runs after the row rather than with the rest of the tab —
    // see the header. A copied tab already carries it and skips this entirely.
    //
    // An adopted tab needs this as much as a replayed one, and for the same
    // reason it was adopted: the run that created it was killed before the
    // shading, which is exactly why the leftover reads as a plain grid of
    // `#DIV/0!` with no bands, no yellow input cells and default column widths.
    if ((made.via === "replay" || made.via === "adopted") && made.shape) {
      notes.push(
        ...(await dressSheetLikeTemplate(
          graph,
          item,
          TEMPLATE_SHEET,
          sheet,
          made.shape,
          sessionId,
        )),
      );
    }

    return {
      ok: true,
      sheet,
      overviewRow: slot.row,
      counter: slot.counter,
      via: made.via,
      ...(notes.length > 0 ? { notes } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "The tracker write failed.",
    };
  } finally {
    // Every return above lands here, including the early "already there" one.
    await closeSession();
  }
}
