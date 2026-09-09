import ExcelJS from "exceljs";
import {
  grandTotal,
  isStillHeld,
  positionStatus,
  type PnlSummaryRow,
} from "./order-history.ts";

/**
 * The P&L summary as a real `.xlsx`.
 *
 * **Server-side only.** ExcelJS is ~1 MB; this module is imported solely by the
 * `app/actions/exports.ts` server action so none of it reaches the browser. It
 * deliberately does not `import "server-only"` — that would also break the
 * plain-Node test runner, and the single-importer rule is what keeps it out of
 * the client bundle.
 *
 * Kept separate from the action so the workbook itself — fills, number formats,
 * the total row — can be generated and read back in a test.
 */

const FILL_OPEN = "FFFFF3CD"; // amber — position still held, in whole or in part
const FILL_CLOSED = "FFD4EDDA"; // green — fully exited
// Neither. The row's own figures are blank, so painting it green would report
// a disposal nobody has evidence of, and amber a holding nobody can size.
const FILL_UNKNOWN = "FFEDEBE4";
const FILL_TOTAL = "FFE7E4DC";
const FILL_HEADER = "FF1D202F";
const INK_FLAG = "FFB8442B";
const MONEY = "#,##0.00";
const QTY = "#,##0";

export const XLSX_FILLS = { FILL_OPEN, FILL_CLOSED, FILL_UNKNOWN, FILL_TOTAL, INK_FLAG };

/**
 * One contract note, as the broker confirmed it.
 *
 * Declared here rather than imported from the DAL because this module is also
 * exercised by the plain-Node test runner, which cannot load `server-only`.
 * Structurally a `TradeRow` minus the identifiers the sheet does not need.
 */
export type TradeLedgerRow = {
  tradeDate: string;
  code: string;
  name: string;
  side: string;
  units: number;
  avgPrice: number;
  consideration: number;
  brokerage: number;
  otherCharges: number;
  gst: number;
  value: number;
  cnote: string;
  status: string;
};

export async function buildPnlSummaryWorkbook(
  rows: PnlSummaryRow[],
  title: string,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Vitti Capital";

  const ws = wb.addWorksheet("P&L summary", {
    views: [{ state: "frozen", ySplit: 1 }], // header stays put while scrolling
  });

  ws.columns = [
    { header: "Row Labels", key: "ticker", width: 12 },
    { header: "Company", key: "name", width: 34 },
    { header: "Buy Qty", key: "buyQty", width: 12, style: { numFmt: QTY } },
    { header: "Sell Qty", key: "sellQty", width: 12, style: { numFmt: QTY } },
    { header: "Buy Price", key: "buy", width: 15, style: { numFmt: MONEY } },
    {
      header: "Sell Price / Current Price",
      key: "sell",
      width: 24,
      style: { numFmt: MONEY },
    },
    { header: "PnL", key: "pnl", width: 15, style: { numFmt: MONEY } },
    { header: "Position", key: "open", width: 15 },
    { header: "Type", key: "type", width: 38 },
  ];

  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: FILL_HEADER } };
  header.height = 20;

  for (const r of rows) {
    // ONE call decides both the word in the cell and the colour of the row, so
    // a line can never read `Closed` on a green fill and `Open` on an amber one.
    const status = positionStatus(r);

    const isOpt = Boolean(
      r.isOption ||
      r.isUnlistedOption ||
      r.ticker.endsWith("-UO") ||
      r.type.toLowerCase().includes("option")
    );
    const bQty = isOpt ? (r.buyQty || r.sellQty) : r.buyQty;
    const sQty = isOpt ? (r.sellQty || r.buyQty) : r.sellQty;

    const row = ws.addRow({
      ticker: r.ticker,
      name: r.name,
      buyQty: bQty,
      sellQty: sQty,
      // Real numbers, never strings — otherwise the Grand Total and any pivot
      // the desk builds on top of this would silently not add up.
      buy: r.buyPrice,
      sell: r.sellOrCurrent,
      pnl: r.pnl,
      open: status,
      type: r.type,
    });

    row.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: {
        argb:
          status === "Unknown"
            ? FILL_UNKNOWN
            : isStillHeld(status)
            ? FILL_OPEN
            : FILL_CLOSED,
      },
    };
    // A flag outranks the open/closed fill, so it takes the font rather than
    // the background — both signals then stay readable at once.
    if (r.flagged) row.font = { bold: true, color: { argb: INK_FLAG } };
  }

  const total = grandTotal(rows);
  // Quantities are deliberately not totalled — units of different companies
  // are not the same thing, so a sum of them would be meaningless.
  const totalRow = ws.addRow({
    ticker: "Grand Total",
    buy: total.buyPrice,
    sell: total.sellOrCurrent,
    pnl: total.pnl,
  });
  totalRow.font = { bold: true };
  totalRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: FILL_TOTAL } };
  totalRow.eachCell((c) => {
    c.border = { top: { style: "double" } };
  });

  // Filter the data rows only — the total must never sort into the middle.
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, rows.length + 1), column: 9 },
  };

  ws.addRow([]);
  const legend = ws.addRow([
    "Position — Open = still held · Partly open = part-sold, a parcel remains · Closed = fully exited · Unknown = the buy side could not be resolved, so nothing can be said about what is left. Amber = still held · Green = fully exited · Red bold = the trade ledger and the holdings snapshot disagree, check before relying on the figure.",
  ]);
  legend.font = { size: 9, color: { argb: "FF6E7180" } };

  const titleRow = ws.addRow([title]);
  titleRow.font = { size: 9, color: { argb: "FF6E7180" } };

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * The trade ledger as a real `.xlsx` — one row per contract note.
 *
 * Separate from the P&L summary workbook on purpose. That one answers "what did
 * these holdings make" and pools a company's trades to do it; this is the
 * unpooled record a client hands an accountant, in the shape the confirmations
 * arrived in.
 *
 * Consideration, fees and net are three columns rather than one, because a
 * return needs the proceeds and the deductible costs separately and the split
 * is otherwise only in the PDFs.
 *
 * Cancelled and reversed notes are included with their status. A ledger that
 * silently drops rows cannot be reconciled against the client's own paperwork,
 * which is the one thing it has to be good for.
 */
