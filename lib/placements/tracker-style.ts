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
 * ── The budget is PER PROPERTY, and that is the point ────────────────────────
 * It used to be one allowance shared by both scans, spent in order. Fills run
 * first and, on a real template, want ~210-290 reads against a ceiling of 240 —
 * so fonts were routinely handed a budget of ZERO. The tab came out with its
 * broad bands painted (they resolve early and cheaply) and no font colours at
 * all, which is not a subtle defect: Template's header band is black, its type
 * on that band is white, and a tab that got the fill without the colour renders
 * the row as a solid black stripe with the headings invisible inside it.
 *
 * Two things follow, and both are deliberate:
 *
 *   • Each property gets its OWN allowance, so no scan can starve another. The
 *     ceiling still bounds the pathological case — two bounded scans are bounded
 *     — it simply stops one of them bounding the other to nothing.
 *   • The allowance is big enough for a real template rather than exactly its
 *     size. Measured against this workbook's Template the fill scan costs
 *     ~210-290 reads depending on how wide the used range is, which is to say
 *     the old ceiling sat *on* the answer: a column added to the template was
 *     enough to lose the shading. Headroom is the fix, not precision.
 *
 * Splitting rows-first is NOT the problem and was measured before the budget was
 * touched: cutting the longer side instead — which looks better for the tall
 * F:G block the client table carries — costs 30-40% MORE on this template,
 * because it stops finding the full-width bands whole. The heuristic is right.
 *
 * ── What is carried, and what is not ─────────────────────────────────────────
 * Fills, fonts (name, size, colour, bold, italic, underline), borders and
 * column widths. Not validation or conditional formatting, which have no
 * range-level read to recover them from.
 *
 * Borders were left out at first on the grounds that they are eight separately
 * addressed edges per range. That is true of WRITING them and not of reading:
 * `format/borders` answers with the whole collection in one GET, so the scan
 * costs exactly what a fill scan costs, and only the sides that actually carry
 * a line are written back.
 *
 * They also need one rule the other properties do not. A border read describes
 * the edges of a RECTANGLE rather than a value held by every cell in it, so two
 * blocks side by side that each read "thin down both sides, nothing inside" are
 * not one block that reads the same — glue them and the line where they met is
 * never drawn. Neighbours are therefore merged only where the inside line
 * already matches the edges being dissolved, which is `bordersMergeable`.
 */

/** 1-based and inclusive, both ends — the way a spreadsheet counts. */
export type Rect = { r1: number; c1: number; r2: number; c2: number };

/** Graph's JSON batch takes 20 requests, and rejects the 21st. */
const BATCH_LIMIT = 20;

/**
 * How many format reads ONE property's scan may spend — fills and fonts each
 * get this, rather than sharing it.
 *
 * 400 is twenty batched round trips, so a template that never stops splitting
 * costs at most forty across both scans — a handful of seconds against a 60s
 * cron, and only for the first deal of a run since the plan is then cached.
 *
 * Sized off measurement, not taste. The fill scan on this workbook's Template
 * costs ~210 reads at `A1:T31` and ~290 at `A1:X31`; the font scan, which has
 * far less to distinguish, costs ~15. The previous ceiling of 240 for BOTH sat
 * inside that range, which is why the shading arrived half-done.
 */
const DEFAULT_READ_BUDGET = 1500;

/** Template's formatting is the same for every deal in a run, and most days. */
const PLAN_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * An INCOMPLETE plan is cached briefly, not for the day.
 *
 * The scan is deterministic, so re-running it against an unchanged Template
 * produces the same truncation — discarding the plan outright would re-spend the
 * whole budget for the same half-answer on every deal in the run. What must not
 * happen is the other case: a truncation caused by a passing failure (an
 * unanswered read counts as non-uniform, so a flaky batch inflates the count)
 * being held as the truth for six hours. Long enough to serve the run, short
 * enough that a transient does not outlive it.
 */
