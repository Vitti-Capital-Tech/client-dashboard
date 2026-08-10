"use server";

import {
  parsePnlFileBuffer,
  buildPnlExportXlsxBuffer,
  buildPnlExportCsvString,
  buildPnlExportFilename,
  splitTrackerUrls,
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
 * Which client an export belongs to, so the file can be named after them.
 *
 * Optional: an export from a file with no `Account` column still works, it just
 * falls back to the old undifferentiated name.
 */
export interface PnlExportScope {
  /** Account numbers in scope — the selected one, or every one in the file. */
  accounts?: string[];
  /** Account number → holder name, as resolved by `resolveAccountHoldersAction`. */
  accountHolders?: Record<string, string>;
  /**
   * The reporting period the figures cover, when one is set.
   *
   * Carried into the download name: a six-month P&L stamped only with today's date is
   * indistinguishable from a lifetime one, and that difference is the whole figure.
   */
  dateFrom?: string;
  dateTo?: string;
}

/**
 * Server action to generate an Excel (.xlsx) export buffer (base64) for download.
 */
export async function exportPnlXlsxAction(
  summaryRows: PnlSummaryItem[],
  scope?: PnlExportScope
): Promise<{ base64: string; filename: string }> {
  const buffer = await buildPnlExportXlsxBuffer(summaryRows);
  const base64 = buffer.toString("base64");
  return { base64, filename: exportFilename(scope, "xlsx") };
}

/**
 * Server action to generate a CSV export string for download.
 */
export async function exportPnlCsvAction(
  summaryRows: PnlSummaryItem[],
  scope?: PnlExportScope
): Promise<{ csv: string; filename: string }> {
  const csv = buildPnlExportCsvString(summaryRows);
  return { csv, filename: exportFilename(scope, "csv") };
}

/**
 * Builds the download name here rather than taking one from the browser, so the
 * sanitising in `buildPnlExportFilename` cannot be bypassed by the caller.
 */
function exportFilename(scope: PnlExportScope | undefined, extension: "xlsx" | "csv"): string {
  return buildPnlExportFilename({
    accounts: scope?.accounts || [],
    accountHolders: scope?.accountHolders || {},
    isoDate: new Date().toISOString().split("T")[0],
    extension,
    range: { from: scope?.dateFrom, to: scope?.dateTo },
  });
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
    // The link is passed in only so a tracker whose sheets carry no year can still
    // be dated from "…Placement Tracker 2025.xlsx" in the URL.
    const placementMap = await parsePlacementTrackerBuffer(download.buffer, download.filename || url);

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

/** One standing Placement Tracker source, resolved and parsed. */
export interface ConfiguredTracker {
  /** Display label — the downloaded filename, never the URL. */
  name: string;
  placementItems: PlacementTickerInfo[];
  source?: PlacementUrlResult["source"];
  error?: string;
  hint?: string;
  /** True when served from the in-process cache instead of being re-parsed. */
  cached?: boolean;
  /** Seconds since this tracker was actually parsed. */
  ageSeconds?: number;
}

/**
 * Splits `PLACEMENT_TRACKER_URL` into individual links.
 *
 * A bare comma or semicolon is NOT a safe separator for these URLs. A SharePoint
 * "copy link" URL carries query parameters containing `%2C`, and if anything in the
 * chain decodes that to a literal comma — pasting through a hosting provider's
 * environment-variable UI will — splitting on commas tears the URL in half. That is
 * exactly what happened in production: the long 2026 link split into a truncated URL
 * plus the fragment `"Refreshin"`, so it 404'd while the short 2025 link still worked,
 * and only one tracker ever appeared.
 *
 * So: split on whitespace (never legal inside a URL), or on a comma/semicolon **only
 * when the next thing is the start of another URL**. Anything that does not look like an
 * http(s) URL is reported rather than quietly attempted.
 */
/** Host only, so a log line can identify a link without publishing the credential. */
function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "(unparseable)";
  }
}

