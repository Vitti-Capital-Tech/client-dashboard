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
 * ── What is offered here, and what stops a second tab ───────────────────────
 * The caller offers the deals still OWED a tab — `tracker_written_at IS NULL`,
 * see `tracker-state.ts` — not the ones a particular run happened to see first.
 * Keying it on freshness is what made a failed write unrecoverable, because a
 * candidate is fresh exactly once and the hourly sweep then had nothing to
 * retry.
 *
 * So the duplicate guard is the only thing standing between the cron and a tab
 * per deal per run, and it is the right one for the job: `writeDealToTracker`
 * re-reads the Overview by ticker AND issue date immediately before touching the
 * workbook. That holds however the queue got into the state it is in — a run
 * killed half way, a mark that never got recorded, a tab somebody built by hand.
 */

export type TrackerSyncReport = {
  /** False only when the tracker could not be reached at all. */
  ok: boolean;
  written: { ticker: string; sheet: string; row: number }[];
  skipped: number;
  failed: { ticker: string; error: string }[];
  notes: string[];
};

/**
 * What became of one deal, reported the moment it settles.
 *
 * `skipped` is the duplicate guard finding the deal already on the Overview —
 * which for a caller keeping a queue means the same thing as written: it is in
 * the workbook, stop owing it.
 */
export type TrackerOutcome =
  | { state: "written"; sheet: string }
  | { state: "skipped" }
  | { state: "failed"; error: string };

export type TrackerSyncDeps<T extends CandidateFeedItem = CandidateFeedItem> = {
  graph: GraphCall;
  /** Resolves the workbook for a year — one file per year. */
  target: (year: number) => Promise<TrackerTarget | null>;
  /** Deals older than this are not written. Defaults to the current year. */
  years?: number[];
  /**
   * Called as each deal settles, before the next one is started.
   *
   * Per-deal and immediate, not once at the end with the report, because the
   * thing this run has to survive is being KILLED half way — which is exactly
   * what happened on 3 September 2026. A caller that records outcomes here keeps
   * every tab this run managed to write even if the invocation never returns; a
   * caller handed the finished report keeps nothing.
   */
  onSettled?: (item: T, outcome: TrackerOutcome) => Promise<void>;
};

/** The mail item, read into the shape a tracker tab wants. */
export function dealFromCandidate(item: CandidateFeedItem): TrackerDeal {
  const read = parseSummaryTerms(item.summary ?? "");
  const isTwoTranche = /\b(?:2\s*tranche|two\s*tranche|tranche\s*2|tranche\s*ii|second\s*tranche)\b/i.test(
    item.summary ?? "",
  );
  return {
    ticker: item.ticker.trim().toUpperCase(),
    // `Date Issued` is the day the deal was announced. The summary header has no
    // such field — it carries Bids Close and Settlement — so the mail's own
    // timestamp is the honest answer, and it is the one the desk types today.
    issueDate: sydneyDay(item.received_at),
    price: read.price ?? null,
    settleDate: read.settleDate ?? null,
    addOns: read.opts ?? null,
    twoTranche: isTwoTranche ? true : false,
  };
}

/** The market this desk trades. Every date on a tab is a date in this zone. */
const DEAL_TIME_ZONE = "Australia/Sydney";

