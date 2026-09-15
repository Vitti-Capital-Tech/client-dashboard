/**
 * Whether the ASX is open, on the ASX's own clock.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * The client dashboard stamped its header with the literal string `· ASX open`
 * and counted down to a book close computed as `close.setHours(16, 0, 0, 0)`.
 * Both were wrong in the same way: they described the market without ever
 * asking it anything. The header claimed the exchange was trading at 2am, on
 * Christmas Day, and all weekend; the countdown ran to 4pm in whatever timezone
 * the *browser* happened to be in, so a client in Perth was told the book shut
 * two hours after it had, and one in London was told it had shut all day.
 *
 * ── Why Intl, and not an offset ─────────────────────────────────────────────
 * Same reason as `lib/commentary/week.ts`: AEST is UTC+10, AEDT is UTC+11, the
 * changeover dates move, and a hardcoded offset is wrong for half the year.
 * `Intl.DateTimeFormat` reads the platform's own tz database.
 *
 * ── Why the holidays are computed, not listed ───────────────────────────────
 * ASX publishes its trading calendar one year at a time. A pasted list of dates
 * is correct until the January nobody remembered to update it, and then it is
 * silently wrong — the market shows as open on Good Friday and nothing fails
 * loudly enough to notice. The eight closures follow rules that have not moved
 * in decades, so the rules are what is encoded; `ONE_OFF_CLOSURES` carries the
 * genuinely unpredictable days.
 *
 * Verified against ASX's published cash-market calendar for 2026 and 2027, both
 * of which the tests pin date-for-date.
 *
 * ── Safe on both sides of the wire ──────────────────────────────────────────
 * No `server-only`, unlike the rest of `lib/asx/`: the header stamp and the
 * countdown are client components, and the point of the module is that they and
 * the server agree.
 */

/** The desk's timezone. Everything the market does happens on this clock. */
export const DESK_TZ = "Australia/Sydney";

/* ───────────────────────────── session times ─────────────────────────────── */

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;

const hm = (h: number, m = 0) => h * MS_PER_HOUR + m * MS_PER_MINUTE;

/** Brokers may queue orders from 07:00; nothing matches until the open. */
const PRE_OPEN_AT = hm(7);
/** The opening auction is randomised across 09:59:45 ± 15s. Call it 10:00. */
const OPEN_AT = hm(10);
/** Normal trading ceases at 16:00 — 14:10 on the two half days below. */
const CLOSE_AT = hm(16);
const HALF_DAY_CLOSE_AT = hm(14, 10);
/**
 * Pre-CSPA runs for ten minutes after the close and the closing auction itself
 * lands at 16:10 ± 30s, so the last price of the day is not struck until about
 * 16:11. Between the close and then the market is neither open nor finished,
 * and printing "closed" over a price that is still being set is the reason this
 * phase is named rather than folded into one of its neighbours.
 */
const AUCTION_RUNS_FOR = hm(0, 11);

/* ──────────────────────────── the desk's clock ───────────────────────────── */

const DESK_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: DESK_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/**
 * An instant, as the desk sees it: which calendar day it is in Sydney and how
 * far into that day the clock has run.
 *
 * Sub-second precision is dropped deliberately. Every consumer renders whole
 * seconds, and `Date#getMilliseconds` answers for the host's timezone rather
 * than Sydney's — harmless today, since every real UTC offset is a whole number
 * of minutes, but not a thing worth depending on for a digit nobody displays.
 */
function deskClock(at: Date): { date: string; msOfDay: number } {
  const parts: Record<string, string> = {};
  for (const part of DESK_PARTS.formatToParts(at)) parts[part.type] = part.value;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    msOfDay: hm(Number(parts.hour), Number(parts.minute)) + Number(parts.second) * 1000,
  };
}

/** `YYYY-MM-DD` for this instant, on the desk's clock. */
export function deskDate(at: Date = new Date()): string {
  return deskClock(at).date;
}

/** Hour of the day, 0–23, on the desk's clock. */
export function deskHour(at: Date = new Date()): number {
  return Math.floor(deskClock(at).msOfDay / MS_PER_HOUR);
}

/* ─────────────────── calendar arithmetic, timezone-free ──────────────────── */

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** Shift a `YYYY-MM-DD` by whole days, with no timezone anywhere near it. */
function shiftDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const at = new Date(Date.UTC(y, m - 1, d) + days * 86_400_000);
  return ymd(at.getUTCFullYear(), at.getUTCMonth() + 1, at.getUTCDate());
}

