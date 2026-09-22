/**
 * An uploaded spreadsheet of PRIVATE transactions, turned into rows to write.
 *
 * ── Why this is pure, and separate from the parser ──────────────────────────
 * `parsePnlFileBuffer` already reads the historical-trades shape out of a .csv
 * or .xlsx, fuzzy-matching the header row — that is the hard, file-format half
 * and it is not re-implemented here. What is left is the half that decides what
 * reaches the database, and that half is where a wrong answer costs money: a
 * row admitted with a mis-read date lands a client's holding in the wrong
 * period, and one admitted with zero units is a trade that never happened.
 *
 * So the rules live here, take plain rows, return plain rows, and are tested
 * against literals rather than against a spreadsheet.
 *
 * ── Why a bad row is reported rather than skipped quietly ───────────────────
 * The desk is uploading a file they believe describes a client's holdings. A
 * silent skip means the client's portfolio is missing a parcel and nothing
 * anywhere says so — the same failure shape as §8.51's stream that connected
 * and delivered nothing. Every rejected row comes back with its line number and
 * the reason, and the caller shows them before anything is written.
 */

import type { ParsedTradeRow } from "../pnl-calculator.ts";

/** One transaction to write. Deliberately the manual form's fields, no more. */
export type PrivateTxnRow = {
  securityCode: string;
  securityName: string | null;
  side: "BUY" | "SELL";
  /** `yyyy-mm-dd`. */
  tradeDate: string;
  units: number;
  avgPrice: number;
  /** Gross before fees. Null falls through to `units × avgPrice` server-side. */
  consideration: number | null;
  /** The file's own reference. Null generates a `PRIVATE-…` one. */
  cnote: string | null;
};

/** A row that will NOT be written, and why — shown to the desk before the write. */
export type PrivateRowError = {
  /** 1-based position in the parsed rows, as the desk would count them. */
  line: number;
  code: string;
  reason: string;
};

export type PrivateRowsResult = {
  rows: PrivateTxnRow[];
  errors: PrivateRowError[];
};

/**
 * Statuses that mean "this transaction happened".
 *
 * A blank status counts. The broker's own export always fills it, but a desk
 * spreadsheet of off-market parcels frequently does not — the column is the
 * broker's convention, and demanding it would reject exactly the hand-made
 * files this feature exists to accept. Anything else present and unrecognised
 * is refused rather than assumed: `CANCELLED` and `PENDING` are the two the
 * historical format actually carries, and both mean the parcel is not the
 * client's.
 */
const ACCEPTED_STATUS = new Set(["", "SETTLED", "S"]);

/** `dd-mm-yyyy`, `dd/mm/yy`, `yyyy-mm-dd` and Excel's own serial, to `yyyy-mm-dd`. */
export function toIsoDate(raw: string | undefined): string | null {
  const v = String(raw ?? "").trim();
  if (!v) return null;

  // Already ISO. Taken first so a `2026-03-04` is never read as day-first.
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;

  const m = v.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    let year = Number(m[3]);
    // A two-digit year is this century. The ledger has no 20th-century trades
    // and will not acquire any.
    if (year < 100) year += 2000;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }

  /**
   * An Excel serial date, which is what a date cell becomes when the sheet is
   * read as values. Day 1 is 1900-01-01, and the epoch below is offset by the
   * two days Excel owes to its deliberate 1900-leap-year bug — the standard
   * correction, not an approximation.
   */
  if (/^\d{5}$/.test(v)) {
    const serial = Number(v);
    const ms = Date.UTC(1899, 11, 30) + serial * 86_400_000;
    const d = new Date(ms);
    if (Number.isFinite(d.getTime())) return d.toISOString().slice(0, 10);
  }

  return null;
}

/**
 * Every row the file offers, sorted into what will be written and what will not.
 *
 * The ACCOUNT column is deliberately ignored. The desk opens this from one
 * client's portfolio and picks the account there, so a file naming a different
 * one would present two answers to a question that has already been settled —
 * and the file's account refs are the broker's numbering, which a hand-made
 * spreadsheet of off-market parcels has no reason to know.
 */
export function toPrivateTransactions(parsed: ParsedTradeRow[]): PrivateRowsResult {
  const rows: PrivateTxnRow[] = [];
  const errors: PrivateRowError[] = [];

  parsed.forEach((r, i) => {
    const line = i + 1;
    const code = String(r.ticker ?? "").trim().toUpperCase();
    const fail = (reason: string) => errors.push({ line, code: code || "—", reason });

    if (!code) return fail("No security code.");

    const status = String(r.status ?? "").trim().toUpperCase();
    if (!ACCEPTED_STATUS.has(status)) {
      return fail(`Status is "${status}" — only settled transactions are imported.`);
    }

    if (r.type !== "BUY" && r.type !== "SELL") return fail("Side is neither BUY nor SELL.");

    const tradeDate = toIsoDate(r.contractDate);
    if (!tradeDate) return fail("The date could not be read.");

    const units = Number(r.units);
    if (!Number.isFinite(units) || units <= 0) return fail("Units must be greater than zero.");

    const avgPrice = Number(r.avgPrice);
    if (!Number.isFinite(avgPrice) || avgPrice < 0) return fail("The price is not a number.");

    const consideration = Number(r.consideration);

    rows.push({
      securityCode: code,
      securityName: String(r.company ?? "").trim() || null,
      side: r.type,
      tradeDate,
      units,
      avgPrice,
      consideration: Number.isFinite(consideration) && consideration > 0 ? consideration : null,
      cnote: String(r.cnote ?? "").trim() || null,
    });
  });

  return { rows, errors };
}

/**
 * The net effect of a batch on each holding, so the positions table is touched
 * once per code instead of once per row.
 *
 * A file of forty transactions across six codes is six position writes, not
 * forty — and, more than a saving, it is the only way the weighted average cost
 * comes out right: forty sequential read-modify-writes each re-read a row the
 * previous one had already moved, so a mid-file SELL would be applied against a
 * cost base that later BUYs in the same file had not yet contributed to.
 *
 * Only BUYs carry cost, for the reason the single-entry path states: a sale
 * removes units at the average the parcel already carries and is not new
 * information about what it cost.
 */
export function netPositionEffects(
  rows: PrivateTxnRow[],
): Map<string, { deltaUnits: number; buyUnits: number; buyCost: number; name: string | null }> {
  const byCode = new Map<
    string,
    { deltaUnits: number; buyUnits: number; buyCost: number; name: string | null }
  >();

  for (const r of rows) {
    const entry = byCode.get(r.securityCode) ?? {
      deltaUnits: 0,
      buyUnits: 0,
      buyCost: 0,
      name: null,
    };

    entry.deltaUnits += r.side === "BUY" ? r.units : -r.units;
    if (r.side === "BUY") {
      entry.buyUnits += r.units;
      entry.buyCost += r.units * r.avgPrice;
    }
    // The first named company wins; a later blank must not erase it.
    entry.name = entry.name ?? r.securityName;

    byCode.set(r.securityCode, entry);
  }

  return byCode;
}
