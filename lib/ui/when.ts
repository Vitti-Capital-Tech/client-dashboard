/**
 * How a notification says when it happened.
 *
 * ── Why not the timestamp that was there ────────────────────────────────────
 * Every alert printed `18 Sep · 09:42`, in mono, at 9.5px. That is a precise
 * answer to a question nobody in a notification list is asking. Scanning a bell
 * you want to know *how fresh* — is this from ten minutes ago or last month —
 * and a date makes you compute that against today's date, for every row.
 *
 * So: relative while it is still news, absolute once it is history. The
 * changeover is a week, which is roughly where "3d ago" stops being easier to
 * read than "11 Sep".
 *
 * The exact stamp does not disappear — `stamp()` puts it in the `title` of
 * every row, so an adviser reconciling an alert against a contract note still
 * has the minute, on hover, without it shouting at everyone who does not.
 *
 * ── Why these take `nowMs` ──────────────────────────────────────────────────
 * So they are pure, and so the tests do not need to fake a clock. The component
 * that calls them (`app/components/TimeAgo.tsx`) owns "now", and re-reads it on
 * a timer — a drawer left open for an hour should not still say "just now".
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const DATE = new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short" });
const DATE_YEAR = new Intl.DateTimeFormat("en-AU", {
  day: "numeric",
  month: "short",
  year: "numeric",
});
const STAMP = new Intl.DateTimeFormat("en-AU", {
  weekday: "short",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * `just now` · `12m ago` · `3h ago` · `2d ago` · `11 Sep` · `11 Sep 2025`.
 *
 * Floors rather than rounds, every step: 59 minutes is "59m ago" and not "1h
 * ago", because an alert must never read as older than it is. A reader deciding
 * whether an expiry warning still has time in it is reading this number.
 *
 * A future timestamp — clock skew between the scanner's host and the browser,
 * which is a few seconds either way and does happen — reads "just now" rather
 * than "-1m ago".
 */
export function relative(iso: string, nowMs: number): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";

  const delta = nowMs - then;
  if (delta < MINUTE) return "just now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  if (delta < WEEK) return `${Math.floor(delta / DAY)}d ago`;
  return absolute(iso, nowMs);
}

/**
 * `11 Sep`, or `11 Sep 2025` once the year is no longer the current one — a
 * bare "11 Sep" on an alert from last September is actively misleading, and
 * printing the year on everything is noise for the 99% of rows that are from
 * this year.
 */
export function absolute(iso: string, nowMs: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameYear = d.getFullYear() === new Date(nowMs).getFullYear();
  return (sameYear ? DATE : DATE_YEAR).format(d);
}

/** The full, unambiguous stamp — for a `title`, not for the page. */
export function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return STAMP.format(d);
}
