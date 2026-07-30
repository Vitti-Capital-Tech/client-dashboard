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

export interface PnlSummaryItem {
  ticker: string;
  company: string;
  buyQty: number;
  sellQty: number;
  buyPrice: number; // Sum of Buy Prices / Value
  sellPrice: number; // Sum of Sell Prices / Value
  totalBuyValue: number; // Total Cost paid
  totalSellValue: number; // Total Proceeds received
  pnlCalculated: number; // Total Sell Value - Total Buy Value (Calculated ONLY when buyQty === sellQty)
  isMatched: boolean; // true when buyQty === sellQty
  isOption: boolean; // true when buyQty !== sellQty (option / unmatched parcel)
  openQty: number; // buyQty - sellQty
  tradeCount: number;
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

    // ONLY calculate PnL if buy and sell qty match!
    const pnlCalculated = isMatched
      ? Math.round((sellPrice - buyPrice) * 100) / 100
      : 0;

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

  // Sort summary: Matched items first by largest P&L, then Option/Unmatched items
  summary.sort((a, b) => {
    if (a.isMatched !== b.isMatched) return a.isMatched ? -1 : 1;
    return b.pnlCalculated - a.pnlCalculated || a.ticker.localeCompare(b.ticker);
  });

  // Total PnL sums ONLY matched positions where buyQty === sellQty
  const totalPnl = summary
    .filter((s) => s.isMatched)
    .reduce((acc, curr) => acc + curr.pnlCalculated, 0);

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

  // Grand Total Row (sums ONLY matched positions)
  const matchedSummary = summary.filter((i) => i.isMatched);
  const totalBuyPrice = matchedSummary.reduce((s, i) => s + i.buyPrice, 0);
  const totalSellPrice = matchedSummary.reduce((s, i) => s + i.sellPrice, 0);
  const totalPnl = matchedSummary.reduce((s, i) => s + i.pnlCalculated, 0);

  const totalRow = ws.addRow({
    ticker: "Grand Total (Matched)",
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
        item.isMatched ? "Matched" : "Option / Unmatched",
        item.openQty,
      ]
        .map(escapeCsv)
        .join(",")
    ),
  ];

  const matchedSummary = summary.filter((i) => i.isMatched);
  const totalBuyPrice = matchedSummary.reduce((s, i) => s + i.buyPrice, 0);
  const totalSellPrice = matchedSummary.reduce((s, i) => s + i.sellPrice, 0);
  const totalPnl = matchedSummary.reduce((s, i) => s + i.pnlCalculated, 0);

  lines.push(
    [
      "Grand Total (Matched)",
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
