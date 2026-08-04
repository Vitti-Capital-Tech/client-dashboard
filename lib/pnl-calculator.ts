import ExcelJS from "exceljs";
import * as XLSX from "xlsx";

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

export interface PlacementTickerInfo {
  ticker: string;
  company?: string;
  issuePrice?: number;
  leadManager?: string;
  totalShares: number;
  totalActualDollar: number;
  clientAllocations: PlacementClientAllocation[];
}

/** Equity/ordinary line vs a listed option line — kept as separate P&L rows. */
export type PnlInstrument = "EQUITY" | "OPTION";

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
  isPartialExit?: boolean; // true when a still-held parcel was ADDED on top of a realised part-sale
  isPartialBuy?: boolean; // true when a Placement allocation was ADDED on top of a short buy side
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
    { header: "Open Qty", key: "openQty", width: 14, style: { numFmt: QTY_FMT } },
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
      status: item.isMatched ? "Matched" : "Unmatched",
      openQty: item.openQty,
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
    openQty: "",
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
    "Open Qty",
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
        item.isMatched ? "Matched" : item.isEdited ? "Edited" : "Unmatched",
        item.openQty,
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
 * Parses a multi-sheet Placement Tracker Excel file buffer (containing Overview and individual Ticker tabs).
 * Focuses on Round Shares (Buy Qty) and ACTUAL $ (Buy Consideration) for each Account Holder / Client.
 */
export async function parsePlacementTrackerBuffer(
  buffer: ArrayBuffer | Buffer
): Promise<Map<string, PlacementTickerInfo>> {
  const workbook = new ExcelJS.Workbook();
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as any);

  try {
    await workbook.xlsx.load(buf as any);
  } catch (err: any) {
    if (err.message && (err.message.includes("central directory") || err.message.includes("zip"))) {
      throw new Error(
        "The file/link provided is not a valid .xlsx Excel workbook (or link requires login). If using Google Sheets, make sure link sharing is set to 'Anyone with the link can view' or upload a saved .xlsx file."
      );
    }
    throw err;
  }

  const placementMap = new Map<string, PlacementTickerInfo>();

  // Exclude non-ticker system/utility sheets
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

  workbook.eachSheet((worksheet) => {
    const rawSheetName = worksheet.name.trim();
    const normSheetName = normHeader(rawSheetName);

    if (ignoredSheets.has(normSheetName) || normSheetName.length === 0) {
      return;
    }

    // Extract ticker from sheet name e.g. "FIN (b)" -> "FIN", "ZEU" -> "ZEU"
    const cleanedTicker = rawSheetName.split(/\s|\(/)[0].trim().toUpperCase();
    if (!cleanedTicker || cleanedTicker.length < 2) return;

    const parentTicker = getParentTicker(cleanedTicker);

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

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (headerRowIdx !== -1 || rowNumber > 25) return;

      const cells = row.values as any[];
      if (!Array.isArray(cells)) return;

      cells.forEach((cellVal, colIdx) => {
        const str = normHeader(extractCellValue(cellVal));
        if (str.includes("clientname") || str === "client" || str.includes("accountname")) {
          headerRowIdx = rowNumber;
        }
      });

      if (headerRowIdx === rowNumber) {
        cells.forEach((cellVal, colIdx) => {
          const str = normHeader(extractCellValue(cellVal));
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
    });

    if (headerRowIdx === -1 || colClient === -1) return;

    const allocations: PlacementClientAllocation[] = [];
    let totalShares = 0;
    let totalActualDollar = 0;

    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber <= headerRowIdx) return;

      const cells = row.values as any[];
      if (!Array.isArray(cells)) return;

      const clientName = String(extractCellValue(cells[colClient]) || "").trim();
      const normClient = normHeader(clientName);

      if (!clientName || normClient === "total" || normClient === "grandtotal" || normClient === "subtotal" || normClient === "sum") {
        return;
      }

      const parseNum = (col: number) => {
        if (col === -1 || col >= cells.length) return 0;
        const v = extractCellValue(cells[col]);
        if (typeof v === "number") return v;
        const n = parseFloat(String(v || "").replace(/[^0-9.-]/g, ""));
        return isNaN(n) ? 0 : n;
      };

      const advisor = colAdvisor !== -1 ? String(extractCellValue(cells[colAdvisor]) || "").trim() : "";
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
    });

    if (allocations.length > 0) {
      placementMap.set(parentTicker, {
        ticker: parentTicker,
        totalShares,
        totalActualDollar: Math.round(totalActualDollar * 100) / 100,
        clientAllocations: allocations,
      });
    }
  });

  return placementMap;
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
 * Rebuilds `comment` from the partial-merge flags.
 *
 * Derived rather than assigned so the two merges stay order-independent: a row
 * that is topped up on both sides (short buy from the Placement Tracker, part-sale
 * valued from the DB) ends up reading "Partial Buy · Partial Exit" whichever merge
 * ran last, instead of one clobbering the other's note.
 */
function applyPartialComment(item: PnlSummaryItem): void {
  const notes: string[] = [];
  if (item.isPartialBuy) notes.push("Partial Buy");
  if (item.isPartialExit) notes.push("Partial Exit");
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
          applyPartialComment(existing);
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
export function mergeDbHoldingsIntoSummary(
  summary: PnlSummaryItem[],
  dbHoldings: Array<{
    accountRef?: string;
    ticker: string;
    parentTicker?: string;
    qty: number;
    marketValue: number;
  }>
): { summary: PnlSummaryItem[]; mergedCount: number; partialExitCount: number; totalPnl: number } {
  const updatedSummary = summary.map((item) => ({ ...item }));
  let mergedCount = 0;
  let partialExitCount = 0;

  for (const item of updatedSummary) {
    const isFullyOpen = item.sellQty === 0 || item.sellPrice === 0;
    // A part-sale still holding a remainder. Requires a real buy side to compare
    // against, so a sell-only row (buyQty 0) never qualifies.
    const isPartialExit =
      !isFullyOpen && item.buyQty > 0 && item.sellQty > 0 && item.sellQty < item.buyQty;

    if (!isFullyOpen && !isPartialExit) continue;

    const parent = summaryParentTicker(item);
    const wantOption = isOptionRow(item);
    // An option row can only be valued by an option holding of the same code —
    // valuing GEDO at the GED share price would be wildly wrong.
    const match = dbHoldings.find((h) => {
      const hCode = String(h.ticker || "").trim().toUpperCase();
      if (isOptionCode(hCode) !== wantOption) return false;
      if (wantOption ? hCode !== item.ticker.toUpperCase() : getParentTicker(hCode) !== parent) return false;
      return h.qty > 0 || h.marketValue > 0;
    });

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
      applyPartialComment(item);
      partialExitCount++;
    } else {
      if (item.sellQty === 0 && match.qty > 0) {
        item.sellQty = match.qty;
      }
      if (item.sellPrice === 0 && match.marketValue > 0) {
        item.sellPrice = Math.round(match.marketValue * 100) / 100;
        item.totalSellValue = item.sellPrice;
      }
    }

    item.pnlCalculated = Math.round((item.sellPrice - item.buyPrice) * 100) / 100;
    item.openQty = item.buyQty - item.sellQty;
    item.isMatched = item.buyQty === item.sellQty && item.buyQty > 0;
    item.isDbMarketValued = true;
    mergedCount++;
  }

  updatedSummary.sort(compareSummaryItems);

  const totalPnl = Math.round(updatedSummary.reduce((acc, curr) => acc + curr.pnlCalculated, 0) * 100) / 100;

  return { summary: updatedSummary, mergedCount, partialExitCount, totalPnl };
}
