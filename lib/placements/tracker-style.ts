import type { GraphCall } from "./tracker-writer.ts";

/**
 * Making a rebuilt deal tab LOOK like Template.
 *
 * ── Why this file has to exist ───────────────────────────────────────────────
 * There is no worksheet copy in the Excel REST API. Not "not on this tenant" —
 * not in the API. `/workbook/worksheets/{id}/copy` is an Office.js method; the
 * Graph reference has `add`, `get`, `update` and `delete` and nothing else, in
 * v1.0 and in beta alike. So the 400 this code once read as a tenant quirk is
 * the permanent answer, every new tab is rebuilt, and "rebuilt" used to mean
 * formulas and number formats on a blank white sheet.
 *
 * That is the bug the desk sees: `Template` is black header bands with white
 * type and yellow cells carrying the "ONLY EDIT FIELDS HIGHLIGHTED IN YELLOW"
 * convention, and a new placement arrived as an unshaded grid where nothing
 * says which cells a person is meant to type in.
 *
 * ── Reading formatting one rectangle at a time ───────────────────────────────
 * Graph will not hand back a cell-by-cell format grid the way it hands back
 * `formulas`. What it will do — and this is the lever — is answer a format read
 * over a RANGE with the value when every cell agrees and `null` when they do
 * not. So a range read is a uniformity test, and the template's formatting can
 * be recovered exactly by asking about the whole sheet, splitting whatever
 * comes back null, and asking again about the halves.
 *
 * Uniform blocks — a black header band, the yellow input block — are answered
 * whole, in one read each. Only the boundaries between them cost a split. On
 * Template's own shape that converges in a few dozen reads rather than the 480
 * a cell-by-cell walk would need, and the answer is READ rather than guessed:
 * nothing here has an opinion about which cells ought to be yellow.
 *
 * ── Two things keep it inside the cron's 60 seconds ──────────────────────────
 * `$batch`, which carries 20 of these reads per round trip, so a scan is ~5
 * requests rather than ~100; and a module-level cache, because Template does
 * not change between two deals in a run — the second placement of a morning
 * pays for the paint alone.
 *
 * A read budget bounds the pathological case. If Template were formatted so
 * finely that the splitting never resolved, the scan stops at the budget and
 * says so rather than spending the ingest's whole allowance on shading.
 *
 * ── What is carried, and what is not ─────────────────────────────────────────
 * Fills, fonts (name, size, colour, bold, italic, underline) and column widths.
 * Not borders — they are eight separately addressed edges per range, which is
 * the cost of the fills and fonts again several times over for the part of the
 * look nobody navigates by. Not validation or conditional formatting, which
 * have no range-level read at all.
 */

/** 1-based and inclusive, both ends — the way a spreadsheet counts. */
export type Rect = { r1: number; c1: number; r2: number; c2: number };

/** Graph's JSON batch takes 20 requests, and rejects the 21st. */
const BATCH_LIMIT = 20;

/**
 * How many format reads one scan may spend.
 *
 * ~240 is twelve batched round trips — a couple of seconds, against a 60s cron
 * that also has candidates to pull and rows to write. Template resolves in far
 * fewer; this is the ceiling for a template that never stops splitting, not the
 * expected cost.
 */
const DEFAULT_READ_BUDGET = 240;

/** Template's formatting is the same for every deal in a run, and most days. */
const PLAN_TTL_MS = 6 * 60 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* Addresses                                                           */
/* ------------------------------------------------------------------ */

/** 1 → `A`, 27 → `AA`. */
export function columnLetters(index: number): string {
  let out = "";
  for (let v = index; v > 0; v = Math.floor((v - 1) / 26)) {
    out = String.fromCharCode(65 + ((v - 1) % 26)) + out;
  }
  return out;
}

/** `A` → 1, `AA` → 27. */
export function columnIndex(letters: string): number {
  return [...letters.toUpperCase()].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0);
}

