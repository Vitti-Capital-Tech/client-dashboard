import "server-only";
import { deskDate } from "../asx/session.ts";
import { getMicrosoftAccessToken } from "../remote-sheets.ts";
import { runPriceRise, type PriceRiseReport, type SessionOpen } from "./price-rise.ts";
import { graphCaller, resolveTrackerTarget, trackerUrls } from "./tracker-writer.ts";

/**
 * Production wiring for the Price Rise column: the real Graph token, this
 * year's tracker, and Yahoo's daily history for the settlement-day open.
 */

type YahooChart = {
  quotes: { date: Date; open: number | null; volume: number | null }[];
};

/**
 * The first traded session's open on or after `from`, from Yahoo's daily bars.
 *
 * Bars are dated at midnight Sydney, so `deskDate` gives the trading day. A bar
 * with no volume is a day the code did not trade and is skipped. Yahoo returns
 * prices as floats (`0.007000000216`), so the open is rounded to four places —
 * finer than any ASX tick.
 */
async function openFrom(code: string, from: string): Promise<SessionOpen | null> {
  const { default: YahooFinance } = await import("yahoo-finance2");
  const yf = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

  const start = new Date(`${from}T00:00:00Z`);
  // A day either side of midnight Sydney, and two weeks to find a traded day.
  const period1 = new Date(start.getTime() - 86_400_000);
  const period2 = new Date(Math.min(start.getTime() + 15 * 86_400_000, Date.now()));
  if (period2 <= period1) return null;

  const chart = (await yf.chart(`${code}.AX`, { period1, period2, interval: "1d" })) as YahooChart;
  for (const bar of chart.quotes ?? []) {
    const on = deskDate(new Date(bar.date));
    if (on < from) continue;
    if (!(Number(bar.volume) > 0) || !(Number(bar.open) > 0)) continue;
    return { open: Math.round(Number(bar.open) * 1e4) / 1e4, on };
  }
  return null;
}

export async function runPriceRiseUpdate(): Promise<PriceRiseReport & { ok: boolean }> {
  const empty = { rows: 0, updated: [], pending: [] };

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

  const report = await runPriceRise({ today, graph, target, openFrom });
  if (report.error) console.error("[price-rise]", report.error);
  return { ok: !report.error, ...report };
}