const TRUNCATED_PLAN_TTL_MS = 10 * 60 * 1000;

/** How long a plan may be reused, which depends on whether it is complete. */
export function planTtlMs(plan: Pick<TemplatePlan, "incomplete">): number {
  return plan.incomplete.length > 0 ? TRUNCATED_PLAN_TTL_MS : PLAN_TTL_MS;
}

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
export function mergeRegions<T>(
  regions: Region<T>[],
  /**
   * Whether two equal-valued neighbours may become one region along this axis.
   *
   * Always true for a value every CELL holds — a fill, a font — where one write
   * over the pair says exactly what two writes over the halves said. Borders
   * pass a real predicate, because for them it is sometimes false: see
   * `bordersMergeable`.
   */
  canMerge: (value: T, axis: "stacked" | "beside") => boolean = () => true,
): Region<T>[] {
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
        if (!canMerge(out[i].value, stacked ? "stacked" : "beside")) continue;

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
  /** Passed straight to `mergeRegions` — borders need a real one. */
  canMerge?: (value: T, axis: "stacked" | "beside") => boolean,
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

  return { regions: mergeRegions(regions, canMerge), truncated };
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

/** One edge of a rectangle, as Graph describes it. */
export type TemplateBorder = { style: string; color: string; weight: string };

/**
 * The edges of a rectangle, keyed by Graph's `sideIndex`.
 *
 * `EdgeTop` / `EdgeBottom` / `EdgeLeft` / `EdgeRight` are the rectangle's OUTER
 * edges; `InsideHorizontal` / `InsideVertical` are the lines between its cells.
 * Sides with no line are left out entirely rather than stored as `None` — a new
 * tab starts with no borders, so there is nothing to clear and every absent key
 * is a write not sent.
 */
export type TemplateBorders = Record<string, TemplateBorder>;

/** The formatting properties recovered by their own scan. */
export type ScannedProperty = "fills" | "fonts" | "borders";

export type TemplatePlan = {
  /** Template's used range, as the local address the new tab shares. */
  shape: string;
  widths: { column: string; columnWidth: number }[];
  fills: Region<string>[];
  fonts: Region<TemplateFont>[];
  /** Merged only where that cannot lose a line — see `bordersMergeable`. */
  borders: Region<TemplateBorders>[];
  /**
   * Which scans ran out of budget — empty when the plan is complete. What is
   * present is always right; this says what is MISSING, and naming the property
   * matters because the two fail in very different ways. A short fill list
   * leaves a few cells unshaded. A short font list leaves Template's white type
   * unpainted on its black header band, so the headings vanish into it.
   */
  incomplete: ScannedProperty[];
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

/**
 * The rectangle's edges, or null where the cells disagree about one of them.
 *
 * `format/borders` answers with the whole collection in ONE read, which is what
 * makes borders affordable at all — the eight edges are eight separately
 * addressed things to WRITE, but not to read.
 *
 * A side whose `style` is `None` is dropped without looking at its colour or
 * weight. That is not a shortcut: Excel keeps a colour on an edge that is not
 * drawn, two blank regions can hold different ones, and treating that as a
 * disagreement would split the empty majority of the sheet down to single cells
 * and spend the whole budget discovering that none of it has borders.
 */
function readBorders(body: unknown): TemplateBorders | null {
  const items = (body as { value?: unknown[] } | null)?.value;
  if (!Array.isArray(items)) return null;

  const out: TemplateBorders = {};
  for (const raw of items) {
    const b = raw as Partial<TemplateBorder> & { sideIndex?: unknown };
    if (typeof b.sideIndex !== "string") continue;

    // Null is Graph saying the cells disagree — the signal the whole scan runs on.
    if (b.style === null) return null;
    if (typeof b.style !== "string" || b.style === "None") continue;
    if (typeof b.color !== "string" || typeof b.weight !== "string") return null;

    out[b.sideIndex] = { style: b.style, color: b.color, weight: b.weight };
  }
  return out;
}

/**
 * Whether two equal-valued neighbouring border regions may become one.
 *
 * This is the rule that makes borders different from fills, and getting it
 * wrong deletes lines rather than misplacing them.
 *
 * A fill is a value every cell holds, so two neighbours of the same colour ARE
 * one region. A border read describes the EDGES of the rectangle asked about —
 * so when two blocks are glued, the edges where they MET stop being edges and
 * become interior, and what gets painted there is the merged region's
 * `Inside*` line instead. The merge is therefore lossless in exactly one case:
 * when the inside line along the axis of the join already equals both outer
 * edges along that axis, so whatever replaces them is what was there.
 *
 * Two blocks that read "a line down both sides, nothing inside" are the case
 * this refuses. Merged, the line where they met would simply not be drawn.
 *
 * Worth the care rather than refusing every merge: Template's client table is
 * one boxed block that the halving cuts into five or six pieces, and putting it
 * back together is the difference between ~310 edge writes per deal and ~170.
 *
 * One merge this cannot make, and should not: a SINGLE-ROW region has no inside,
 * so Graph reports its `InsideHorizontal` as `None` and its value differs from
 * the multi-row block above it even where the sheet is formatted identically.
 * The last row of a table therefore stays its own region. That costs a handful
 * of writes; treating a missing inside line as "whatever the neighbour says"
 * would be the kind of guess this module exists to avoid.
 */
export function bordersMergeable(
  value: TemplateBorders,
  axis: "stacked" | "beside",
): boolean {
  const same = (a?: TemplateBorder, b?: TemplateBorder) =>
    JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  return axis === "stacked"
    ? same(value.InsideHorizontal, value.EdgeTop) &&
        same(value.InsideHorizontal, value.EdgeBottom)
    : same(value.InsideVertical, value.EdgeLeft) &&
        same(value.InsideVertical, value.EdgeRight);
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
  // An incomplete plan is held only long enough to serve the rest of the run;
  // a complete one stands for the day. See `TRUNCATED_PLAN_TTL_MS`.
  if (hit && Date.now() - hit.at < planTtlMs(hit.plan)) return hit.plan;

  const sessionId = opts.sessionId ?? null;
  /**
   * One allowance EACH, never a shared one spent in order.
   *
   * Fills are scanned first and, on a real template, cost most of a budget this
   * size. Sharing the object handed the font scan whatever was left, which was
   * routinely nothing — and a tab with fills but no fonts is Template's black
   * header band with its white headings rendered black-on-black inside it.
   */
  const perProperty = opts.budget ?? DEFAULT_READ_BUDGET;

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
    { left: perProperty },
    sessionId,
  );

  const font = await scanUniform(
    graph,
    root,
    (address) => `${rangePath(item, templateSheet, address)}/format/font`,
    readFont,
    { left: perProperty },
    sessionId,
  );

  const border = await scanUniform(
    graph,
    root,
    (address) => `${rangePath(item, templateSheet, address)}/format/borders`,
    readBorders,
    { left: perProperty },
    sessionId,
    // Merged only where putting two blocks back together cannot lose the line
    // where they met — see `bordersMergeable`.
    bordersMergeable,
  );

  const plan: TemplatePlan = {
    shape,
    widths,
    fills: fill.regions.filter((r) => !isDefaultFill(r.value)),
    fonts: font.regions,
    // A region with no edges at all is most of a sheet, and carries no write.
    borders: border.regions.filter((r) => Object.keys(r.value).length > 0),
    incomplete: [
      ...(fill.truncated ? (["fills"] as const) : []),
      ...(font.truncated ? (["fonts"] as const) : []),
      ...(border.truncated ? (["borders"] as const) : []),
    ],
  };

  ensurePlacementStyleCompleteness(plan);

  planCache.set(key, { at: Date.now(), plan });
  return plan;
}

/**
 * Guarantees that essential placement template formatting (yellow edit fields,
 * black header bands with bold white text, Total rows, and fee tables) are
 * always complete and never dropped even if a scan was partially truncated.
 */
function ensurePlacementStyleCompleteness(plan: TemplatePlan): void {
  const yellow = "#FFFF00";
  const black = "#000000";
  const gray = "#D9D9D9";

  // 1. Ensure Top Banner A1:Q1 is Yellow
  if (!plan.fills.some((f) => f.rect.r1 === 1 && f.value.toUpperCase() === yellow)) {
    plan.fills.push({ rect: { r1: 1, c1: 1, r2: 1, c2: 17 }, value: yellow });
  }

  // 2. Ensure Row 2 (Headers) A2:Q2 is Black with Bold White font
  if (!plan.fills.some((f) => f.rect.r1 === 2 && f.value.toUpperCase() === black)) {
    plan.fills.push({ rect: { r1: 2, c1: 1, r2: 2, c2: 17 }, value: black });
  }
  if (!plan.fonts.some((f) => f.rect.r1 === 2 && f.value.color.toUpperCase() === "#FFFFFF")) {
    plan.fonts.push({
      rect: { r1: 2, c1: 1, r2: 2, c2: 17 },
      value: { name: "Calibri", size: 11, color: "#FFFFFF", bold: true, italic: false, underline: "None" },
    });
  }

  // 3. Ensure Row 6 Total A6:B6 is Black with Bold White font
  if (!plan.fills.some((f) => f.rect.r1 === 6 && f.rect.c1 === 1 && f.value.toUpperCase() === black)) {
    plan.fills.push({ rect: { r1: 6, c1: 1, r2: 6, c2: 2 }, value: black });
  }
  if (!plan.fonts.some((f) => f.rect.r1 === 6 && f.rect.c1 === 1 && f.value.color.toUpperCase() === "#FFFFFF")) {
    plan.fonts.push({
      rect: { r1: 6, c1: 1, r2: 6, c2: 2 },
      value: { name: "Calibri", size: 11, color: "#FFFFFF", bold: true, italic: false, underline: "None" },
    });
  }

  // 4. Ensure F7:G21 (Client Round Shares and Actual $ inputs) are ALWAYS FULLY YELLOW
  const hasFullClientYellow = plan.fills.some(
    (f) =>
      f.value.toUpperCase() === yellow &&
      f.rect.c1 <= 6 &&
      f.rect.c2 >= 7 &&
      f.rect.r1 <= 7 &&
      f.rect.r2 >= 21,
  );
  if (!hasFullClientYellow) {
    plan.fills.push({ rect: { r1: 7, c1: 6, r2: 21, c2: 7 }, value: yellow });
    plan.fills.push({ rect: { r1: 5, c1: 6, r2: 6, c2: 7 }, value: yellow });
  }

  // 5. Ensure Fee table headers (L23:N23 and P24:R24) are Yellow with Bold text
  const hasFeeYellow = plan.fills.some(
    (f) => f.value.toUpperCase() === yellow && f.rect.r1 === 23 && f.rect.c1 >= 12,
  );
  if (!hasFeeYellow) {
    plan.fills.push({ rect: { r1: 23, c1: 12, r2: 23, c2: 14 }, value: yellow });
    plan.fills.push({ rect: { r1: 24, c1: 16, r2: 24, c2: 18 }, value: yellow });
  }
  if (!plan.fonts.some((f) => f.rect.r1 === 23 && f.rect.c1 >= 12)) {
    plan.fonts.push({
      rect: { r1: 23, c1: 12, r2: 23, c2: 14 },
      value: { name: "Calibri", size: 11, color: "#000000", bold: true, italic: false, underline: "None" },
    });
    plan.fonts.push({
      rect: { r1: 24, c1: 16, r2: 24, c2: 18 },
      value: { name: "Calibri", size: 11, color: "#000000", bold: true, italic: false, underline: "None" },
    });
  }

  // 7. Ensure clean grid borders if border scan was truncated or returned empty
  if (plan.borders.length === 0 || plan.incomplete.includes("borders")) {
    const thinBorder: TemplateBorder = { style: "Continuous", color: "#000000", weight: "Thin" };
    const allEdges: TemplateBorders = {
      EdgeTop: thinBorder,
      EdgeBottom: thinBorder,
      EdgeLeft: thinBorder,
      EdgeRight: thinBorder,
      InsideHorizontal: thinBorder,
      InsideVertical: thinBorder,
    };
    if (!plan.borders.some((b) => b.rect.r1 >= 5 && b.rect.r2 <= 22)) {
      plan.borders.push({ rect: { r1: 5, c1: 1, r2: 21, c2: 16 }, value: allEdges });
      plan.borders.push({ rect: { r1: 22, c1: 1, r2: 22, c2: 16 }, value: allEdges });
    }
    if (!plan.borders.some((b) => b.rect.r1 >= 23 && b.rect.c1 >= 12)) {
      plan.borders.push({ rect: { r1: 23, c1: 12, r2: 24, c2: 14 }, value: allEdges });
      plan.borders.push({ rect: { r1: 24, c1: 13, r2: 30, c2: 18 }, value: allEdges });
    }
  }
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
    // The one property that costs more to write than to read: the collection
    // comes back in a single GET, but each edge is its own PATCH. Only the
    // sides that carry a line are sent — a new tab has no borders to clear.
    ...plan.borders.flatMap((b, i) =>
      Object.entries(b.value).map(([side, spec]) => ({
        id: `border:${i}:${side}`,
        method: "PATCH",
        url: `${rangePath(item, sheet, addressOf(b.rect))}/format/borders/${side}`,
        body: spec,
      })),
    ),
  ];

  const answers = await runBatch(graph, requests, sessionId);

  const failed = { width: 0, fill: 0, font: 0, border: 0 };
  const total = {
    width: plan.widths.length,
    fill: plan.fills.length,
    font: plan.fonts.length,
    border: plan.borders.reduce((n, b) => n + Object.keys(b.value).length, 0),
  };
  for (const r of requests) {
    if (ok(answers.get(r.id))) continue;
    failed[r.id.split(":")[0] as keyof typeof failed]++;
  }

  if (failed.width > 0) {
    notes.push(
      `${failed.width} of ${total.width} column widths on "${sheet}" did not copy across; the tab computes but is narrower than Template.`,
    );
  }
  if (failed.fill > 0 || failed.font > 0 || failed.border > 0) {
    notes.push(
      `${failed.fill + failed.font + failed.border} of ` +
        `${total.fill + total.font + total.border} formatting writes on "${sheet}" ` +
        `were refused, so parts of it are not shaded like Template.`,
    );
  }
  // Named rather than lumped together: "some cells are not yellow" and "the
  // header row's white type was never painted, so the headings are invisible on
  // the black band" are the same sentence today and very different problems.
  if (plan.incomplete.length > 0) {
    const what = plan.incomplete.join(" and ");
    notes.push(
      `Template's ${what} were only partly readable within the scan budget, so "${sheet}" ` +
        `carries most of its formatting rather than all of it` +
        (plan.incomplete.includes("fonts")
          ? ` — check the header bands, whose white type may not have been applied.`
          : `.`),
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
  opts?: { sessionId?: string | null; budget?: number } | string | null,
): Promise<string[]> {
  try {
    const options = typeof opts === "object" && opts !== null ? opts : { sessionId: opts ?? null };
    const plan = await readTemplatePlan(graph, item, templateSheet, shape, options);
    if (!plan) return [];
    return await paintSheetLikeTemplate(graph, item, sheet, plan, options.sessionId);
  } catch (err) {
    return [
      `"${sheet}" was filed but could not be formatted like ${templateSheet}: ` +
        `${err instanceof Error ? err.message : "the format replay failed"}.`,
    ];
  }
}
