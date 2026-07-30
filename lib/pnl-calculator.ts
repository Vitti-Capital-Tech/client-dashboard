import ExcelJS from "exceljs";

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

export interface PnlSummaryItem {
  ticker: string;
  company: string;
  buyQty: number;
  sellQty: number;
  buyPrice: number; // Sum of Buy Prices / Value
  sellPrice: number; // Sum of Sell Prices / Value
  totalBuyValue: number; // Total Cost paid
  totalSellValue: number; // Total Proceeds received
  pnlCalculated: number; // Total Sell Value - Total Buy Value
  isMatched: boolean; // true when buyQty === sellQty
  isOption: boolean; // true when buyQty !== sellQty (option / unmatched parcel)
  isEdited?: boolean; // true if manually adjusted by staff
  isEnriched?: boolean; // true if merged with placement tracker data
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
 * Parses trade rows from an Excel or CSV Buffer completely in-memory.
 */
export async function parsePnlFileBuffer(
  buffer: Buffer,
  filename: string
): Promise<ParseResult> {
  const isCsv = filename.toLowerCase().endsWith(".csv");
  const workbook = new ExcelJS.Workbook();
  const errors: string[] = [];
  const rawTrades: ParsedTradeRow[] = [];

  if (isCsv) {
    // Read as CSV
    const { Readable } = await import("stream");
    const stream = Readable.from(buffer);
    await workbook.csv.read(stream);
  } else {
    // Read as Excel XLSX/XLS
    await workbook.xlsx.load(buffer as any);
  }

  const worksheet = workbook.worksheets[0];
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

  // Identify column headers from row 1
  const headerRow = worksheet.getRow(1);
  const colMap: Record<string, number> = {};

  headerRow.eachCell((cell, colNumber) => {
    const rawVal = parseStr(cell.value);
    const key = normHeader(rawVal);
    if (key) colMap[key] = colNumber;
  });

  // Helper to find column index by multiple possible alias names
  const getCol = (aliases: string[]): number | undefined => {
    for (const alias of aliases) {
      const norm = normHeader(alias);
      if (colMap[norm] != null) return colMap[norm];
    }
    return undefined;
  };

  const colType = getCol(["type", "side", "tradetype", "buysell"]);
  const colSecurity = getCol(["security", "ticker", "code", "securitycode", "symbol"]);
  const colCompany = getCol(["company", "description", "name", "securityname"]);
  const colUnits = getCol(["units", "qty", "quantity", "volume"]);
  const colAvgPrice = getCol(["avgprice", "price", "unitprice", "rate"]);
  const colValue = getCol(["value", "consideration", "totalvalue", "amount", "netvalue"]);
  const colCNote = getCol(["cnote", "contractnote", "ref", "reference"]);
  const colAccount = getCol(["account", "accountno", "clientcode"]);
  const colDate = getCol(["contractdate", "date", "tradedate"]);
  const colStatus = getCol(["status"]);

  if (!colType || !colSecurity || (!colUnits && !colValue)) {
    return {
      summary: [],
      rawTrades: [],
      totalPnl: 0,
      totalTrades: 0,
      uniqueTickers: 0,
      matchedTickers: 0,
      optionTickers: 0,
      errors: [
        "Required columns could not be mapped. Please ensure the file includes columns for Type (BUY/SELL), Security (Ticker), and Units/Qty.",
      ],
    };
  }

  // Iterate data rows starting from row 2
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // Skip header

    const typeRaw = parseStr(colType ? row.getCell(colType).value : "").toUpperCase();
    const tickerRaw = parseStr(colSecurity ? row.getCell(colSecurity).value : "").toUpperCase();

    if (!tickerRaw || (typeRaw !== "BUY" && typeRaw !== "SELL")) {
      return; // Skip invalid or non-trade rows
    }

    const units = parseNum(colUnits ? row.getCell(colUnits).value : 0);
    const avgPrice = parseNum(colAvgPrice ? row.getCell(colAvgPrice).value : 0);
    let value = parseNum(colValue ? row.getCell(colValue).value : 0);

    if (value === 0 && units > 0 && avgPrice > 0) {
      value = Math.round(units * avgPrice * 100) / 100;
    }

    const status = colStatus ? parseStr(row.getCell(colStatus).value).toUpperCase() : "SETTLED";

    // ONLY SETTLED trades are considered for PNL calculation
    if (status !== "SETTLED") {
      return;
    }

    rawTrades.push({
      cnote: colCNote ? parseStr(row.getCell(colCNote).value) : undefined,
      account: colAccount ? parseStr(row.getCell(colAccount).value) : undefined,
      type: typeRaw as "BUY" | "SELL",
      ticker: tickerRaw,
      company: colCompany ? parseStr(row.getCell(colCompany).value) : tickerRaw,
      contractDate: colDate ? parseStr(row.getCell(colDate).value) : undefined,
      units,
      avgPrice,
      value,
      status,
    });
  });

  // Aggregate by Parent Ticker (e.g. EOSXX -> EOS, ACWXX -> ACW)
  const tickerMap = new Map<string, PnlSummaryItem>();

  for (const t of rawTrades) {
    const parent = getParentTicker(t.ticker);
    let item = tickerMap.get(parent);
    if (!item) {
      item = {
        ticker: parent,
        company: t.company || parent,
        buyQty: 0,
        sellQty: 0,
        buyPrice: 0,
        sellPrice: 0,
        totalBuyValue: 0,
        totalSellValue: 0,
        pnlCalculated: 0,
        isMatched: false,
        isOption: true,
        openQty: 0,
        tradeCount: 0,
      };
      tickerMap.set(parent, item);
    } else if (t.ticker.length === 3 && t.company) {
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
    const isOption = !isMatched;

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

  // Sort summary by largest P&L descending
  summary.sort((a, b) => b.pnlCalculated - a.pnlCalculated || a.ticker.localeCompare(b.ticker));

  // Total PnL sums all positions
  const totalPnl = summary.reduce((acc, curr) => acc + curr.pnlCalculated, 0);

  const matchedTickers = summary.filter((s) => s.isMatched).length;
  const optionTickers = summary.filter((s) => s.isOption).length;

  return {
    summary,
    rawTrades,
    totalPnl: Math.round(totalPnl * 100) / 100,
    totalTrades: rawTrades.length,
    uniqueTickers: summary.length,
    matchedTickers,
    optionTickers,
    errors,
  };
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
    { header: "Buy Qty (Sum)", key: "buyQty", width: 16, style: { numFmt: QTY_FMT } },
    { header: "Sell Qty (Sum)", key: "sellQty", width: 16, style: { numFmt: QTY_FMT } },
    { header: "Buy Price (Sum)", key: "buyPrice", width: 18, style: { numFmt: MONEY_FMT } },
    { header: "Sell Price (Sum)", key: "sellPrice", width: 18, style: { numFmt: MONEY_FMT } },
    { header: "PnL Calculated", key: "pnlCalculated", width: 18, style: { numFmt: MONEY_FMT } },
    { header: "Status", key: "status", width: 16 },
    { header: "Open Qty", key: "openQty", width: 14, style: { numFmt: QTY_FMT } },
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

  for (const item of summary) {
    const row = ws.addRow({
      ticker: item.ticker,
      company: item.company,
      buyQty: item.buyQty,
      sellQty: item.sellQty,
      buyPrice: item.buyPrice,
      sellPrice: item.sellPrice,
      pnlCalculated: item.pnlCalculated,
      status: item.isMatched ? "Matched" : "Option / Unmatched",
      openQty: item.openQty,
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
    buyQty: "",
    sellQty: "",
    buyPrice: totalBuyPrice,
    sellPrice: totalSellPrice,
    pnlCalculated: totalPnl,
    status: "",
    openQty: "",
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
    "Buy Qty (Sum)",
    "Sell Qty (Sum)",
    "Buy Price",
    "Sell Price",
    "PnL Calculated",
    "Status",
    "Open Qty",
  ];

  const escapeCsv = (val: any) => {
    const s = String(val == null ? "" : val);
    if (/[",\r\n]/.test(s)) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const lines = [
    headers.join(","),
    ...summary.map((item) =>
      [
        item.ticker,
        item.company,
        item.buyQty,
        item.sellQty,
        item.buyPrice.toFixed(2),
        item.sellPrice.toFixed(2),
        item.pnlCalculated.toFixed(2),
        item.isMatched ? "Matched" : item.isEdited ? "Edited" : "Option / Unmatched",
        item.openQty,
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
 * Merges parsed Placement Tracker data into an existing PNL Summary.
 * Fills missing Buy Qty (from Round Shares) & Buy Price (from ACTUAL $) for account holder matching filename stem.
 */
export function mergePlacementTrackerIntoSummary(
  summary: PnlSummaryItem[],
  placementData: Map<string, PlacementTickerInfo>,
  fileStem?: string
): { summary: PnlSummaryItem[]; mergedCount: number; totalPnl: number } {
  const updatedSummary = summary.map((item) => ({ ...item }));
  let mergedCount = 0;

  for (const [rawTicker, info] of placementData.entries()) {
    const parentTicker = getParentTicker(rawTicker);
    const existing = updatedSummary.find((s) => getParentTicker(s.ticker) === parentTicker);

    if (existing) {
      // Find allocations for the matching account holder if fileStem is specified
      let matchedAllocations = info.clientAllocations;
      if (fileStem && fileStem.trim()) {
        matchedAllocations = info.clientAllocations.filter((alloc) =>
          isClientMatch(alloc.clientName, fileStem)
        );
      }

      if (matchedAllocations.length > 0) {
        const addedQty = matchedAllocations.reduce((sum, a) => sum + a.roundShares, 0);
        const addedPrice = matchedAllocations.reduce((sum, a) => sum + a.actualDollar, 0);

        if (addedQty > 0 || addedPrice > 0) {
          existing.buyQty += addedQty;
          existing.buyPrice = Math.round((existing.buyPrice + addedPrice) * 100) / 100;
          existing.totalBuyValue = existing.buyPrice;

          existing.pnlCalculated = Math.round((existing.sellPrice - existing.buyPrice) * 100) / 100;
          existing.openQty = existing.buyQty - existing.sellQty;
          existing.isMatched = existing.buyQty === existing.sellQty && existing.buyQty > 0;
          existing.isOption = !existing.isMatched;
          existing.isEnriched = true;
          existing.clientAllocations = matchedAllocations;
          mergedCount++;
        }
      }
    }
  }

  // Sort by pnlCalculated descending
  updatedSummary.sort((a, b) => b.pnlCalculated - a.pnlCalculated || a.ticker.localeCompare(b.ticker));

  const totalPnl = Math.round(updatedSummary.reduce((acc, curr) => acc + curr.pnlCalculated, 0) * 100) / 100;

  return { summary: updatedSummary, mergedCount, totalPnl };
}
