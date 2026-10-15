import { deskDate } from "../asx/session.ts";
import { OVERVIEW_FIRST_DATA_ROW } from "./tracker-format.ts";
import type { GraphCall, TrackerTarget } from "./tracker-writer.ts";

/**
 * Price Rise: each deal's opening price today against its Issue Price, written
 * into the Overview's Price Rise column (M) as `$0.0090 (+28.57%)`.
 *
 * ── When ────────────────────────────────────────────────────────────────────
 * Once a trading day at 12pm Sydney, from the existing `alert-live-tick` job
 * (`/api/alerts/live`) rather than a cron of its own — see `priceRiseDue`. By
 * noon the market has been open two hours, so every code that is going to
 * trade at all usually has.
 *
 * ── Which rows ──────────────────────────────────────────────────────────────
 * Every Overview row with a listed ASX code and an Issue Price. Private deals
 * (named in full, like `Yatima`) and rows whose Issue Price is blank or an
 * error are left alone.
 *
 * ── A code that has not traded today ────────────────────────────────────────
 * Yahoo keeps quoting the PREVIOUS session's open for a code with no trade
 * today, so an open is used only when the last trade printed today (Sydney).
 * Otherwise the cell keeps whatever it had — writing yesterday's open under
 * today's run would present a stale price as a fresh one.
 *
 * ── One write ───────────────────────────────────────────────────────────────
 * Column M is read as formulas and written back as one range, `M4:M<last>`.
 * Cells this run has nothing new for are written back exactly as they were, so
 * a value the desk typed by hand survives.
 *
 * Free of `server-only`, with Graph and the quote feed injected.
 */

/** The Overview's Price Rise column. */
export const PRICE_RISE_COLUMN = "M";

export type OpenQuote = { open: number | null; tradedAt: string | null };

export type PriceRiseDeps = {
  /** Today on the desk's clock, `YYYY-MM-DD`. */
  today: string;
  graph: GraphCall;
  target: TrackerTarget;
  /** Quotes for ASX codes, keyed by code. */
  quotes: (codes: string[]) => Promise<Map<string, OpenQuote>>;
};

export type PriceRiseReport = {
  rows: number;
  updated: number;
  /** Codes with no trade yet today — their cells were left as they were. */
  noTradeToday: string[];
  /** Codes Yahoo returned nothing for. */
  noQuote: string[];
  error?: string;
};

/**
 * A listed ASX code — the Overview also carries private deals named in full.
 * Matched as written, not uppercased: the tracker writes codes in capitals, and
 * `Yatima` uppercased would pass for a six-letter code.
 */
function asxCode(value: unknown): string | null {
  const code = String(value ?? "").trim();
  return /^[A-Z0-9]{3,6}$/.test(code) ? code : null;
}

function price(n: number): string {
  return `$${n >= 1 ? n.toFixed(2) : n.toFixed(4)}`;
}

/** `$0.0090 (+28.57%)` — the open, and how far it sits from the issue price. */
export function priceRiseText(issuePrice: number, open: number): string {
  const pct = ((open - issuePrice) / issuePrice) * 100;
  const sign = pct > 0 ? "+" : "";
  return `${price(open)} (${sign}${pct.toFixed(2)}%)`;
}

/** True when the trade behind a quote printed today on the Sydney clock. */
export function tradedToday(tradedAt: string | null, today: string): boolean {
  return tradedAt !== null && deskDate(new Date(tradedAt)) === today;
}

/**
 * When the run is due: the first 10-minute tick of 12pm Sydney, on an ASX
 * trading day. The caller passes `isTradingDay` so the exchange calendar stays
 * in `lib/asx/session.ts`.
 */
export function priceRiseDue(
  at: Date,
  isTradingDay: (date: string) => boolean,
): boolean {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-AU", {
      timeZone: "Australia/Sydney",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return Number(parts.hour) === 12 && Number(parts.minute) < 10 && isTradingDay(deskDate(at));
}

export async function runPriceRise(deps: PriceRiseDeps, lastRow = 400): Promise<PriceRiseReport> {
  const report: PriceRiseReport = { rows: 0, updated: 0, noTradeToday: [], noQuote: [] };
  const sheet = `/drives/${deps.target.driveId}/items/${deps.target.itemId}/workbook/worksheets('${encodeURIComponent(
    deps.target.overviewSheet,
  )}')`;
  const first = OVERVIEW_FIRST_DATA_ROW;

  // C (ticker) through M (Price Rise): values for the ticker and Issue Price,
  // formulas for M so whatever is there can be written back untouched.
  const read = await deps.graph(
    `${sheet}/range(address='C${first}:${PRICE_RISE_COLUMN}${lastRow}')?$select=values,formulas`,
  );
  if (!read.ok) {
    report.error = `Could not read ${deps.target.overviewSheet} (${read.status}).`;
    return report;
  }
  const body = read.body as { values?: unknown[][]; formulas?: unknown[][] } | null;
  const values = body?.values ?? [];
  const formulas = body?.formulas ?? [];

  // The data ends at the last row with a ticker; the rows below are scaffolding.
  let last = -1;
  values.forEach((row, i) => {
    if (String(row?.[0] ?? "").trim() !== "") last = i;
  });
  if (last === -1) return report;

  const rows = values.slice(0, last + 1).map((row, i) => ({
    code: asxCode(row?.[0]),
    issue: typeof row?.[5] === "number" ? row[5] : Number.NaN,
    current: formulas[i]?.[10] ?? "",
  }));
  report.rows = rows.length;

  const codes = [...new Set(rows.flatMap((r) => (r.code && r.issue > 0 ? [r.code] : [])))];
  const quotes = await deps.quotes(codes);

  const missing = new Set<string>();
  const stale = new Set<string>();
  const column = rows.map((r) => {
    if (!r.code || !(r.issue > 0)) return [r.current];
    const q = quotes.get(r.code);
    if (!q || q.open === null) {
      missing.add(r.code);
      return [r.current];
    }
    if (!tradedToday(q.tradedAt, deps.today)) {
      stale.add(r.code);
      return [r.current];
    }
    report.updated++;
    return [priceRiseText(r.issue, q.open)];
  });
  report.noQuote = [...missing];
  report.noTradeToday = [...stale];
  if (report.updated === 0) return report;

  const write = await deps.graph(
    `${sheet}/range(address='${PRICE_RISE_COLUMN}${first}:${PRICE_RISE_COLUMN}${first + last}')`,
    { method: "PATCH", body: { formulas: column } },
  );
  if (!write.ok) {
    report.error = `Could not write ${PRICE_RISE_COLUMN} on ${deps.target.overviewSheet} (${write.status}).`;
    report.updated = 0;
  }
  return report;
}
