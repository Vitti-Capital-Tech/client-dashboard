import ExcelJS from "exceljs";
import * as XLSX from "xlsx";
import {
  blackScholesCall,
  yearsToExpiry,
  UNLISTED_OPTION_ASSUMPTIONS,
} from "./black-scholes.ts";

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
  listed: boolean;
}

export interface PlacementTickerInfo {
  ticker: string;
  company?: string;
  issuePrice?: number;
  leadManager?: string;
  totalShares: number;
  totalActualDollar: number;
  clientAllocations: PlacementClientAllocation[];
  /** Every grant parsed out of the Overview sheet's Add-Ons cell, in cell order. */
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

/**
 * Aggregates an array of parsed trade rows into ticker-level summary items.
 *
 * Equity and options on the same underlying are separate rows: GED (ordinary,
 * incl. non-option derivatives like GEDXX) and GEDO (option) each get their own
 * line, so their P&L is never netted against each other.
 */
export function aggregateTradesToSummary(rawTrades: ParsedTradeRow[]): { summary: PnlSummaryItem[]; totalPnl: number } {
  const tickerMap = new Map<string, PnlSummaryItem>();

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

  ws.columns = [
    { header: "Ticker", key: "ticker", width: 14 },
    { header: "Company", key: "company", width: 32 },
    { header: "Instrument", key: "instrument", width: 13 },
    { header: "Underlying", key: "underlying", width: 13 },
    { header: "Buy Qty (Sum)", key: "buyQty", width: 16, style: { numFmt: QTY_FMT } },
    { header: "Sell Qty (Sum)", key: "sellQty", width: 16, style: { numFmt: QTY_FMT } },
    { header: "Buy Price (Sum)", key: "buyPrice", width: 18, style: { numFmt: MONEY_FMT } },
    { header: "Sell Price (Sum)", key: "sellPrice", width: 18, style: { numFmt: MONEY_FMT } },
    { header: "PnL Calculated", key: "pnlCalculated", width: 18, style: { numFmt: MONEY_FMT } },
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
    const row = ws.addRow({
      ticker: item.ticker,
      company: item.company,
      instrument: isOptionRow(item) ? "Option" : "Equity",
      underlying: summaryParentTicker(item),
      buyQty: item.buyQty,
      sellQty: item.sellQty,
      buyPrice: item.buyPrice,
      sellPrice: item.sellPrice,
      pnlCalculated: item.pnlCalculated,
      status: exportStatus(item),
      comment: item.comment ?? "",
    });

    // PnL cell highlighting
    const pnlCell = row.getCell("pnlCalculated");
    if (item.isMatched) {
      if (item.pnlCalculated > 0) {
        pnlCell.font = { color: { argb: "FF166534" }, bold: true }; // Green
      } else if (item.pnlCalculated < 0) {
        pnlCell.font = { color: { argb: "FF991B1B" }, bold: true }; // Red
      }
    } else {
      pnlCell.font = { color: { argb: "FF6B7280" }, italic: true };
    }
  }

  // Grand Total Row (sums all exported positions)
  const totalBuyPrice = summary.reduce((s, i) => s + i.buyPrice, 0);
  const totalSellPrice = summary.reduce((s, i) => s + i.sellPrice, 0);
  const totalPnl = summary.reduce((s, i) => s + i.pnlCalculated, 0);

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
    ...sortedSummary.map((item) =>
      [
        item.ticker,
        item.company,
        isOptionRow(item) ? "Option" : "Equity",
        summaryParentTicker(item),
        item.buyQty,
        item.sellQty,
        item.buyPrice.toFixed(2),
        item.sellPrice.toFixed(2),
        item.pnlCalculated.toFixed(2),
        item.isEdited && !item.isMatched ? "Edited" : exportStatus(item),
        item.comment ?? "",
      ]
        .map(escapeCsv)
        .join(",")
    ),
  ];

