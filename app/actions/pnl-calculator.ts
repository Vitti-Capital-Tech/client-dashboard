"use server";

import {
  parsePnlFileBuffer,
  buildPnlExportXlsxBuffer,
  buildPnlExportCsvString,
  type ParseResult,
  type PnlSummaryItem,
} from "@/lib/pnl-calculator";

/**
 * Server action to parse an uploaded Excel or CSV trade file in-memory.
 * Zero database calls or storage.
 */
export async function parsePnlFileAction(formData: FormData): Promise<ParseResult> {
  const file = formData.get("file") as File | null;
  if (!file) {
    return {
      summary: [],
      rawTrades: [],
      totalPnl: 0,
      totalTrades: 0,
      uniqueTickers: 0,
      errors: ["No file uploaded."],
    };
  }

  try {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    return await parsePnlFileBuffer(buffer, file.name || "trades.xlsx");
  } catch (err: any) {
    console.error("Error parsing P&L file:", err);
    return {
      summary: [],
      rawTrades: [],
      totalPnl: 0,
      totalTrades: 0,
      uniqueTickers: 0,
      errors: [err.message || "Failed to process the uploaded file."],
    };
  }
}

/**
 * Server action to generate an Excel (.xlsx) export buffer (base64) for download.
 */
export async function exportPnlXlsxAction(
  summaryRows: PnlSummaryItem[]
): Promise<{ base64: string; filename: string }> {
  const buffer = await buildPnlExportXlsxBuffer(summaryRows);
  const base64 = buffer.toString("base64");
  const isoDate = new Date().toISOString().split("T")[0];
  const filename = `pnl-summary-calculated-${isoDate}.xlsx`;
  return { base64, filename };
}

/**
 * Server action to generate a CSV export string for download.
 */
export async function exportPnlCsvAction(
  summaryRows: PnlSummaryItem[]
): Promise<{ csv: string; filename: string }> {
  const csv = buildPnlExportCsvString(summaryRows);
  const isoDate = new Date().toISOString().split("T")[0];
  const filename = `pnl-summary-calculated-${isoDate}.csv`;
  return { csv, filename };
}
