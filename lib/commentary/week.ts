/**
 * Which week a commentary note belongs to.
 *
 * ── Why Friday, and why Sydney ──────────────────────────────────────────────
 * The note is written once a week, after the ASX has closed for the week, so
 * that it reads against a settled market rather than a mid-session one. The
 * week it belongs to is therefore identified by ITS FRIDAY: a note generated on
 * Friday evening, on Saturday, or on a Sunday catch-up run all belong to the
 * same Friday and must not produce three different rows.
 *
 * The anchor is Sydney's calendar date, not UTC's. Friday 18:00 AEDT is Friday
 * 07:00 UTC — same day — but Saturday 09:00 AEDT is Friday 22:00 UTC, and a
 * UTC-based rule would file the Saturday catch-up run under the same Friday by
 * accident and the Sunday one under the wrong week entirely. Worse, it would
 * flip behaviour twice a year with daylight saving.
 *
 * ── Why Intl rather than an offset ──────────────────────────────────────────
 * AEST is UTC+10, AEDT is UTC+11, and the changeover dates move. Any hardcoded
 * offset is wrong for about half the year, and code that tracks the changeover
 * itself is code that has to be corrected when the rule changes.
 * `Intl.DateTimeFormat` already knows, from the platform's own tz database.
 */

/** The desk's timezone. Everything the market does happens on this clock. */
export const DESK_TZ = "Australia/Sydney";

const YMD = new Intl.DateTimeFormat("en-CA", {
  timeZone: DESK_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Day-of-week name, needed because the numeric weekday of an instant in Sydney
 * cannot be read off a `Date` — `getUTCDay()` answers for UTC, and `getDay()`
 * answers for whatever timezone the server happens to be in.
 */
const WEEKDAY = new Intl.DateTimeFormat("en-US", {
  timeZone: DESK_TZ,
  weekday: "short",
});

const DAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** `YYYY-MM-DD` for this instant, on the desk's clock. */
export function deskDate(at: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD, which is also what Postgres wants for a DATE.
  return YMD.format(at);
}

/** Numeric weekday (0 = Sunday) for this instant, on the desk's clock. */
export function deskWeekday(at: Date = new Date()): number {
  return DAY_INDEX[WEEKDAY.format(at)];
}

/** Shift a `YYYY-MM-DD` by whole days, with no timezone anywhere near it. */
function shiftDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const shifted = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/**
 * The Friday whose week this instant falls in — the note's identity.
 *
 * Friday itself, Saturday and Sunday all resolve to the Friday just gone, so a
 * weekend catch-up run tops up the same week rather than opening a new one.
 * Monday to Thursday resolve BACKWARDS to the previous Friday too: mid-week the
 * current note is still last Friday's, which is exactly what a client should be
 * reading until the next one is written.
 */
export function commentaryWeek(at: Date = new Date()): string {
  const today = deskDate(at);
  const dow = deskWeekday(at); // 0 Sun … 5 Fri, 6 Sat
  // Days back to the most recent Friday: Fri→0, Sat→1, Sun→2, Mon→3 … Thu→6.
  const back = (dow - 5 + 7) % 7;
  return shiftDays(today, -back);
}

/**
 * Is it late enough in the week to write the note?
 *
 * Friday from 17:00 Sydney (after the 16:00 close, plus slack for the closing
 * auction) through to the end of Sunday. Checked in the job rather than trusted
 * to the schedule alone, because a manual catch-up run and a mis-set cron entry
 * both arrive as an ordinary request and neither should produce a note written
 * against a market that is still open.
 */
export function withinCommentaryWindow(at: Date = new Date()): boolean {
  const dow = deskWeekday(at);
  if (dow === 6 || dow === 0) return true; // Saturday, Sunday
  if (dow !== 5) return false; // Monday–Thursday
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: DESK_TZ,
      hour: "2-digit",
      hour12: false,
    }).format(at),
  );
  return hour >= 17;
}
