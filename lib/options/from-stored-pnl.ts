import type { OptionRow } from "../data/queries.ts";
import type { StoredPnlRow } from "../data/pnl.ts";
import { moneynessOf, UNKNOWN_MONEYNESS, type OptionMoneyness } from "./moneyness.ts";

/**
 * One options register, from the two places option data actually lives.
 *
 * ── Why this is shared rather than a staff detail ────────────────────────────
 * This derivation used to sit inside the staff console's own `useMemo`, and the
 * client portal's Options tab read `option_holdings` directly instead. That was
 * survivable only because nobody had ever signed in as a client: the moment one
 * did, the tab was empty for every client in the database — `option_holdings`
 * holds nothing and never has, because it was demo-seed data and no part of the
 * broker/tracker pipeline writes it. The real option positions arrive as
 * `pnl_summary` rows, which is what the staff screen was reading all along.
 *
 * So there is one function, and the two screens cannot disagree about what
 * counts as an option, what its terms are, or what exercising it is worth. A
 * client seeing a different strike from the adviser looking at the same grant is
 * the failure this removes.
 *
 * ── This does not scope anything ────────────────────────────────────────────
 * Pure, and it maps exactly the rows it is handed. Restricting a client to their
 * own rows is the CALLER's job and is done twice over: the client-scoped getters
 * filter on `client_id`, and the `pnl_summary` / `option_holdings` RLS policies
 * (`is_staff() OR client_id = current_client_id()`) are what actually enforce
 * it. Passing this function somebody else's rows would happily format them,
 * which is why it must never be handed an unscoped query.
 */

/** One row of the options register, whichever source it came from. */
export type OptionTableItem = {
  id: string;
  accountId: string;
  clientId: string;
  ticker: string;
  parentTicker: string | null;
  company: string;
  isUnlisted: boolean;
  isListed: boolean;
  quantity: number;
  costBasis: number;
  marketValue: number;
  pnl: number;
  /**
   * Null, never 0, when the terms could not be read.
   *
   * A grant whose strike did not parse is not a free option, and rendering it as
   * `$0.00` says exactly that — to a client, on their own holdings. Every
   * consumer has to show a blank instead.
   */
  strike: number | null;
  underlyingPrice: number | null;
  /** Where the strike sits against the underlying, and what exercising is worth. */
  money: OptionMoneyness;
  expiryDate: string | null;
  dte: number | null;
  pricingMethod: string | null;
  termsNote: string | null;
  source: string | null;
  status: "live" | "expired" | "exercised" | "pending";
};

/**
 * The expiry date and the days left to it.
 *
 * Two sources, in order of trust: an actual date on the row, then the option's
 * own NAME — the broker writes series as `… OPTION 30-JUN-27`, and for a
 * registered series that string is the only place the expiry appears. Returns
 * nulls rather than guessing when neither yields a date, because a wrong expiry
 * on an option is a wrong exercise window.
 */
