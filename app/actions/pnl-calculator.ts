"use server";

import {
  parsePnlFileBuffer,
  buildPnlExportXlsxBuffer,
  buildPnlExportCsvString,
  type ParseResult,
  type PnlSummaryItem,
  type PlacementTickerInfo,
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
      matchedTickers: 0,
      optionTickers: 0,
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
      matchedTickers: 0,
      optionTickers: 0,
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

/**
 * Normalizes a Google Sheets URL, Google Drive link, or SharePoint link to a direct Excel download URL.
 */
function normalizeExcelUrl(rawUrl: string): string {
  let url = rawUrl.trim();

  // Handle Google Sheets URLs
  const gsheetsMatch = url.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (gsheetsMatch && gsheetsMatch[1]) {
    return `https://docs.google.com/spreadsheets/d/${gsheetsMatch[1]}/export?format=xlsx`;
  }

  // Handle Google Drive File URLs
  const gdriveMatch = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9-_]+)/);
  if (gdriveMatch && gdriveMatch[1]) {
    return `https://docs.google.com/uc?export=download&id=${gdriveMatch[1]}`;
  }

  // Handle SharePoint / OneDrive links
  if (url.includes("sharepoint.com") || url.includes("1drv.ms")) {
    let converted = url.replace(/\/doc2?\.aspx/i, "/download.aspx");
    if (!converted.includes("download=1")) {
      const sep = converted.includes("?") ? "&" : "?";
      converted = `${converted}${sep}download=1`;
    }
    return converted;
  }

  return url;
}

/**
 * Server action to fetch a Placement Tracker from a direct URL (e.g. Google Sheets / SharePoint link).
 * Returns parsed placement ticker allocations array for client-side merge.
 */
export async function fetchPlacementTrackerUrlAction(
  url: string
): Promise<{ ok: boolean; placementItems: PlacementTickerInfo[]; error?: string }> {
  if (!url || !url.trim()) {
    return { ok: false, placementItems: [], error: "Please enter a valid file URL." };
  }

  try {
    const targetUrl = normalizeExcelUrl(url);
    const res = await fetch(targetUrl, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ClientDashboard/1.0",
      },
    });

    if (!res.ok) {
      return {
        ok: false,
        placementItems: [],
        error: `Failed to fetch URL (HTTP ${res.status}: ${res.statusText}). Make sure link sharing is set to 'Anyone with link can view'.`,
      };
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Check if the response is HTML (login/permission page) instead of binary Excel
    const snippet = buffer.toString("utf-8", 0, Math.min(buffer.length, 500)).toLowerCase();
    if (snippet.includes("<!doctype") || snippet.includes("<html") || snippet.includes("<body") || snippet.includes("google-signin")) {
      return {
        ok: false,
        placementItems: [],
        error: "The link returned an HTML page (access permission required) instead of an Excel file. Please set Google Sheet link sharing to 'Anyone with the link can view' or upload the .xlsx file directly.",
      };
    }

    const { parsePlacementTrackerBuffer, placementMapToArray } = await import("@/lib/pnl-calculator");
    const placementMap = await parsePlacementTrackerBuffer(buffer);

    if (placementMap.size === 0) {
      return {
        ok: false,
        placementItems: [],
        error: "No valid placement ticker sheets found in the linked document.",
      };
    }

    return {
      ok: true,
      placementItems: placementMapToArray(placementMap),
    };
  } catch (err: any) {
    console.error("Error fetching Placement Tracker URL:", err);
    return {
      ok: false,
      placementItems: [],
      error: err.message || "Failed to parse Placement Tracker from link.",
    };
  }
}

/**
 * Server action to parse a local Placement Tracker .xlsx file uploaded via FormData.
 * Returns parsed placement ticker allocations array for client-side merge.
 */
export async function parsePlacementTrackerFileAction(
  formData: FormData
): Promise<{ ok: boolean; placementItems: PlacementTickerInfo[]; error?: string }> {
  const file = formData.get("file") as File | null;
  if (!file) {
    return { ok: false, placementItems: [], error: "No placement file uploaded." };
  }

  try {
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const { parsePlacementTrackerBuffer, placementMapToArray } = await import("@/lib/pnl-calculator");
    const placementMap = await parsePlacementTrackerBuffer(buffer);

    if (placementMap.size === 0) {
      return {
        ok: false,
        placementItems: [],
        error: "No valid placement ticker sheets found in the uploaded file.",
      };
    }

    return {
      ok: true,
      placementItems: placementMapToArray(placementMap),
    };
  } catch (err: any) {
    console.error("Error parsing Placement Tracker file:", err);
    return {
      ok: false,
      placementItems: [],
      error: err.message || "Failed to process placement file.",
    };
  }
}
