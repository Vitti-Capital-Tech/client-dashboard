/**
 * Black-Scholes European call pricing — pure, dependency-free.
 *
 * Used to value the free UNLISTED options attached to a placement. They do not
 * trade, so there is no market price to read: the only defensible number is a
 * model price, and the desk fixes volatility / rate / dividend yield by policy
 * rather than fitting them per name (see `UNLISTED_OPTION_ASSUMPTIONS`).
 *
 * A model price is an estimate, not a mark. Every figure derived from it is
 * labelled as such in the P&L table and its exports.
 */

/**
 * Standard normal CDF.
 *
 * Abramowitz & Stegun 7.1.26 applied to erf, |error| < 1.5e-7 — far tighter than
 * the uncertainty in a hand-fixed 50% volatility, so it is not the weak link.
 */
export function normalCdf(x: number): number {
  // erf(z) via A&S 7.1.26, mirrored for negative z.
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;

  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-z * z);

  return 0.5 * (1 + sign * y);
}

export interface BlackScholesInput {
  /** Spot price of the underlying. */
  spot: number;
  /** Strike price. */
  strike: number;
  /** Time to expiry in YEARS. */
  timeToExpiryYears: number;
  /** Annualised volatility as a DECIMAL (0.5 = 50%). */
  volatility: number;
  /** Continuously-compounded risk-free rate as a DECIMAL (0.05 = 5%). */
  riskFreeRate: number;
  /** Continuous dividend yield as a DECIMAL (0 = none). */
  dividendYield: number;
}

/**
 * Black-Scholes value of a European CALL.
 *
 * Degenerate inputs collapse to intrinsic value rather than returning NaN:
 * an expired or zero-vol option is worth exactly what it is worth exercised, and
 * a chart-less/suspended underlying (spot 0) is worth nothing. Returning NaN here
 * would silently poison a P&L total.
 */
export function blackScholesCall(input: BlackScholesInput): number {
  const { spot, strike, timeToExpiryYears: T, volatility: sigma, riskFreeRate: r, dividendYield: q } = input;

  if (!Number.isFinite(spot) || !Number.isFinite(strike) || spot <= 0 || strike <= 0) return 0;

  // At or past expiry, or with no uncertainty left, the option IS its intrinsic value.
  if (!Number.isFinite(T) || T <= 0 || !Number.isFinite(sigma) || sigma <= 0) {
    return Math.max(spot - strike, 0);
  }

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(spot / strike) + (r - q + (sigma * sigma) / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;

  const call = spot * Math.exp(-q * T) * normalCdf(d1) - strike * Math.exp(-r * T) * normalCdf(d2);

  return Math.max(call, 0);
}

/**
 * Desk policy for valuing unlisted placement options. Fixed by decision, not
 * fitted per name — an unlisted option has no market from which to imply
 * anything, so a consistent assumption beats a bespoke guess.
 */
export const UNLISTED_OPTION_ASSUMPTIONS = {
  /** 50% */
  volatility: 0.5,
  /** 5% */
  riskFreeRate: 0.05,
  /** 0% */
  dividendYield: 0,
} as const;

/** Days per year used to convert an expiry date into Black-Scholes' `T`. */
export const DAYS_PER_YEAR = 365;

/**
 * Year fraction from `asOf` to `expiry`, clamped at 0.
 *
 * Both are floored to UTC midnight so the result depends only on the calendar
 * date, never on the clock time the calculator happened to be opened — otherwise
 * the same file priced twice in one day gives two different answers.
 *
 * UTC on both sides deliberately, not local time. An expiry is built from a bare
 * `YYYY-MM-DD` as UTC midnight, so reading it back with local getters shifts it a
 * day earlier anywhere west of Greenwich (`2027-12-31T00:00:00Z` is 30 December
 * in New York). Measuring both ends on the same UTC calendar keeps the day count
 * exact wherever it runs.
 */
export function yearsToExpiry(expiry: Date, asOf: Date): number {
  const toUtcDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const days = (toUtcDay(expiry) - toUtcDay(asOf)) / 86_400_000;
  return days <= 0 ? 0 : days / DAYS_PER_YEAR;
}
