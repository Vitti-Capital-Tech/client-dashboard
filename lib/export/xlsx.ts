import ExcelJS from "exceljs";
import { grandTotal, type PnlSummaryRow } from "./order-history.ts";

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

const FILL_OPEN = "FFFFF3CD"; // amber — position still open
const FILL_CLOSED = "FFD4EDDA"; // green — fully exited
const FILL_TOTAL = "FFE7E4DC";
const FILL_HEADER = "FF1D202F";
const INK_FLAG = "FFB8442B";
const MONEY = "#,##0.00";
const QTY = "#,##0";

export const XLSX_FILLS = { FILL_OPEN, FILL_CLOSED, FILL_TOTAL, INK_FLAG };

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
    { header: "Open Positions", key: "open", width: 15 },
    { header: "Type", key: "type", width: 38 },
  ];

  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: FILL_HEADER } };
  header.height = 20;

  for (const r of rows) {
    const row = ws.addRow({
      ticker: r.ticker,
      name: r.name,
      buyQty: r.buyQty,
      sellQty: r.sellQty,
      // Real numbers, never strings — otherwise the Grand Total and any pivot
      // the desk builds on top of this would silently not add up.
      buy: r.buyPrice,
      sell: r.sellOrCurrent,
      pnl: r.pnl,
      open: r.openPosition ? "Yes" : "No",
      type: r.type,
    });

    row.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: r.openPosition ? FILL_OPEN : FILL_CLOSED },
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
    "Amber = position still open · Green = fully exited · Red bold = the trade ledger and the holdings snapshot disagree, check before relying on the figure.",
  ]);
  legend.font = { size: 9, color: { argb: "FF6E7180" } };

  const titleRow = ws.addRow([title]);
  titleRow.font = { size: 9, color: { argb: "FF6E7180" } };

  return Buffer.from(await wb.xlsx.writeBuffer());
}