export function parseExpiry(
  dateStr?: string | null,
  companyName?: string | null,
): { date: string | null; dte: number | null } {
  const daysUntil = (d: Date) =>
    Math.round((d.getTime() - Date.now()) / (1000 * 60 * 60 * 24));

  if (dateStr) {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) return { date: dateStr, dte: daysUntil(d) };
  }

  if (companyName) {
    const match = companyName.match(/OPTION\s+(\d{1,2})-([A-Za-z]{3})-(\d{2,4})/i);
    if (match) {
      const day = parseInt(match[1], 10);
      const monStr = match[2].toUpperCase();
      let year = parseInt(match[3], 10);
      if (year < 100) year += 2000;
      const months: Record<string, number> = {
        JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
        JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
      };
      if (monStr in months) {
        const d = new Date(year, months[monStr], day);
        const formatted = `${year}-${String(months[monStr] + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        return { date: formatted, dte: daysUntil(d) };
      }
    }
  }

  return { date: null, dte: null };
}

/** Is this stored P&L row an option position at all? */
export function isOptionRow(r: StoredPnlRow): boolean {
  return Boolean(
    r.isOption ||
      r.isUnlistedOption ||
      r.ticker.endsWith("-UO") ||
      (r.instrument && r.instrument.toLowerCase().includes("option")),
  );
}

/**
 * What the register shows as the position size.
 *
 * Bought units first, then sold, then whatever is open. A grant that has been
 * exercised in full still belongs on the register — it is the same holding,
 * closed — so falling through to the sell leg is deliberate rather than a
 * fallback for missing data.
 */
function registerQuantity(r: StoredPnlRow): number {
  if (r.buyQty > 0) return r.buyQty;
  if (r.sellQty > 0) return r.sellQty;
  return r.openQty !== 0 ? Math.abs(r.openQty) : 0;
}

function fromStoredPnl(rows: StoredPnlRow[]): {
  items: OptionTableItem[];
  seen: Set<string>;
} {
  const items: OptionTableItem[] = [];
  const seen = new Set<string>();

  for (const r of rows) {
    if (!isOptionRow(r)) continue;

    const isUnlisted = Boolean(r.isUnlistedOption || r.ticker.endsWith("-UO"));
    const key = `${r.accountId}:${r.ticker}`;
    seen.add(key);

    // Terms are carried only by the MODELLED grants — they were the inputs to
    // that row's price. A listed series is quoted and traded on its own market,
    // so its Current Value is already the answer; a strike and an intrinsic
    // figure struck off the underlying would be a second, unrelated number
    // sitting beside it claiming to describe the same row.
    const uo = r.unlistedOption;
    const strike = uo?.strike ?? null;
    const underlyingPrice = uo?.spot ?? null;
    const { date: expiryDate, dte } = parseExpiry(uo?.expiry ?? null, r.company);
    const quantity = registerQuantity(r);

    const pricingMethod = uo?.pricingMethod
      ? uo.pricingMethod === "black-scholes"
        ? "Black-Scholes model"
        : "Intrinsic value"
      : isUnlisted
        ? "Modelled grant"
        : "Listed feed";

    const termsNote =
      uo?.raw ||
      r.comment ||
      (isUnlisted
        ? "Free unlisted placement options"
        : r.company || "Exchange traded listed options");

    items.push({
      id: `pnl-${key}`,
      accountId: r.accountId,
      clientId: r.clientId,
      ticker: r.ticker,
      parentTicker: r.parentTicker,
      company: r.company || r.ticker,
      isUnlisted,
      isListed: !isUnlisted,
      quantity,
      costBasis: r.buyPrice,
      marketValue: r.sellPrice,
      pnl: r.pnl,
      strike,
      underlyingPrice,
      // Placement grants are calls by construction.
      money: isUnlisted
        ? moneynessOf({ spot: underlyingPrice, strike, qty: quantity, kind: "Call" })
        : UNKNOWN_MONEYNESS,
      expiryDate,
      dte,
      pricingMethod,
      termsNote,
      source: isUnlisted ? "Placement grant" : "Broker feed",
      status: "live",
    });
  }

  return { items, seen };
}

const HOLDING_STATUS: Record<string, OptionTableItem["status"]> = {
  open: "live",
  expired: "expired",
  exercised: "exercised",
  pending: "pending",
};

function fromOptionHoldings(rows: OptionRow[], seen: Set<string>): OptionTableItem[] {
  const items: OptionTableItem[] = [];

  for (const o of rows) {
    const accountId = o.accountId || "";
    // A stored P&L row for the same account and ticker is the richer record —
    // it has a valuation behind it — so the register entry is dropped rather
    // than listed twice.
    if (seen.has(`${accountId}:${o.code}`)) continue;

    const isUnlisted = !o.listed;
    const { date: expiryDate, dte } = parseExpiry(o.expiryDate, o.name);

    // These rows have no stored valuation behind them — the register is all
    // there is — so exercise value IS the value reported, for listed and
    // unlisted alike. Taken from the shared helper rather than open-coded,
    // which is what had a registered PUT reading as worthless whenever it was
    // in the money.
    const money = moneynessOf({
      spot: o.under,
      strike: o.strike,
      qty: o.qty,
      kind: o.type,
    });

    items.push({
      id: `opt-${o.id}`,
      accountId,
      clientId: o.clientId,
      ticker: o.code,
      parentTicker: o.code.replace(/O[A-Z]?$/, ""),
      company: o.name || o.code,
      isUnlisted,
      isListed: o.listed,
      quantity: o.qty,
      costBasis: 0,
      marketValue: money.intrinsicValue,
      pnl: money.intrinsicValue,
      // Reported only for the unlisted grants, matching the stored-P&L rows
      // above — one rule for the whole table, so a listed series never shows a
      // strike on one screen and a dash on the other.
      strike: isUnlisted ? o.strike : null,
      underlyingPrice: isUnlisted ? o.under : null,
      money: isUnlisted ? money : UNKNOWN_MONEYNESS,
      expiryDate,
      dte,
      pricingMethod: o.listed ? "Listed feed" : "Manual registry",
      termsNote: o.source || (o.listed ? "Listed option series" : "Unlisted placement option"),
      source: o.source || (o.listed ? "Broker feed" : "Manual register"),
      status: HOLDING_STATUS[o.status] || "live",
    });
  }

  return items;
}

/**
 * The register for whatever rows the caller was allowed to read.
 *
 * Stored P&L first, because a ticker present in both is better described there;
 * the `option_holdings` entry for the same account and ticker is then skipped.
 */
export function optionsFromSources(
  storedPnl: StoredPnlRow[],
  optionHoldings: OptionRow[] = [],
): OptionTableItem[] {
  const { items, seen } = fromStoredPnl(storedPnl);
  return [...items, ...fromOptionHoldings(optionHoldings, seen)];
}