const SYDNEY_YMD = new Intl.DateTimeFormat("en-AU", {
  timeZone: DEAL_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * The announcement's date **in Sydney**, which is the date the desk types.
 *
 * ── Why not the UTC prefix of the timestamp ──────────────────────────────────
 * This used to take the first ten characters of `received_at`, which is the UTC
 * day, and that is wrong for every deal announced before 10am in Sydney — the
 * whole pre-open window, which is when a raise with a trading halt is normally
 * announced. `23:25:13Z` is `09:25` the NEXT morning there.
 *
 * It reached the workbook on 3 September 2026: NGY's mail went out at
 * `2026-09-02T23:25:13Z` and belonged to the 3rd, which is also the date the
 * upstream filed it under and the date the desk wrote in by hand. One deal in
 * nine of that fortnight's mail fell in the window.
 *
 * A wrong `Date Issued` is not cosmetic. It is what the Overview's *Settling
 * today / Settled yesterday / Settling tomorrow* banner counts from, and it is
 * half of `alreadyInOverview`'s duplicate key — so a date somebody corrects by
 * hand is a date a later write no longer recognises.
 *
 * `Intl` rather than a fixed offset, because the answer differs by ten or eleven
 * hours depending on daylight saving and the changeover is mid-year here.
 * `formatToParts` rather than a formatted string, so the assembly does not
 * depend on what order a locale happens to print in.
 */
function sydneyDay(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;

  const at = Date.parse(raw);
  // An unparseable timestamp still has its literal day, and using it is better
  // than filing the deal with no date at all — which `syncTrackerRows` counts as
  // a failure because there is no year to choose a workbook by.
  if (!Number.isFinite(at)) return isoDay(raw);

  const parts = SYDNEY_YMD.formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  const [y, m, d] = [get("year"), get("month"), get("day")];
  return y && m && d ? `${y}-${m}-${d}` : isoDay(raw);
}

/** `2026-08-12T02:31:46Z` → `2026-08-12`, without going through a Date. */
function isoDay(value: string | null | undefined): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec((value ?? "").trim());
  return m ? m[1] : null;
}

export async function syncTrackerRows<T extends CandidateFeedItem>(
  items: T[],
  deps: TrackerSyncDeps<T>,
): Promise<TrackerSyncReport> {
  const report: TrackerSyncReport = { ok: true, written: [], skipped: 0, failed: [], notes: [] };
  if (items.length === 0) return report;

  /**
   * Tell the caller how one deal ended, without letting that reporting break
   * the run.
   *
   * A queue that cannot be updated is worth a note and nothing more: the tab is
   * already in the workbook, and the only cost of a lost mark is that the next
   * run offers the deal again — where the duplicate guard reads the Overview and
   * skips it. Throwing here would trade a redundant check for an abandoned batch.
   */
  const settled = async (item: T, outcome: TrackerOutcome) => {
    if (!deps.onSettled) return;
    try {
      await deps.onSettled(item, outcome);
    } catch (err) {
      report.notes.push(
        `${item.ticker}: the write was ${outcome.state} but recording that failed — ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

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
      await settled(item, { state: "failed", error: blocked });
      continue;
    }

    const deal = dealFromCandidate(item);
    if (!deal.ticker) continue;

    const year = Number(deal.issueDate?.slice(0, 4));
    if (!Number.isFinite(year)) {
      const error = "No date to file this deal under.";
      report.failed.push({ ticker: deal.ticker, error });
      await settled(item, { state: "failed", error });
      continue;
    }
    if (deps.years && !deps.years.includes(year)) {
      // Deliberately NOT settled: this run declined to file the deal, which is
      // not the same as the workbook having it. Nothing in production passes
      // `years`, so nothing is left owed by this in practice.
      report.skipped++;
      continue;
    }

    const target = await targetFor(year);
    if (!target) {
      report.ok = false;
      blocked = `No Placement Tracker workbook configured with a "${year} Overview" sheet.`;
      report.failed.push({ ticker: deal.ticker, error: blocked });
      await settled(item, { state: "failed", error: blocked });
      continue;
    }

    const res = await writeDealToTracker(deal, { graph: deps.graph, target });

    if (res.ok && res.skipped) {
      report.skipped++;
      await settled(item, { state: "skipped" });
    } else if (res.ok && res.sheet) {
      report.written.push({ ticker: deal.ticker, sheet: res.sheet, row: res.overviewRow ?? 0 });
      if (res.via === "replay") replayed++;
      // A tab that landed but not where it should have, or without its widths.
      // The deal IS filed, so these belong in the run's notes rather than
      // anywhere that reads as a failure.
      if (res.notes?.length) report.notes.push(...res.notes);
      await settled(item, { state: "written", sheet: res.sheet });
    } else {
      const error = [res.error, res.hint].filter(Boolean).join(" ");
      report.failed.push({ ticker: deal.ticker, error });
      await settled(item, { state: "failed", error });
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
