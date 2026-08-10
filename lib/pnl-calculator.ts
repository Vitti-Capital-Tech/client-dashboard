import ExcelJS from "exceljs";
import * as XLSX from "xlsx";
import {
  blackScholesCall,
  yearsToExpiry,
  UNLISTED_OPTION_ASSUMPTIONS,
} from "./black-scholes.ts";
// One definition of "is this an ASX code or a foreign listing", shared with the
// broker importer. Two copies of that rule would drift, and the two subsystems
// disagreeing about what a security IS is exactly the kind of split that shows
// up as a P&L discrepancy nobody can explain.
import { isExchangeQualified } from "./import/normalize.ts";

export interface ParsedTradeRow {
  cnote?: string;
  account?: string;
  type: "BUY" | "SELL";
  ticker: string;
  company: string;
  contractDate?: string;
  units: number;
  avgPrice: number;
  consideration?: number;
  value: number;
  status?: string;
}

export interface PlacementClientAllocation {
  clientName: string;
  advisor: string;
  askingBid: number;
  allocationDollar: number;
  roundShares: number;
  actualDollar: number;
  tranche1Dollar?: number;
  tranche1Shares?: number;
  tranche2Dollar?: number;
  tranche2Shares?: number;
  sellerFee?: number;
}

/**
 * A free option attached to a placement, as written in the Overview sheet's
 * **Add-Ons** column — e.g. `1:2 @$1.20 Unlisted Exp 31/12/27`.
 *
 * One cell can describe SEVERAL grants, so a cell parses to a list of these:
 * `1:2 @ $ 0.60 Unlisted Exp 30/06/27 + 1:2 @ $ 1.00 Unlisted Piggyback Exp 30/06/28`
 * is two tranches at different strikes and expiries.
 *
 * Only UNLISTED add-ons become P&L rows. A listed option already trades under its
 * own code, so it arrives through the broker ledger like any other line and must
 * not be modelled a second time.
 */
export interface PlacementAddOn {
  /** Verbatim text of THIS tranche's segment, so the table shows what was read. */
  raw: string;
  /** 1-based position among the grants parsed out of the cell. */
  tranche: number;
  /** Wording that qualifies the tranche, e.g. "Piggyback". Display only. */
  note?: string;
  /**
   * A piggyback grant: earned by EXERCISING the base tranche, not by holding
   * shares, so its ratio applies to the base tranche's option count.
   */
  piggyback: boolean;
  /** `1` in `1:3` — options granted per `ratioPerShares` shares held. */
  ratioOptions: number;
  /** `3` in `1:3`. */
  ratioPerShares: number;
  /** Exercise price, e.g. 0.14. */
  strike: number;
  /** ISO `YYYY-MM-DD`. The source is day-first `DD/MM/YY`. */
  expiry: string;
  /**
   * True when the cell named no expiry and one was DERIVED from the placement's
   * issue date (see `ASSUMED_UNLISTED_OPTION_TERM_YEARS`). Carried all the way to
   * the tooltip and the export so a modelled term is never mistaken for a read one.
   */
  expiryAssumed?: boolean;
  listed: boolean;
}

/**
 * ONE year's placement in a ticker that was placed in more than one.
 *
 * A ticker can appear in both the 2025 and the 2026 tracker — either as two genuinely
 * different placements or as the same one carried forward. Neither may be summed, so
 * the years are kept apart until the trade file says which one the client actually
 * took part in (`mergePlacementTrackerIntoSummary`).
 */
export interface PlacementYearCandidate {
  /** The tab it came from (`KNI (b)`), for the audit note. Absent on Overview-only rows. */
  sheetName?: string;
  /** From the Overview's Date Issued, else the Overview sheet's own year. */
  issueYear?: number;
  /** ISO `YYYY-MM-DD`, when the sheet states one. */
  issueDate?: string;
  totalShares: number;
  totalActualDollar: number;
  clientAllocations: PlacementClientAllocation[];
  /**
   * THIS year's grants, and only this year's.
   *
   * A ticker placed twice often carries options in one year and none in the other:
   * ACM's 2025 row grants `1:2@0.1 Unlisted` while its 2026 row's Add-Ons cell is
   * empty. Taking add-ons from "the first workbook that has them", as the merge once
   * did, minted an option position off a placement the client never took part in.
   */
  addOns?: PlacementAddOn[];
}

export interface PlacementTickerInfo {
  ticker: string;
  company?: string;
  issuePrice?: number;
  leadManager?: string;
  totalShares: number;
  totalActualDollar: number;
  clientAllocations: PlacementClientAllocation[];
  /** ISO `YYYY-MM-DD` from the Overview's Date Issued column. */
  issueDate?: string;
  /** Year of `issueDate`, falling back to the year in the Overview sheet's name. */
  issueYear?: number;
  /**
   * Set ONLY when the loaded workbooks place this ticker in more than one year.
   * The top-level totals then describe the first candidate alone and must not be
   * used to fill a row — `mergePlacementTrackerIntoSummary` picks by trade year.
   */
  candidates?: PlacementYearCandidate[];
  /** Every grant parsed out of the Overview sheet's grant cell ("Add-Ons" in the
   *  2026 tracker, "Options" in the 2025 one), in cell order. */
  addOns?: PlacementAddOn[];
}

/** Equity/ordinary line vs a listed option line — kept as separate P&L rows. */
export type PnlInstrument = "EQUITY" | "OPTION";

/**
 * Where an underlying's spot price came from.
 *
 * `yahoo` and `asx` are live quotes; `database` is the last holdings snapshot and is
 * therefore only as fresh as the last import. Carried through to the UI so the two
 * are never silently interchangeable on a valuation.
 */
export type SpotSource = "yahoo" | "asx" | "database" | "unavailable";

/**
 * Which sources are live quotes, so the UI warns only about a stale snapshot.
 *
 * Lives here rather than beside `fetchSpotPricesAction`: a `"use server"` module may
 * only export async functions — every export becomes a server-action reference — so
 * a plain array there fails at runtime with "can only export async functions, found
 * object". Types are erased and are fine; values are not.
 */
export const LIVE_SPOT_SOURCES: readonly SpotSource[] = ["yahoo", "asx"];

/** Everything that went into an unlisted option row's model price, for audit. */
export interface UnlistedOptionValuation {
  addOn: PlacementAddOn;
  /** Parent-row Buy Qty. Context even when the ratio was applied to something else. */
  sharesHeld: number;
  /** The count the ratio was actually applied to. */
  basisQty: number;
  /** What that count is: shares held, or the base tranche's options for a piggyback. */
  basisKind: "shares" | "base-options";
  /** Underlying spot used, and where it came from. */
  spot: number;
  /** `yahoo` / `asx` are live quotes; `database` is the last holdings snapshot. */
  spotSource: SpotSource;
  /** Years to expiry at valuation time. */
  timeToExpiryYears: number;
  /** Black-Scholes value of ONE option. */
  optionPrice: number;
  volatility: number;
  riskFreeRate: number;
  dividendYield: number;
  /** ISO date the valuation was struck. */
  valuedAt: string;
}

export interface PnlSummaryItem {
  ticker: string; // Option rows keep their full option code (e.g. GEDO); equity rows use the 3-char parent (GED)
  parentTicker?: string; // Underlying 3-char code — same for GED and GEDO
  instrument?: PnlInstrument;
  company: string;
  buyQty: number;
  sellQty: number;
  buyPrice: number; // Sum of Buy Prices / Value
  sellPrice: number; // Sum of Sell Prices / Value
  totalBuyValue: number; // Total Cost paid
  totalSellValue: number; // Total Proceeds received
  pnlCalculated: number; // Total Sell Value - Total Buy Value
  isMatched: boolean; // true when buyQty === sellQty && buyQty > 0
  isOption: boolean; // true when buyQty === 0 or raw ticker is an option code (length > 3 with 'O')
  hasOptionCode?: boolean; // true if any raw trade ticker was an option code (length > 3 with 'O')
  isEdited?: boolean; // true if manually adjusted by staff
  isEnriched?: boolean; // true if merged with placement tracker data
  isDbMarketValued?: boolean; // true if sellQty/sellPrice auto-filled from database portfolio market value
  isDbOpenValued?: boolean; // true when a FULLY open position was valued off the DB — nothing was sold
  isDbOnly?: boolean; // true when the row exists ONLY because the DB holds it — no trade in the file
  isPartialExit?: boolean; // true when a still-held parcel was ADDED on top of a realised part-sale
  isPartialBuy?: boolean; // true when a Placement allocation was ADDED on top of a short buy side
  isUnlistedOption?: boolean; // true for a synthetic row valuing free UNLISTED placement options
  unlistedOption?: UnlistedOptionValuation; // The inputs behind that row's Black-Scholes price
  comment?: string; // Derived from the flags above — surfaced in the table and both exports
  openQty: number; // buyQty - sellQty
  tradeCount: number;
  clientAllocations?: PlacementClientAllocation[];
  /** Calendar years of the ledger's Contract Date, BUY trades only. Sorted, unique. */
  buyYears?: number[];
  /** Same for every trade on the row, buy or sell — the fallback when there are no buys. */
  tradeYears?: number[];
  /**
   * The ticker was placed in more than one tracker year and the trade dates did not
   * single one out, so NOTHING was filled from the placement. Never merge silently
   * here: summing the years is exactly what produced the wrong P&L.
   */
  placementYearUnresolved?: boolean;
  /** Human-readable reason for `placementYearUnresolved`, shown on hover. */
  placementYearNote?: string;
  /**
   * The grants on the placement row(s) this client was actually found in — the ONLY
   * source `buildUnlistedOptionRows` trusts once the merge has run.
   *
   * An empty array is a real answer ("that placement grants nothing"), which is why
   * it is distinct from `undefined` ("the merge never identified a placement").
   */
  placementAddOns?: PlacementAddOn[];
}

/**
 * Whether a row's buy side is genuinely UNKNOWN rather than zero.
 *
 * Nothing in the ledger and nothing usable in the tracker: showing `0` would read as
 * "bought for nothing" and hand the row a P&L equal to its whole sale proceeds. The
 * table and both exports leave these cells blank and paint them red instead, and the
 * Grand Total skips the row — a blank cannot be summed.
 */
export function isBuySideUnknown(item: PnlSummaryItem): boolean {
  return Boolean(item.placementYearUnresolved) && item.buyQty === 0 && item.buyPrice === 0;
}

export interface ParseResult {
  summary: PnlSummaryItem[];
  rawTrades: ParsedTradeRow[];
  totalPnl: number;
  totalTrades: number;
  uniqueTickers: number;
  matchedTickers: number;
  optionTickers: number;
  accounts?: string[]; // Unique account numbers (external_ref) found in the file
  errors: string[];
}

/**
 * Normalizes header string to lower case alphanumeric only for flexible matching
 */