/**
 * Numeric weekday (0 = Sunday) of a `YYYY-MM-DD`. UTC throughout: the string
 * already *is* a Sydney date, so re-interpreting it in any zone would be a
 * second conversion of an already-converted value.
 */
function weekdayOf(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

const isWeekend = (date: string) => weekdayOf(date) % 6 === 0;

/* ──────────────────────────── the closed days ────────────────────────────── */

/**
 * Easter Sunday, by the anonymous Gregorian computus. Good Friday and Easter
 * Monday hang off it, and they are the only ASX closures whose date cannot be
 * written down as a rule about a fixed day of the month.
 */
function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd(year, month, day);
}

/** The Monday a weekend holiday is observed on. */
function observedMonday(date: string): string {
  const day = weekdayOf(date);
  if (day === 6) return shiftDays(date, 2);
  if (day === 0) return shiftDays(date, 1);
  return date;
}

/**
 * Christmas and Boxing Day both move two days when they land on a weekend,
 * rather than to "the next Monday": a Saturday Christmas is taken on the Monday
 * and pushes Boxing Day to the Tuesday, and a Sunday Christmas is taken on the
 * Tuesday because Boxing Day already owns the Monday. Two days covers both.
 */
function observedPlusTwo(date: string): string {
  return isWeekend(date) ? shiftDays(date, 2) : date;
}

/** The nth occurrence of a weekday in a month — King's Birthday is 2nd Monday. */
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  const first = ymd(year, month, 1);
  const offset = (weekday - weekdayOf(first) + 7) % 7;
  return shiftDays(first, offset + (n - 1) * 7);
}

/**
 * Closures that follow no rule: a national day of mourning, an outage declared
 * a non-trading day after the fact. Add them here when ASX announces one; the
 * rules above cover everything else.
 */
const ONE_OFF_CLOSURES: Record<string, string> = {
  // Queen Elizabeth II — the ASX did not trade.
  "2022-09-22": "National Day of Mourning",
};

const holidayCache = new Map<number, Map<string, string>>();

/** Every day the ASX cash market does not trade in a given year, by date. */
function holidaysFor(year: number): Map<string, string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;

  const days = new Map<string, string>();
  days.set(observedMonday(ymd(year, 1, 1)), "New Year's Day");
  days.set(observedMonday(ymd(year, 1, 26)), "Australia Day");

  const easter = easterSunday(year);
  days.set(shiftDays(easter, -2), "Good Friday");
  days.set(shiftDays(easter, 1), "Easter Monday");

  // Anzac Day is NOT moved off a weekend. NSW takes the Monday after a Sunday
  // Anzac Day off; the ASX trades it, which is why this is the one fixed-date
  // closure with no observance rule. ASX's own 2027 calendar confirms it —
  // Monday 26 April 2027 is a trading day.
  days.set(ymd(year, 4, 25), "Anzac Day");

  days.set(nthWeekday(year, 6, 1, 2), "King's Birthday");

  days.set(observedPlusTwo(ymd(year, 12, 25)), "Christmas Day");
  days.set(observedPlusTwo(ymd(year, 12, 26)), "Boxing Day");

  const prefix = `${year}-`;
  for (const [date, name] of Object.entries(ONE_OFF_CLOSURES)) {
    if (date.startsWith(prefix)) days.set(date, name);
  }

  holidayCache.set(year, days);
  return days;
}

/** The name of the holiday closing the market on a Sydney date, if any. */
export function holidayOn(date: string): string | null {
  return holidaysFor(Number(date.slice(0, 4))).get(date) ?? null;
}

/** Does the ASX cash market trade on this Sydney date at all? */
export function isTradingDay(date: string): boolean {
  return !isWeekend(date) && holidayOn(date) === null;
}

/** The last trading day on or before a date. */
function tradingDayOnOrBefore(date: string): string {
  let cursor = date;
  // Four consecutive closed days is the worst the calendar produces (Easter).
  for (let i = 0; i < 10 && !isTradingDay(cursor); i++) cursor = shiftDays(cursor, -1);
  return cursor;
}

/**
 * The two half days: the last trading day before Christmas and the last of the
 * year, both of which stop normal trading at 14:10. They are defined by the
 * trading calendar rather than by date — when 24 December is a Saturday the
 * early close is the Friday before it.
 */
export function isHalfDay(date: string): boolean {
  const year = Number(date.slice(0, 4));
  return (
    date === tradingDayOnOrBefore(ymd(year, 12, 24)) ||
    date === tradingDayOnOrBefore(ymd(year, 12, 31))
  );
}

