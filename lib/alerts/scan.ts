/**
 * What the desk should have told a client today, about their options.
 *
 * ── Why this is pure ────────────────────────────────────────────────────────
 * The engine takes option rows, a date and what it saw last time, and returns
 * alerts plus what to remember. It reads nothing and writes nothing, so every
 * rule in it is testable against a fixture rather than against a database at a
 * particular moment — and the rules are the part that has to be right.
 * `lib/alerts/run.ts` is the half that talks to Supabase.
 *
 * ── The one rule about what these may say ───────────────────────────────────
 * An alert states a fact and its consequence. It never recommends an action.
 *
 *   "MRD in the money · unlisted · window closes in 12 days · unlisted options
 *    are not exercised automatically"      ← fact, and why it matters
 *   "Exercise MRD before it expires"       ← advice, and not ours to give
 *
 * The same line `lib/commentary/prompt.ts` gates generated text on and
 * `lib/glossary.ts` is written to. Enforced by a test here too, because an
 * alert is the most action-shaped surface in the product and so the easiest
 * place to drift across it.
 *
 * ── Why alerts are events, not conditions ───────────────────────────────────
 * "Is in the money" is true for months on end. A scan that emitted an alert
 * whenever the condition held would hand a client one a day until the bell
 * became wallpaper — and a bell nobody reads has lost the one alert that
 * mattered. So every alert here is tied to a CROSSING, and carries a `key`
 * naming that crossing. The unique index in `…_alert_dedupe.sql` turns the key
 * into the guarantee: run this twenty times an hour, and after the first run it
 * inserts nothing.
 *
 * Two kinds of crossing, handled differently:
 *
 *   • **Expiry** crossings are implicit in the date. The ladder rung a grant
 *     sits in IS the key, so no memory is needed — 6 days is the 7-day rung
 *     today and tomorrow, and drops to the 3-day rung on its own.
 *   • **Moneyness** crossings are not. Whether today's "in the money" is new
 *     depends on yesterday, so the caller hands in `prev` and gets back the
 *     state to store. A grant that goes in, falls out and goes in again is two
 *     genuine events, and the spell counter is what keeps them distinct.
 */

import { moneynessOf, type Moneyness } from "../options/moneyness.ts";
import { priceText } from "../ui/price.ts";

/** What the scan needs to know about one option. A subset of `OptionRow`. */
export type ScannableOption = {
  id: string;
  clientId: string;
  code: string;
  listed: boolean;
  type: "Call" | "Put" | null;
  qty: number;
  strike: number | null;
  /** Price of the UNDERLYING. Null when there is no quote for it. */
  under: number | null;
  /** `YYYY-MM-DD`. */
  expiryDate: string;
  status: "open" | "pending" | "expired";
};

/** What the last scan saw, so this one can tell a crossing from a continuation. */
export type OptionScanState = {
  moneyness: Moneyness;
  /** Increments each time the grant crosses INTO the money past the band. */
  spell: number;
  /**
   * Inside a reported in-the-money spell.
   *
   * Set when an ITM alert fires and cleared only when the grant falls back
   * BELOW its strike. While it is set no further ITM alert can fire, which is
   * what stops a grant sitting near its strike from chattering.
   */
  inSpell: boolean;
};

export type ScannedAlert = {
  clientId: string;
  optionId: string;
  kind: "expiry" | "itm" | "window";
  severity: "red" | "amber" | "green";
  title: string;
  subtitle: string;
  /** Identifies the event. See the module header and the dedupe migration. */
  key: string;
};

/**
 * The escalation ladder, widest first.
 *
 * Five rungs rather than a daily countdown, because each rung is one event a
 * client can be told about once. The legacy `scanAlerts` in `lib/db.ts` had
 * these exact thresholds and the shape was right; what it lacked was anywhere
 * to run and any way to avoid repeating itself.
 */
const EXPIRY_LADDER = [30, 14, 7, 3, 1] as const;

/** Inside this many days, an exercisable unlisted grant is the red case. */
const URGENT_DAYS = 14;