/**
 * `A1:P30` → the column letters it spans. Widths are a per-COLUMN property, so
 * this is what has to be walked; `null` for anything not shaped like a range,
 * which then simply skips the width replay rather than guessing at `A:XFD`.
 */
export function columnsOf(shape: string): string[] | null {
  const rect = rectOf(shape);
  if (!rect) return null;
  return Array.from({ length: rect.c2 - rect.c1 + 1 }, (_, i) => columnLetters(rect.c1 + i));
}

/** `A1:P30` (or a bare `A1`) → the rectangle it names. */
export function rectOf(shape: string): Rect | null {
  const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i.exec(shape.trim());
  if (!m) return null;

  const c1 = columnIndex(m[1]);
  const r1 = Number(m[2]);
  const c2 = m[3] ? columnIndex(m[3]) : c1;
  const r2 = m[4] ? Number(m[4]) : r1;
  if (c2 < c1 || r2 < r1) return null;

  return { r1, c1, r2, c2 };
}

export function addressOf(rect: Rect): string {
  return `${columnLetters(rect.c1)}${rect.r1}:${columnLetters(rect.c2)}${rect.r2}`;
}

/**
 * Halve a rectangle that came back non-uniform.
 *
 * ROWS first, always. A spreadsheet is formatted in bands — a black header row,
 * a grey total row — and cutting across the rows finds those whole, where
 * cutting down the columns would slice every one of them in half and double the
 * reads. Null for a single cell, which is where the splitting stops: one cell
 * is uniform by definition, so a null there is "no fill", not "ask again".
 */