function normHeader(h: string): string {
  return String(h || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Normalizes security codes/tickers by mapping derivatives (e.g. EOSXX, ACWXX, EOSYY, EOSZZ)
 * to their 3-character ordinary parent ticker (e.g. EOS, ACW).
 */
export function getParentTicker(rawCode: string): string {
  const code = String(rawCode || "").trim().toUpperCase();
  // A foreign listing is its own parent — `BRAI:NAS` is a whole NASDAQ ticker,
  // not `BRA` plus a suffix. Slicing it would merge unrelated instruments under
  // an invented ASX-shaped code. Shared with the importer so the two cannot
  // disagree about what a security IS.
  if (isExchangeQualified(code)) return code;
  if (code.length >= 3) {
    return code.slice(0, 3);
  }
  return code;
}

/**
 * Checks if a raw security code represents an Option (length > 3 and suffix after 3-letter base contains 'O', e.g. EOSO, ACWO, ZEUOB)
 */
export function isOptionCode(rawCode: string): boolean {
  const code = String(rawCode || "").trim().toUpperCase();
  // The "an O after the third character" tell is an ASX convention and means
  // nothing on a foreign ticker — it would read `SONO:NAS` as an option on
  // `SON`. Today's three US holdings happen to have no O in that position, so
  // this guards a bug that has not fired yet rather than one that has.
  if (isExchangeQualified(code)) return false;
  if (code.length > 3) {
    const suffix = code.slice(3);
    return suffix.includes("O");
  }
  return false;
}

/**
 * The row a raw security code belongs to in the P&L table.
 *
 * Options are reported on their own line, so they key on the full option code
 * (GEDO stays GEDO). Everything else — ordinaries and non-option derivatives
 * like GEDXX — rolls up into the 3-char parent (GED).
 */
export function getSummaryGroupKey(rawCode: string): string {
  const code = String(rawCode || "").trim().toUpperCase();
  return isOptionCode(code) ? code : getParentTicker(code);
}

/**
 * The `Status` cell for an exported row.
 *
 * An option line's buy and sell legs are not expected to balance — a 1:3 grant is
 * never bought at all — so labelling one "Unmatched" reports a discrepancy that
 * does not exist. Options say what they are instead, matching the table, where the
 * Unmatched badge and the Unmatched tab both exclude them.
 */
export function exportStatus(item: PnlSummaryItem): string {
  // Checked before `isMatched`: a DB-only row trivially reconciles because both legs
  // were set from the same held quantity, so "Matched" would imply a trade
  // reconciliation that never happened. Where the figures came from is the useful fact.
  if (item.isDbOnly) return "DB Holding";
  // Ahead of everything else: the row's figures are blank, so no status describing
  // them can be true. `isMatched` is especially wrong here — 0 buys against 0 buys.
  if (isBuySideUnknown(item)) return "Buy Side Unknown";
  if (item.isMatched) return "Matched";
  if (item.isUnlistedOption) return "Unlisted Option";
  if (isOptionRow(item)) return "Option";
  return "Unmatched";
}

/** Whether a summary row represents an option line rather than the equity line. */
export function isOptionRow(item: Pick<PnlSummaryItem, "ticker" | "instrument" | "hasOptionCode">): boolean {
  if (item.instrument) return item.instrument === "OPTION";
  return Boolean(item.hasOptionCode) || isOptionCode(item.ticker);
}

/** The underlying 3-char code for a summary row (GEDO -> GED). */
export function summaryParentTicker(item: Pick<PnlSummaryItem, "ticker" | "parentTicker">): string {
  return item.parentTicker || getParentTicker(item.ticker);
}

/**
 * Orders the P&L table so each underlying's equity line is followed by its
 * option lines (GED, then GEDO) instead of the two drifting apart.
 */
export function compareSummaryItems(a: PnlSummaryItem, b: PnlSummaryItem): number {
  const parentDiff = summaryParentTicker(a).localeCompare(summaryParentTicker(b));
  if (parentDiff !== 0) return parentDiff;

  const optionDiff = Number(isOptionRow(a)) - Number(isOptionRow(b));
  if (optionDiff !== 0) return optionDiff;

  return a.ticker.localeCompare(b.ticker);
}

/**
 * Parses numeric values safely from Excel cell or string
 */
function parseNum(val: any): number {
  if (val == null) return 0;
  if (typeof val === "number") return isNaN(val) ? 0 : val;
  if (typeof val === "object" && "result" in val) return parseNum(val.result);
  const cleaned = String(val).replace(/[^0-9.-]/g, "");
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? 0 : parsed;
}

/**
 * Extracts string value safely from Excel cell or value
 */
function parseStr(val: any): string {
  if (val == null) return "";
  // A REAL date cell — which every .xlsx Contract Date is — arrives as a `Date`, and
  // `String(date)` renders it "Sun Jun 21 2026 10:00:00 GMT+0530 (India Standard
  // Time)". Nothing downstream can read that back, so an entire uploaded ledger
  // counted as having no readable Contract Date and every reporting period came out
  // empty while the lifetime view looked perfectly fine. ISO is the one form the rest
  // of this file already speaks.
  if (val instanceof Date) return isoFromDateValue(val);
  if (typeof val === "object") {
    if ("result" in val) return parseStr(val.result);
    if ("text" in val) return parseStr(val.text);
    if ("richText" in val && Array.isArray(val.richText)) {
      return val.richText.map((t: any) => t.text || "").join("");
    }
  }
  return String(val).trim();
}

/**
 * A spreadsheet date cell as `YYYY-MM-DD`.
 *
 * Which end to read it from is the whole difficulty. A serial date is a calendar day
 * with no timezone, but the readers disagree on how to hand it over: some give UTC
 * midnight (`2026-06-22T00:00:00Z`), others apply the machine's offset and give
 * `2026-06-21T14:00:00Z` for the same cell. Reading UTC parts off the second, or local
 * parts off the first, moves the date a day — enough to drop a trade out of a
 * reporting period.
 *
 * So: exact UTC midnight is taken as UTC (that reader meant the calendar day), and
 * anything else is read with LOCAL parts, which is what the offset was applied to.
 */
function isoFromDateValue(d: Date): string {
  if (Number.isNaN(d.getTime())) return "";

  const atUtcMidnight =
    d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;

  const year = atUtcMidnight ? d.getUTCFullYear() : d.getFullYear();
  const month = (atUtcMidnight ? d.getUTCMonth() : d.getMonth()) + 1;
  const day = atUtcMidnight ? d.getUTCDate() : d.getDate();

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Normalizes account numbers (external_ref) by trimming and stripping trailing float zeroes like "114716.0" -> "114716"
 */
export function normalizeAccountNo(val: any): string {
  const str = parseStr(val).trim();
  if (!str) return "";
  return str.replace(/\.0+$/, "");
}

/**
 * Parses trade rows from an Excel or CSV Buffer completely in-memory.
 */
export async function parsePnlFileBuffer(
  buffer: Buffer,
  filename: string
): Promise<ParseResult> {
  const isCsv = filename.toLowerCase().endsWith(".csv");
  let workbook = new ExcelJS.Workbook();
  const errors: string[] = [];
  const rawTrades: ParsedTradeRow[] = [];

  // Attempt 1: Try reading based on extension
  try {
    if (isCsv) {
      const { Readable } = await import("stream");
      await workbook.csv.read(Readable.from(buffer));
    } else {
      await workbook.xlsx.load(buffer as any);
    }
  } catch (e) {
    // If XLSX fails, try CSV
    try {
      workbook = new ExcelJS.Workbook();
      const { Readable } = await import("stream");
      await workbook.csv.read(Readable.from(buffer));
    } catch (e2) {
      // ignore
    }
  }

  let worksheet = workbook.worksheets[0];

  // Helper to scan a worksheet for headers
  const scanHeaders = (ws: any) => {
    let headerRowNumber = 1;
    let maxMatches = 0;
    let bestColMap: Record<string, number> = {};

    const knownHeaderKeywords = [
      "type", "side", "security", "ticker", "code", "units", "qty", "quantity",
      "avgprice", "price", "consideration", "considera", "value", "cnote", "account", "status", "contractdate", "contractdat", "date"
    ];

    for (let r = 1; r <= Math.min(ws.rowCount || 1, 15); r++) {
      const row = ws.getRow(r);
      const tempColMap: Record<string, number> = {};
      let matches = 0;

      // Scan row.values array
      const values = Array.isArray(row.values) ? row.values : [];
      for (let c = 1; c < values.length; c++) {
        const rawVal = parseStr(values[c]);
        const key = normHeader(rawVal);
        if (key) {
          tempColMap[key] = c;
          if (knownHeaderKeywords.some((k) => key.includes(k))) {
            matches++;
          }
        }
      }

      // Also scan row.eachCell fallback
      row.eachCell({ includeEmpty: false }, (cell: any, colNumber: number) => {
        const rawVal = parseStr(cell.value);
        const key = normHeader(rawVal);
        if (key && !tempColMap[key]) {
          tempColMap[key] = colNumber;
          if (knownHeaderKeywords.some((k) => key.includes(k))) {
            matches++;
          }
        }
      });

      if (matches > maxMatches) {
        maxMatches = matches;
        headerRowNumber = r;
        bestColMap = tempColMap;
      }
    }

    return { headerRowNumber, maxMatches, bestColMap };
  };

  let scanResult = worksheet ? scanHeaders(worksheet) : { headerRowNumber: 1, maxMatches: 0, bestColMap: {} };

  // Fallback: If 0 header matches found with ExcelJS, try loading with SheetJS (XLSX)
  if (scanResult.maxMatches === 0) {
    const sheetJsRes = parsePnlSheetJsMatrix(buffer);
    if (sheetJsRes && sheetJsRes.rawTrades.length > 0) {
      return sheetJsRes;
    }
  }

  if (!worksheet) {
    return {
      summary: [],
      rawTrades: [],
      totalPnl: 0,
      totalTrades: 0,
      uniqueTickers: 0,
      matchedTickers: 0,
      optionTickers: 0,
      errors: ["The uploaded file contains no worksheets."],
    };
  }

  const { headerRowNumber, bestColMap: colMap } = scanResult;

  // Helper to find column index by multiple possible alias names
  const getCol = (aliases: string[]): number | undefined => {
    for (const alias of aliases) {
      const norm = normHeader(alias);
      if (colMap[norm] != null) return colMap[norm];
    }
    return undefined;
  };

  const colType = getCol(["type", "side", "tradetype", "buysell", "b/s", "bs", "action", "transactiontype", "ordertype", "buy/sell"]);
  const colSecurity = getCol(["security", "ticker", "code", "securitycode", "symbol", "stock", "instrument"]);
  const colCompany = getCol(["company", "description", "name", "securityname", "companyname", "stockname"]);
  const colUnits = getCol(["units", "qty", "quantity", "volume", "shares", "numberofshares", "tradedqty", "matchedqty", "filledqty", "size"]);
  const colAvgPrice = getCol(["avgprice", "price", "unitprice", "rate", "execprice", "price$", "tradeprice", "averageprice"]);
  const colValue = getCol(["value", "consideration", "totalvalue", "amount", "netvalue", "grossvalue", "netamount", "totalconsideration", "netconsideration", "total"]);
  const colCNote = getCol(["cnote", "contractnote", "ref", "reference", "note", "cnotenumber", "confirmation"]);
  const colAccount = getCol(["account", "accountno", "clientcode", "brokeraccount", "accno", "clientid", "externalref", "external_ref"]);
  const colDate = getCol(["contractdate", "date", "tradedate", "transdate", "executiondate"]);
  const colStatus = getCol(["status", "state", "tradestatus"]);

  if (!colSecurity || (!colUnits && !colValue)) {
    return {
      summary: [],
      rawTrades: [],
      totalPnl: 0,
      totalTrades: 0,
      uniqueTickers: 0,
      matchedTickers: 0,
      optionTickers: 0,
      errors: [
        "Required columns could not be mapped. Please ensure the file includes columns for Security (Ticker) and Units/Qty or Value.",
      ],
    };
  }

  // Iterate data rows starting after headerRowNumber
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRowNumber) return; // Skip header row and any title rows above it

    const typeStr = parseStr(colType ? row.getCell(colType).value : "").toUpperCase().trim();
    const tickerRaw = parseStr(colSecurity ? row.getCell(colSecurity).value : "").toUpperCase().trim();
    const rawUnitsNum = parseNum(colUnits ? row.getCell(colUnits).value : 0);

    let tradeType: "BUY" | "SELL" | null = null;
    if (
      typeStr === "BUY" ||
      typeStr === "B" ||
      typeStr === "BOUGHT" ||
      typeStr === "PURCHASE" ||
      typeStr.includes("BUY") ||
      typeStr.startsWith("B")
    ) {
      tradeType = "BUY";
    } else if (
      typeStr === "SELL" ||
      typeStr === "S" ||
      typeStr === "SOLD" ||
      typeStr === "SALE" ||
      typeStr === "SL" ||
      typeStr.includes("SELL") ||
      typeStr.includes("SOLD") ||
      typeStr.includes("SALE") ||
      typeStr.startsWith("S")
    ) {
      tradeType = "SELL";
    } else if (rawUnitsNum < 0) {
      tradeType = "SELL";
    } else if (rawUnitsNum > 0) {
      tradeType = "BUY";
    }

    if (!tradeType || !tickerRaw) {
      return; // Skip invalid or non-trade rows
    }

    const units = Math.abs(rawUnitsNum);
    let avgPrice = parseNum(colAvgPrice ? row.getCell(colAvgPrice).value : 0);
    let value = Math.abs(parseNum(colValue ? row.getCell(colValue).value : 0));

    if (value === 0 && units > 0 && avgPrice > 0) {
      value = Math.round(units * avgPrice * 100) / 100;
    } else if (avgPrice === 0 && units > 0 && value > 0) {
      avgPrice = Math.round((value / units) * 10000) / 10000;
    }

    const status = colStatus ? parseStr(row.getCell(colStatus).value).toUpperCase() : "SETTLED";

    // ONLY SETTLED trades are considered for PNL calculation
    if (status !== "SETTLED") {
      return;
    }

    rawTrades.push({
      cnote: colCNote ? parseStr(row.getCell(colCNote).value) : undefined,
      account: colAccount ? normalizeAccountNo(row.getCell(colAccount).value) : undefined,
      type: tradeType,
      ticker: tickerRaw,
      company: colCompany ? parseStr(row.getCell(colCompany).value) : tickerRaw,
      contractDate: colDate ? parseStr(row.getCell(colDate).value) : undefined,
      units,
      avgPrice,
      value,
      status,
    });
  });

  const { summary, totalPnl } = aggregateTradesToSummary(rawTrades);
  const matchedTickers = summary.filter((s) => s.isMatched).length;
  const optionTickers = summary.filter((s) => s.isOption).length;

  const accountsSet = new Set<string>();
  for (const t of rawTrades) {
    if (t.account && t.account.trim()) {
      accountsSet.add(t.account.trim());
    }
  }
  const accounts = Array.from(accountsSet).sort();

  return {
    summary,
    rawTrades,
    totalPnl,
    totalTrades: rawTrades.length,
    uniqueTickers: summary.length,
    matchedTickers,
    optionTickers,
    accounts,
    errors,
  };
}

/**
 * Universal SheetJS fallback parser for .xls (Excel 97-2003 BIFF format), .xlsm, .xlsb, and HTML/CSV exports
 */
function parsePnlSheetJsMatrix(buffer: Buffer): ParseResult | null {
  try {
    const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
    if (!wb.SheetNames || wb.SheetNames.length === 0) return null;
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) return null;
    const rowsMatrix = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, raw: false });
    if (!rowsMatrix || rowsMatrix.length === 0) return null;

    const knownHeaderKeywords = [
      "type", "side", "security", "ticker", "code", "units", "qty", "quantity",
      "avgprice", "price", "consideration", "considera", "value", "cnote", "account", "status", "contractdate", "contractdat", "date"
    ];

    let headerRowIdx = -1;
    let maxMatches = 0;
    let bestColMap: Record<string, number> = {};

    for (let r = 0; r < Math.min(rowsMatrix.length, 15); r++) {
      const rowArr = rowsMatrix[r];
      if (!Array.isArray(rowArr)) continue;
      const tempColMap: Record<string, number> = {};
      let matches = 0;

      rowArr.forEach((cellVal, colIdx) => {
        const rawVal = parseStr(cellVal);
        const key = normHeader(rawVal);
        if (key) {
          tempColMap[key] = colIdx;
          if (knownHeaderKeywords.some((k) => key.includes(k))) {
            matches++;
          }
        }
      });

      if (matches > maxMatches) {
        maxMatches = matches;
        headerRowIdx = r;
        bestColMap = tempColMap;
      }
    }

    if (maxMatches === 0 || headerRowIdx === -1) return null;

    const colMap = bestColMap;
    const getCol = (aliases: string[]): number | undefined => {
      for (const alias of aliases) {
        const norm = normHeader(alias);
        if (colMap[norm] != null) return colMap[norm];
      }
      return undefined;
    };

    const colType = getCol(["type", "side", "tradetype", "buysell", "b/s", "bs", "action", "transactiontype", "ordertype", "buy/sell"]);
    const colSecurity = getCol(["security", "ticker", "code", "securitycode", "symbol", "stock", "instrument"]);
    const colCompany = getCol(["company", "description", "name", "securityname", "companyname", "stockname"]);
    const colUnits = getCol(["units", "qty", "quantity", "volume", "shares", "numberofshares", "tradedqty", "matchedqty", "filledqty", "size"]);
    const colAvgPrice = getCol(["avgprice", "price", "unitprice", "rate", "execprice", "price$", "tradeprice", "averageprice"]);
    const colValue = getCol(["value", "consideration", "totalvalue", "amount", "netvalue", "grossvalue", "netamount", "totalconsideration", "netconsideration", "total"]);
    const colCNote = getCol(["cnote", "contractnote", "ref", "reference", "note", "cnotenumber", "confirmation"]);
    const colAccount = getCol(["account", "accountno", "clientcode", "brokeraccount", "accno", "clientid", "externalref", "external_ref"]);
    const colDate = getCol(["contractdate", "date", "tradedate", "transdate", "executiondate"]);
    const colStatus = getCol(["status", "state", "tradestatus"]);

    if (!colSecurity || (!colUnits && !colValue)) return null;

    const rawTrades: ParsedTradeRow[] = [];

    for (let r = headerRowIdx + 1; r < rowsMatrix.length; r++) {
      const rowArr = rowsMatrix[r];
      if (!Array.isArray(rowArr) || rowArr.length === 0) continue;

      const typeStr = parseStr(colType != null ? rowArr[colType] : "").toUpperCase().trim();
      const tickerRaw = parseStr(colSecurity != null ? rowArr[colSecurity] : "").toUpperCase().trim();
      const rawUnitsNum = parseNum(colUnits != null ? rowArr[colUnits] : 0);

      let tradeType: "BUY" | "SELL" | null = null;
      if (
        typeStr === "BUY" ||
        typeStr === "B" ||
        typeStr === "BOUGHT" ||
        typeStr === "PURCHASE" ||
        typeStr.includes("BUY") ||
        typeStr.startsWith("B")
      ) {
        tradeType = "BUY";
      } else if (
        typeStr === "SELL" ||
        typeStr === "S" ||
        typeStr === "SOLD" ||
        typeStr === "SALE" ||
        typeStr === "SL" ||
        typeStr.includes("SELL") ||
        typeStr.includes("SOLD") ||
        typeStr.includes("SALE") ||
        typeStr.startsWith("S")
      ) {
        tradeType = "SELL";
      } else if (rawUnitsNum < 0) {
        tradeType = "SELL";
      } else if (rawUnitsNum > 0) {
        tradeType = "BUY";
      }

      if (!tradeType || !tickerRaw) continue;

      const units = Math.abs(rawUnitsNum);
      let avgPrice = parseNum(colAvgPrice != null ? rowArr[colAvgPrice] : 0);
      let value = Math.abs(parseNum(colValue != null ? rowArr[colValue] : 0));

      if (value === 0 && units > 0 && avgPrice > 0) {
        value = Math.round(units * avgPrice * 100) / 100;
      } else if (avgPrice === 0 && units > 0 && value > 0) {
        avgPrice = Math.round((value / units) * 10000) / 10000;
      }

      const status = colStatus != null ? parseStr(rowArr[colStatus]).toUpperCase() : "SETTLED";
      if (status !== "SETTLED") continue;

      rawTrades.push({
        cnote: colCNote != null ? parseStr(rowArr[colCNote]) : undefined,
        account: colAccount != null ? normalizeAccountNo(rowArr[colAccount]) : undefined,
        type: tradeType,
        ticker: tickerRaw,
        company: colCompany != null ? parseStr(rowArr[colCompany]) : tickerRaw,
        contractDate: colDate != null ? parseStr(rowArr[colDate]) : undefined,
        units,
        avgPrice,
        value,
        status,
      });
    }

    const { summary, totalPnl } = aggregateTradesToSummary(rawTrades);
    const matchedTickers = summary.filter((s) => s.isMatched).length;
    const optionTickers = summary.filter((s) => s.isOption).length;

    const accountsSet = new Set<string>();
    for (const t of rawTrades) {
      if (t.account && t.account.trim()) {
        accountsSet.add(t.account.trim());
      }
    }
    const accounts = Array.from(accountsSet).sort();

    return {
      summary,
      rawTrades,
      totalPnl,
      totalTrades: rawTrades.length,
      uniqueTickers: summary.length,
      matchedTickers,
      optionTickers,
      accounts,
      errors: [],
    };
  } catch (e) {
    console.warn("SheetJS fallback parse error:", e);
    return null;
  }
}

/** An inclusive `YYYY-MM-DD` window. Either end may be blank for "open-ended". */
export interface DateRange {
  from?: string;
  to?: string;
}

/** Whether a range actually constrains anything. */
export function hasDateRange(range?: DateRange | null): boolean {
  return Boolean(range?.from || range?.to);
}

/** `2026-02-04` is in `[from, to]`, either end optional, both inclusive. */
function isoInRange(iso: string, range: DateRange): boolean {
  if (range.from && iso < range.from) return false;
  if (range.to && iso > range.to) return false;
  return true;
}