  const totalBuyPrice = summary.reduce((s, i) => s + i.buyPrice, 0);
  const totalSellPrice = summary.reduce((s, i) => s + i.sellPrice, 0);
  const totalPnl = summary.reduce((s, i) => s + i.pnlCalculated, 0);

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
  buffer: ArrayBuffer | Buffer
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
      placementMap.set(parentTicker, {
        ticker: parentTicker,
        totalShares,
        totalActualDollar: Math.round(totalActualDollar * 100) / 100,
        clientAllocations: allocations,
        addOns: addOnsByTicker.get(parentTicker),
      });
    }
  }

  // A ticker can carry an unlisted add-on while its allocation tab is absent from
  // THIS workbook (a prior year's placement, or a sheet not filled in). The option
  // entitlement is driven by the client's Buy Qty in the trade file, not by the
  // allocation rows, so it must survive with an empty allocation list — which the
  // `matchedAllocations.length > 0` guard in the merge treats as "nothing to fill".
  for (const [ticker, addOns] of addOnsByTicker.entries()) {
    if (placementMap.has(ticker)) continue;
    if (!addOns.some((a) => !a.listed)) continue;
    placementMap.set(ticker, {
      ticker,
      totalShares: 0,
      totalActualDollar: 0,
      clientAllocations: [],
      addOns,
    });
  }

  return placementMap;
}

/**
 * Reads the **Add-Ons** column off the Placement Tracker's Overview sheet.
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
function parseOverviewAddOns(buffer: Buffer): Map<string, PlacementAddOn[]> {
  const found = new Map<string, PlacementAddOn[]>();

  let rows: unknown[][];
  try {
    const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
    const sheetName = wb.SheetNames.find((n) => normHeader(n).includes("overview"));
    if (!sheetName) return found;
    rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], {
      header: 1,
      raw: false,
      defval: "",
    });
  } catch {
    // A CSV or a workbook SheetJS cannot open simply has no Overview to read.
    return found;
  }

  let headerRowIdx = -1;
  let colTicker = -1;
  let colAddOns = -1;

  for (let r = 0; r < Math.min(25, rows.length); r++) {
    const cells = rows[r];
    if (!Array.isArray(cells)) continue;

    let sawAddOns = -1;
    let sawTicker = -1;
    cells.forEach((cellVal, colIdx) => {
      const str = normHeader(String(cellVal ?? ""));
      if (str.startsWith("addon")) sawAddOns = colIdx;
      // The ticker column is headed "Counter" in the real workbook.
      else if (str === "counter" || str === "ticker" || str === "code" || str === "security") {
        sawTicker = colIdx;
      }
    });

    if (sawAddOns !== -1) {
      headerRowIdx = r;
      colAddOns = sawAddOns;
      colTicker = sawTicker;
      break;
    }
  }

  if (headerRowIdx === -1) return found;

  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    const cells = rows[r];
    if (!Array.isArray(cells)) continue;

    const specs = parseAddOnSpecs(cells[colAddOns]);
    if (specs.length === 0) continue;

    // Sheet names carry suffixes the Overview does not ("FIN (b)" vs "FIN"), so
    // normalise to the bare parent code the P&L table groups on.
    const rawTicker = String(cells[colTicker > -1 ? colTicker : 2] ?? "").trim();
    const ticker = getParentTicker(rawTicker.split(/\s|\(/)[0].toUpperCase());
    if (!ticker || ticker.length < 2) continue;

    // First row wins: a ticker placed twice in a year keeps its earliest add-ons
    // rather than silently adopting the later row's strikes.
    if (!found.has(ticker)) found.set(ticker, specs);
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
  if (item.isPartialBuy) notes.push("Partial Buy");
  if (item.isPartialExit) notes.push("Partial Exit");
  // "DB Holding" already implies an open position valued off the snapshot, so it
  // stands alone rather than reading "Open · DB Holding".
  else if (item.isDbOnly) notes.push("DB Holding");
  else if (item.isDbOpenValued) notes.push("Open");
  if (notes.length > 0) item.comment = notes.join(" · ");
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
} {
  const updatedSummary = summary.map((item) => ({ ...item }));
  let mergedCount = 0;
  let partialBuyCount = 0;
  const ambiguousTickers: string[] = [];

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
      // Keep only the allocation rows belonging to the account holder(s) in play.
      let matchedAllocations = hints.length
        ? info.clientAllocations.filter((alloc) =>
            hints.some((hint) => isClientMatch(alloc.clientName, hint))
          )
        : [];

      if (matchedAllocations.length === 0) {
        if (info.clientAllocations.length === 1) {
          // Only one participant — no ambiguity about whose allocation this is.
          matchedAllocations = info.clientAllocations;
        } else if (info.clientAllocations.length > 1) {
          ambiguousTickers.push(parentTicker);
        }
      }

      if (matchedAllocations.length > 0) {
        const placementQty = matchedAllocations.reduce((sum, a) => sum + a.roundShares, 0);
        const placementPrice = matchedAllocations.reduce((sum, a) => sum + a.actualDollar, 0);

        let updated = false;

        // A SHORT BUY side: units were sold that the ledger never saw bought, but
        // some buys ARE recorded — so the row is not simply blank. The placement
        // allocation is the missing parcel and is ADDED on top of what is already
        // there. Evaluated up front because the qty branch below mutates buyQty,
        // which would otherwise change the answer for the price branch.
        const isShortBuy =
          existing.buyQty > 0 && existing.sellQty > 0 && existing.buyQty < existing.sellQty;

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
          existing.clientAllocations = matchedAllocations;
          if (existing.isPartialBuy) partialBuyCount++;
          applyDerivedComment(existing);
          mergedCount++;
        }
      }
    }
  }

  updatedSummary.sort(compareSummaryItems);

  const totalPnl = Math.round(updatedSummary.reduce((acc, curr) => acc + curr.pnlCalculated, 0) * 100) / 100;

  return { summary: updatedSummary, mergedCount, partialBuyCount, totalPnl, ambiguousTickers };
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
 */
