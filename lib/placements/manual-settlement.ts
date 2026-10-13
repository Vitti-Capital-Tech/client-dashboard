import { esc, type SendResult, type StaffMail } from "../notify/staff-mail.ts";
import { OVERVIEW_FIRST_DATA_ROW } from "./tracker-format.ts";
import type { GraphCall, TrackerTarget } from "./tracker-writer.ts";

/**
 * Manual-settlement watch: a deal the desk settles by hand, and the issuer's
 * Appendix 3B landing on or after its settlement date.
 *
 * ── What it watches ─────────────────────────────────────────────────────────
 * The Overview's Settlement Type column (E). A row reading exactly `Manual` is
 * a deal the desk settles by hand, so nothing downstream tells them when the
 * issuer has actually lodged the paperwork. `Manual & Private` and anything
 * else is deliberately NOT watched — the desk asked for plain `Manual` only.
 *
 * ── What it looks for ───────────────────────────────────────────────────────
 * A "Proposed issue of securities" announcement on that ticker, released on or
 * after the row's Settlement Date (Sydney calendar day). Earlier ones belong to
 * a previous raise and are ignored.
 *
 * ── Where the announcements come from ───────────────────────────────────────
 * ASX's announcements search (`announcements.do?by=asxCode&period=M6`), which
 * returns six months of a ticker's announcements as a plain HTML table — date
 * and time already on the Sydney clock. Not the company page on asx.com.au:
 * that page is an empty shell filled in by JavaScript, and the JSON feed it
 * fills itself from returns only the latest FIVE items, which an issuer can
 * outrun in an hour (AAU did on 8 Oct 2026). With six months of history an
 * hourly look cannot miss a 3B.
 *
 * ── Who runs it ─────────────────────────────────────────────────────────────
 * No cron of its own. The existing `alert-live-tick` job calls
 * `/api/alerts/live` every 10 minutes; that route runs this watch on the first
 * tick of each hour, 7am–7pm Sydney on weekdays (`manualWatchDue`).
 *
 * ── Once per announcement ───────────────────────────────────────────────────
 * Every alert is keyed on the ASX document key and claimed in the database
 * BEFORE the mail goes out; a failed send releases the claim so the next run
 * tries again. Overlapping runs therefore cannot both mail the same 3B.
 *
 * Free of `server-only`, with Graph, the feed, the database and the mailer all
 * injected, so the whole decision is covered by tests with no network.
 */

/** Overview columns B..F: counter, ticker, date issued, settlement type, settlement date. */
const WATCH_COLUMNS = { first: "B", last: "F" } as const;

/** How far back a settlement date still gets watched. */
export const WATCH_DAYS = 14;

/** The env var holding the alert's recipients. */
export const MANUAL_SETTLEMENT_TO_VAR = "MANUAL_SETTLEMENT_NOTIFY_TO";

export type ManualSettlementRow = {
  counter: number | null;
  ticker: string;
  /** `YYYY-MM-DD`. */
  settlementDate: string;
};

export type Announcement = {
  /** ASX's `idsId` — the PDF's identity, and the once-only key. */
  documentKey: string;
  headline: string;
  /** `YYYY-MM-DD`, Sydney calendar day, as ASX prints it. */
  releasedOn: string;
  /** `9:40 am`, Sydney, as ASX prints it. */
  releasedTime: string;
  /** The announcement PDF. */
  url: string;
};

export type ManualSettlementAlert = ManualSettlementRow & { announcement: Announcement };

