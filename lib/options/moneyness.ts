/**
 * Moneyness — where an option's strike sits against the underlying's price, and
 * what the position is worth if it were exercised today.
 *
 * Pure and client-safe, so the client profile's Options tab and the staff
 * Options register can ask ONE function rather than each re-deciding what "in
 * the money" means. Two tables that disagree about which options are ITM is
 * exactly the kind of discrepancy the desk cannot resolve from the screen.
 *
 * This is deliberately NOT a valuation. A modelled unlisted option is priced by
 * Black-Scholes (`lib/black-scholes.ts`), which carries time value on top of
 * intrinsic and is what the stored P&L reports. Intrinsic is the floor under
 * that number — the part a holder could realise today — and it is what makes an
 * ITM badge checkable: strike, spot and quantity are all on the row beside it.
 */

/** Which side of the strike the underlying is trading. */
export type Moneyness = "ITM" | "ATM" | "OTM" | "unknown";

export type OptionMoneyness = {
  moneyness: Moneyness;
  /** Convenience for the common test — false whenever moneyness is unknown. */
  isItm: boolean;
  /** Exercise value of ONE option, floored at zero. */
  intrinsicPerOption: number;
  /** `qty × intrinsicPerOption` — the whole parcel's exercise value. */
  intrinsicValue: number;
};

/**
 * No verdict. Returned when the terms are missing, and passed deliberately for
 * rows where the question does not arise — a LISTED series is quoted and traded
 * on its own market, so its own price is the answer and an intrinsic figure
 * struck off the underlying says nothing the desk can act on.
 */
export const UNKNOWN_MONEYNESS: OptionMoneyness = {
  moneyness: "unknown",
  isItm: false,
  intrinsicPerOption: 0,
  intrinsicValue: 0,
};

/**
 * Prices arrive as `numeric` from Postgres and as parsed cells from the
 * tracker, so a NaN or an Infinity is a real possibility rather than a
 * defensive fiction. A strike of zero is treated as absent too: a free option
 * with no exercise price is a modelling artefact, and calling it "infinitely
 * ITM" would put a badge on a row nobody can act on.
 */
const usable = (n: number | null | undefined): n is number =>
  typeof n === "number" && Number.isFinite(n) && n > 0;

/**
 * ASX prices are quoted to a tenth of a cent, so anything closer than that is
 * the same price wearing floating-point noise — `0.14` reached by two different
 * routes must not read as ITM by 2e-17.
 */
const TICK = 0.0005;

export function moneynessOf({
  spot,
  strike,
  qty = 0,
  kind = "Call",
}: {
  /** Current price of the UNDERLYING, not of the option. */
  spot: number | null | undefined;
  strike: number | null | undefined;
  /** Options held. Only scales `intrinsicValue`; moneyness holds without it. */
  qty?: number | null;
  /** Placement grants are all calls; the register also carries puts. */
  kind?: "Call" | "Put" | null;
}): OptionMoneyness {
  if (!usable(spot) || !usable(strike)) return UNKNOWN_MONEYNESS;

  // A put is ITM on the other side of the strike and pays the mirror amount.
  // The register's `option_type` allows one, so reading every row as a call
  // would report a deep-ITM put as worthless.
  const edge = kind === "Put" ? strike - spot : spot - strike;

  const moneyness: Moneyness =
    Math.abs(edge) < TICK ? "ATM" : edge > 0 ? "ITM" : "OTM";

  const intrinsicPerOption = Math.max(edge, 0);
  const units = typeof qty === "number" && Number.isFinite(qty) ? Math.abs(qty) : 0;

  return {
    moneyness,
    isItm: moneyness === "ITM",
    intrinsicPerOption,
    intrinsicValue: intrinsicPerOption * units,
  };
}

/** The badge's wording, and null when there is nothing honest to claim. */
export function moneynessLabel(m: Moneyness): string | null {
  return m === "unknown" ? null : m;
}