export function combinePlacementMaps(
  files: Array<{ map: Map<string, PlacementTickerInfo> }>
): Map<string, PlacementTickerInfo> {
  const combined = new Map<string, PlacementTickerInfo>();

  for (const f of files) {
    for (const [ticker, info] of f.map.entries()) {
      const existing = combined.get(ticker);

      if (!existing) {
        combined.set(ticker, {
          ticker: info.ticker,
          company: info.company,
          totalShares: info.totalShares,
          totalActualDollar: info.totalActualDollar,
          clientAllocations: info.clientAllocations.map((a) => ({ ...a })),
          addOns: info.addOns ? info.addOns.map((a) => ({ ...a })) : undefined,
        });
        continue;
      }

      existing.totalShares += info.totalShares;
      existing.totalActualDollar += info.totalActualDollar;

      if (!existing.addOns?.length && info.addOns?.length) {
        existing.addOns = info.addOns.map((a) => ({ ...a }));
      }

      for (const alloc of info.clientAllocations) {
        const found = existing.clientAllocations.find((a) => a.clientName === alloc.clientName);
        if (found) {
          found.roundShares += alloc.roundShares;
          found.actualDollar += alloc.actualDollar;
        } else {
          existing.clientAllocations.push({ ...alloc });
        }
      }
    }
  }

  return combined;
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
 * number AND the holder's name both go in the name.
 *
 * Multiple accounts drop the names and keep the numbers: concatenating several
 * "Mr Shaishav Kumar Patel + Mrs Vidushi Patel" would blow past path limits. Beyond
 * three, even the numbers are summarised.
 */
export function buildPnlExportFilename(args: {
  /** Account numbers in scope — the selected one, or every one in the file. */
  accounts: string[];
  accountHolders: Record<string, string>;
  /** `YYYY-MM-DD`. */
  isoDate: string;
  extension: "xlsx" | "csv";
}): string {
  const { accountHolders, isoDate, extension } = args;
  const accounts = [...new Set((args.accounts || []).map((a) => String(a || "").trim()).filter(Boolean))];

  const stamp = filenamePart(isoDate, 10);
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
    return `${base}-${accounts.map((a) => filenamePart(a, 24)).join("-")}-${stamp}.${extension}`;
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
    for (const alloc of info.clientAllocations) {
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
  }>
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

    // Same predicate as the fill pass, so a holding already merged into a row is
    // never given a second, duplicate row.
    const isOption = isOptionCode(code);
    const alreadyRepresented = updatedSummary.some((row) => dbHoldingMatchesRow(h, row));
    if (alreadyRepresented) continue;

    const costBase = Math.round((h.costBase ?? 0) * 100) / 100;
    const marketValue = Math.round(h.marketValue * 100) / 100;

    updatedSummary.push({
      ticker: code,
      parentTicker: h.parentTicker || getParentTicker(code),
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

  const totalPnl = Math.round(updatedSummary.reduce((acc, curr) => acc + curr.pnlCalculated, 0) * 100) / 100;

  return { summary: updatedSummary, mergedCount, partialExitCount, createdCount, totalPnl };
}

// ---------------------------------------------------------------------------
// Unlisted placement options
// ---------------------------------------------------------------------------

/** Suffix marking a synthetic unlisted-option row (`GRV` -> `GRV-UO`). */
export const UNLISTED_OPTION_SUFFIX = "-UO";

/** Matches a grant ratio like `1:3` or `1:20`. Also used to find tranche starts. */
const ADD_ON_RATIO = /(\d+)\s*:\s*(\d+)/g;

/**
 * Parses ONE tranche segment from an **Add-Ons** cell.
 *
 * The column is hand-typed, so the real workbook contains all of these:
 *
 *   1:1 @$0.04 Listed Exp 30/11/28      <- listed, ignored downstream
 *   1:2 @$1.20 Unlisted Exp 31/12/27
 *   1:1 @ $0.028 Unlisted Exp 31/01/29  <- space after @
 *   1:3@0.14 Unlisted Expiry 31/12/27   <- no space, no $, "Expiry"
 *   IPO / Entitlement Offer / 00:00     <- not an option at all
 *
 * Returns null unless a ratio, a strike AND an expiry are all present — a partial
 * segment is not enough to price anything, and guessing a missing strike would
 * invent a number. That requirement is also what rejects the `0:00` time cells.
 *
 * For a cell that may hold several grants use `parseAddOnSpecs`.
 */
export function parseAddOnSpec(rawText: unknown, tranche = 1): PlacementAddOn | null {
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
  if (!expiryMatch) return null;
  const expiry = isoFromDayFirst(expiryMatch[1], expiryMatch[2], expiryMatch[3]);
  if (!expiry) return null;

  // "Unlisted" CONTAINS "listed", so the negative has to be tested first.
  const listed = !/unlisted/i.test(raw);

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
    listed,
  };
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
 */
export function parseAddOnSpecs(rawText: unknown): PlacementAddOn[] {
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
    const spec = parseAddOnSpec(segment, specs.length + 1);
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

/** The ASX codes whose spot price an unlisted-option valuation needs. */
export function collectUnlistedOptionTickers(
  summary: PnlSummaryItem[],
  placementData: Map<string, PlacementTickerInfo>
): string[] {
  const wanted = new Set<string>();
  for (const [, info] of placementData.entries()) {
    if (!info.addOns?.some((a) => !a.listed)) continue;
    const parent = getParentTicker(info.ticker);
    // Only names the client actually holds shares in earn an entitlement.
    const equityRow = summary.find((s) => summaryParentTicker(s) === parent && !isOptionRow(s));
    if (equityRow && equityRow.buyQty > 0) wanted.add(parent);
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
    const unlistedAddOns = (info.addOns ?? []).filter((a) => !a.listed);
    if (unlistedAddOns.length === 0) continue;

    const parent = getParentTicker(info.ticker);
    const equityRow = rows.find((s) => summaryParentTicker(s) === parent && !isOptionRow(s));

    if (!equityRow || equityRow.buyQty <= 0) continue;

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
        company: `${equityRow.company} — Unlisted Option${label} ${addOn.ratioOptions}:${addOn.ratioPerShares} @$${addOn.strike} exp ${addOn.expiry}`,
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
