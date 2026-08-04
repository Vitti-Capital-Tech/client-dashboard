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

export interface PlacementUrlResult {
  ok: boolean;
  placementItems: PlacementTickerInfo[];
  error?: string;
  /** Actionable next step when the fetch fails (setup or sharing instruction). */
  hint?: string;
  /** Name of the downloaded file, so the UI can label the merged source. */
  filename?: string;
  /** Whether the bytes came from an authenticated read or a public link. */
  source?: "google-service-account" | "microsoft-graph" | "public-link";
}

/**
 * Server action to fetch a Placement Tracker from a link (Google Sheets/Drive,
 * SharePoint/OneDrive, or any direct .xlsx URL).
 *
 * Private files are read with server-side service credentials when they are
 * configured — see `lib/remote-sheets.ts` — so a link no longer has to be
 * shared publicly. Returns parsed placement ticker allocations for the
 * client-side merge.
 */
export async function fetchPlacementTrackerUrlAction(
  url: string
): Promise<PlacementUrlResult> {
  const { fetchRemoteSpreadsheet } = await import("@/lib/remote-sheets");
  const download = await fetchRemoteSpreadsheet(url);

  if (!download.ok || !download.buffer) {
    return {
      ok: false,
      placementItems: [],
      error: download.error || "Failed to fetch the Placement Tracker link.",
      hint: download.hint,
    };
  }

  try {
    const { parsePlacementTrackerBuffer, placementMapToArray } = await import(
      "@/lib/pnl-calculator"
    );
    const placementMap = await parsePlacementTrackerBuffer(download.buffer);

    if (placementMap.size === 0) {
      return {
        ok: false,
        placementItems: [],
        error: "No valid placement ticker sheets found in the linked document.",
        hint: "The workbook needs one tab per ticker with Round Shares and ACTUAL $ columns.",
      };
    }

    return {
      ok: true,
      placementItems: placementMapToArray(placementMap),
      filename: download.filename,
      source: download.source,
    };
  } catch (err: any) {
    console.error("Error parsing Placement Tracker from URL:", err);
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

export type SpotSource = "yahoo" | "database" | "unavailable";

export interface SpotPrice {
  ticker: string;
  price: number;
  source: SpotSource;
}

/**
 * Current spot price per ASX code, for valuing unlisted placement options.
 *
 * Yahoo first (a live last-traded price via `yahoo-finance2`), falling back to
 * `securities.last_price` from the most recent holdings snapshot. The fallback is
 * stale by construction — only as fresh as the last import — so the source is
 * returned alongside the price and shown in the UI rather than being quietly
 * interchangeable.
 *
 * A name that resolves to neither comes back `unavailable` at price 0. It is never
 * defaulted to a strike or a cost base: a fabricated spot would produce a
 * confident-looking option value with nothing behind it.
 */
export async function fetchSpotPricesAction(
  tickers: string[]
): Promise<{ ok: boolean; prices: SpotPrice[]; error?: string }> {
  const wanted = [...new Set(tickers.map((t) => String(t || "").trim().toUpperCase()).filter(Boolean))];
  if (wanted.length === 0) return { ok: true, prices: [] };

  const resolved = new Map<string, SpotPrice>();

  // One batched request for the whole list. Unknown symbols are simply omitted
  // from the response rather than failing it, so a delisted name costs nothing.
  try {
    const { default: YahooFinance } = await import("yahoo-finance2");
    const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

    // ASX names are quoted with a .AX suffix.
    const quotes = await yf.quote(wanted.map((t) => `${t}.AX`));
    const list = Array.isArray(quotes) ? quotes : quotes ? [quotes] : [];

    for (const q of list) {
      const symbol = String(q?.symbol || "").toUpperCase();
      const ticker = symbol.replace(/\.AX$/, "");
      const price = Number(q?.regularMarketPrice);
      if (ticker && Number.isFinite(price) && price > 0) {
        resolved.set(ticker, { ticker, price, source: "yahoo" });
      }
    }
  } catch (err) {
    // Offline, blocked or rate-limited — every name falls through to the DB.
    console.error("Yahoo spot price lookup failed:", err);
  }

  const missing = wanted.filter((t) => !resolved.has(t));

  if (missing.length > 0) {
    try {
      const { createClient } = await import("@/lib/supabase/server");
      const supabase = await createClient();
      const { data } = await supabase
        .from("securities")
        .select("code, last_price")
        .in("code", missing);

      for (const row of data || []) {
        const price = Number(row.last_price);
        const code = String(row.code || "").trim().toUpperCase();
        if (Number.isFinite(price) && price > 0) {
          resolved.set(code, { ticker: code, price, source: "database" });
        }
      }
    } catch (err) {
      console.error("Spot price DB fallback failed:", err);
    }
  }

  const prices: SpotPrice[] = wanted.map(
    (ticker) => resolved.get(ticker) ?? { ticker, price: 0, source: "unavailable" as const }
  );

  return { ok: true, prices };
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
    const { getParentTicker, getSummaryGroupKey, normalizeAccountNo } = await import("@/lib/pnl-calculator");
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

    // Aggregate DB holdings the same way the P&L table groups rows: options keep
    // their own code (ENVO) while ordinaries roll up to the parent (ENV, NVO), so
    // an option row is never valued off the underlying's share price.
    const holdingMap = new Map<string, DbHoldingInfo>();

    for (const p of filteredPositions) {
      const code = String(p.security_code || "").trim().toUpperCase();
      const parent = getParentTicker(code);
      const groupKey = getSummaryGroupKey(code);
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

      const existing = holdingMap.get(groupKey);
      if (!existing) {
        holdingMap.set(groupKey, {
          accountRef: accountRefStr,
          ticker: groupKey,
          parentTicker: parent,
          companyName: secInfo?.name || groupKey,
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