/**
 * The in-the-money band, as a percentage of the strike.
 *
 * ── Why a band and not a line ───────────────────────────────────────────────
 * The first production run raised this, correctly by its own rules and useless
 * in practice:
 *
 *   OD6-UO is in the money · underlying $0.11 vs strike $0.10
 *
 * One cent above the strike, on a stock whose ordinary day is one cent. It
 * would have crossed out and back in within the week, and each crossing is a
 * genuinely new spell, so the client would have collected the same alert five
 * times a fortnight about a grant that had not really done anything.
 *
 * A single threshold cannot fix that — whatever line you draw, a price sitting
 * on it oscillates across it. Two thresholds can: report at ENTER, and do not
 * report again until the grant has fallen past EXIT. Between them nothing
 * happens, so the noise band around the strike is silent by construction.
 *
 * EXIT is the strike itself rather than a negative number, because "fell out of
 * the money" is a fact a holder would recognise, and requiring it to fall
 * further would leave a grant that genuinely recovered unable to alert.
 */
const ITM_ENTER_PCT = 5;
const ITM_EXIT_PCT = 0;

/**
 * How far in the money, as a percentage of the strike. Negative when out.
 *
 * Null when it cannot be answered — no strike, no quote, or a zero strike,
 * which would make the percentage meaningless rather than infinite.
 */
export function edgePct(
  spot: number | null,
  strike: number | null,
  kind: "Call" | "Put" | null,
): number | null {
  if (spot === null || strike === null || !(strike > 0)) return null;
  if (!Number.isFinite(spot) || !Number.isFinite(strike)) return null;
  const edge = kind === "Put" ? strike - spot : spot - strike;
  return (edge / strike) * 100;
}

const DAY_MS = 86_400_000;