/**
 * Keeps the trades whose **Contract Date** falls inside the window.
 *
 * Comparison is on the ISO form, not on `Date` objects: the ledger writes day-first
 * `04-02-2026` and the date inputs emit `2026-02-04`, and string comparison on ISO is
 * exact where a timezone-bearing `Date` is a coin toss either side of midnight.
 *
 * A trade the date of which cannot be read is EXCLUDED while a window is set, and
 * counted in `undated` so the UI can say so. Keeping it would put money from outside
 * the period into a figure that claims to cover the period; dropping it silently
 * would be just as bad, hence the count.
 */
export function filterTradesByDateRange(
  trades: ParsedTradeRow[],
  range?: DateRange | null
): { trades: ParsedTradeRow[]; excluded: number; undated: number } {
  if (!hasDateRange(range) || !range) return { trades, excluded: 0, undated: 0 };

  const kept: ParsedTradeRow[] = [];
  let undated = 0;

  for (const t of trades) {
    const parsed = parseTrackerDate(t.contractDate);
    if (!parsed) {
      undated++;
      continue;
    }
    if (isoInRange(parsed.toISOString().slice(0, 10), range)) kept.push(t);
  }

  return { trades: kept, excluded: trades.length - kept.length, undated };
}

/**
 * The 3-char underlyings a set of trades touches — GEDO and GEDXX both count as GED.
 *
 * This is the "in-window evidence" a dateless holdings snapshot gets anchored to; see
 * `createMissingRowsFor` on `mergeDbHoldingsIntoSummary`.
 */
export function tradedParentTickers(trades: ParsedTradeRow[]): Set<string> {
  const parents = new Set<string>();
  for (const t of trades) {
    const code = String(t.ticker || "").trim().toUpperCase();
    if (code) parents.add(getParentTicker(code));
  }
  return parents;
}

/*
 * Keeps the placements struck INSIDE the reporting period — the desk's rule: a period's
 * unlisted options are the ones its own placements granted.
 *
 * The end of the window is the part that is unarguable: an SKK placement issued 3 July
 * cannot have granted anything to a period ending 30 June, because the grant did not
 * exist yet.
 *
 * The start is a deliberate choice with a cost worth knowing. A placement settles days
 * before its shares are traded, so a window can hold the trade and miss the placement —
 * GRV settling 28 Jan and bought 4 Feb earns nothing in a February-only window. When a
 * grant is expected and missing, widening `from` past the placement's date is the fix,
 * not a bug.
 *
 * Only what can be *proved* outside is dropped. A placement dated to a YEAR alone is
 * kept when that year overlaps the window at all — a bare year cannot say which side of
 * a date inside it the placement fell — which is also what saves the rows whose date
 * cell is unusable (`0 Jan 1900` in the real Overview) but whose sheet names its year.
 */
export function filterPlacementsByDateRange(
  placementData: Map<string, PlacementTickerInfo>,
  range?: DateRange | null
): Map<string, PlacementTickerInfo> {
  if (!hasDateRange(range) || !range) return placementData;

  const fromYear = range.from ? Number(range.from.slice(0, 4)) : -Infinity;
  const toYear = range.to ? Number(range.to.slice(0, 4)) : Infinity;
  const filtered = new Map<string, PlacementTickerInfo>();

  for (const [ticker, info] of placementData.entries()) {
    const kept = placementEntries(info).filter((entry) => {
      if (entry.issueDate) return isoInRange(entry.issueDate, range);
      if (entry.issueYear != null) return entry.issueYear >= fromYear && entry.issueYear <= toYear;
      // Neither a date nor a year: nothing to place it inside or outside the window.
      return false;
    });

    if (kept.length === 0) continue;

    const first = kept[0];
    filtered.set(ticker, {
      ...info,
      totalShares: first.totalShares,
      totalActualDollar: first.totalActualDollar,
      clientAllocations: first.clientAllocations,
      addOns: first.addOns,
      issueDate: first.issueDate,
      issueYear: first.issueYear,
      candidates: kept.length > 1 ? kept : undefined,
    });
  }

  return filtered;
}

/**
 * Aggregates an array of parsed trade rows into ticker-level summary items.
 *
 * Equity and options on the same underlying are separate rows: GED (ordinary,
 * incl. non-option derivatives like GEDXX) and GEDO (option) each get their own
 * line, so their P&L is never netted against each other.
 */
export function aggregateTradesToSummary(rawTrades: ParsedTradeRow[]): { summary: PnlSummaryItem[]; totalPnl: number } {
  const tickerMap = new Map<string, PnlSummaryItem>();
  // Contract Date years per row, kept aside so the item objects stay plain until the
  // end. They are what tells two placements of the same ticker apart at merge time.
  const yearsByKey = new Map<string, { buy: Set<number>; all: Set<number> }>();

  for (const t of rawTrades) {
    const rawCode = String(t.ticker || "").trim().toUpperCase();
    const parent = getParentTicker(rawCode);
    const isOpt = isOptionCode(rawCode);
    const key = getSummaryGroupKey(rawCode);
    let item = tickerMap.get(key);
    if (!item) {
      item = {
        ticker: key,
        parentTicker: parent,
        instrument: isOpt ? "OPTION" : "EQUITY",
        company: t.company || key,
        buyQty: 0,
        sellQty: 0,
        buyPrice: 0,
        sellPrice: 0,
        totalBuyValue: 0,
        totalSellValue: 0,
        pnlCalculated: 0,
        isMatched: false,
        isOption: isOpt,
        hasOptionCode: isOpt,
        openQty: 0,
        tradeCount: 0,
      };
      tickerMap.set(key, item);
    } else if (rawCode.length === 3 && t.company) {
      // Prefer cleaner company name from ordinary 3-char security
      item.company = t.company;
    }

    item.tradeCount += 1;

    const year = parseTrackerDate(t.contractDate)?.getUTCFullYear();
    if (year) {
      let years = yearsByKey.get(key);
      if (!years) {
        years = { buy: new Set(), all: new Set() };
        yearsByKey.set(key, years);
      }
      years.all.add(year);
      if (t.type === "BUY") years.buy.add(year);
    }

    if (t.type === "BUY") {
      item.buyQty += t.units;
      item.totalBuyValue += t.value;
    } else {
      item.sellQty += t.units;
      item.totalSellValue += t.value;
    }
  }

  // Calculate sum of buy price and sum of sell price per ticker
  const summary: PnlSummaryItem[] = Array.from(tickerMap.values()).map((item) => {
    const buyPrice = Math.round(item.totalBuyValue * 100) / 100;
    const sellPrice = Math.round(item.totalSellValue * 100) / 100;
    const isMatched = item.buyQty === item.sellQty && item.buyQty > 0;
    const isOption = item.instrument === "OPTION";

    // Calculate PnL for all positions regardless of qty match
    const pnlCalculated = Math.round((sellPrice - buyPrice) * 100) / 100;
    const openQty = item.buyQty - item.sellQty;
    const years = yearsByKey.get(item.ticker);

    return {
      ...item,
      buyPrice,
      sellPrice,
      totalBuyValue: buyPrice,
      totalSellValue: sellPrice,
      pnlCalculated,
      isMatched,
      isOption,
      openQty,
      buyYears: years ? [...years.buy].sort((a, b) => a - b) : undefined,
      tradeYears: years ? [...years.all].sort((a, b) => a - b) : undefined,
    };
  });

  // Sort by underlying, equity line before its option lines
  summary.sort(compareSummaryItems);

  const totalPnl = Math.round(summary.reduce((acc, curr) => acc + curr.pnlCalculated, 0) * 100) / 100;

  return { summary, totalPnl };
}

/**
 * Builds an Excel (.xlsx) workbook buffer for the P&L summary download.
 */
export async function buildPnlExportXlsxBuffer(
  summary: PnlSummaryItem[]
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Vitti Capital Admin";

  const ws = wb.addWorksheet("PnL Summary", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  const MONEY_FMT = "$#,##0.00;($#,##0.00);\"-\"";
  const QTY_FMT = "#,##0";
  // The P&L column carries a SIGN, not an accounting bracket: a loss reads -$1,234.56.
  // Zero prints as $0.00 rather than the "-" the other money columns use, which in a
  // column of minus signs would read as a negative rather than as nothing.
  const PNL_FMT = "$#,##0.00;-$#,##0.00;$0.00";
  const GREEN = "FF166534";
  const RED = "FF991B1B";
  /** Green above zero, red below, plain at zero — the whole rule, rows and total alike. */
  const pnlFont = (value: number) => ({
    bold: true,
    color: { argb: value > 0 ? GREEN : value < 0 ? RED : "FF334155" },
  });

  ws.columns = [
    { header: "Ticker", key: "ticker", width: 14 },
    { header: "Company", key: "company", width: 32 },
    { header: "Instrument", key: "instrument", width: 13 },
    { header: "Underlying", key: "underlying", width: 13 },
    { header: "Buy Qty (Sum)", key: "buyQty", width: 16, style: { numFmt: QTY_FMT } },
    { header: "Sell Qty (Sum)", key: "sellQty", width: 16, style: { numFmt: QTY_FMT } },
    { header: "Buy Price (Sum)", key: "buyPrice", width: 18, style: { numFmt: MONEY_FMT } },
    { header: "Sell Price (Sum)", key: "sellPrice", width: 18, style: { numFmt: MONEY_FMT } },
    { header: "PnL Calculated", key: "pnlCalculated", width: 18, style: { numFmt: PNL_FMT } },
    { header: "Status", key: "status", width: 16 },
    { header: "Comments", key: "comment", width: 18 },
  ];

  // Header formatting
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF1E293B" }, // dark slate navy
  };
  headerRow.height = 24;

  const sortedSummary = [...summary].sort(compareSummaryItems);

  for (const item of sortedSummary) {
    // An unknown buy side is left EMPTY, not zero: a zero here reads as "bought for
    // nothing" and books the entire sale as profit. The row is painted red so it is
    // impossible to scroll past.
    const unknown = isBuySideUnknown(item);

    const row = ws.addRow({
      ticker: item.ticker,
      company: item.company,
      instrument: isOptionRow(item) ? "Option" : "Equity",
      underlying: summaryParentTicker(item),
      buyQty: unknown ? "" : item.buyQty,
      sellQty: item.sellQty,
      buyPrice: unknown ? "" : item.buyPrice,
      sellPrice: item.sellPrice,
      pnlCalculated: unknown ? "" : item.pnlCalculated,
      status: exportStatus(item),
      comment: item.comment ?? "",
    });

    if (unknown) {
      row.font = { color: { argb: "FF991B1B" }, bold: true };
      row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFEE2E2" } };
      if (item.placementYearNote) row.getCell("comment").note = item.placementYearNote;
      continue;
    }

    // PnL cell: green for a gain, red for a loss, whatever else the row is. It used to
    // be coloured only when the row was `isMatched` and greyed out otherwise, so most
    // of the column read as disabled — the sign is the thing people scan for.
    row.getCell("pnlCalculated").font = pnlFont(item.pnlCalculated);
  }

  // Grand Total Row. Rows with an unknown buy side are skipped whole: their cells are
  // blank, and a blank cannot be summed into a figure people read as the answer.
  const totalled = summary.filter((i) => !isBuySideUnknown(i));
  const totalBuyPrice = totalled.reduce((s, i) => s + i.buyPrice, 0);
  const totalSellPrice = totalled.reduce((s, i) => s + i.sellPrice, 0);
  const totalPnl = totalled.reduce((s, i) => s + i.pnlCalculated, 0);

  const totalRow = ws.addRow({
    ticker: "Grand Total",
    company: "",
    instrument: "",
    underlying: "",
    buyQty: "",
    sellQty: "",
    buyPrice: totalBuyPrice,
    sellPrice: totalSellPrice,
    pnlCalculated: totalPnl,
    status: "",
    comment: "",
  });

  totalRow.font = { bold: true };
  totalRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FFE2E8F0" },
  };
  totalRow.eachCell((c) => {
    c.border = { top: { style: "thin" }, bottom: { style: "double" } };
  });

  // Set AFTER the row-wide bold, which would otherwise overwrite it: the total is the
  // one figure everybody reads, so it follows the same green/red rule as the rows.
  totalRow.getCell("pnlCalculated").font = pnlFont(totalPnl);

  return Buffer.from(await wb.xlsx.writeBuffer() as any);
}

/**
 * Builds CSV string for the P&L summary download.
 */
