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

export interface DbHoldingInfo {
  accountRef: string;
  ticker: string;
  parentTicker: string;
  companyName: string;
  qty: number;
  costBase: number;
  marketValue: number;
  unrealizedPnl: number;
}

/**
 * Server action to fetch current portfolio holdings (units & market value) from the database
 * for open position valuation in the PNL calculator.
 */
export async function fetchDatabaseHoldingsAction(
  accountRef?: string | string[]
): Promise<{ ok: boolean; holdings: DbHoldingInfo[]; error?: string }> {
  try {
    const { createClient } = await import("@/lib/supabase/server");
    const { getParentTicker, normalizeAccountNo } = await import("@/lib/pnl-calculator");
    const supabase = await createClient();

    // Query positions, accounts, securities in parallel — clean plain table queries
    const [posRes, accRes, secRes] = await Promise.all([
      supabase.from("positions").select("id, client_id, account_id, security_code, qty, avg_cost"),
      supabase.from("accounts").select("id, external_ref, ref, client_id"),
      supabase.from("securities").select("code, name, last_price"),
    ]);

    if (posRes.error) {
      console.error("Error querying positions table:", posRes.error);
      return { ok: false, holdings: [], error: posRes.error.message };
    }

    const rawPositions = posRes.data || [];
    const accounts = accRes.data || [];
    const securities = (secRes.data || []) as any[];

    // Map security code -> last_price & name
    const secMap = new Map<string, { name: string; lastClose: number }>();
    for (const s of securities) {
      if (s.code) {
        secMap.set(s.code.trim().toUpperCase(), {
          name: s.name || s.code,
          lastClose: Number(s.last_price) || 0,
        });
      }
    }

    // Build normalized set of requested target accounts
    const requestedAccs: string[] = Array.isArray(accountRef)
      ? accountRef
      : accountRef
      ? [accountRef]
      : [];

    const normTargetSet = new Set(
      requestedAccs
        .map((r) => normalizeAccountNo(r))
        .filter((r) => r && r !== "ALL")
    );

    const accMap = new Map<string, string>();
    let targetAccountIds = new Set<string>();

    for (const a of accounts) {
      const ext = normalizeAccountNo(a.external_ref);
      const ref = normalizeAccountNo(a.ref);
      const refCode = a.external_ref || a.ref || "";
      accMap.set(a.id, refCode);

      if (normTargetSet.size > 0) {
        if (normTargetSet.has(ext) || normTargetSet.has(ref) || normTargetSet.has(a.id)) {
          targetAccountIds.add(a.id);
        }
      }
    }

    // Filter positions by targetAccountIds if specified
    let filteredPositions = rawPositions;
    if (targetAccountIds.size > 0) {
      filteredPositions = rawPositions.filter(
        (p) => p.account_id && targetAccountIds.has(p.account_id)
      );
    } else if (normTargetSet.size > 0 && targetAccountIds.size === 0) {
      // If requested account was not found in DB, return empty holdings
      return { ok: true, holdings: [] };
    }

    // Aggregate DB holdings by 3-character parentTicker (e.g. ENV, NVO)
    const holdingMap = new Map<string, DbHoldingInfo>();

    for (const p of filteredPositions) {
      const code = String(p.security_code || "").trim().toUpperCase();
      const parent = getParentTicker(code);
      const qty = Number(p.qty) || 0;
      const avgCost = Number(p.avg_cost) || 0;
      const costBase = Math.round(qty * avgCost * 100) / 100;

      const secInfo = secMap.get(code) || secMap.get(parent);
      const lastClose = secInfo?.lastClose || 0;

      let marketValue = 0;
      if (qty > 0 && lastClose > 0) {
        marketValue = Math.round(qty * lastClose * 100) / 100;
      } else if (costBase > 0) {
        marketValue = costBase;
      }

      const unrealizedPnl = Math.round((marketValue - costBase) * 100) / 100;
      const accountRefStr = accMap.get(p.account_id || "") || "";

      const existing = holdingMap.get(parent);
      if (!existing) {
        holdingMap.set(parent, {
          accountRef: accountRefStr,
          ticker: parent,
          parentTicker: parent,
          companyName: secInfo?.name || parent,
          qty,
          costBase,
          marketValue,
          unrealizedPnl,
        });
      } else {
        existing.qty += qty;
        existing.costBase = Math.round((existing.costBase + costBase) * 100) / 100;
        existing.marketValue = Math.round((existing.marketValue + marketValue) * 100) / 100;
        existing.unrealizedPnl = Math.round((existing.marketValue - existing.costBase) * 100) / 100;
      }
    }

    const holdings = Array.from(holdingMap.values());
    return { ok: true, holdings };
  } catch (err: any) {
    console.error("Error fetching database holdings:", err);
    return { ok: false, holdings: [], error: err.message || "Failed to fetch DB holdings." };
  }
}