export function splitRect(rect: Rect): [Rect, Rect] | null {
  if (rect.r2 > rect.r1) {
    const mid = rect.r1 + Math.floor((rect.r2 - rect.r1) / 2);
    return [
      { ...rect, r2: mid },
      { ...rect, r1: mid + 1 },
    ];
  }
  if (rect.c2 > rect.c1) {
    const mid = rect.c1 + Math.floor((rect.c2 - rect.c1) / 2);
    return [
      { ...rect, c2: mid },
      { ...rect, c1: mid + 1 },
    ];
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Regions                                                             */
/* ------------------------------------------------------------------ */

export type Region<T> = { rect: Rect; value: T };

/**
 * Glue the split back together where it did not need to happen.
 *
 * The scan halves a rectangle the moment any cell in it disagrees, so a yellow
 * block straddling a cut comes back as two regions that are really one. Every
 * pair merged here is one PATCH the paint does not send, and the cut points are
 * arbitrary, so there are always some.
 */
export function mergeRegions<T>(regions: Region<T>[]): Region<T>[] {
  const out = regions.slice();
  const same = (a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);

  for (let merged = true; merged; ) {
    merged = false;

    outer: for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i].rect;
        const b = out[j].rect;
        if (!same(out[i].value, out[j].value)) continue;

        const stacked = a.c1 === b.c1 && a.c2 === b.c2 && (a.r2 + 1 === b.r1 || b.r2 + 1 === a.r1);
        const beside = a.r1 === b.r1 && a.r2 === b.r2 && (a.c2 + 1 === b.c1 || b.c2 + 1 === a.c1);
        if (!stacked && !beside) continue;

        out[i] = {
          value: out[i].value,
          rect: {
            r1: Math.min(a.r1, b.r1),
            c1: Math.min(a.c1, b.c1),
            r2: Math.max(a.r2, b.r2),
            c2: Math.max(a.c2, b.c2),
          },
        };
        out.splice(j, 1);
        merged = true;
        break outer;
      }
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Batched Graph                                                       */
/* ------------------------------------------------------------------ */

type InnerRequest = { id: string; method: string; url: string; body?: unknown };
type InnerResponse = { status: number; body: unknown };

/**
 * Twenty requests per round trip, answered by id.
 *
 * The session id is repeated on every inner request. A batch is one HTTP call
 * carrying twenty independent ones, and there is nothing in the outer envelope
 * that makes its headers theirs.
 *
 * A `$batch` that refuses outright falls through to sending the requests one at
 * a time. Slower, and it only matters on a tenant that has switched batching
 * off — but the alternative is a tab that stays white because of the transport.
 */
async function runBatch(
  graph: GraphCall,
  requests: InnerRequest[],
  sessionId?: string | null,
): Promise<Map<string, InnerResponse>> {
  const answers = new Map<string, InnerResponse>();
  const headers = (hasBody: boolean) => ({
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
    ...(sessionId ? { "workbook-session-id": sessionId } : {}),
  });

  for (let from = 0; from < requests.length; from += BATCH_LIMIT) {
    const chunk = requests.slice(from, from + BATCH_LIMIT);

    const res = await graph("/$batch", {
      method: "POST",
      body: {
        requests: chunk.map((r) => ({
          id: r.id,
          method: r.method,
          url: r.url,
          headers: headers(r.body !== undefined),
          ...(r.body === undefined ? {} : { body: r.body }),
        })),
      },
    });

    if (!res.ok) {
      for (const r of chunk) {
        const one = await graph(r.url, { method: r.method, body: r.body });
        answers.set(r.id, { status: one.status, body: one.body });
      }
      continue;
    }

    const responses =
      (res.body as { responses?: { id?: string; status?: number; body?: unknown }[] } | null)
        ?.responses ?? [];

    for (const r of responses) {
      if (r.id != null) answers.set(String(r.id), { status: r.status ?? 500, body: r.body ?? null });
    }
    // Graph answers out of order and, on a malformed batch, may not answer at
    // all. An unanswered read is a non-uniform one: it splits rather than
    // painting the whole sheet whatever the last cell happened to be.
    for (const r of chunk) if (!answers.has(r.id)) answers.set(r.id, { status: 500, body: null });
  }

  return answers;
}

const ok = (r: InnerResponse | undefined) => !!r && r.status >= 200 && r.status < 300;

/* ------------------------------------------------------------------ */
/* The scan                                                            */
/* ------------------------------------------------------------------ */

/**
 * Every rectangle of `root` that is uniform in one formatting property.
 *
 * Breadth-first so that each round is a batch: the rectangles waiting to be
 * asked about are all independent of each other, which is exactly the shape
 * `$batch` wants. A rectangle that answers with a value is a region; one that
 * answers null is halved and both halves rejoin the queue.
 */
async function scanUniform<T>(
  graph: GraphCall,
  root: Rect,
  urlFor: (address: string) => string,
  readValue: (body: unknown) => T | null,
  budget: { left: number },
  sessionId?: string | null,
): Promise<{ regions: Region<T>[]; truncated: boolean }> {
  const regions: Region<T>[] = [];
  let queue: Rect[] = [root];
  let truncated = false;

  while (queue.length > 0) {
    if (budget.left <= 0) {
      truncated = true;
      break;
    }

    const asking = queue.slice(0, Math.min(BATCH_LIMIT, budget.left));
    queue = queue.slice(asking.length);
    budget.left -= asking.length;

    const answers = await runBatch(
      graph,
      asking.map((rect, i) => ({ id: String(i), method: "GET", url: urlFor(addressOf(rect)) })),
      sessionId,
    );

    asking.forEach((rect, i) => {
      const answer = answers.get(String(i));
      const value = ok(answer) ? readValue(answer!.body) : null;
      if (value !== null) {
        regions.push({ rect, value });
        return;
      }
      const halves = splitRect(rect);
      if (halves) queue.push(...halves);
    });
  }

  return { regions: mergeRegions(regions), truncated };
}

/* ------------------------------------------------------------------ */
/* What a tab has to look like                                         */
/* ------------------------------------------------------------------ */

export type TemplateFont = {
  name: string;
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
  underline: string;
};

export type TemplatePlan = {
  /** Template's used range, as the local address the new tab shares. */
  shape: string;
  widths: { column: string; columnWidth: number }[];
  fills: Region<string>[];
  fonts: Region<TemplateFont>[];
  /** The scan ran out of budget: what is here is right, but incomplete. */
  truncated: boolean;
};

/** `#FFFF00`, or null where the cells disagree — which is the whole signal. */
function readFill(body: unknown): string | null {
  const color = (body as { color?: unknown } | null)?.color;
  return typeof color === "string" && color.trim() !== "" ? color : null;
}

/**
 * Graph cannot tell an unfilled cell from a white-filled one — both read
 * `#FFFFFF` — and the two do not look the same: a fill of any colour, white
 * included, hides the gridlines under it.
 *
 * A new sheet starts unfilled, which is the commoner of the two, so white is
 * left alone rather than painted. The template's plain area keeps its gridlines,
 * and the only thing given up is a genuinely white-filled block showing
 * gridlines it should not — a far smaller wrong than a tab with no grid on it at
 * all. It also drops the single largest region on most templates, which is a
 * write's worth of budget for nothing.
 */
const isDefaultFill = (color: string) => /^#?fff(fff)?$/i.test(color.trim());

/**
 * A font is uniform only when EVERY part of it is.
 *
 * Graph nulls each property separately, so a black band of white bold type over
 * white cells of black regular type answers `{name: "Calibri", size: 11, color:
 * null, bold: null}`. Accepting that would paint one of the two everywhere; the
 * rectangle is split instead, and both come back whole a level down.
 */
function readFont(body: unknown): TemplateFont | null {
  const f = body as Partial<TemplateFont> | null;
  if (!f) return null;

  const { name, size, color, bold, italic, underline } = f;
  if (
    typeof name !== "string" ||
    typeof size !== "number" ||
    typeof color !== "string" ||
    typeof bold !== "boolean" ||
    typeof italic !== "boolean" ||
    typeof underline !== "string"
  ) {
    return null;
  }

  return { name, size, color, bold, italic, underline };
}

const sheetPath = (item: string, name: string) =>
  `${item}/worksheets('${encodeURIComponent(name)}')`;

const rangePath = (item: string, sheet: string, address: string) =>
  `${sheetPath(item, sheet)}/range(address='${address}')`;

/** Template does not change between two deals in a run, or most weeks. */
const planCache = new Map<string, { at: number; plan: TemplatePlan }>();

/** Exposed for the tests, which must not inherit a plan from the case before. */
export function clearTemplatePlanCache(): void {
  planCache.clear();
}

/**
 * Everything a new tab needs to look like Template, read from Template.
 *
 * Cached against the workbook and the shape: the first placement of a run pays
 * for the scan, the rest of that morning's deals pay for the paint alone.
 */
export async function readTemplatePlan(
  graph: GraphCall,
  item: string,
  templateSheet: string,
  shape: string,
  opts: { sessionId?: string | null; budget?: number } = {},
): Promise<TemplatePlan | null> {
  const root = rectOf(shape);
  if (!root) return null;

  const key = `${item}|${templateSheet}|${shape}`;
  const hit = planCache.get(key);
  if (hit && Date.now() - hit.at < PLAN_TTL_MS) return hit.plan;

  const sessionId = opts.sessionId ?? null;
  const budget = { left: opts.budget ?? DEFAULT_READ_BUDGET };

  // Widths are a per-column property and cannot be read from a rectangle, so
  // they are their own pass — but one batch of them, not one call each.
  const columns = columnsOf(shape) ?? [];
  const widthAnswers = await runBatch(
    graph,
    columns.map((column) => ({
      id: column,
      method: "GET",
      url: `${rangePath(item, templateSheet, `${column}1:${column}1`)}/format?$select=columnWidth`,
    })),
    sessionId,
  );

  const widths: { column: string; columnWidth: number }[] = [];
  for (const column of columns) {
    const answer = widthAnswers.get(column);
    const width = ok(answer) ? (answer!.body as { columnWidth?: unknown }).columnWidth : undefined;
    if (typeof width === "number") widths.push({ column, columnWidth: width });
  }

  const fill = await scanUniform(
    graph,
    root,
    (address) => `${rangePath(item, templateSheet, address)}/format/fill?$select=color`,
    readFill,
    budget,
    sessionId,
  );

  const font = await scanUniform(
    graph,
    root,
    (address) => `${rangePath(item, templateSheet, address)}/format/font`,
    readFont,
    budget,
    sessionId,
  );

  const plan: TemplatePlan = {
    shape,
    widths,
    fills: fill.regions.filter((r) => !isDefaultFill(r.value)),
    fonts: font.regions,
    truncated: fill.truncated || font.truncated,
  };

  planCache.set(key, { at: Date.now(), plan });
  return plan;
}

/**
 * Paint one plan onto a tab.
 *
 * Never fatal, and deliberately called after the deal is already filed: every
 * failure in here is cosmetic, and a tab that is shaded wrong is a far smaller
 * problem than a deal that is not in the workbook. Failures are counted rather
 * than returned one by one — twenty identical "protected sheet" lines in an
 * ingest log hide the one that says what to do.
 */
export async function paintSheetLikeTemplate(
  graph: GraphCall,
  item: string,
  sheet: string,
  plan: TemplatePlan,
  sessionId?: string | null,
): Promise<string[]> {
  const notes: string[] = [];

  const requests: InnerRequest[] = [
    ...plan.widths.map((w) => ({
      id: `width:${w.column}`,
      method: "PATCH",
      url: `${rangePath(item, sheet, `${w.column}1:${w.column}1`)}/format`,
      body: { columnWidth: w.columnWidth },
    })),
    ...plan.fills.map((f, i) => ({
      id: `fill:${i}`,
      method: "PATCH",
      url: `${rangePath(item, sheet, addressOf(f.rect))}/format/fill`,
      body: { color: f.value },
    })),
    ...plan.fonts.map((f, i) => ({
      id: `font:${i}`,
      method: "PATCH",
      url: `${rangePath(item, sheet, addressOf(f.rect))}/format/font`,
      body: f.value,
    })),
  ];

  const answers = await runBatch(graph, requests, sessionId);

  const failed = { width: 0, fill: 0, font: 0 };
  const total = { width: plan.widths.length, fill: plan.fills.length, font: plan.fonts.length };
  for (const r of requests) {
    if (ok(answers.get(r.id))) continue;
    failed[r.id.split(":")[0] as keyof typeof failed]++;
  }

  if (failed.width > 0) {
    notes.push(
      `${failed.width} of ${total.width} column widths on "${sheet}" did not copy across; the tab computes but is narrower than Template.`,
    );
  }
  if (failed.fill > 0 || failed.font > 0) {
    notes.push(
      `${failed.fill + failed.font} of ${total.fill + total.font} formatting writes on "${sheet}" ` +
        `were refused, so parts of it are not shaded like Template.`,
    );
  }
  if (plan.truncated) {
    notes.push(
      `Template's formatting was only partly readable within the scan budget, so "${sheet}" ` +
        `carries most of its shading rather than all of it.`,
    );
  }

  return notes;
}

/**
 * Read Template's look, then wear it — the one call the writer makes.
 *
 * Returns notes, never an error: by the time this runs the deal is in the
 * workbook and on the Overview, and nothing about shading is worth reporting as
 * a failed write.
 */
export async function dressSheetLikeTemplate(
  graph: GraphCall,
  item: string,
  templateSheet: string,
  sheet: string,
  shape: string,
  sessionId?: string | null,
): Promise<string[]> {
  try {
    const plan = await readTemplatePlan(graph, item, templateSheet, shape, { sessionId });
    if (!plan) return [];
    return await paintSheetLikeTemplate(graph, item, sheet, plan, sessionId);
  } catch (err) {
    return [
      `"${sheet}" was filed but could not be formatted like ${templateSheet}: ` +
        `${err instanceof Error ? err.message : "the format replay failed"}.`,
    ];
  }
}