export function buildPnlExportCsvString(summary: PnlSummaryItem[]): string {
  const headers = [
    "Ticker",
    "Company",
    "Instrument",
    "Underlying",
    "Buy Qty (Sum)",
    "Sell Qty (Sum)",
    "Buy Price",
    "Sell Price",
    "PnL Calculated",
    "Status",
    "Comments",
  ];

  const escapeCsv = (val: any) => {
    const s = String(val == null ? "" : val);
    if (/[",\r\n]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const sortedSummary = [...summary].sort(compareSummaryItems);

  const lines = [
    headers.join(","),
    ...sortedSummary.map((item) => {
      // Blank, not zero — see the xlsx builder. CSV has no colour, so the Comments
      // column ("Check Placement Year") is what carries the warning here.
      const unknown = isBuySideUnknown(item);

      return [
        item.ticker,
        item.company,
        isOptionRow(item) ? "Option" : "Equity",
        summaryParentTicker(item),
        unknown ? "" : item.buyQty,
        item.sellQty,
        unknown ? "" : item.buyPrice.toFixed(2),
        item.sellPrice.toFixed(2),
        unknown ? "" : item.pnlCalculated.toFixed(2),
        item.isEdited && !item.isMatched ? "Edited" : exportStatus(item),
        unknown && item.placementYearNote ? item.placementYearNote : item.comment ?? "",
      ]
        .map(escapeCsv)
        .join(",");
    }),
  ];

  const totalled = summary.filter((i) => !isBuySideUnknown(i));
  const totalBuyPrice = totalled.reduce((s, i) => s + i.buyPrice, 0);
  const totalSellPrice = totalled.reduce((s, i) => s + i.sellPrice, 0);
  const totalPnl = totalled.reduce((s, i) => s + i.pnlCalculated, 0);

  lines.push(
    [
      "Grand Total",
      "",
      "",
      "",
      "",
      "",
      totalBuyPrice.toFixed(2),
      totalSellPrice.toFixed(2),
      totalPnl.toFixed(2),
      "",
      "",
    ]
      .map(escapeCsv)
      .join(",")
  );

  return lines.join("\r\n");
}

/**
 * Safely extracts raw scalar values from ExcelJS cells, resolving formulas if present.
 */
function extractCellValue(val: any): any {
  if (val === null || val === undefined) return "";
  if (typeof val === "object") {
    if ("result" in val && val.result !== undefined && val.result !== null) {
      return val.result;
    }
    if ("text" in val) return val.text;
    if ("richText" in val && Array.isArray(val.richText)) {
      return val.richText.map((t: any) => t.text || "").join("");
    }
  }
  return val;
}

/**
 * How many rows of each ticker sheet to read.
 *
 * The allocation table starts around row 5 and the real sheets carry a handful of
 * participants, so this is generous. Capping matters: it is what keeps a 177-sheet,
 * 12.5 MB workbook from being fully materialised.
 */
const PLACEMENT_SHEET_ROW_CAP = 200;

/**
 * Parses a multi-sheet Placement Tracker Excel file buffer (Overview + per-ticker tabs).
 * Focuses on Round Shares (Buy Qty) and ACTUAL $ (Buy Consideration) per account holder.
 *
 * Uses **SheetJS, not ExcelJS**. ExcelJS materialises the entire workbook with styling:
 * measured on the real 2026 tracker (12.5 MB, 177 sheets) it cost **8.8s and 1,628 MB**
 * of heap, and the full load peaked at **2.1 GB RSS**. That exceeded the default 1 GB
 * memory of a Vercel function, so the larger workbook threw while the smaller 2025 one
 * squeezed through — which is why only one tracker appeared in production. SheetJS reads
 * the same data in **~1s for ~51 MB** with the row cap, a 32× reduction.
 *
 * Row/cell access is 0-indexed here, where ExcelJS was 1-indexed. That is invisible
 * downstream because columns are located by matching their header text within the same
 * indexing scheme, never by a hard-coded position.
 */
export async function parsePlacementTrackerBuffer(
  buffer: ArrayBuffer | Buffer,
  /**
   * File name or URL, used ONLY as a last-resort source of the tracker's year
   * ("Placement Tracker 2025.xlsx"). Two workbooks that cannot be dated cannot be
   * told apart, and a ticker in both then has to be reported instead of merged.
   */
  sourceName?: string
): Promise<Map<string, PlacementTickerInfo>> {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as any);

  // SheetJS is lenient where ExcelJS threw: handed an HTML login page or a stray text
  // file it happily returns an empty workbook, which would surface as the vague "no
  // ticker sheets found". Check the ZIP magic bytes so the actionable message survives.
  const isZip =
    buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
  if (!isZip) {
    throw new Error(
      "The file/link provided is not a valid .xlsx Excel workbook (or link requires login). If using Google Sheets, make sure link sharing is set to 'Anyone with the link can view' or upload a saved .xlsx file."
    );
  }

  let workbook: XLSX.WorkBook;
  try {
    // `sheetRows` caps rows per sheet; `cellStyles`/`cellHTML` stay off so only values
    // are built. Raw values (not formatted text) so numbers keep full precision and
    // formula cells yield their cached result.
    workbook = XLSX.read(buf, {
      type: "buffer",
      sheetRows: PLACEMENT_SHEET_ROW_CAP,
      cellDates: true,
      cellStyles: false,
      cellHTML: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (/central directory|zip|password|encrypt/i.test(message)) {
      throw new Error(
        "The file/link provided is not a valid .xlsx Excel workbook (or link requires login). If using Google Sheets, make sure link sharing is set to 'Anyone with the link can view' or upload a saved .xlsx file."
      );
    }
    throw err;
  }

  const placementMap = new Map<string, PlacementTickerInfo>();
  // One entry per PLACEMENT, not per ticker: a stock placed twice has two tabs and two
  // Overview rows, and only one of them may be the client's.
  const entriesByTicker = new Map<string, PlacementYearCandidate[]>();
  // How many tabs a ticker has produced so far, to pair the nth tab with the nth row.
  const tabsSeen = new Map<string, number>();

  // Exclude non-ticker system/utility sheets. The Overview sheet is not a ticker
  // tab, but it is the ONLY place the Add-Ons column lives, so it gets its own
  // pass below before being skipped here.
  const ignoredSheets = new Set([
    "template",
    "index",
    "invoice",
    "options",
    "2026 overview",
    "overview",
    "summary",
    "dashboard",
  ]);

  const addOnsByTicker = parseOverviewAddOns(buf);

  // Which year's tracker this is, for tickers whose own row carries no date. The sheet
  // names are the more reliable source (a file can be renamed or downloaded as
  // "document.xlsx"), so the caller's name is only consulted after them.
  const workbookYear =
    workbook.SheetNames.map(yearFromText).find((y) => y !== undefined) ??
    yearFromText(sourceName ?? "");

  for (const sheetName of workbook.SheetNames) {
    const rawSheetName = sheetName.trim();
    const normSheetName = normHeader(rawSheetName);

    if (ignoredSheets.has(normSheetName) || normSheetName.length === 0) {
      continue;
    }

    // Extract ticker from sheet name e.g. "FIN (b)" -> "FIN", "ZEU" -> "ZEU"
    const cleanedTicker = rawSheetName.split(/\s|\(/)[0].trim().toUpperCase();
    if (!cleanedTicker || cleanedTicker.length < 2) continue;

    const parentTicker = getParentTicker(cleanedTicker);

    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null });

    // Scan top 25 rows for table headers
    let headerRowIdx = -1;
    let colClient = -1;
    let colAdvisor = -1;
    let colAskingBid = -1;
    let colAlloc = -1;
    let colRoundShares = -1;
    let colActualDollar = -1;
    let colT1Dollar = -1;
    let colT1Shares = -1;
    let colT2Dollar = -1;
    let colT2Shares = -1;
    let colSellerFee = -1;

    for (let rowNumber = 0; rowNumber < Math.min(25, rows.length); rowNumber++) {
      if (headerRowIdx !== -1) break;

      const cells = rows[rowNumber];
      if (!Array.isArray(cells)) continue;

      cells.forEach((cellVal) => {
        const str = normHeader(String(cellVal ?? ""));
        if (str.includes("clientname") || str === "client" || str.includes("accountname")) {
          headerRowIdx = rowNumber;
        }
      });

      if (headerRowIdx === rowNumber) {
        cells.forEach((cellVal, colIdx) => {
          const str = normHeader(String(cellVal ?? ""));
          if (str.includes("clientname") || str === "client" || str.includes("account")) colClient = colIdx;
          else if (str.includes("advisor") || str.includes("broker")) colAdvisor = colIdx;
          else if (str.includes("askingbid") || str === "bid") colAskingBid = colIdx;
          else if (str === "allocation" || str.includes("alloc")) colAlloc = colIdx;
          else if (str.includes("roundshares") || str.includes("ofshares") || str === "shares") colRoundShares = colIdx;
          else if (str.includes("actual") || str === "actual") colActualDollar = colIdx;
          else if (str.includes("tranche1") && str.includes("shares")) colT1Shares = colIdx;
          else if (str.includes("tranche1")) colT1Dollar = colIdx;
          else if (str.includes("tranche2") && str.includes("shares")) colT2Shares = colIdx;
          else if (str.includes("tranche2")) colT2Dollar = colIdx;
          else if (str.includes("sellerfee")) colSellerFee = colIdx;
        });
      }
    }

    if (headerRowIdx === -1 || colClient === -1) continue;

    const allocations: PlacementClientAllocation[] = [];
    let totalShares = 0;
    let totalActualDollar = 0;

    for (let rowNumber = headerRowIdx + 1; rowNumber < rows.length; rowNumber++) {
      const cells = rows[rowNumber];
      if (!Array.isArray(cells)) continue;

      const clientName = String(cells[colClient] ?? "").trim();
      const normClient = normHeader(clientName);

      if (!clientName || normClient === "total" || normClient === "grandtotal" || normClient === "subtotal" || normClient === "sum") {
        continue;
      }

      const parseNum = (col: number) => {
        if (col === -1 || col >= cells.length) return 0;
        const v = cells[col];
        if (typeof v === "number") return v;
        const n = parseFloat(String(v ?? "").replace(/[^0-9.-]/g, ""));
        return isNaN(n) ? 0 : n;
      };

      const advisor = colAdvisor !== -1 ? String(cells[colAdvisor] ?? "").trim() : "";
      const askingBid = parseNum(colAskingBid);
      const allocationDollar = parseNum(colAlloc);
      const roundShares = Math.round(parseNum(colRoundShares > -1 ? colRoundShares : colT1Shares));
      const actualDollar = Math.round(parseNum(colActualDollar > -1 ? colActualDollar : colAlloc) * 100) / 100;

      if (roundShares > 0 || actualDollar > 0 || allocationDollar > 0) {
        allocations.push({
          clientName,
          advisor,
          askingBid,
          allocationDollar,
          roundShares,
          actualDollar,
          tranche1Dollar: parseNum(colT1Dollar),
          tranche1Shares: parseNum(colT1Shares),
          tranche2Dollar: parseNum(colT2Dollar),
          tranche2Shares: parseNum(colT2Shares),
          sellerFee: parseNum(colSellerFee),
        });

        totalShares += roundShares;
        totalActualDollar += actualDollar;
      }
    }

    if (allocations.length > 0) {
      // `KNI (a)` and `KNI (b)` are two placements of the same stock, each with its
      // own Overview row — its own date and its own Options cell. They are paired by
      // ORDER: the nth tab for a ticker to the nth Overview row for it, both being
      // chronological. `set()` used to overwrite here, so whichever tab came second
      // was the only one that survived and the earlier parcel vanished from the merge.
      const overviewRows = addOnsByTicker.get(parentTicker) ?? [];
      const seen = tabsSeen.get(parentTicker) ?? 0;
      tabsSeen.set(parentTicker, seen + 1);
      const overview = overviewRows[seen] ?? overviewRows[0];

      const entry: PlacementYearCandidate = {
        sheetName: rawSheetName,
        totalShares,
        totalActualDollar: Math.round(totalActualDollar * 100) / 100,
        clientAllocations: allocations,
        addOns: overview?.addOns?.length ? overview.addOns : undefined,
        issueDate: overview?.issueDate,
        // Falls back to the workbook's own year so a tracker whose Overview has no
        // usable date can still be told apart from the other year's tracker.
        issueYear: overview?.issueYear ?? workbookYear,
      };

      const existing = entriesByTicker.get(parentTicker);
      if (existing) existing.push(entry);
      else entriesByTicker.set(parentTicker, [entry]);
    }
  }

  // A ticker can carry an unlisted add-on while its allocation tab is absent from
  // THIS workbook (a prior year's placement, or a sheet not filled in). The option
  // entitlement is driven by the client's Buy Qty in the trade file, not by the
  // allocation rows, so it must survive with an empty allocation list — which the
  // `matchedAllocations.length > 0` guard in the merge treats as "nothing to fill".
  for (const [ticker, overviewRows] of addOnsByTicker.entries()) {
    if (entriesByTicker.has(ticker)) continue;
    const granting = overviewRows.filter((r) => r.addOns.some((a) => !a.listed));
    if (granting.length === 0) continue;

    entriesByTicker.set(
      ticker,
      granting.map((r) => ({
        totalShares: 0,
        totalActualDollar: 0,
        clientAllocations: [],
        addOns: r.addOns,
        issueDate: r.issueDate,
        issueYear: r.issueYear ?? workbookYear,
      }))
    );
  }

  for (const [ticker, entries] of entriesByTicker.entries()) {
    const first = entries[0];
    placementMap.set(ticker, {
      ticker,
      // The first placement's figures. With more than one, `candidates` is what any
      // consumer must read — these describe one of them, not the ticker.
      totalShares: first.totalShares,
      totalActualDollar: first.totalActualDollar,
      clientAllocations: first.clientAllocations,
      addOns: first.addOns,
      issueDate: first.issueDate,
      issueYear: first.issueYear,
      candidates: entries.length > 1 ? entries : undefined,
    });
  }

  return placementMap;
}

/**
 * Header text marking a column that carries option grants.
 *
 * The column has been renamed between workbooks: the 2025 tracker heads it
 * **Options**, the 2026 one **Add-Ons**. Matching only "Add-Ons" silently dropped
 * every 2025 unlisted grant, so both spellings — plus the "Free/Attaching/Unlisted
 * Options" variants seen in older tabs — are accepted.
 *
 * Being generous costs nothing: a matched column only contributes cells that
 * actually parse into a ratio + strike + expiry, so an "Option Fee ($)" column of
 * numbers yields no grants rather than junk ones.
 */
function isAddOnHeader(norm: string): boolean {
  return norm.startsWith("addon") || norm.includes("option");
}

/**
 * Finds grant columns by their CONTENT when no header matched.
 *
 * A cell only counts if it parses into a ratio + strike, which no date, fee or note
 * column does — so this locates the column whatever it is called. The sentinel date
 * makes expiry-less cells ("1:2@0.1 Unlisted") count too; it is used for DETECTION
 * only, never kept — the real rows are re-parsed against their own settlement date.
 */
function sniffAddOnColumns(rows: unknown[][], startRow: number): number[] {
  const hits = new Map<number, number>();
  const detectionDate = new Date(Date.UTC(2000, 0, 1));

  for (let r = startRow; r < rows.length; r++) {
    const cells = rows[r];
    if (!Array.isArray(cells)) continue;
    for (let c = 0; c < cells.length; c++) {
      if (parseAddOnSpecs(cells[c], detectionDate).length === 0) continue;
      hits.set(c, (hits.get(c) ?? 0) + 1);
    }
  }

  return [...hits.keys()].sort((a, b) => a - b);
}

/**
 * Concatenates the grants of several cells on one row, dropping repeats.
 *
 * Two columns describing the same grant (an "Options" column copied into a newer
 * "Add-Ons" one) must not double the entitlement, so identical tranches collapse —
 * the same rule `parseAddOnSpecs` applies within a single cell. Tranche numbers are
 * reassigned across the merged list to keep them 1..n.
 */
function mergeAddOnSpecs(perColumn: PlacementAddOn[][]): PlacementAddOn[] {
  const merged: PlacementAddOn[] = [];
  const seen = new Set<string>();

  for (const specs of perColumn) {
    for (const spec of specs) {
      const key = `${spec.ratioOptions}:${spec.ratioPerShares}@${spec.strike}/${spec.expiry}/${spec.listed}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ ...spec, tranche: merged.length + 1 });
    }
  }

  return merged;
}

/** Header text for the Overview's ticker column ("Counter" in the real workbook). */
function isTickerHeader(norm: string): boolean {
  return (
    norm === "counter" ||
    norm === "ticker" ||
    norm === "code" ||
    norm === "security" ||
    norm === "asx" ||
    norm === "asxcode"
  );
}

/**
 * Header text for the column an assumed expiry is counted from.
 *
 * Settlement is what the convention names, so it is preferred; an issue/allotment
 * date is accepted as a stand-in because some tabs carry only that, and being a few
 * days out on a two-year term is immaterial next to dropping the grant entirely.
 * Ranked, not boolean, so "Settlement Date" always beats "Date Issued" on a sheet
 * that has both.
 */
function dateHeaderRank(norm: string): number {
  if (norm.includes("settle")) return 2;
  if (norm.includes("dateissued") || norm.includes("issuedate") || norm.includes("allot")) return 1;
  if (norm === "date") return 1;
  return 0;
}

/**
 * Reads a Placement Tracker date cell.
 *
 * Cells arrive as DISPLAYED text (`raw: false`), and the column is formatted every
 * which way across the tabs, so all of "3/03/2025", "3 Mar 2025", "3-Mar-25" and
 * "2025-03-03" have to land on the same day. Day-first for the numeric form, as
 * everywhere else in this file. A bare serial number is read as an Excel date.
 */
function parseTrackerDate(cellVal: unknown): Date | null {
  if (cellVal instanceof Date) return Number.isNaN(cellVal.getTime()) ? null : cellVal;

  const raw = String(cellVal ?? "").trim();
  if (!raw) return null;

  const iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return utcDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // "Sun Jun 21 2026 10:00:00 GMT+0530 (…)" — what `String(new Date())` produces.
  // `parseStr` converts date cells to ISO before they reach here, so this is only a
  // backstop for a file that already carries the text form; without it such a date is
  // written off as unreadable and its trade falls out of every reporting period.
  const jsDateString = raw.match(/^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})\b/);
  if (jsDateString) {
    const month = MONTH_NAMES.indexOf(jsDateString[1].toLowerCase()) + 1;
    if (month > 0) return utcDate(Number(jsDateString[3]), month, Number(jsDateString[2]));
  }

  const dayFirst = raw.match(/^(\d{1,2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{2,4})/);
  if (dayFirst) {
    const isoText = isoFromDayFirst(dayFirst[1], dayFirst[2], dayFirst[3]);
    return isoText ? new Date(`${isoText}T00:00:00Z`) : null;
  }

  // "3 Mar 2025", "3-Mar-25", "03 March 2025"
  const named = raw.match(/^(\d{1,2})\s*[-\s]\s*([A-Za-z]{3,})\.?\s*[-,\s]\s*(\d{2,4})$/);
  if (named) {
    const month = MONTH_NAMES.indexOf(named[2].slice(0, 3).toLowerCase()) + 1;
    if (month > 0) {
      const year = Number(named[3]) + (named[3].length <= 2 ? 2000 : 0);
      return utcDate(year, month, Number(named[1]));
    }
  }

  // An Excel serial that never got a date format. Day 1 is 1900-01-01, offset by the
  // spreadsheet's phantom 29 Feb 1900 — hence the 1899-12-30 epoch.
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const serial = Number(raw);
    // Below ~1990 the "serial" is far more likely to be a plain number in the wrong
    // column than a real 1900s date.
    if (serial > 32000 && serial < 80000) {
      return new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000);
    }
  }

  return null;
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** A calendar-valid UTC midnight, or null if the parts do not form a real date. */
function utcDate(year: number, month: number, day: number): Date | null {
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? d : null;
}

/**
 * Reads the option-grant column off the Placement Tracker's Overview sheet.
 *
 * The sheet is named per year ("2026 Overview"), the header row is not row 1, and
 * the Add-Ons column sits at the far right past a block of fee columns — so both
 * the sheet and the columns are located by content rather than by position.
 *
 * Deliberately uses SheetJS with `raw: false` rather than ExcelJS. The column
 * carries a date/time number format (some rows really are blank times, rendering
 * as "0:00"), and ExcelJS coerces the whole column to `Date` — which turns
 * "1:1 @ $0.028 Unlisted Exp 31/01/29" into `Invalid Date` and silently loses 38
 * of the 42 real specs. `raw: false` returns each cell's DISPLAYED text, which is
 * exactly what a hand-typed column means.
 *
 * Listed add-ons are parsed and kept too: `buildUnlistedOptionRows` filters them
 * out, and keeping them makes "why is there no row for X" answerable.
 */
function parseOverviewAddOns(buffer: Buffer): Map<string, OverviewRow[]> {
  const found = new Map<string, OverviewRow[]>();

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  } catch {
    // A CSV or a workbook SheetJS cannot open simply has no Overview to read.
    return found;
  }

  // A workbook can hold more than one ("2025 Overview" beside "2026 Overview"), and
  // reading only the first would drop a whole year of grants.
  const overviewSheets = wb.SheetNames.filter((n) => normHeader(n).includes("overview"));
  // Tried only if the Overview sheets yielded nothing, so a renamed SHEET is no more
  // fatal than the renamed COLUMN was. Ticker tabs are excluded — their tables are
  // read by the caller, and scanning ~50 of them for nothing is wasted work.
  const fallbackSheets = wb.SheetNames.filter(
    (n) => !normHeader(n).includes("overview") && !looksLikeTickerTab(n)
  );

  const readSheet = (sheetName: string) => {
    let rows: unknown[][];
    try {
      rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], {
        header: 1,
        raw: false,
        defval: "",
      });
    } catch {
      return;
    }
    // "2025 Overview" dates every placement on the sheet, which is what identifies the
    // year when a row's own Date Issued is blank. Without a year the ticker cannot be
    // told apart from the same ticker in another tracker.
    const sheetYear = yearFromText(sheetName);

    // EVERY row for a ticker, in sheet order — a stock placed twice in a year has two
    // Overview rows with their own dates and their own Options cells, and one of them
    // may grant options while the other grants none.
    for (const [ticker, rowsForTicker] of readAddOnRows(rows)) {
      const dated = rowsForTicker.map((r) => ({ ...r, issueYear: r.issueYear ?? sheetYear }));
      const existing = found.get(ticker);
      if (existing) existing.push(...dated);
      else found.set(ticker, dated);
    }
  };

  for (const sheetName of overviewSheets) readSheet(sheetName);
  if (found.size === 0) {
    for (const sheetName of fallbackSheets) {
      readSheet(sheetName);
      if (found.size > 0) break;
    }
  }

  return found;
}

/** One Overview row's grants and the date that dates them. */
interface OverviewRow {
  addOns: PlacementAddOn[];
  /** ISO `YYYY-MM-DD` from the row's settlement / issue date, when it has one. */
  issueDate?: string;
  issueYear?: number;
}

/** The first plausible placement year in a sheet name — "2025 Overview" -> 2025. */
function yearFromText(text: string): number | undefined {
  const m = text.match(/\b(20\d{2})\b/);
  return m ? Number(m[1]) : undefined;
}

/** `GRV`, `GRV (b)` — a per-placement tab, not a summary sheet. */
function looksLikeTickerTab(sheetName: string): boolean {
  return /^[A-Za-z0-9]{2,5}(\s*\(.*\))?$/.test(sheetName.trim());
}

/**
 * Pulls `ticker -> [{ grants, date }, …]` out of one already-read sheet.
 *
 * The date is read for EVERY row carrying a ticker, not just the ones with grants:
 * it is what tells two placements of the same ticker apart across tracker years, and
 * a ticker with no add-ons still needs that.
 *
 * Rows are kept in sheet order and NOT collapsed. A stock placed twice in one year
 * has two rows — matching the two `KNI (a)` / `KNI (b)` tabs — and the grants on one
 * of them do not belong to the other.
 */
function readAddOnRows(rows: unknown[][]): Map<string, OverviewRow[]> {
  const found = new Map<string, OverviewRow[]>();

  let headerRowIdx = -1;
  let colTicker = -1;
  // The settlement date an unstated expiry is counted from. -1 means the sheet has
  // no such column, so those grants stay unpriceable.
  let colDate = -1;
  let colDateRank = 0;
  // Every grant column on the header row, not just the first: a sheet may carry both
  // an "Options" and an "Add-Ons" column, and dropping either loses real entitlements.
  let addOnCols: number[] = [];

  // Remembered so a sheet whose grant column is headed something unexpected can still
  // be read by sniffing the cells (below) instead of giving up.
  let tickerOnlyRowIdx = -1;
  let tickerOnlyCol = -1;

  for (let r = 0; r < Math.min(25, rows.length); r++) {
    const cells = rows[r];
    if (!Array.isArray(cells)) continue;

    const sawAddOns: number[] = [];
    let sawTicker = -1;
    let sawDate = -1;
    let sawDateRank = 0;
    cells.forEach((cellVal, colIdx) => {
      const str = normHeader(String(cellVal ?? ""));
      if (!str) return;
      if (isAddOnHeader(str)) sawAddOns.push(colIdx);
      // The ticker column is headed "Counter" in the real workbook.
      else if (isTickerHeader(str)) sawTicker = colIdx;
      else if (dateHeaderRank(str) > sawDateRank) {
        sawDate = colIdx;
        sawDateRank = dateHeaderRank(str);
      }
    });

    if (sawAddOns.length > 0) {
      headerRowIdx = r;
      addOnCols = sawAddOns;
      colTicker = sawTicker;
      colDate = sawDate;
      colDateRank = sawDateRank;
      break;
    }

    if (sawTicker !== -1 && tickerOnlyRowIdx === -1) {
      tickerOnlyRowIdx = r;
      tickerOnlyCol = sawTicker;
    }
  }

  // No recognisable header: fall back to the columns whose CELLS read as grants. The
  // column has already been renamed once (Options -> Add-Ons), so a header-only match
  // is one rename away from silently losing a year of options again.
  if (headerRowIdx === -1) {
    if (tickerOnlyRowIdx === -1) return found;
    headerRowIdx = tickerOnlyRowIdx;
    colTicker = tickerOnlyCol;
    addOnCols = sniffAddOnColumns(rows, headerRowIdx + 1);
  }

  if (addOnCols.length === 0) return found;

  // Two-line headers put "Counter" (and the dates) one row above "Add-Ons". Without
  // this the ticker falls back to column 2 and every grant is filed under the wrong
  // code, and an unstated expiry has nothing to count from.
  for (const r of [headerRowIdx - 1, headerRowIdx + 1]) {
    if (colTicker !== -1 && colDate !== -1) break;
    const cells = rows[r];
    if (!Array.isArray(cells)) continue;
    cells.forEach((cellVal, colIdx) => {
      const str = normHeader(String(cellVal ?? ""));
      if (!str) return;
      if (colTicker === -1 && isTickerHeader(str)) colTicker = colIdx;
      else if (dateHeaderRank(str) > colDateRank) {
        colDate = colIdx;
        colDateRank = dateHeaderRank(str);
      }
    });
  }

  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    const cells = rows[r];
    if (!Array.isArray(cells)) continue;

    // Grants that name no expiry are dated off this, and it dates the placement.
    const settlementDate = colDate > -1 ? parseTrackerDate(cells[colDate]) : null;

    const specs = mergeAddOnSpecs(addOnCols.map((c) => parseAddOnSpecs(cells[c], settlementDate)));

    // Sheet names carry suffixes the Overview does not ("FIN (b)" vs "FIN"), so
    // normalise to the bare parent code the P&L table groups on.
    const rawTicker = String(cells[colTicker > -1 ? colTicker : 2] ?? "").trim();
    const ticker = getParentTicker(rawTicker.split(/\s|\(/)[0].toUpperCase());
    if (!ticker || ticker.length < 2) continue;

    // Only a real ticker COLUMN makes a row without grants worth keeping. Falling back
    // to column 2 is a guess that is safe next to a parsed grant and not on its own.
    if (specs.length === 0 && (colTicker === -1 || !settlementDate)) continue;

    const isoDate = settlementDate ? settlementDate.toISOString().slice(0, 10) : undefined;
    const row: OverviewRow = {
      addOns: specs,
      issueDate: isoDate,
      issueYear: settlementDate ? settlementDate.getUTCFullYear() : undefined,
    };

    const existing = found.get(ticker);
    if (existing) existing.push(row);
    else found.set(ticker, [row]);
  }

  return found;
}

/**
 * Converts Placement Map to JSON-serializable array.
 */
export function placementMapToArray(map: Map<string, PlacementTickerInfo>): PlacementTickerInfo[] {
  return Array.from(map.values());
}

/**
 * Converts JSON-serializable array back to Placement Map.
 */
export function placementArrayToMap(list: PlacementTickerInfo[]): Map<string, PlacementTickerInfo> {
  const map = new Map<string, PlacementTickerInfo>();
  for (const item of list) {
    map.set(item.ticker, item);
  }
  return map;
}

/**
 * Helper to check if a client name matches or contains the filename stem.
 */
export function isClientMatch(clientName: string, fileStem: string): boolean {
  if (!clientName || !fileStem) return false;
  const c = clientName.toLowerCase().replace(/[^a-z0-9]/g, "");
  const s = fileStem.toLowerCase().replace(/[^a-z0-9]/g, "");

  if (c.includes(s) || s.includes(c)) return true;

  // Also check individual words (e.g. "Akshit" and "Verma")
  const stemWords = fileStem
    .toLowerCase()
    .split(/[\s\-_]+/)
    .filter((w) => w.length > 2 && !["trade", "ledger", "contract", "note", "notes", "xlsx", "csv", "xls"].includes(w));

  if (stemWords.length > 0 && stemWords.every((w) => clientName.toLowerCase().includes(w))) {
    return true;
  }

  return false;
}

/**
 * Rebuilds `comment` from the merge flags.
 *
 * Derived rather than assigned so the merges stay order-independent: a row topped
 * up on both sides (short buy from the Placement Tracker, part-sale valued from the
 * DB) reads "Partial Buy · Partial Exit" whichever merge ran last, instead of one
 * clobbering the other's note.
 *
 * "Open" and "Partial Exit" are mutually exclusive by construction — a row either
 * sold nothing (open) or sold part of the parcel (partial exit) — so the partial
 * note wins and they never both appear.
 */
function applyDerivedComment(item: PnlSummaryItem): void {
  const notes: string[] = [];
  // First, because it is the one note that says the row's figures are NOT to be used.
  if (item.placementYearUnresolved) notes.push("Check Placement Year");
  if (item.isPartialBuy) notes.push("Partial Buy");
  if (item.isPartialExit) notes.push("Partial Exit");
  // "DB Holding" already implies an open position valued off the snapshot, so it
  // stands alone rather than reading "Open · DB Holding".
  else if (item.isDbOnly) notes.push("DB Holding");
  else if (item.isDbOpenValued) notes.push("Open");
  if (notes.length > 0) item.comment = notes.join(" · ");
}

/**
 * Picks WHICH year's placement belongs on a summary row, or `null` if it cannot be
 * told — never a guess, and never the sum of the years.
 *
 * One candidate is the ordinary case and is used as-is; the year check exists only to
 * separate placements that would otherwise be stacked on one row.
 *
 * With several, the ledger's **Contract Date** decides: a placement issued in 2025 is
 * the one behind trades dated 2025. BUY years are preferred, since a placement is a
 * purchase; a row with no recorded buys at all (the classic placement row — free or
 * unnoted parcels never produce a contract note) falls back to every trade year on the
 * row, because the sale is then the only date the ledger offers.
 *
 * Anything other than exactly one match returns `null`:
 *  - no trade dates at all — the ledger cannot answer the question;
 *  - no year matches — the tracker and the trades disagree, which a human should see;
 *  - several years match — the client traded in both years, so both parcels are
 *    plausible and picking one would be a coin toss.
 */
function chooseYearCandidate(
  info: PlacementTickerInfo,
  row: PnlSummaryItem
): PlacementYearCandidate | null {
  if (!info.candidates || info.candidates.length <= 1) {
    return info.candidates?.[0] ?? {
      issueYear: info.issueYear,
      issueDate: info.issueDate,
      totalShares: info.totalShares,
      totalActualDollar: info.totalActualDollar,
      clientAllocations: info.clientAllocations,
      addOns: info.addOns,
    };
  }

  const years = rowTradeYears(row);
  if (years.length === 0) return null;

  const matches = info.candidates.filter((c) => c.issueYear != null && years.includes(c.issueYear));
  return matches.length === 1 ? matches[0] : null;
}

/** The years to compare a placement against: buys if there are any, else all trades. */
function rowTradeYears(row: PnlSummaryItem): number[] {
  if (row.buyYears?.length) return row.buyYears;
  return row.tradeYears ?? [];
}

/**
 * Which placements of a ticker this client is actually in, and their parcels.
 *
 * The tracker is read the same way a person reads it: find the client's name in the
 * placement's participant list, and take THAT row — its allocation and its Options
 * cell alike. Grants belong to a placement, not to a stock, so a client who took the
 * January 2026 ACM placement (empty Add-Ons cell) earns nothing from the June 2025
 * one that granted `1:2@0.1 Unlisted`.
 *
 * A placement with exactly ONE participant is used even when the name did not match —
 * there is no one else it could belong to, and this is what lets a merge work before
 * the account holder has been resolved. A placement with several participants and no
 * match is `ambiguous`: filling from it would sum strangers' allocations.
 *
 * The year is a TIE-BREAK, not the primary key, and only bites when the client's
 * placements span more than one year: then the ledger's Contract Date has to name one,
 * and if it cannot, `unresolvedYear` sends the row to blank-and-red. Two placements in
 * the SAME year (`KNI (a)` and `KNI (b)`) are both the client's and both come back —
 * quantities sort them out downstream, not dates.
 */
function selectClientPlacements(
  info: PlacementTickerInfo,
  row: PnlSummaryItem,
  hints: string[]
): {
  entries: PlacementYearCandidate[];
  allocations: PlacementClientAllocation[];
  ambiguous: boolean;
  unresolvedYear: boolean;
} {
  const entries = placementEntries(info);

  const byName = entries.map((entry) => ({
    entry,
    matched: hints.length
      ? entry.clientAllocations.filter((a) => hints.some((h) => isClientMatch(a.clientName, h)))
      : [],
    ambiguous: false,
  }));

  // The single-participant fallback applies ONLY when the name found nothing anywhere.
  // Per placement it would be actively wrong: `ABE (a)` listing one name and `ABE (b)`
  // listing the client would hand this row the stranger's parcel as well as their own.
  const perEntry = byName.some((p) => p.matched.length > 0)
    ? byName
    : entries.map((entry) => {
        // One participant — no question about whose allocation this is.
        if (entry.clientAllocations.length === 1) {
          return { entry, matched: entry.clientAllocations, ambiguous: false };
        }
        return { entry, matched: [], ambiguous: entry.clientAllocations.length > 1 };
      });

  let inPlay = perEntry.filter((p) => p.matched.length > 0);

  if (inPlay.length === 0) {
    // No parcel to fill with. An entry carrying grants but no allocation rows at all
    // (the Overview-only case) still counts as "the client's", since the entitlement
    // runs off their ledger Buy Qty rather than off a participant list.
    const grantOnly = perEntry.filter((p) => p.entry.clientAllocations.length === 0);
    return {
      entries: grantOnly.map((p) => p.entry),
      allocations: [],
      ambiguous: perEntry.some((p) => p.ambiguous),
      unresolvedYear: false,
    };
  }

  const years = new Set(inPlay.map((p) => p.entry.issueYear));

  if (years.size > 1) {
    // Placements a year apart: the Contract Date answers first.
    const tradeYears = rowTradeYears(row);
    const byYear = inPlay.filter(
      (p) => p.entry.issueYear != null && tradeYears.includes(p.entry.issueYear)
    );

    if (byYear.length > 0 && new Set(byYear.map((p) => p.entry.issueYear)).size === 1) {
      inPlay = byYear;
    } else {
      // The dates could not name one. QUANTITIES can: if one combination of the
      // client's parcels reconciles exactly with the row's buy and sell, that is the
      // placement they were in — harder evidence than any date heuristic. Only an
      // exact, unambiguous fit counts; anything else goes to blank-and-red.
      const byQty = narrowToReconcilingParcels(inPlay, row);
      if (!byQty) return { entries: [], allocations: [], ambiguous: false, unresolvedYear: true };
      inPlay = byQty;
    }
  } else if (inPlay.length > 1) {
    // The client's name sits on several placements of one stock — two tabs of a year,
    // or two placements inside one reporting period. The ledger decides which: the
    // parcels have to reconcile with its BUY and SELL quantities.
    //
    //   blank buy side -> the parcels should add up to the units sold. Both together
    //                     often do, which is how a client in `KNI (a)` and `KNI (b)`
    //                     gets both; one alone matching means only that one is theirs.
    //   short buy side -> to the shortfall, the recorded buys being one of the parcels
    //                     already arriving as a contract note. Adding all of them
    //                     would count that one twice.
    //
    // No unique fit means no narrowing: every parcel is used, as before, and a
    // short-buy row is still flagged Partial Buy for a human to check.
    inPlay = narrowToReconcilingParcels(inPlay, row) ?? inPlay;
  }

  return {
    entries: inPlay.map((p) => p.entry),
    allocations: inPlay.flatMap((p) => p.matched),
    ambiguous: false,
    unresolvedYear: false,
  };
}

/**
 * Confirms a client's placements against the ledger's own quantities.
 *
 * Finding the name is not proof: the same name can sit in two placements of the same
 * stock, and only one of them may be the parcel this trade file is about. The numbers
 * settle it — the units the ledger cannot account for must equal what the placement
 * delivered:
 *
 *   - blank buy side  -> the parcels should add up to the units SOLD;
 *   - short buy side  -> to the SHORTFALL, `sellQty - buyQty`, since the buys already
 *                        recorded are one of the parcels arriving as a contract note.
 *
 * Returns the one combination that fits exactly, or `null` when none does or when
 * several do — a tie is not evidence, and the caller treats it accordingly.
 */
function narrowToReconcilingParcels<T extends { matched: PlacementClientAllocation[] }>(
  inPlay: T[],
  row: PnlSummaryItem
): T[] | null {
  const target = row.buyQty === 0 ? row.sellQty : row.sellQty - row.buyQty;
  // 2^n over the placements, not the allocations: n is how many times one stock was
  // placed, which is 2 or 3 in the real trackers.
  if (target <= 0 || inPlay.length > 10) return null;

  let fit: T[] | null = null;

  for (let mask = 1; mask < 1 << inPlay.length; mask++) {
    let sum = 0;
    const subset: T[] = [];
    for (let i = 0; i < inPlay.length; i++) {
      if (mask & (1 << i)) {
        subset.push(inPlay[i]);
        for (const a of inPlay[i].matched) sum += a.roundShares;
      }
    }
    if (sum !== target) continue;
    // A second exact fit means the quantities do not identify anything.
    if (fit) return null;
    fit = subset;
  }

  return fit;
}

/**
 * Which of a client's parcels account for the units sold but never bought.
 *
 * A stock placed twice in one year gets two tabs — `KNI (a)` and `KNI (b)` — and the
 * client can be in both. The trade file's SELL quantity covers both parcels, but the
 * BUY side often carries only one of them: the other never produced a contract note.
 * Adding every parcel on top of a buy side that already contains one of them counts
 * that parcel twice, which is the same doubling as the cross-year case, one file down.
 *
 * The year cannot separate these — they share one — so the QUANTITIES do. The subset
 * of parcels summing exactly to the shortfall is the missing one(s); the fewest
 * parcels wins if more than one subset fits. With no exact fit nothing is assumed and
 * every parcel is returned, which is the long-standing behaviour and still flagged
 * `Partial Buy` for a human to look at.
 *
 * Brute force over subsets: a stock placed more than three or four times in a year is
 * not a thing, and 2^n on n≤10 is nothing. Above that the search is skipped entirely.
 */
function parcelsCoveringShortfall(
  parcels: PlacementClientAllocation[],
  shortfall: number
): PlacementClientAllocation[] {
  if (shortfall <= 0 || parcels.length > 10) return parcels;

  let best: PlacementClientAllocation[] | null = null;

  for (let mask = 1; mask < 1 << parcels.length; mask++) {
    let sum = 0;
    const subset: PlacementClientAllocation[] = [];
    for (let i = 0; i < parcels.length; i++) {
      if (mask & (1 << i)) {
        sum += parcels[i].roundShares;
        subset.push(parcels[i]);
      }
    }
    if (sum !== shortfall) continue;
    if (!best || subset.length < best.length) best = subset;
  }

  return best ?? parcels;
}

/** Why a ticker was left blank, in one line the desk can act on. */
function describeYearMismatch(info: PlacementTickerInfo, row: PnlSummaryItem): string {
  const placed = (info.candidates ?? [])
    .map((c) => (c.issueYear != null ? String(c.issueYear) : "undated"))
    .join(" and ");
  const years = rowTradeYears(row);
  const traded = years.length ? years.join(", ") : "none in the file";
  const basis = row.buyYears?.length ? "buy" : "trade";

  return `Placed in ${placed}; ${basis} dates ${traded}. Nothing was filled — resolve the year in the tracker or the trade file.`;
}

/**
 * Merges parsed Placement Tracker data into an existing PNL Summary.
 * Fills missing Buy Qty (from Round Shares) & Buy Price (from ACTUAL $) from the
 * allocation rows belonging to the account holder(s) whose trades the summary
 * represents.
 *
 * `clientHints` identifies that account holder — the loaded trade-file names
 * and/or an account holder picked explicitly in the UI. A placement sheet lists
 * *every* client who took part in the placement, so choosing the right rows is
 * the whole job: summing all of them would inflate one client's Buy Qty by the
 * number of participants.
 *
 * When the hints match nothing, a ticker is only merged if it has a single
 * allocation (where "which client" is not in question). Otherwise it is left
 * untouched and reported in `ambiguousTickers` so the caller can ask which
 * account holder to use, rather than filling in a wrong number.
 *
 * Two fill modes, mirroring `mergeDbHoldingsIntoSummary` on the sell side:
 *
 *  - BLANK buy side (`buyQty === 0` / `buyPrice === 0`) — the allocation FILLS it.
 *  - SHORT buy side (`0 < buyQty < sellQty`) — more units were sold than the
 *    ledger ever saw bought, yet some buys are recorded, so the allocation is
 *    ADDED on top. Filling would throw away the recorded buys; the old
 *    `buyQty === 0` gate skipped these rows entirely, leaving P&L overstated by
 *    the whole unrecorded parcel's cost. Rows are flagged `isPartialBuy`.
 */
export function mergePlacementTrackerIntoSummary(
  summary: PnlSummaryItem[],
  placementData: Map<string, PlacementTickerInfo>,
  clientHints?: string | string[]
): {
  summary: PnlSummaryItem[];
  mergedCount: number;
  partialBuyCount: number;
  totalPnl: number;
  ambiguousTickers: string[];
  /** Tickers placed in several years that the trade dates could not resolve. */
  unresolvedYearTickers: string[];
} {
  const updatedSummary = summary.map((item) => ({ ...item }));
  let mergedCount = 0;
  let partialBuyCount = 0;
  const ambiguousTickers: string[] = [];
  const unresolvedYearTickers: string[] = [];

  const hints = (Array.isArray(clientHints) ? clientHints : [clientHints])
    .map((h) => (h || "").trim())
    .filter((h) => h.length > 0);

  for (const [rawTicker, info] of placementData.entries()) {
    const parentTicker = getParentTicker(rawTicker);
    // A placement allocates ordinary shares, so it fills the equity row only —
    // never the option row that now sits alongside it under the same underlying.
    const existing = updatedSummary.find(
      (s) => summaryParentTicker(s) === parentTicker && !isOptionRow(s)
    );

    if (existing) {
      // WHICH PLACEMENTS is this client in? Everything else follows from that — the
      // parcels to fill with AND the option grants, which are read off the very rows
      // the client was found in rather than off the ticker as a whole.
      const selection = selectClientPlacements(info, existing, hints);

      if (selection.unresolvedYear) {
        // Nothing defensible to fill with. The row is left alone and flagged, so the
        // buy side reads blank-and-red rather than as a confident zero or, worse, as
        // both years added together.
        existing.placementYearUnresolved = true;
        existing.placementYearNote = describeYearMismatch(info, existing);
        applyDerivedComment(existing);
        unresolvedYearTickers.push(parentTicker);
        continue;
      }

      if (selection.ambiguous) ambiguousTickers.push(parentTicker);

      // Set even when nothing is filled — a client whose parcel the ledger already
      // records in full still earns that placement's options, and a placement with an
      // empty Add-Ons cell must be able to say "none" rather than leave the question
      // open for a different year's grants to answer.
      if (selection.entries.length > 0) {
        existing.placementAddOns = mergeAddOnSpecs(selection.entries.map((e) => e.addOns ?? []));
      }

      const matchedAllocations = selection.allocations;

      if (matchedAllocations.length > 0) {
        // A SHORT BUY side: units were sold that the ledger never saw bought, but
        // some buys ARE recorded — so the row is not simply blank. The placement
        // allocation is the missing parcel and is ADDED on top of what is already
        // there. Evaluated up front because the qty branch below mutates buyQty,
        // which would otherwise change the answer for the price branch.
        const isShortBuy =
          existing.buyQty > 0 && existing.sellQty > 0 && existing.buyQty < existing.sellQty;

        // With several parcels in the same year (the `KNI (a)` / `KNI (b)` case) the
        // ledger often already carries one of them as a real contract note. Adding
        // every parcel would then double that one, so the SHORTFALL — units sold but
        // never bought — is matched against the parcels first: exactly the parcels
        // that account for it are used, and the rest are left alone.
        const parcelsUsed =
          isShortBuy && matchedAllocations.length > 1
            ? parcelsCoveringShortfall(matchedAllocations, existing.sellQty - existing.buyQty)
            : matchedAllocations;

        const placementQty = parcelsUsed.reduce((sum, a) => sum + a.roundShares, 0);
        const placementPrice = parcelsUsed.reduce((sum, a) => sum + a.actualDollar, 0);

        let updated = false;

        if (existing.buyQty === 0 && placementQty > 0) {
          // Blank buy side — fill it.
          existing.buyQty = placementQty;
          updated = true;
        } else if (isShortBuy && placementQty > 0) {
          existing.buyQty += placementQty;
          existing.isPartialBuy = true;
          updated = true;
        }

        if (existing.buyPrice === 0 && placementPrice > 0) {
          // Blank buy value — fill it.
          existing.buyPrice = Math.round(placementPrice * 100) / 100;
          existing.totalBuyValue = existing.buyPrice;
          updated = true;
        } else if (isShortBuy && placementPrice > 0) {
          // buyPrice is a VALUE sum, not a per-unit price, so ACTUAL $ adds.
          existing.buyPrice = Math.round((existing.buyPrice + placementPrice) * 100) / 100;
          existing.totalBuyValue = existing.buyPrice;
          existing.isPartialBuy = true;
          updated = true;
        }

        if (updated) {
          existing.pnlCalculated = Math.round((existing.sellPrice - existing.buyPrice) * 100) / 100;
          existing.openQty = existing.buyQty - existing.sellQty;
          existing.isMatched = existing.buyQty === existing.sellQty && existing.buyQty > 0;
          existing.isEnriched = true;
          // The parcels actually applied, not every one on offer — the audit trail
          // has to say which placement the filled figures came from.
          existing.clientAllocations = parcelsUsed;
          if (existing.isPartialBuy) partialBuyCount++;
          applyDerivedComment(existing);
          mergedCount++;
        }
      }
    }
  }

  updatedSummary.sort(compareSummaryItems);

  return {
    summary: updatedSummary,
    mergedCount,
    partialBuyCount,
    totalPnl: sumPnl(updatedSummary),
    ambiguousTickers,
    unresolvedYearTickers,
  };
}

/**
 * The P&L total, skipping rows whose buy side is unknown.
 *
 * Such a row shows blanks, not figures, and its `pnlCalculated` is `sellPrice` alone —
 * the whole sale booked as profit because nothing is recorded against it. Summing that
 * would put a number the table refuses to display into the one figure people read.
 */
export function sumPnl(summary: PnlSummaryItem[]): number {
  const total = summary.reduce((acc, item) => (isBuySideUnknown(item) ? acc : acc + item.pnlCalculated), 0);
  return Math.round(total * 100) / 100;
}

/**
 * Splits a `PLACEMENT_TRACKER_URL`-style value into individual links.
 *
 * A bare comma or semicolon is NOT a safe separator for these URLs. A SharePoint
 * "copy link" URL carries query parameters containing `%2C`, and if anything in the
 * chain decodes that to a literal comma — pasting through a hosting provider's
 * environment-variable UI will — splitting on commas tears the URL in half. That is
 * exactly what happened in production: the long 2026 link split into a truncated URL
 * plus the fragment `"Refreshin"`, so it failed while the short 2025 link still worked,
 * and only one tracker ever appeared.
 *
 * So: split on whitespace (never legal inside a URL), or on a comma/semicolon **only
 * when the next thing is the start of another URL**. Anything that does not look like an
 * http(s) URL is returned in `rejected` rather than quietly attempted.
 *
 * Surrounding quotes are also stripped. A `.env` file wants `KEY="value"` and dotenv
 * removes the quotes for you, which trains people to include them — but a hosting
 * provider's environment UI stores the value verbatim, so the quote becomes part of the
 * URL. That shipped too: the deploy log read `ignored 1 entry … ""https://netorgft…"
 * (325 chars)`, exactly one character longer than the real link.
 */
export function splitTrackerUrls(raw: string): { urls: string[]; rejected: string[] } {
  // A quote is never legal in a URL, so stripping it from either end is unambiguous.
  const unquote = (s: string) => s.replace(/^["'\s]+/, "").replace(/["'\s]+$/, "");

  const parts = unquote(String(raw || ""))
    .split(/\s+|,(?=\s*["']?\s*https?:\/\/)|;(?=\s*["']?\s*https?:\/\/)/)
    .map(unquote)
    .filter(Boolean);

  const urls: string[] = [];
  const rejected: string[] = [];

  for (const part of parts) {
    if (/^https?:\/\/\S+$/i.test(part)) {
      if (!urls.includes(part)) urls.push(part);
    } else {
      rejected.push(part);
    }
  }

  return { urls, rejected };
}

/**
 * Merges several Placement Tracker workbooks into one lookup.
 *
 * DEEP-copies each allocation. Copying only the array — `[...info.clientAllocations]` —
 * leaves the element objects shared with the caller's stored maps, so the
 * `found.roundShares += …` below would mutate the source data. Since this runs on every
 * re-merge (each trade upload, each account switch), that made allocations grow without
 * bound: a ticker present in both the 2025 and 2026 workbooks doubled, then tripled,
 * and the Buy Qty crept up every time anything was re-uploaded.
 *
 * Add-ons are taken from the first workbook that has them rather than concatenated —
 * two workbooks listing the same placement would otherwise double every tranche.
 *
 * **Allocations across workbooks are never summed.** They used to be, and a ticker
 * placed in both the 2025 and the 2026 tracker came out with both parcels stacked on
 * one row — a Buy Qty and cost the client never had, and a P&L wrong by a whole
 * placement. The two cases behind it are:
 *
 *  - the SAME placement carried forward into the newer tracker — counting it twice is
 *    plainly wrong;
 *  - two DIFFERENT placements a year apart — real, but only one of them is what the
 *    trade file in front of us is about.
 *
 * Neither is summable here, so every placement stays its own `candidate` and the choice
 * is deferred to `mergePlacementTrackerIntoSummary`, which knows both the client and
 * the ledger's Contract Dates.
 *
 * Two tabs of ONE workbook (`KNI (a)`, `KNI (b)`) are two real placements and are both
 * kept. What is dropped is a placement REPEATED in a later workbook: an incoming
 * placement identical to one already held — same year, same date, same participant
 * list — is the same sheet carried forward, not a second parcel.
 *
 * A workbook whose year could not be read is keyed by its position instead, so two
 * undated files still produce two candidates and get reported rather than silently
 * collapsing into one.
 */
export function combinePlacementMaps(
  files: Array<{ map: Map<string, PlacementTickerInfo> }>
): Map<string, PlacementTickerInfo> {
  const byTicker = new Map<string, PlacementYearCandidate[]>();
  const meta = new Map<string, { ticker: string; company?: string }>();

  files.forEach((f, fileIdx) => {
    for (const [ticker, info] of f.map.entries()) {
      const entries = byTicker.get(ticker) ?? [];
      if (!entries.length) byTicker.set(ticker, entries);

      for (const entry of placementEntries(info)) {
        // An undated workbook cannot be compared with any other, so its placements are
        // kept apart rather than assumed to repeat one already seen.
        const year = entry.issueYear ?? undefined;
        const key = entrySignature(entry, year != null ? `y${year}` : `f${fileIdx}`);
        if (entries.some((e) => entrySignature(e, e.issueYear != null ? `y${e.issueYear}` : `f${fileIdx}`) === key)) {
          continue;
        }

        // DEEP copy: sharing allocation objects with the caller's stored maps let a
        // later merge mutate the source, which is what once made a ticker's Buy Qty
        // grow on every re-upload.
        entries.push({
          ...entry,
          clientAllocations: entry.clientAllocations.map((a) => ({ ...a })),
          addOns: entry.addOns ? entry.addOns.map((a) => ({ ...a })) : undefined,
        });
      }

      const m = meta.get(ticker);
      if (!m) meta.set(ticker, { ticker: info.ticker, company: info.company });
      else if (!m.company && info.company) m.company = info.company;
    }
  });

  const combined = new Map<string, PlacementTickerInfo>();

  for (const [ticker, entries] of byTicker.entries()) {
    if (entries.length === 0) continue;
    const first = entries[0];
    const m = meta.get(ticker)!;

    combined.set(ticker, {
      ticker: m.ticker,
      company: m.company,
      issueDate: first.issueDate,
      issueYear: first.issueYear,
      // With one candidate these ARE the placement. With several they describe the
      // first one only and must not be used to fill anything — hence `candidates`,
      // which every consumer of this map has to honour. `addOns` included: taking
      // them from whichever placement happened to have some is what minted an option
      // position off a placement the client was never in.
      totalShares: first.totalShares,
      totalActualDollar: first.totalActualDollar,
      clientAllocations: first.clientAllocations.map((a) => ({ ...a })),
      addOns: first.addOns ? first.addOns.map((a) => ({ ...a })) : undefined,
      candidates: entries.length > 1 ? entries : undefined,
    });
  }

  return combined;
}

/** Every placement behind a ticker — the `candidates` list, or the info itself. */
function placementEntries(info: PlacementTickerInfo): PlacementYearCandidate[] {
  if (info.candidates?.length) return info.candidates;
  return [
    {
      issueYear: info.issueYear,
      issueDate: info.issueDate,
      totalShares: info.totalShares,
      totalActualDollar: info.totalActualDollar,
      clientAllocations: info.clientAllocations,
      addOns: info.addOns,
    },
  ];
}

/**
 * Identifies a placement well enough to spot the same one arriving twice.
 *
 * Year, date, size and the participant list: a sheet copied into the next year's
 * workbook matches on all four, while two genuine placements of one stock differ in at
 * least the size or the participants.
 */
function entrySignature(entry: PlacementYearCandidate, yearKey: string): string {
  const clients = entry.clientAllocations
    .map((a) => `${a.clientName.trim().toLowerCase()}:${a.roundShares}`)
    .sort()
    .join("|");
  return `${yearKey}/${entry.issueDate ?? ""}/${entry.totalShares}/${clients}`;
}

/**
 * Which account-holder name(s) the Placement Tracker merge should match on.
 *
 * Preference order is the whole point:
 *
 *   1. An explicit choice by staff always wins.
 *   2. Names resolved from the trade file's `Account` column via the database. The
 *      account number is DATA INSIDE THE FILE; it identifies the client whatever the
 *      file is called.
 *   3. The file name, only as a last resort.
 *
 * A filename is a convention someone has to remember, and it is often simply wrong:
 * `PKevadiya-….csv` belongs to "Sri Guru Nanak Pty Ltd" and matches nothing in the
 * placement sheets, leaving four tickers unfilled that the account number resolves.
 */
export function resolvePlacementClientHints(args: {
  /** Per-file account numbers and names, in upload order. */
  files: Array<{ name: string; accounts?: string[] }>;
  /** Explicit staff choice, or `autoSentinel` to infer. */
  override: string;
  autoSentinel: string;
  /** Account number → holder name, resolved from the database. */
  accountHolders: Record<string, string>;
  /** How a file name is reduced to a candidate name. */
  filenameStem: (name: string) => string;
}): { hints: string[]; source: "override" | "account" | "filename" | "none" } {
  const { files, override, autoSentinel, accountHolders, filenameStem } = args;

  if (override !== autoSentinel) return { hints: [override], source: "override" };

  const fromAccounts = [
    ...new Set(
      files.flatMap((f) => (f.accounts || []).map((ref) => accountHolders[ref]).filter(Boolean))
    ),
  ];
  if (fromAccounts.length > 0) return { hints: fromAccounts, source: "account" };

  const fromNames = files.map((f) => filenameStem(f.name)).filter(Boolean);
  return fromNames.length > 0
    ? { hints: fromNames, source: "filename" }
    : { hints: [], source: "none" };
}

/**
 * Reduces a name to a safe filename fragment.
 *
 * Windows rejects `\ / : * ? " < > |` outright and both platforms choke on control
 * characters, so anything outside `[A-Za-z0-9]` collapses to a single dash. A
 * trailing dot is also stripped — Windows silently drops those, which would corrupt
 * the extension.
 */
function filenamePart(value: string, maxLength = 48): string {
  const cleaned = String(value || "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.slice(0, maxLength).replace(/-+$/, "");
}

/**
 * Names an export after the client it belongs to.
 *
 * A folder of `pnl-summary-calculated-2026-08-05.xlsx` files is unusable — nothing
 * says whose figures are inside, and one per client per day collides. So the account
 * number AND the holder's name both go in, for every account in scope, alongside the
 * reporting period:
 *
 *   pnl-114716-Sri-Guru-Nanak-PTY-LTD-2026-01-01_to_2026-06-30.xlsx
 *
 * Several accounts each keep their number and name too, but a name is shortened and
 * the whole thing is length-checked: three of "Mr Shaishav Kumar Patel + Mrs Vidushi
 * Patel" would run past what Windows accepts as a path, so an over-long result falls
 * back to numbers only. Beyond three accounts even the numbers are summarised.
 */
export function buildPnlExportFilename(args: {
  /** Account numbers in scope — the selected one, or every one in the file. */
  accounts: string[];
  accountHolders: Record<string, string>;
  /** `YYYY-MM-DD`. */
  isoDate: string;
  extension: "xlsx" | "csv";
  /** The reporting period, when one is set. Omitted means the lifetime view. */
  range?: DateRange | null;
}): string {
  const { accountHolders, isoDate, extension, range } = args;
  const accounts = [...new Set((args.accounts || []).map((a) => String(a || "").trim()).filter(Boolean))];

  // A period-scoped export stamped only with today's date is indistinguishable from a
  // lifetime one, and the difference is the whole figure. The period wins the stamp.
  const stamp = hasDateRange(range)
    ? `${filenamePart(range?.from || "start", 10)}_to_${filenamePart(range?.to || isoDate, 10)}`
    : filenamePart(isoDate, 10);
  const base = "pnl";

  if (accounts.length === 0) {
    // Nothing identifies the client — keep the old shape rather than invent one.
    return `pnl-summary-calculated-${stamp}.${extension}`;
  }

  if (accounts.length === 1) {
    const ref = filenamePart(accounts[0], 24);
    const holder = filenamePart(accountHolders[accounts[0]] || "");
    return holder
      ? `${base}-${ref}-${holder}-${stamp}.${extension}`
      : `${base}-${ref}-${stamp}.${extension}`;
  }

  if (accounts.length <= 3) {
    const numbersOnly = `${base}-${accounts.map((a) => filenamePart(a, 24)).join("-")}-${stamp}.${extension}`;

    // Each account keeps its own name beside its number. Names are trimmed harder here
    // than for a single account, since there are up to three of them.
    const withNames = `${base}-${accounts
      .map((a) => {
        const ref = filenamePart(a, 24);
        const holder = filenamePart(accountHolders[a] || "", 20);
        return holder ? `${ref}-${holder}` : ref;
      })
      .join("-")}-${stamp}.${extension}`;

    // 120 characters leaves room for a Downloads path inside Windows' 260-character
    // limit. Past that the names are what goes, not the numbers: a number still
    // identifies the account, where a truncated name identifies nothing.
    return withNames.length <= 120 ? withNames : numbersOnly;
  }

  return `${base}-${accounts.length}-accounts-${stamp}.${extension}`;
}

/**
 * Every distinct account holder named across a set of parsed Placement Tracker
 * sheets — the candidate list staff pick from when a trade-file name does not
 * identify the client on its own.
 */
export function collectPlacementClientNames(
  placementData: Map<string, PlacementTickerInfo>
): string[] {
  const seen = new Map<string, string>();
  for (const info of placementData.values()) {
    // Every year's participants, not just the first candidate's: the dropdown exists
    // to name a holder, and one who only took part in the other year still counts.
    const lists = info.candidates?.length
      ? info.candidates.map((c) => c.clientAllocations)
      : [info.clientAllocations];

    for (const alloc of lists.flat()) {
      const name = (alloc.clientName || "").trim();
      if (!name) continue;
      const key = name.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (key && !seen.has(key)) seen.set(key, name);
    }
  }
  return Array.from(seen.values()).sort((a, b) => a.localeCompare(b));
}

/**
 * Merges database portfolio holdings (units & market value) into the PNL summary
 * so an open parcel is valued instead of being counted against zero proceeds.
 *
 * Two distinct cases, because they are not the same arithmetic:
 *
 *  - FULLY OPEN (`sellQty === 0 || sellPrice === 0`) — nothing has been sold, so
 *    the blank sell side is FILLED from the holding.
 *
 *  - PARTIAL EXIT (`0 < sellQty < buyQty`) — part of the parcel was genuinely
 *    sold and the rest is still held, so the holding is ADDED on top of the
 *    realised sale. Filling would throw away the cash actually received;
 *    replacing it understated P&L by the whole remaining parcel, which is why
 *    these rows used to be skipped by the `sellQty === 0` gate entirely.
 *
 * `buyPrice`/`sellPrice` are VALUE sums (see `PnlSummaryItem`), not per-unit
 * prices, so adding market value to proceeds is correct — no weighted average.
 *
 * The DB's held qty is added VERBATIM; it is never back-solved from
 * `buyQty - sellQty`. If the snapshot disagrees with that gap the row stays
 * Unmatched with a non-zero Open Qty, which is the discrepancy worth seeing
 * rather than a balanced row hiding it.
 */
/**
 * Whether a DB holding belongs to a given summary row.
 *
 * Shared by the fill pass and the create pass so they cannot disagree — if they
 * used different rules, a holding could be filled into a row AND also given a
 * duplicate row of its own.
 *
 * An option row can only be matched by an option holding of the SAME code: valuing
 * GEDO at the GED share price would be wildly wrong.
 */
function dbHoldingMatchesRow(
  holding: { ticker: string; qty: number; marketValue: number },
  row: Pick<PnlSummaryItem, "ticker" | "instrument" | "hasOptionCode" | "parentTicker">
): boolean {
  const hCode = String(holding.ticker || "").trim().toUpperCase();
  const wantOption = isOptionRow(row);
  if (isOptionCode(hCode) !== wantOption) return false;
  if (wantOption ? hCode !== row.ticker.toUpperCase() : getParentTicker(hCode) !== summaryParentTicker(row)) {
    return false;
  }
  return holding.qty > 0 || holding.marketValue > 0;
}

export function mergeDbHoldingsIntoSummary(
  summary: PnlSummaryItem[],
  dbHoldings: Array<{
    accountRef?: string;
    ticker: string;
    parentTicker?: string;
    companyName?: string;
    qty: number;
    marketValue: number;
    /** `qty × avg_cost` from the snapshot. 0 for a free option. */
    costBase?: number;
  }>,
  opts?: {
    /**
     * Which underlyings a holding the trade file never mentions may invent a row for,
     * as 3-char parent codes.
     *
     * OMITTED in the lifetime view: any holding may, because there is no period for it
     * to land on the wrong side of.
     *
     * A SET while a reporting period is set, and the set is the whole point. The
     * snapshot is "as of today" and carries no date, so on its own it cannot say
     * whether a position belongs inside the window — letting every holding through put
     * positions the client merely holds NOW into periods whose ledger shows no trade in
     * them. Refusing all of them instead deleted the rows that only ever exist in the
     * snapshot: a free attaching option is never bought, so no contract note creates
     * it, and GEDO/LITOC disappeared from every windowed view.
     *
     * So the gate is the underlyings the IN-WINDOW trades touch. GED traded inside the
     * period vouches for the GEDO held against it; a period that never touched GED gets
     * neither. The dateless snapshot is placed by the ledger's dates instead of its own.
     *
     * Rows that already exist from in-window trades are valued off the snapshot either
     * way — this only gates inventing new ones.
     */
    createMissingRowsFor?: ReadonlySet<string>;
  }
): {
  summary: PnlSummaryItem[];
  mergedCount: number;
  partialExitCount: number;
  /** Rows invented for holdings the trade file never mentioned. */
  createdCount: number;
  totalPnl: number;
} {
  const updatedSummary = summary.map((item) => ({ ...item }));
  let mergedCount = 0;
  let partialExitCount = 0;
  let createdCount = 0;

  for (const item of updatedSummary) {
    const isFullyOpen = item.sellQty === 0 || item.sellPrice === 0;
    // A part-sale still holding a remainder. Requires a real buy side to compare
    // against, so a sell-only row (buyQty 0) never qualifies.
    const isPartialExit =
      !isFullyOpen && item.buyQty > 0 && item.sellQty > 0 && item.sellQty < item.buyQty;

    if (!isFullyOpen && !isPartialExit) continue;

    const match = dbHoldings.find((h) => dbHoldingMatchesRow(h, item));

    if (!match) continue;

    if (isPartialExit) {
      if (match.qty > 0) {
        item.sellQty += match.qty;
      }
      if (match.marketValue > 0) {
        item.sellPrice = Math.round((item.sellPrice + match.marketValue) * 100) / 100;
        item.totalSellValue = item.sellPrice;
      }
      item.isPartialExit = true;
      partialExitCount++;
    } else {
      if (item.sellQty === 0 && match.qty > 0) {
        item.sellQty = match.qty;
      }
      if (item.sellPrice === 0 && match.marketValue > 0) {
        item.sellPrice = Math.round(match.marketValue * 100) / 100;
        item.totalSellValue = item.sellPrice;
      }
      // Nothing was sold — the whole "sell side" is an open position marked to the
      // holdings snapshot, which is what the row's note has to say.
      item.isDbOpenValued = true;
    }

    applyDerivedComment(item);

    item.pnlCalculated = Math.round((item.sellPrice - item.buyPrice) * 100) / 100;
    item.openQty = item.buyQty - item.sellQty;
    item.isMatched = item.buyQty === item.sellQty && item.buyQty > 0;
    item.isDbMarketValued = true;
    mergedCount++;
  }

  // -------------------------------------------------------------------------
  // Holdings the trade file never mentioned get a row of their own.
  //
  // The fill pass above can only annotate rows that already exist, and rows only
  // exist for things that were TRADED. A free placement option is never bought, so
  // no contract note exists for it and no row was ever created — which silently
  // dropped the whole position from the P&L. (Real case: 106 of 108 option
  // positions in the database carry `avg_cost = 0`, e.g. GEDO, LITOC.)
  //
  // The buy side comes from the snapshot's own cost base, NOT from zero: a free
  // option really did cost nothing, so its entire market value is gain, while a
  // holding that was genuinely paid for keeps its cost and shows an honest
  // unrealised gain instead of an inflated one.
  // -------------------------------------------------------------------------
  for (const h of dbHoldings) {
    const code = String(h.ticker || "").trim().toUpperCase();
    if (!code) continue;
    if (!(h.qty > 0 || h.marketValue > 0)) continue;

    const parent = String(h.parentTicker || getParentTicker(code)).trim().toUpperCase();
    // While a period is set, the snapshot may only recover positions whose underlying
    // the period's own trades touched — the ledger dates what the snapshot cannot.
    if (opts?.createMissingRowsFor && !opts.createMissingRowsFor.has(parent)) continue;

    // Same predicate as the fill pass, so a holding already merged into a row is
    // never given a second, duplicate row.
    const isOption = isOptionCode(code);
    const alreadyRepresented = updatedSummary.some((row) => dbHoldingMatchesRow(h, row));
    if (alreadyRepresented) continue;

    const costBase = Math.round((h.costBase ?? 0) * 100) / 100;
    const marketValue = Math.round(h.marketValue * 100) / 100;

    updatedSummary.push({
      ticker: code,
      parentTicker: parent,
      instrument: isOption ? "OPTION" : "EQUITY",
      company: h.companyName || code,
      // Units held stand in for both legs: bought at the snapshot's cost base,
      // marked to its market value, so the row reads as the open position it is.
      buyQty: h.qty,
      sellQty: h.qty,
      buyPrice: costBase,
      sellPrice: marketValue,
      totalBuyValue: costBase,
      totalSellValue: marketValue,
      pnlCalculated: Math.round((marketValue - costBase) * 100) / 100,
      isMatched: h.qty > 0,
      isOption,
      hasOptionCode: isOption,
      isDbMarketValued: true,
      isDbOpenValued: true,
      // Nothing in the uploaded ledger backs this row — its cost basis is the
      // snapshot's, which the Comments column has to say out loud.
      isDbOnly: true,
      comment: "DB Holding",
      openQty: 0,
      tradeCount: 0,
    });
    createdCount++;
  }

  updatedSummary.sort(compareSummaryItems);

  return {
    summary: updatedSummary,
    mergedCount,
    partialExitCount,
    createdCount,
    // Skips rows whose buy side is unknown — their cells are blank, and a blank
    // cannot be summed into the figure everyone reads.
    totalPnl: sumPnl(updatedSummary),
  };
}

// ---------------------------------------------------------------------------
// Unlisted placement options
// ---------------------------------------------------------------------------

/** Suffix marking a synthetic unlisted-option row (`GRV` -> `GRV-UO`). */
export const UNLISTED_OPTION_SUFFIX = "-UO";

/** Matches a grant ratio like `1:3` or `1:20`. Also used to find tranche starts. */
const ADD_ON_RATIO = /(\d+)\s*:\s*(\d+)/g;

/**
 * Term assumed for a grant whose cell states no expiry — most of the 2025 tracker
 * ("1:2@0.1 Unlisted" and nothing more).
 *
 * Two years from the placement's SETTLEMENT date, by desk convention. Dropping these
 * grants instead — the previous behaviour — reported a real entitlement as nothing at
 * all, which is a worse error than a term that is out by a few months. Every row built
 * this way is flagged `expiryAssumed` so the estimate is never read as a stated term.
 */
export const ASSUMED_UNLISTED_OPTION_TERM_YEARS = 2;

/**
 * Marks a grant as unlisted, tolerating how it is actually typed.
 *
 * "Unisted" (missing the l) appears in the real 2025 column, and the plain
 * `/unlisted/` test read it as LISTED — which silently discarded the grant, since
 * listed add-ons are dropped downstream. No trailing `\b`: "UnlistedExp 31/12/27"
 * runs the word straight into the expiry.
 */
const UNLISTED_WORD = /\bun\s*-?\s*l?isted/i;

/**
 * Parses ONE tranche segment from an **Add-Ons** cell.
 *
 * The column is hand-typed, so the real workbook contains all of these:
 *
 *   1:1 @$0.04 Listed Exp 30/11/28      <- listed, ignored downstream
 *   1:2 @$1.20 Unlisted Exp 31/12/27
 *   1:1 @ $0.028 Unlisted Exp 31/01/29  <- space after @
 *   1:3@0.14 Unlisted Expiry 31/12/27   <- no space, no $, "Expiry"
 *   1:2@0.1 Unlisted                    <- no expiry at all (most of the 2025 tab)
 *   1:2@0.008 Unisted                   <- typed without the l
 *   IPO / Entitlement Offer / 00:00     <- not an option at all
 *
 * Returns null unless a ratio AND a strike are present — guessing a missing strike
 * would invent a number, and that requirement is also what rejects the `0:00` time
 * cells. A missing EXPIRY is different: it is the norm in the 2025 column, so when
 * `settlementDate` is known the standard term is applied and the result is flagged
 * `expiryAssumed`. With no date to count from there is nothing to derive, and the
 * segment is rejected as before.
 *
 * For a cell that may hold several grants use `parseAddOnSpecs`.
 */
export function parseAddOnSpec(
  rawText: unknown,
  tranche = 1,
  settlementDate?: Date | null
): PlacementAddOn | null {
  const raw = String(rawText ?? "").trim();
  if (!raw) return null;

  const ratioMatch = raw.match(/(\d+)\s*:\s*(\d+)/);
  if (!ratioMatch) return null;
  const ratioOptions = Number(ratioMatch[1]);
  const ratioPerShares = Number(ratioMatch[2]);
  if (!(ratioOptions > 0) || !(ratioPerShares > 0)) return null;

  // "@$0.04", "@ $0.028", "@0.14"
  const strikeMatch = raw.match(/@\s*\$?\s*(\d*\.?\d+)/);
  if (!strikeMatch) return null;
  const strike = Number(strikeMatch[1]);
  if (!(strike > 0)) return null;

  // "Exp 30/11/28", "Expiry 31/12/27", "Exp. 31/1/29"
  const expiryMatch = raw.match(/exp(?:iry)?\.?\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{2,4})/i);
  const statedExpiry = expiryMatch
    ? isoFromDayFirst(expiryMatch[1], expiryMatch[2], expiryMatch[3])
    : null;

  // An expiry that was typed but is not a real date (31/02) is a data error, not a
  // blank — deriving one from the issue date would paper over it.
  if (expiryMatch && !statedExpiry) return null;

  const expiry = statedExpiry ?? assumedExpiryFrom(settlementDate);
  if (!expiry) return null;

  // "Unlisted" CONTAINS "listed", so the negative has to be tested first.
  const listed = !UNLISTED_WORD.test(raw);

  // Wording that distinguishes one tranche from another, e.g. "Piggyback".
  const noteMatch = raw.match(/\b(piggyback|piggy\s*back|tranche\s*\d+|t\d)\b/i);

  return {
    raw,
    tranche,
    note: noteMatch ? noteMatch[1].replace(/\s+/g, " ") : undefined,
    piggyback: /piggy\s*back/i.test(raw),
    ratioOptions,
    ratioPerShares,
    strike,
    expiry,
    expiryAssumed: statedExpiry ? undefined : true,
    listed,
  };
}

/**
 * `settlementDate + ASSUMED_UNLISTED_OPTION_TERM_YEARS` as ISO, or null with no date.
 *
 * A 29 Feb settlement rolls to 1 March rather than being rejected: unlike a typed
 * expiry, this date is already an approximation, so a day either way changes nothing.
 */
function assumedExpiryFrom(settlementDate?: Date | null): string | null {
  if (!settlementDate || Number.isNaN(settlementDate.getTime())) return null;

  const d = new Date(
    Date.UTC(
      settlementDate.getUTCFullYear() + ASSUMED_UNLISTED_OPTION_TERM_YEARS,
      settlementDate.getUTCMonth(),
      settlementDate.getUTCDate()
    )
  );

  return d.toISOString().slice(0, 10);
}

/**
 * Parses an **Add-Ons** cell into every grant it describes.
 *
 * One cell can carry more than one tranche:
 *
 *   1:2 @ $ 0.60 Unlisted Exp 30/06/27 +  1:2  @ $ 1.00 Unlisted Piggyback Exp 30/06/28
 *
 * Segments are cut at each ratio occurrence rather than on a separator, because the
 * separator is whatever was typed that day (`+`, `&`, `and`, a line break). Anything
 * before the first ratio is preamble and is dropped.
 *
 * Duplicate tranches (same ratio, strike and expiry) collapse to one — a cell that
 * repeats itself should not double the entitlement.
 *
 * `settlementDate` is the placement's settlement date, used to derive an expiry for
 * tranches that state none. Omit it and those tranches are skipped.
 */
export function parseAddOnSpecs(rawText: unknown, settlementDate?: Date | null): PlacementAddOn[] {
  const raw = String(rawText ?? "").trim();
  if (!raw) return [];

  const starts: number[] = [];
  ADD_ON_RATIO.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ADD_ON_RATIO.exec(raw)) !== null) starts.push(m.index);
  if (starts.length === 0) return [];

  const specs: PlacementAddOn[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < starts.length; i++) {
    const segment = raw.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : undefined);
    const spec = parseAddOnSpec(segment, specs.length + 1, settlementDate);
    if (!spec) continue;

    const key = `${spec.ratioOptions}:${spec.ratioPerShares}@${spec.strike}/${spec.expiry}/${spec.listed}`;
    if (seen.has(key)) continue;
    seen.add(key);
    specs.push(spec);
  }

  return specs;
}

/**
 * `31/12/27` -> `2027-12-31`. Day-first, matching every other date in the broker
 * and placement exports. A 2-digit year is 2000-based: these are future expiries.
 */
function isoFromDayFirst(dd: string, mm: string, yy: string): string | null {
  const day = Number(dd);
  const month = Number(mm);
  let year = Number(yy);
  if (yy.length <= 2) year += 2000;

  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;

  // Reject a rolled-over date (31/02 becoming 3 March) rather than pricing to it.
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * The unlisted grants that belong to the placement THIS row actually took part in.
 *
 * Grants are a property of a placement, not of a stock. ACM was placed in June 2025
 * with `1:2@0.1 Unlisted` attached and again in January 2026 with an empty Add-Ons
 * cell; the client took the 2026 parcel, and reading the grants off "whichever row of
 * that ticker had some" minted 23,333 options out of a placement they were never in.
 *
 * The merge has already found which placement row the client is in, so `placementAddOns`
 * is the answer whenever it is set — INCLUDING when it is empty, which means "that
 * placement grants nothing", not "look elsewhere". Only a row the merge never reached
 * falls back to picking a placement by year.
 */
function unlistedAddOnsFor(info: PlacementTickerInfo, equityRow: PnlSummaryItem): PlacementAddOn[] {
  const source = equityRow.placementAddOns ?? chooseYearCandidate(info, equityRow)?.addOns ?? [];

  // `placementAddOns` was stamped on the row by the merge, which runs on the FULL
  // placement map — allocations must not be date-filtered, since a parcel bought in
  // 2025 and sold in a 2026 window still needs its 2025 cost base. `info` here is the
  // map the caller passed, which for a reporting period has already been narrowed to
  // that period's placements. Intersecting the two is what stops a row-level stamp
  // from smuggling a grant past the window: SKK is in both trackers, only the 2026 one
  // grants options, and a period ending in Oct 2025 was still showing them.
  const offered = placementEntries(info).flatMap((e) => e.addOns ?? []);
  const offeredKeys = new Set(offered.map(grantKey));

  return source.filter((a) => !a.listed && offeredKeys.has(grantKey(a)));
}

/** Identifies a grant by what it actually confers, not by which object it is. */
function grantKey(a: PlacementAddOn): string {
  return `${a.ratioOptions}:${a.ratioPerShares}@${a.strike}/${a.expiry}/${a.listed}`;
}

/** The ASX codes whose spot price an unlisted-option valuation needs. */
export function collectUnlistedOptionTickers(
  summary: PnlSummaryItem[],
  placementData: Map<string, PlacementTickerInfo>
): string[] {
  const wanted = new Set<string>();
  for (const [, info] of placementData.entries()) {
    const parent = getParentTicker(info.ticker);
    // Only names the client actually holds shares in earn an entitlement.
    const equityRow = summary.find((s) => summaryParentTicker(s) === parent && !isOptionRow(s));
    if (!equityRow || equityRow.buyQty <= 0) continue;
    // The SAME year the row was filled from, so this list cannot disagree with the
    // rows `buildUnlistedOptionRows` goes on to create.
    if (!unlistedAddOnsFor(info, equityRow).length) continue;
    wanted.add(parent);
  }
  return [...wanted].sort();
}

/**
 * Adds one synthetic P&L row per UNLISTED placement add-on.
 *
 * The economics: the options are FREE, so `buyQty` and `buyPrice` are 0 and the
 * whole Black-Scholes value is P&L. Quantity is `floor(basis * ratioOptions /
 * ratioPerShares)`, floored because a fraction of an option is not granted, where
 * the basis is the SHARES bought for a base tranche and the BASE TRANCHE'S OPTION
 * COUNT for a piggyback.
 *
 * Rebuilt from scratch on every call: any existing `-UO` rows are dropped first,
 * so re-running after a re-upload or a price refresh cannot accumulate duplicates.
 */
export function buildUnlistedOptionRows(
  summary: PnlSummaryItem[],
  placementData: Map<string, PlacementTickerInfo>,
  spotPrices: Map<string, { price: number; source: SpotSource }>,
  asOf: Date
): {
  summary: PnlSummaryItem[];
  addedCount: number;
  /** Names with no spot price at all — their rows exist but are valued at $0. */
  skipped: string[];
  /** Piggyback grants with no base tranche to compute from, so no row was made. */
  unresolvedPiggybacks: string[];
  totalPnl: number;
} {
  // Drop previously generated rows so a refresh replaces rather than stacks.
  const rows = summary.filter((s) => !s.isUnlistedOption).map((s) => ({ ...s }));
  const skipped: string[] = [];
  const unresolvedPiggybacks: string[] = [];
  let addedCount = 0;

  for (const [, info] of placementData.entries()) {
    const parent = getParentTicker(info.ticker);
    const equityRow = rows.find((s) => summaryParentTicker(s) === parent && !isOptionRow(s));

    if (!equityRow || equityRow.buyQty <= 0) continue;

    // Only the chosen year's grants. The shares in `buyQty` came from ONE placement,
    // so the entitlement they earn has to come from that same one.
    const unlistedAddOns = unlistedAddOnsFor(info, equityRow);
    if (unlistedAddOns.length === 0) continue;

    const spotInfo = spotPrices.get(parent);
    const spot = spotInfo?.price ?? 0;
    const spotSource = spotInfo?.source ?? "unavailable";
    let spotReported = false;

    // Each tranche is its own grant at its own strike and expiry, so each becomes
    // its own row. What the ratio applies to differs by kind:
    //
    //   base tranche  -> SHARES held        (1:2 on 10,000 shares  = 5,000 options)
    //   piggyback     -> BASE OPTION count  (1:2 on 5,000 options  = 2,500 options)
    //
    // A piggyback is earned by exercising the base grant, not by holding stock, so
    // running it off the share count would roughly double the entitlement.
    //
    // `null` distinguishes "no base tranche seen yet" from "the base came to 0".
    let baseOptionQty: number | null = null;
    let created = 0;

    for (const addOn of unlistedAddOns) {
      if (addOn.piggyback && baseOptionQty === null) {
        // Nothing to piggyback on. Inventing a basis would fabricate a position, so
        // the grant is reported instead of guessed.
        unresolvedPiggybacks.push(`${parent} (${addOn.raw.trim()})`);
        continue;
      }

      const basisKind: "shares" | "base-options" = addOn.piggyback ? "base-options" : "shares";
      const basisQty = addOn.piggyback ? (baseOptionQty as number) : equityRow.buyQty;

      const optionQty = Math.floor((basisQty * addOn.ratioOptions) / addOn.ratioPerShares);

      // Recorded even when 0, so a base too small to grant anything correctly
      // zeroes its piggyback rather than leaving it looking unresolved.
      if (!addOn.piggyback) baseOptionQty = optionQty;

      if (optionQty <= 0) continue;

      // No spot means no defensible price. The row is still created — the
      // entitlement is real and hiding it would understate the position — but it is
      // valued at 0 and reported in `skipped` so the desk knows why. Reported once
      // per name, however many tranches it has.
      if (spot <= 0 && !spotReported) {
        skipped.push(parent);
        spotReported = true;
      }

      const timeToExpiryYears = yearsToExpiry(new Date(`${addOn.expiry}T00:00:00Z`), asOf);
      const { volatility, riskFreeRate, dividendYield } = UNLISTED_OPTION_ASSUMPTIONS;

      const optionPrice = blackScholesCall({
        spot,
        strike: addOn.strike,
        timeToExpiryYears,
        volatility,
        riskFreeRate,
        dividendYield,
      });

      const sellValue = Math.round(optionPrice * optionQty * 100) / 100;

      // First tranche keeps the bare `-UO` code; later ones are numbered so two
      // grants on the same underlying never collide on one row key.
      created++;
      const suffix = created === 1 ? UNLISTED_OPTION_SUFFIX : `${UNLISTED_OPTION_SUFFIX}${created}`;
      const label = addOn.note ? ` ${addOn.note}` : "";

      rows.push({
        ticker: `${parent}${suffix}`,
        parentTicker: parent,
        instrument: "OPTION",
        company: `${equityRow.company} — Unlisted Option${label} ${addOn.ratioOptions}:${addOn.ratioPerShares} @$${addOn.strike} exp ${addOn.expiry}${
          addOn.expiryAssumed ? " (assumed)" : ""
        }`,
        buyQty: 0,
        sellQty: optionQty,
        buyPrice: 0,
        sellPrice: sellValue,
        totalBuyValue: 0,
        totalSellValue: sellValue,
        // Free options, so the entire modelled value is the gain.
        pnlCalculated: sellValue,
        isMatched: false,
        isOption: true,
        hasOptionCode: true,
        isUnlistedOption: true,
        comment: "Unlisted Options",
        openQty: -optionQty,
        tradeCount: 0,
        unlistedOption: {
          addOn,
          sharesHeld: equityRow.buyQty,
          basisQty,
          basisKind,
          spot,
          spotSource,
          timeToExpiryYears,
          optionPrice,
          volatility,
          riskFreeRate,
          dividendYield,
          valuedAt: asOf.toISOString(),
        },
      });
      addedCount++;
    }
  }

  rows.sort(compareSummaryItems);

  const totalPnl = Math.round(rows.reduce((acc, curr) => acc + curr.pnlCalculated, 0) * 100) / 100;

  return {
    summary: rows,
    addedCount,
    skipped: skipped.sort(),
    unresolvedPiggybacks: unresolvedPiggybacks.sort(),
    totalPnl,
  };
}
