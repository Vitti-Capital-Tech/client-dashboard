import { deskDate } from "../asx/session.ts";
import { isoFromExcelSerial } from "./manual-settlement.ts";
import { OVERVIEW_FIRST_DATA_ROW } from "./tracker-format.ts";
import type { GraphCall, TrackerTarget } from "./tracker-writer.ts";

/**
 * Price Rise: each deal's opening price ON ITS SETTLEMENT DATE against its Issue
 * Price, written once into the Overview's Price Rise column (M) as
 * `$0.0090 (+28.57%)`.
 *
 * ── Which rows ──────────────────────────────────────────────────────────────
 * Rows whose Price Rise cell is still EMPTY, whose Settlement Date (F) has
 * arrived, with a listed ASX code and an Issue Price (H). A filled cell is never
 * touched again — the figure is a fact about settlement day, not a running
 * price. Private deals (named in full, like `Yatima`) and rows with no Issue
 * Price or Settlement Date are left alone.
 *
 * ── Which open ──────────────────────────────────────────────────────────────
 * The open of the first trading session on or after the Settlement Date — the
 * settlement day itself unless the code did not trade that day (a halt, say),
 * in which case the next day it did. Read from Yahoo's daily history, so a row
 * written weeks after settlement still gets settlement day's open, not today's.
 *
 * ── When ────────────────────────────────────────────────────────────────────
 * Once a trading day at 12pm Sydney, from the existing `alert-live-tick` job
 * (`/api/alerts/live`) rather than a cron of its own — see `priceRiseDue`. By
 * noon on settlement day the market has been open two hours, so the day's open
 * exists. A row Yahoo cannot fill yet stays empty and is tried again next day.
 *
 * ── One write ───────────────────────────────────────────────────────────────
 * Column M is read as formulas and written back as one range, `M4:M<last>`,
 * with every cell this run did not fill written back exactly as it was.
 *
 * Free of `server-only`, with Graph and the price history injected.
 */

/** The Overview's Price Rise column. */
export const PRICE_RISE_COLUMN = "M";

/** How many history lookups run at once — Yahoo is an unofficial endpoint. */
const CONCURRENCY = 6;

/** A session's open, and the Sydney date it was struck on. */
export type SessionOpen = { open: number; on: string };

export type PriceRiseDeps = {
  /** Today on the desk's clock, `YYYY-MM-DD`. */
  today: string;
  graph: GraphCall;
  target: TrackerTarget;
  /** The first traded session's open on or after `from`, or null when there is none yet. */
  openFrom: (code: string, from: string) => Promise<SessionOpen | null>;
};

export type PriceRiseReport = {
  rows: number;
  /** Cells written this run. */
  updated: { ticker: string; settlementDate: string; openOn: string; text: string }[];
  /** Rows due but with no open yet — tried again next run. */
  pending: { ticker: string; settlementDate: string }[];
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

/** Run `fn` over `items`, at most `limit` at a time, keeping order. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function runPriceRise(deps: PriceRiseDeps, lastRow = 400): Promise<PriceRiseReport> {
  const report: PriceRiseReport = { rows: 0, updated: [], pending: [] };
  const sheet = `/drives/${deps.target.driveId}/items/${deps.target.itemId}/workbook/worksheets('${encodeURIComponent(
    deps.target.overviewSheet,
  )}')`;
  const first = OVERVIEW_FIRST_DATA_ROW;

  // C (ticker) through M (Price Rise): values for ticker, Settlement Date and
  // Issue Price, formulas for M so whatever is there is written back untouched.
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
  report.rows = last + 1;

  const column = values.slice(0, last + 1).map((_, i) => [formulas[i]?.[10] ?? ""]);

  // Due: empty cell, listed code, an Issue Price, and a Settlement Date that has arrived.
  const due = values.slice(0, last + 1).flatMap((row, i) => {
    const code = asxCode(row?.[0]);
    const settlementDate = isoFromExcelSerial(row?.[3]);
    const issue = typeof row?.[5] === "number" ? row[5] : Number.NaN;
    const empty = String(column[i][0] ?? "").trim() === "";
    if (!empty || !code || !settlementDate || !(issue > 0) || settlementDate > deps.today) return [];
    return [{ i, code, settlementDate, issue }];
  });
  if (due.length === 0) return report;

  const opens = await pool(due, CONCURRENCY, (d) =>
    deps.openFrom(d.code, d.settlementDate).catch(() => null),
  );

  due.forEach((d, n) => {
    const o = opens[n];
    if (!o) {
      report.pending.push({ ticker: d.code, settlementDate: d.settlementDate });
      return;
    }
    const text = priceRiseText(d.issue, o.open);
    column[d.i] = [text];
    report.updated.push({ ticker: d.code, settlementDate: d.settlementDate, openOn: o.on, text });
  });
  if (report.updated.length === 0) return report;

  const write = await deps.graph(
    `${sheet}/range(address='${PRICE_RISE_COLUMN}${first}:${PRICE_RISE_COLUMN}${first + last}')`,
    { method: "PATCH", body: { formulas: column } },
  );
  if (!write.ok) {
    report.error = `Could not write ${PRICE_RISE_COLUMN} on ${deps.target.overviewSheet} (${write.status}).`;
    report.updated = [];
  }
  return report;
}