/**
 * Parsed trackers, cached per URL for the life of the server process.
 *
 * Parsing the real workbooks costs **~48s of CPU** (30s for the 12.5 MB 2026 file, 18s
 * for the 9.3 MB 2025 one) while the parsed result is only ~0.23 MB of JSON. Without a
 * cache every session — every reload, every staff member — paid that again. Caching
 * turns it into once per process, shared by everyone.
 *
 * The TTL exists because the desk edits the tracker during the day; a long-lived cache
 * would hide placements added since the process started.
 */
const TRACKER_CACHE_TTL_MS = 10 * 60 * 1000;
const trackerCache = new Map<string, { at: number; items: PlacementTickerInfo[]; name: string; source?: PlacementUrlResult["source"] }>();

/**
 * Loads the Placement Tracker(s) configured in `PLACEMENT_TRACKER_URL`.
 *
 * Set it in `.env.local` to one or more links, separated by commas, semicolons or
 * newlines — the desk keeps a workbook per year (2025 and 2026), and
 * `combinePlacementMaps` merges them on the client exactly as if they had been
 * uploaded by hand.
 *
 * The URL is read **server-side only** and never returned. It is deliberately not a
 * `NEXT_PUBLIC_` variable: for a "anyone with the link can view" sheet the URL *is*
 * the credential, and putting it in the client bundle would hand it to anything that
 * can read the page source.
 *
 * Each link is reported independently, so one dead link costs only itself.
 *
 * Links are processed **SEQUENTIALLY, not concurrently**. Parsing is CPU-bound and
 * single-threaded, so running two in parallel saved nothing measurable (45s vs 57s) while
 * doubling peak memory to **3.2 GB RSS** — enough to destabilise the Next server and
 * intermittently lose one of the two trackers. One at a time roughly halves that peak.
 *
 * Results are cached per URL for `TRACKER_CACHE_TTL_MS`, so the ~48s of parsing happens
 * once per server process rather than once per session.
 */