export async function buildTradeLedgerWorkbook(
  rows: TradeLedgerRow[],
  title: string,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Vitti Capital";

  const ws = wb.addWorksheet("Transactions", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  ws.columns = [
    { header: "Trade date", key: "tradeDate", width: 13 },
    { header: "Code", key: "code", width: 12 },
    { header: "Company", key: "name", width: 34 },
    { header: "Side", key: "side", width: 8 },
    { header: "Units", key: "units", width: 14, style: { numFmt: QTY } },
    { header: "Price", key: "avgPrice", width: 12, style: { numFmt: "#,##0.0000" } },
    { header: "Consideration", key: "consideration", width: 15, style: { numFmt: MONEY } },
    { header: "Brokerage", key: "brokerage", width: 12, style: { numFmt: MONEY } },
    { header: "Other charges", key: "otherCharges", width: 14, style: { numFmt: MONEY } },
    { header: "GST", key: "gst", width: 10, style: { numFmt: MONEY } },
    { header: "Net value", key: "value", width: 14, style: { numFmt: MONEY } },
    { header: "Contract note", key: "cnote", width: 16 },
    { header: "Status", key: "status", width: 12 },
  ];

  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: FILL_HEADER } };
  header.alignment = { vertical: "middle" };

  for (const r of rows) {
    const row = ws.addRow({
      tradeDate: r.tradeDate,
      code: r.code,
      name: r.name,
      side: r.side,
      units: r.units,
      avgPrice: r.avgPrice,
      consideration: r.consideration,
      brokerage: r.brokerage,
      otherCharges: r.otherCharges,
      gst: r.gst,
      value: r.value,
      cnote: r.cnote,
      status: r.status,
    });

    // A note that did not settle is marked rather than dropped — see the header.
    if (r.status !== "SETTLED") {
      row.font = { color: { argb: INK_FLAG } };
    }
  }

  ws.autoFilter = { from: "A1", to: { row: 1, column: ws.columns.length } };
  ws.getCell("A1").note = title;

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out);
}
