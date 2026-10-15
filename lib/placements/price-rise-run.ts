import "server-only";
import { deskDate } from "../asx/session.ts";
import { getQuotes } from "../asx/quotes.ts";
import { getMicrosoftAccessToken } from "../remote-sheets.ts";
import { runPriceRise, type PriceRiseReport } from "./price-rise.ts";
import { graphCaller, resolveTrackerTarget, trackerUrls } from "./tracker-writer.ts";

/**
 * Production wiring for the Price Rise column: the real Graph token, this
 * year's tracker, and Yahoo quotes through `getQuotes`.
 */
export async function runPriceRiseUpdate(): Promise<PriceRiseReport & { ok: boolean }> {
  const empty = { rows: 0, updated: 0, noTradeToday: [], noQuote: [] };

  const urls = trackerUrls(process.env.PLACEMENT_TRACKER_URL);
  if (urls.length === 0) {
    return { ok: false, ...empty, error: "No PLACEMENT_TRACKER_URL is set." };
  }

  const token = await getMicrosoftAccessToken();
  if (!token) {
    return { ok: false, ...empty, error: "No Microsoft Graph token — check MICROSOFT_* credentials." };
  }

  const today = deskDate();
  const graph = graphCaller(token);
  const year = Number(today.slice(0, 4));
  const target = await resolveTrackerTarget(urls, year, graph);
  if (!target) {
    return { ok: false, ...empty, error: `No ${year} tracker found.` };
  }

  const report = await runPriceRise({ today, graph, target, quotes: getQuotes });
  if (report.error) console.error("[price-rise]", report.error);
  return { ok: !report.error, ...report };
}
