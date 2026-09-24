/**
 * When an option expires, said the way a holder asks: "how long have I got?"
 *
 * ── Where the date comes from ───────────────────────────────────────────────
 * `parseExpiry`, the same reader the alert scanner uses, so the Options tab and
 * the expiry alerts can never disagree about a date. It tries the row's own
 * `expiry` first (unlisted grants carry one from the Placement Tracker) and then
 * the series NAME — the broker writes a listed series as `… OPTION 30-JUN-27`,
 * and that string is the only place its expiry appears. Neither yields a date →
 * null, shown as "—". A guessed expiry is a wrong exercise window.
 *
 * Pure, and free of any server import: it runs in the client portal.
 */

import type { PnlSummaryRow } from "../export/order-history.ts";
import { parseExpiry } from "./from-stored-pnl.ts";

/** The filter choices on the Options tab, in the order they are offered. */
export const EXPIRY_FILTERS = ["all", "30d", "90d", "12m", "later", "expired", "unknown"] as const;
export type ExpiryFilter = (typeof EXPIRY_FILTERS)[number];

export const EXPIRY_FILTER_LABELS: Record<ExpiryFilter, string> = {
  all: "All expiries",
  "30d": "Within 30 days",
  "90d": "Within 90 days",
  "12m": "Within 12 months",
  later: "More than 12 months",
  expired: "Expired",
  unknown: "No expiry on record",
};

export type OptionExpiry = {
  /** `YYYY-MM-DD`, or null when no date could be read. */
  date: string | null;
  /** Whole days from today; negative once expired; null when unknown. */
  dte: number | null;
};

/** The expiry of one option row. */
export function optionExpiry(row: Pick<PnlSummaryRow, "expiry" | "name">): OptionExpiry {
  return parseExpiry(row.expiry ?? null, row.name);
}

/**
 * "12 days", "5 months", "1 yr 3 mo" — precise where it matters.
 *
 * Days up to two months, because that is where a holder decides whether to act
 * and "1 month" would blur 31 days into 59. Months beyond that, and years past a
 * year, because "418 days" is a number nobody reads as a time.
 */
export function timeToExpiryLabel(dte: number | null): string {
  if (dte === null) return "—";
  if (dte < 0) {
    const ago = -dte;
    return `Expired ${ago} day${ago === 1 ? "" : "s"} ago`;
  }
  if (dte === 0) return "Expires today";
  if (dte <= 60) return `${dte} day${dte === 1 ? "" : "s"}`;
  if (dte < 365) {
    const months = Math.round(dte / 30.44);
    return `${months} months`;
  }
  const years = Math.floor(dte / 365.25);
  const months = Math.round((dte - years * 365.25) / 30.44);
  // `months` can round up to 12 on the last days before an anniversary.
  if (months >= 12) return `${years + 1} yr`;
  return months === 0 ? `${years} yr` : `${years} yr ${months} mo`;
}

/**
 * Does an option's days-to-expiry fall under a filter?
 *
 * The "within" choices are CUMULATIVE — within 90 days includes the ones within
 * 30 — because that is the question being asked ("what expires before the end
 * of the quarter?"). Expired and unknown are kept out of every "within" choice:
 * an option that has already lapsed is not one about to.
 */
export function matchesExpiryFilter(dte: number | null, filter: ExpiryFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "unknown":
      return dte === null;
    case "expired":
      return dte !== null && dte < 0;
    case "30d":
      return dte !== null && dte >= 0 && dte <= 30;
    case "90d":
      return dte !== null && dte >= 0 && dte <= 90;
    case "12m":
      return dte !== null && dte >= 0 && dte <= 365;
    case "later":
      return dte !== null && dte > 365;
  }
}

/** `2027-06-30` → `30 Jun 2027`. The ISO form is unambiguous but not how anyone reads a date. */
export function formatExpiryDate(iso: string | null): string {
  if (!iso) return "—";
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[Number(m[2]) - 1];
  return month ? `${Number(m[3])} ${month} ${m[1]}` : iso;
}