/** Excel serial → `YYYY-MM-DD`. The inverse of `excelSerialDate`, same 1899-12-30 epoch. */
export function isoFromExcelSerial(serial: unknown): string | null {
  const n = typeof serial === "number" ? serial : Number(serial);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = Date.UTC(1899, 11, 30) + Math.floor(n) * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Exactly `Manual`, ignoring case and stray spaces. `Manual & Private` is not. */
export function isManualSettlement(value: unknown): boolean {
  return String(value ?? "").trim().toLowerCase() === "manual";
}

/** A listed ASX code — the Overview also carries private deals named in full. */
function asxCode(value: unknown): string | null {
  const code = String(value ?? "").trim().toUpperCase();
  return /^[A-Z0-9]{3,6}$/.test(code) ? code : null;
}

/** `2026-10-08` minus `days`, as a calendar date. */
export function shiftDate(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The Overview rows marked `Manual`, from a B..F `values` block. */
export function manualRowsFromValues(values: unknown[][]): ManualSettlementRow[] {
  const rows: ManualSettlementRow[] = [];
  for (const row of values) {
    if (!isManualSettlement(row?.[3])) continue;
    const ticker = asxCode(row?.[1]);
    const settlementDate = isoFromExcelSerial(row?.[4]);
    if (!ticker || !settlementDate) continue;
    const counter = Number(row?.[0]);
    rows.push({ counter: Number.isFinite(counter) ? counter : null, ticker, settlementDate });
  }
  return rows;
}

/** Read one year's Overview and return its `Manual` rows. Null when the sheet cannot be read. */
export async function readManualRows(
  graph: GraphCall,
  target: TrackerTarget,
  lastRow = 400,
): Promise<ManualSettlementRow[] | null> {
  const address = `${WATCH_COLUMNS.first}${OVERVIEW_FIRST_DATA_ROW}:${WATCH_COLUMNS.last}${lastRow}`;
  const res = await graph(
    `/drives/${target.driveId}/items/${target.itemId}/workbook/worksheets('${encodeURIComponent(
      target.overviewSheet,
    )}')/range(address='${address}')?$select=values`,
  );
  if (!res.ok) return null;
  const values = (res.body as { values?: unknown[][] } | null)?.values ?? [];
  return manualRowsFromValues(values);
}

/** The headline the desk is waiting for. ASX appends ` - AAU`, so match the prefix. */
export function isProposedIssue(headline: string): boolean {
  return /proposed issue of securities/i.test(headline);
}

const ASX = "https://www.asx.com.au";

/** The ticker's announcements, as ASX's search serves them: six months, server-rendered. */
export function announcementsSearchUrl(ticker: string): string {
  return `${ASX}/asx/v2/statistics/announcements.do?by=asxCode&asxCode=${encodeURIComponent(
    ticker.toUpperCase(),
  )}&timeframe=D&period=M6`;
}

/** The few entities ASX's markup actually uses in a headline. */
function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * The search page's table rows → announcements.
 *
 * Each row is a `<tr>` holding `08/10/2026<br><span class="dates-time">9:40 am</span>`,
 * then an `<a href="…displayAnnouncement.do?display=pdf&amp;idsId=03149993">`
 * whose text up to the first `<br>` is the headline. A row missing any of those
 * is not an announcement (the header row, for one) and is skipped.
 */
export function parseAnnouncementsHtml(html: string): Announcement[] {
  const out: Announcement[] = [];
  for (const chunk of html.split(/<tr[\s>]/i).slice(1)) {
    const date = /(\d{2})\/(\d{2})\/(\d{4})/.exec(chunk);
    const link = /<a[^>]*href="([^"]*displayAnnouncement\.do[^"]*idsId=(\d+)[^"]*)"[^>]*>([\s\S]*?)<br/i.exec(
      chunk,
    );
    if (!date || !link) continue;
    const time = /class="dates-time"[^>]*>\s*([^<]*?)\s*</i.exec(chunk);
    out.push({
      documentKey: link[2],
      headline: decodeEntities(link[3].replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim(),
      releasedOn: `${date[3]}-${date[2]}-${date[1]}`,
      releasedTime: time?.[1] ?? "",
      url: ASX + decodeEntities(link[1]),
    });
  }
  return out;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** One ticker's last six months of announcements. Null on any failure — the next run tries again. */
export async function fetchAnnouncements(
  ticker: string,
  fetchImpl: FetchLike = fetch,
): Promise<Announcement[] | null> {
  try {
    const res = await fetchImpl(announcementsSearchUrl(ticker), {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "text/html" },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return parseAnnouncementsHtml(await res.text());
  } catch {
    return null;
  }
}

/** The `Manual` rows' matching announcements: a 3B released on or after settlement. */
export function matchAlerts(
  rows: ManualSettlementRow[],
  announcements: Map<string, Announcement[]>,
): ManualSettlementAlert[] {
  const alerts: ManualSettlementAlert[] = [];
  for (const row of rows) {
    for (const a of announcements.get(row.ticker) ?? []) {
      if (!isProposedIssue(a.headline)) continue;
      if (a.releasedOn < row.settlementDate) continue;
      alerts.push({ ...row, announcement: a });
    }
  }
  return alerts;
}

/** `2026-10-08` → `8 Oct 2026`, the desk's own date style. */
function humanDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** The alert itself: short, one deal, and the link to check it. */
export function manualSettlementMail(alert: ManualSettlementAlert): StaffMail {
  const { ticker, settlementDate, announcement } = alert;
  const rows: [string, string][] = [
    ["Ticker", ticker],
    ["Settlement date", humanDate(settlementDate)],
    ["Settlement type", "Manual"],
    ["Announcement", announcement.headline],
    [
      "Released",
      [humanDate(announcement.releasedOn), announcement.releasedTime].filter(Boolean).join(", ") +
        " (Sydney)",
    ],
  ];
  const cells = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#6b675e;font-size:13px;white-space:nowrap">${esc(k)}</td>` +
        `<td style="padding:4px 0;color:#1a1a1a;font-size:13px"><b>${esc(v)}</b></td></tr>`,
    )
    .join("");

  return {
    subject: `ALERT: Proposed issue of securities — ${ticker} (manual settlement ${humanDate(settlementDate)})`,
    html:
      `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px">` +
      `<p style="margin:0 0 14px;font-size:15px;color:#b42318"><b>Alert: ${esc(ticker)} has lodged a ` +
      `Proposed issue of securities after its settlement date.</b></p>` +
      `<p style="margin:0 0 14px;font-size:13px;color:#1a1a1a">This deal is marked for manual ` +
      `settlement in the Placement Tracker — please action it.</p>` +
      `<table style="border-collapse:collapse">${cells}</table>` +
      `<p style="margin:18px 0 0"><a href="${esc(announcement.url)}" ` +
      `style="background:#1f3a5f;color:#fff;text-decoration:none;padding:9px 16px;` +
      `border-radius:7px;font-size:13px;font-weight:600;display:inline-block">Open the announcement</a>` +
      `&nbsp;&nbsp;<a href="${esc(announcementsSearchUrl(ticker))}" style="font-size:13px;color:#1f3a5f">` +
      `All ${esc(ticker)} announcements</a></p>` +
      `<p style="margin:22px 0 0;color:#9a958a;font-size:11.5px">` +
      `Sent by the Vitti client portal's manual-settlement watch.</p>` +
      `</div>`,
  };
}

/**
 * Whether this tick should run the watch: the first 10-minute tick of each hour,
 * 7am–7pm Sydney, Monday to Friday. The live tick fires every 10 minutes; with
 * six months of history per fetch, hourly is plenty and keeps the Graph and
 * ASX reads to a dozen runs a day.
 */
export function manualWatchDue(at: Date = new Date()): boolean {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-AU", {
      timeZone: "Australia/Sydney",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  return !["Sat", "Sun"].includes(parts.weekday) && hour >= 7 && hour <= 18 && minute < 10;
}

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

export type ManualSettlementDeps = {
  /** Today on the desk's clock, `YYYY-MM-DD`. */
  today: string;
  graph: GraphCall;
  /** The tracker for a given year, or null when there is none. */
  target: (year: number) => Promise<TrackerTarget | null>;
  announcements: (ticker: string) => Promise<Announcement[] | null>;
  /** Claim a document key. True when THIS call claimed it, false when already claimed. */
  claim: (alert: ManualSettlementAlert) => Promise<boolean>;
  /** Give a claim back after a failed send, so the next run retries. */
  release: (documentKey: string) => Promise<void>;
  send: (mail: StaffMail) => Promise<SendResult>;
};

export type ManualSettlementReport = {
  watched: { ticker: string; settlementDate: string }[];
  sent: { ticker: string; documentKey: string }[];
  failed: { ticker: string; reason: string }[];
  notes: string[];
};

export async function runManualSettlementWatch(
  deps: ManualSettlementDeps,
): Promise<ManualSettlementReport> {
  const report: ManualSettlementReport = { watched: [], sent: [], failed: [], notes: [] };
  const from = shiftDate(deps.today, -WATCH_DAYS);

  // A window reaching back over 1 January spans two workbooks.
  const years = [...new Set([Number(from.slice(0, 4)), Number(deps.today.slice(0, 4))])];

  const rows: ManualSettlementRow[] = [];
  for (const year of years) {
    const target = await deps.target(year);
    if (!target) {
      report.notes.push(`No ${year} tracker found.`);
      continue;
    }
    const read = await readManualRows(deps.graph, target);
    if (!read) {
      report.failed.push({ ticker: "-", reason: `Could not read ${target.overviewSheet}.` });
      continue;
    }
    rows.push(...read.filter((r) => r.settlementDate >= from && r.settlementDate <= deps.today));
  }
  report.watched = rows.map(({ ticker, settlementDate }) => ({ ticker, settlementDate }));
  if (rows.length === 0) return report;

  const feeds = new Map<string, Announcement[]>();
  for (const ticker of new Set(rows.map((r) => r.ticker))) {
    const items = await deps.announcements(ticker);
    if (items) feeds.set(ticker, items);
    else report.failed.push({ ticker, reason: "Could not read ASX announcements." });
  }

  for (const alert of matchAlerts(rows, feeds)) {
    const key = alert.announcement.documentKey;
    if (!(await deps.claim(alert))) continue;
    const result = await deps.send(manualSettlementMail(alert));
    if (result.sent) {
      report.sent.push({ ticker: alert.ticker, documentKey: key });
    } else {
      await deps.release(key);
      report.failed.push({ ticker: alert.ticker, reason: result.reason });
    }
  }

  return report;
}