/** When normal trading ceases on a Sydney date, as ms since local midnight. */
function closeAtOn(date: string): number {
  return isHalfDay(date) ? HALF_DAY_CLOSE_AT : CLOSE_AT;
}

/* ─────────────────────────────── the session ─────────────────────────────── */

export type AsxPhase = "closed" | "pre-open" | "open" | "closing-auction";

export type AsxSession = {
  phase: AsxPhase;
  /** Ready for the header stamp: "ASX open", "ASX closed", … */
  label: string;
  /** The Sydney calendar date this session belongs to, `YYYY-MM-DD`. */
  date: string;
  /** The holiday keeping the market shut today, when one is. */
  holiday: string | null;
  /** Today stops normal trading at 14:10 rather than 16:00. */
  halfDay: boolean;
  /** ms until normal trading ceases; null unless the market is open now. */
  msToClose: number | null;
  /** ms until normal trading starts; null unless it still will today. */
  msToOpen: number | null;
};

const LABELS: Record<AsxPhase, string> = {
  closed: "ASX closed",
  "pre-open": "ASX pre-open",
  open: "ASX open",
  "closing-auction": "ASX closing auction",
};

/**
 * Where the market is right now.
 *
 * The distances to open and close are plain subtraction on the Sydney wall
 * clock rather than on instants, and that is exact for what it is used for:
 * Sydney changes its offset at 2am/3am, so no daylight-saving boundary can ever
 * fall between the current time and a 10:00 or 16:00 on the same day.
 */
export function asxSession(at: Date = new Date()): AsxSession {
  const { date, msOfDay } = deskClock(at);
  const holiday = holidayOn(date);
  const trading = isTradingDay(date);
  const base = { date, holiday, halfDay: trading && isHalfDay(date) };

  const shut = (msToOpen: number | null = null): AsxSession => ({
    ...base,
    phase: "closed",
    label: LABELS.closed,
    msToClose: null,
    msToOpen,
  });

  if (!trading) return shut();

  const closeAt = closeAtOn(date);

  // Before brokers can even queue an order, the market is shut — but it will
  // open today, and the countdown is more use saying so than saying nothing.
  if (msOfDay < PRE_OPEN_AT) return shut(OPEN_AT - msOfDay);

  if (msOfDay < OPEN_AT) {
    return {
      ...base,
      phase: "pre-open",
      label: LABELS["pre-open"],
      msToClose: null,
      msToOpen: OPEN_AT - msOfDay,
    };
  }
  if (msOfDay < closeAt) {
    return {
      ...base,
      phase: "open",
      label: LABELS.open,
      msToClose: closeAt - msOfDay,
      msToOpen: null,
    };
  }
  if (msOfDay < closeAt + AUCTION_RUNS_FOR) {
    return {
      ...base,
      phase: "closing-auction",
      label: LABELS["closing-auction"],
      msToClose: 0,
      msToOpen: null,
    };
  }
  return shut();
}

const STAMP_DATE = new Intl.DateTimeFormat("en-AU", {
  timeZone: "UTC",
  day: "numeric",
  month: "short",
  year: "2-digit",
});

/**
 * The header stamp: `12 Jun 26 · ASX open`.
 *
 * Formatted out of the session's own `YYYY-MM-DD` with `timeZone: "UTC"`, which
 * looks wrong and is not — the string has already been resolved to a Sydney
 * date, so formatting it in any other zone would convert an already-converted
 * value a second time and land a viewer in Los Angeles on yesterday.
 */
export function sessionStamp(session: AsxSession): string {
  const [y, m, d] = session.date.split("-").map(Number);
  return `${STAMP_DATE.format(new Date(Date.UTC(y, m - 1, d)))} · ${session.label}`;
}

/**
 * The countdown line under a live book: `closes 2:14:09` while the market is
 * trading, and what is actually happening the rest of the time.
 *
 * It reads from the session rather than counting to 4pm on the viewer's clock,
 * which is the whole point — the old version ran to 16:00 local and so was
 * wrong for every client outside AEST and every hour outside a trading day.
 */
export function closeCountdown(session: AsxSession): string {
  if (session.phase === "open" && session.msToClose !== null) {
    const total = Math.floor(session.msToClose / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return `closes ${h}:${pad(m)}:${pad(total % 60)}`;
  }
  if (session.phase === "closing-auction") return "closing auction";
  if (session.msToOpen !== null) {
    const total = Math.floor(session.msToOpen / 1000);
    return `opens in ${Math.floor(total / 3600)}h ${pad(Math.floor((total % 3600) / 60))}m`;
  }
  return "closed";
}