export async function loadConfiguredPlacementTrackersAction(): Promise<{
  configured: boolean;
  trackers: ConfiguredTracker[];
}> {
  const raw = process.env.PLACEMENT_TRACKER_URL?.trim();
  if (!raw) return { configured: false, trackers: [] };

  const { urls, rejected } = splitTrackerUrls(raw);

  if (rejected.length > 0) {
    // Logged, not silently dropped: this is the one thing that is invisible from the UI.
    console.error(
      `PLACEMENT_TRACKER_URL: ignored ${rejected.length} entry(ies) that are not URLs:`,
      rejected.map((r) => `"${r.slice(0, 24)}…" (${r.length} chars)`).join(", ")
    );
  }

  if (urls.length === 0) return { configured: false, trackers: [] };

  console.log(`PLACEMENT_TRACKER_URL: ${urls.length} link(s) configured.`);

  const trackers: ConfiguredTracker[] = [];

  for (const [index, url] of urls.entries()) {
    const fallbackName = `Configured Tracker ${index + 1}`;

    const hit = trackerCache.get(url);
    if (hit && Date.now() - hit.at < TRACKER_CACHE_TTL_MS) {
      trackers.push({
        name: hit.name,
        placementItems: hit.items,
        source: hit.source,
        cached: true,
        ageSeconds: Math.round((Date.now() - hit.at) / 1000),
      });
      continue;
    }

    try {
      const res = await fetchPlacementTrackerUrlAction(url);

      if (!res.ok || res.placementItems.length === 0) {
        // Logged with the link's shape but never the link itself — it may be the
        // credential. This is what makes a production-only failure diagnosable.
        console.error(
          `PLACEMENT_TRACKER_URL[${index}] failed:`,
          res.error || `parsed 0 tickers`,
          `| host=${safeHost(url)} | urlLength=${url.length}`,
          res.hint ? `| hint=${res.hint}` : ""
        );
        // Keep serving a stale copy rather than losing the tracker outright.
        if (hit) {
          trackers.push({
            name: hit.name,
            placementItems: hit.items,
            source: hit.source,
            cached: true,
            ageSeconds: Math.round((Date.now() - hit.at) / 1000),
            hint: "Refresh failed; showing the last successfully parsed copy.",
          });
          continue;
        }
        trackers.push({
          name: res.filename || fallbackName,
          placementItems: [],
          error: res.error || "Failed to fetch or parse the configured Placement Tracker.",
          hint: res.hint,
        });
        continue;
      }

      const name = res.filename || fallbackName;
      console.log(
        `PLACEMENT_TRACKER_URL[${index}] loaded: ${name} | ${res.placementItems.length} tickers | via ${res.source} | host=${safeHost(url)}`
      );
      trackerCache.set(url, {
        at: Date.now(),
        items: res.placementItems,
        name,
        source: res.source,
      });
      trackers.push({ name, placementItems: res.placementItems, source: res.source, ageSeconds: 0 });
    } catch (err) {
      // Never surface the URL in the error — it may be the credential.
      console.error("Configured placement tracker failed:", err);
      if (hit) {
        trackers.push({
          name: hit.name,
          placementItems: hit.items,
          source: hit.source,
          cached: true,
          ageSeconds: Math.round((Date.now() - hit.at) / 1000),
          hint: "Refresh failed; showing the last successfully parsed copy.",
        });
        continue;
      }
      trackers.push({
        name: fallbackName,
        placementItems: [],
        error: "Failed to load a configured Placement Tracker link.",
      });
    }
  }

  return { configured: true, trackers };
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
    const placementMap = await parsePlacementTrackerBuffer(buffer, file.name);

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

// `SpotSource` and `LIVE_SPOT_SOURCES` live in lib/pnl-calculator.ts. They cannot be
// re-exported from here: a "use server" module may only export async functions.
import type { SpotSource } from "@/lib/pnl-calculator";

export interface SpotPrice {
  ticker: string;
  price: number;
  source: SpotSource;
}

/**
 * Fetches one ASX code's last traded price from the ASX's own market-data API.
 *
 * This is the feed behind asx.com.au's company pages. The older
 * `www.asx.com.au/asx/1/share/<CODE>` endpoint is gone (404s), so this is the
 * current path. There is no batch form, hence one request per code.
 *
 * An unknown code answers 400, which is why a non-OK response resolves to null
 * rather than throwing — a delisted name must not cost the whole batch.
 */
async function fetchAsxSpot(ticker: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://asx.api.markitdigital.com/asx-research/1.0/companies/${encodeURIComponent(ticker)}/header`,
      {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
        signal: AbortSignal.timeout(8000),
        cache: "no-store",
      }
    );
    if (!res.ok) return null;

    const json = await res.json();
    // `priceLast` is what the ASX page shows; `priceClose` is the sibling field on
    // their other endpoints, kept as a fallback in case the shape shifts again.
    const price = Number(json?.data?.priceLast ?? json?.data?.priceClose);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

/**
 * Current spot price per ASX code, for valuing unlisted placement options.
 *
 * Three sources, tried in order of authority:
 *
 *   1. `yahoo-finance2` — one batched request for the whole list.
 *   2. The **ASX** market-data API — live too, but one request per code, so it only
 *      runs for whatever Yahoo could not answer.
 *   3. `securities.last_price` — the last holdings snapshot. Stale by construction:
 *      only as fresh as the last import.
 *
 * The source rides back with each price and is shown in the UI, so a live quote and
 * a month-old snapshot are never silently interchangeable.
 *
 * A name that resolves to none of the three comes back `unavailable` at price 0. It
 * is never defaulted to a strike or a cost base: a fabricated spot would produce a
 * confident-looking option value with nothing behind it.
 */
export async function fetchSpotPricesAction(
  tickers: string[]
): Promise<{ ok: boolean; prices: SpotPrice[]; error?: string }> {
  const wanted = [...new Set(tickers.map((t) => String(t || "").trim().toUpperCase()).filter(Boolean))];
  if (wanted.length === 0) return { ok: true, prices: [] };

  const resolved = new Map<string, SpotPrice>();

  // 1. Yahoo. One batched request for the whole list. Unknown symbols are omitted
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

  // 2. ASX, for whatever Yahoo did not answer. Concurrent, each failure contained.
  const missingAfterYahoo = wanted.filter((t) => !resolved.has(t));
  if (missingAfterYahoo.length > 0) {
    const asxPrices = await Promise.all(
      missingAfterYahoo.map(async (ticker) => [ticker, await fetchAsxSpot(ticker)] as const)
    );
    for (const [ticker, price] of asxPrices) {
      if (price !== null) resolved.set(ticker, { ticker, price, source: "asx" });
    }
  }

  // 3. The last holdings snapshot, for anything still unresolved.
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

export interface AccountHolder {
  /** Broker account number exactly as it appeared in the trade file. */
  accountRef: string;
  /** `clients.display_name` — the account name the broker export carried. */
  clientName: string;
  /**
   * `clients.placement_aliases` — the other names the Placement Tracker uses for
   * this client, carried separately from `clientName` because the UI labels the
   * account with one name while the merge may match on any of them.
   */
  aliases: string[];
}

/**
 * Resolves the trade file's `Account` numbers to the account holders' names.
 *
 * This is what lets the Placement Tracker merge identify the client without relying
 * on the uploaded file being *named* after them. The account number is data from
 * inside the file; a filename is a convention someone has to remember. (Real case:
 * `PKevadiya-…csv` actually belongs to "Sri Guru Nanak Pty Ltd" — the filename
 * matches nothing in the placement sheets.)
 *
 * Matching is on the normalised `external_ref`, the same way `fetchDatabaseHoldings`
 * does it, so `114716` and `114716.0` resolve alike. Accounts absent from the
 * database are simply omitted; the caller falls back to the filename for those.
 */
export async function resolveAccountHoldersAction(
  accountRefs: string[]
): Promise<{ ok: boolean; holders: AccountHolder[]; error?: string }> {
  const wanted = [...new Set((accountRefs || []).map((r) => String(r || "").trim()).filter(Boolean))];
  if (wanted.length === 0) return { ok: true, holders: [] };

  try {
    const { createClient } = await import("@/lib/supabase/server");
    const { normalizeAccountNo } = await import("@/lib/pnl-calculator");
    const supabase = await createClient();

    const [accRes, clientRes] = await Promise.all([
      supabase.from("accounts").select("external_ref, ref, client_id"),
      // `placement_aliases` rides along so this page matches placement sheets the
      // same way the stored recompute does. Without it the two surfaces would fill
      // different rows from the same tracker, which is the one thing the shared
      // engine exists to prevent.
      supabase.from("clients").select("id, display_name, placement_aliases"),
    ]);

    if (accRes.error) return { ok: false, holders: [], error: accRes.error.message };

    const nameById = new Map((clientRes.data || []).map((c) => [c.id, c.display_name as string]));
    const aliasesById = new Map(
      (clientRes.data || []).map((c) => [c.id, (c.placement_aliases ?? []) as string[]])
    );
    const wantedByNorm = new Map(wanted.map((r) => [normalizeAccountNo(r), r]));

    const holders: AccountHolder[] = [];
    const seen = new Set<string>();

    for (const a of accRes.data || []) {
      for (const candidate of [a.external_ref, a.ref]) {
        const norm = normalizeAccountNo(candidate);
        const original = norm ? wantedByNorm.get(norm) : undefined;
        if (!original || seen.has(original)) continue;
        const clientName = nameById.get(a.client_id as string);
        if (!clientName) continue;
        holders.push({
          accountRef: original,
          clientName,
          aliases: (aliasesById.get(a.client_id as string) ?? [])
            .map((s) => String(s ?? "").trim())
            .filter(Boolean),
        });
        seen.add(original);
      }
    }

    return { ok: true, holders };
  } catch (err) {
    console.error("Error resolving account holders:", err);
    const message = err instanceof Error ? err.message : "Failed to resolve account holders.";
    return { ok: false, holders: [], error: message };
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