/** Whole days from `today` to `expiry`, both `YYYY-MM-DD`, no clock involved. */
export function daysBetween(today: string, expiry: string): number {
  return Math.round(
    (Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS,
  );
}

/**
 * The narrowest ladder rung this many days falls inside, or null when the
 * expiry is further out than the widest rung.
 *
 * Narrowest, so 6 days reports the 7-day window rather than the 30-day one.
 * Because the key is built from the rung, crossing from 7 into 3 is a new key
 * and so a new alert, while sitting at 6 days for a second day is not.
 */
export function ladderRung(dte: number): number | null {
  if (dte < 0) return null;
  return EXPIRY_LADDER.filter((t) => dte <= t).at(-1) ?? null;
}

/**
 * A dollar AMOUNT — an exercise value, not a price.
 *
 * Kept separate from `priceText` deliberately. Three decimals on a $30,000
 * figure is noise; two decimals on a ten-cent price is a lie. The two are
 * different kinds of number and are formatted by different rules.
 */
const amount = (n: number) =>
  `$${n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const qtyOf = (n: number) => n.toLocaleString("en-AU");

export type OptionScanResult = {
  alerts: ScannedAlert[];
  /** What to remember for the next run. Null when there is nothing to track. */
  state: OptionScanState | null;
};

/** Every alert one option warrants today, and the state to carry forward. */
export function scanOption(
  o: ScannableOption,
  today: string,
  prev: OptionScanState | null,
): OptionScanResult {
  const m = moneynessOf({ spot: o.under, strike: o.strike, qty: o.qty, kind: o.type ?? "Call" });

  // `pending` and `expired` are not live positions, and an expired grant has
  // nothing left to warn about — the warning was due before it lapsed. State is
  // dropped with them, so a grant re-opened later starts its spell count fresh.
  if (o.status !== "open") return { alerts: [], state: null };

  const dte = daysBetween(today, o.expiryDate);
  if (dte < 0) return { alerts: [], state: null };

  /**
   * A crossing INTO the money, past the band, counted.
   *
   * `edge === null` — no strike, or no quote for the underlying — changes
   * nothing in either direction. Treating missing data as "fell out of the
   * money" would re-arm the alert, and the next quote to arrive would read as a
   * fresh crossing and fire a second time about a grant that never moved.
   */
  const edge = edgePct(o.under, o.strike, o.type);
  const wasInSpell = prev?.inSpell ?? false;

  const crossedIn = !wasInSpell && edge !== null && edge >= ITM_ENTER_PCT;
  // Re-armed only by falling back below the strike, not by dipping under the
  // entry band — that gap IS the hysteresis.
  const fellOut = wasInSpell && edge !== null && edge < ITM_EXIT_PCT;

  const spell = (prev?.spell ?? 0) + (crossedIn ? 1 : 0);
  const state: OptionScanState = {
    moneyness: m.moneyness === "unknown" ? (prev?.moneyness ?? "unknown") : m.moneyness,
    spell,
    inSpell: crossedIn ? true : fellOut ? false : wasInSpell,
  };

  const alerts: ScannedAlert[] = [];
  const base = { clientId: o.clientId, optionId: o.id };
  const days = `${dte} day${dte === 1 ? "" : "s"}`;
  // Prices to three places. `toFixed(2)` printed a $0.105 underlying as $0.11
  // — rounding it UP past a $0.10 strike, so a 5% edge read as a 10% one in an
  // alert whose entire subject is the distance between those two numbers.
  const strikeStr = priceText(o.strike);
  const underStr = o.under === null ? "no price" : priceText(o.under);

  const rung = ladderRung(dte);
  if (rung !== null) {
    alerts.push({
      ...base,
      kind: "expiry",
      // Amber even at three days for a LISTED series: it can be sold on market
      // right up to expiry, so the deadline is real but it is not a cliff.
      severity: !o.listed && m.isExercisable && dte <= URGENT_DAYS ? "red" : "amber",
      title: `${o.code} expires in ${days}`,
      subtitle: [
        o.listed ? "Listed" : "Unlisted",
        `${qtyOf(o.qty)} @ ${strikeStr}`,
        `${rung}-day window`,
      ].join(" · "),
      key: `expiry:${o.id}:${rung}`,
    });
  }

  /**
   * The grant is worth exercising and nothing will do it for them.
   *
   * This is the alert the whole feature exists for. A listed series is quoted
   * and can be sold on its own market, so a holder who does nothing still has a
   * tradeable asset. An unlisted grant that reaches expiry unexercised is worth
   * nothing at all, however deep in the money it was the day before — which
   * makes silence here the one failure with a dollar figure attached.
   *
   * Keyed on the rung, so it repeats down the ladder: a client who ignored the
   * 14-day notice is told again at 7, 3 and 1. That is not noise. It is the
   * one case where escalation is the point.
   */
  if (!o.listed && m.isExercisable && dte <= URGENT_DAYS) {
    alerts.push({
      ...base,
      kind: "window",
      severity: "red",
      title: `${o.code} — exercise window closes in ${days}`,
      subtitle: [
        `${qtyOf(o.qty)} at ${strikeStr}`,
        `underlying ${underStr}`,
        `exercise value ${amount(m.intrinsicValue)}`,
        "unlisted options are not exercised automatically",
      ].join(" · "),
      key: `window:${o.id}:${rung}`,
    });
  }

  /**
   * It has just crossed into the money.
   *
   * Suppressed inside the urgent window for an unlisted grant, because the red
   * alert above already says this and says it more usefully. Two rows about one
   * grant on one morning is how a bell starts getting ignored.
   */
  if (crossedIn && !(!o.listed && dte <= URGENT_DAYS)) {
    const edgeStr = edge === null ? "" : `${edge >= 0 ? "+" : ""}${edge.toFixed(1)}% vs strike`;
    alerts.push({
      ...base,
      kind: "itm",
      severity: "green",
      title: `${o.code} is in the money`,
      subtitle: [
        `underlying ${underStr} vs strike ${strikeStr}`,
        edgeStr,
        `exercise value ${amount(m.intrinsicValue)}`,
        `${days} to expiry`,
      ]
        .filter(Boolean)
        .join(" · "),
      key: `itm:${o.id}:${spell}`,
    });
  }

  return { alerts, state };
}

export type BookScanResult = {
  alerts: ScannedAlert[];
  /** `option_id` → state to persist for the next run. */
  states: Map<string, OptionScanState>;
};

/** Every alert a whole book warrants today, and the state to write back. */
export function scanBook(
  options: ScannableOption[],
  today: string,
  prior: Map<string, OptionScanState>,
): BookScanResult {
  const alerts: ScannedAlert[] = [];
  const states = new Map<string, OptionScanState>();

  for (const o of options) {
    const { alerts: got, state } = scanOption(o, today, prior.get(o.id) ?? null);
    alerts.push(...got);
    if (state) states.set(o.id, state);
  }

  return { alerts, states };
}
