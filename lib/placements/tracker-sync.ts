import { parseSummaryTerms } from "./summary-terms.ts";
import { writeDealToTracker, type GraphCall, type TrackerTarget } from "./tracker-writer.ts";
import type { TrackerDeal } from "./tracker-format.ts";
import type { CandidateFeedItem } from "./candidates.ts";

/**
 * Every deal the broker mail brings in, written into the Placement Tracker —
 * with nobody pressing anything.
 *
 * This runs inside the deal-mail cron, straight after the candidates land. The
 * terms come from `parseSummaryTerms`, which reads the labelled header the
 * upstream summary opens with, and those five fields are exactly the ones a new
 * tab needs: ticker, date issued, issue price, DVP date and attaching options.
 *
 * ── What this means, and it is worth being clear about ───────────────────────
 * The tracker stops meaning "deals the desk did" and starts meaning "deals the
 * desk was offered". Every announcement gets a tab and a row, including the ones
 * nobody ends up doing — and a row is not withdrawn when a candidate is later
 * dismissed, because by then a person may have typed into it. That is the trade
 * for never having to remember to press a button.
 *
 * ── Only what arrived ────────────────────────────────────────────────────────
 * Fresh candidates only, and the workbook is checked again before each write.
 * The cron re-reads the same dates every run, so without both guards the tracker
 * would grow a tab per deal per run.
 */

export type TrackerSyncReport = {
  /** False only when the tracker could not be reached at all. */
  ok: boolean;
  written: { ticker: string; sheet: string; row: number }[];
  skipped: number;
  failed: { ticker: string; error: string }[];
  notes: string[];
};

export type TrackerSyncDeps = {
  graph: GraphCall;
  /** Resolves the workbook for a year — one file per year. */
  target: (year: number) => Promise<TrackerTarget | null>;
  /** Deals older than this are not written. Defaults to the current year. */
  years?: number[];
};

/** The mail item, read into the shape a tracker tab wants. */
export function dealFromCandidate(item: CandidateFeedItem): TrackerDeal {
  const read = parseSummaryTerms(item.summary ?? "");
  return {
    ticker: item.ticker.trim().toUpperCase(),
    // `Date Issued` is the day the deal was announced. The summary header has no
    // such field — it carries Bids Close and Settlement — so the mail's own
    // timestamp is the honest answer, and it is the one the desk types today.
    issueDate: isoDay(item.received_at),
    price: read.price ?? null,
    settleDate: read.settleDate ?? null,
    addOns: read.opts ?? null,
  };
}

/** `2026-08-12T02:31:46Z` → `2026-08-12`, without going through a Date. */
function isoDay(value: string | null | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec((value ?? "").trim());
  return m ? m[1] : null;
}

export async function syncTrackerRows(
  items: CandidateFeedItem[],
  deps: TrackerSyncDeps,
): Promise<TrackerSyncReport> {
  const report: TrackerSyncReport = { ok: true, written: [], skipped: 0, failed: [], notes: [] };
  if (items.length === 0) return report;

  // One workbook per year, resolved once and reused — resolving it is two Graph
  // calls, and a morning's mail is nearly always the same year.
  const targets = new Map<number, TrackerTarget | null>();
  const targetFor = async (year: number) => {
    if (!targets.has(year)) targets.set(year, await deps.target(year));
    return targets.get(year) ?? null;
  };

  // A permission failure is the same failure for every deal in the run. Reported
  // once, and the rest are not attempted: forty identical 403s in a cron log is
  // noise that hides the one line explaining what to do.
  let blocked: string | null = null;
  /** Tabs this run had to rebuild because the tenant has no worksheet copy. */
  let replayed = 0;

  for (const item of items) {
    if (blocked) {
      report.failed.push({ ticker: item.ticker, error: blocked });
      continue;
    }

    const deal = dealFromCandidate(item);
    if (!deal.ticker) continue;

    const year = Number(deal.issueDate?.slice(0, 4));
    if (!Number.isFinite(year)) {
      report.failed.push({ ticker: deal.ticker, error: "No date to file this deal under." });
      continue;
    }
    if (deps.years && !deps.years.includes(year)) {
      report.skipped++;
      continue;
    }

    const target = await targetFor(year);
    if (!target) {
      report.ok = false;
      blocked = `No Placement Tracker workbook configured with a "${year} Overview" sheet.`;
      report.failed.push({ ticker: deal.ticker, error: blocked });
      continue;
    }

    const res = await writeDealToTracker(deal, { graph: deps.graph, target });

    if (res.ok && res.skipped) {
      report.skipped++;
    } else if (res.ok && res.sheet) {
      report.written.push({ ticker: deal.ticker, sheet: res.sheet, row: res.overviewRow ?? 0 });
      if (res.via === "replay") replayed++;
      // A tab that landed but not where it should have, or without its widths.
      // The deal IS filed, so these belong in the run's notes rather than
      // anywhere that reads as a failure.
      if (res.notes?.length) report.notes.push(...res.notes);
    } else {
      const error = [res.error, res.hint].filter(Boolean).join(" ");
      report.failed.push({ ticker: deal.ticker, error });
      // A missing permission will not fix itself between two deals in one run.
      if (res.hint?.includes("ReadWrite")) {
        report.ok = false;
        blocked = error;
      }
    }
  }

  report.notes.push(
    `Tracker: ${report.written.length} written, ${report.skipped} already there, ${report.failed.length} failed.`,
  );

  // Said once per run, not once per deal. Graph has no worksheet copy, so this
  // is every tab, every time: formulas, number formats, fills, fonts and widths
  // are replayed from Template; data validation and conditional formatting have
  // no range-level read and cannot be.
  if (replayed > 0) {
    report.notes.push(
      `${replayed} tab${replayed === 1 ? "" : "s"} rebuilt from Template rather than copied — ` +
        `Graph has no worksheet copy, so validation and conditional formatting did not carry.`,
    );
  }

  return report;
}
