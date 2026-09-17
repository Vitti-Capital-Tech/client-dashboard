/**
 * A traded price, written the way the market quotes it.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Last prices were being formatted at ten call sites with `toFixed(2)`, and two
 * decimals is not enough for this book. Most of the register is small-cap ASX
 * names trading in fractions of a cent, where the second decimal is the whole
 * position: a grant struck at $0.10 against an underlying of $0.105 is 5% in
 * the money, and `toFixed(2)` prints that as
 *
 *     underlying $0.11 vs strike $0.10
 *
 * which rounds the number UP past the strike and makes a 5% edge look like a
 * 10% one. That line went out in a real alert. Two decimals do not describe a
 * ten-cent stock, and every screen that quotes one was saying something
 * slightly untrue.
 *
 * ── Why "up to" three and not exactly three ─────────────────────────────────
 * `minimumFractionDigits: 2` keeps a $40 stock reading `$40.25` rather than
 * `$40.250`, which is a trailing zero that claims a precision the quote does
 * not have. The third place appears only when the price actually uses it. Same
 * shape as `money4` in the options tables, which keeps up to four places for
 * strikes quoted in fractions of a cent.
 *
 * ── What this is NOT for ────────────────────────────────────────────────────
 * Money totals. A portfolio value, a cost base, a P&L figure — those are
 * amounts of dollars, and a third decimal on `$424,220.15` is noise. Those keep
 * `money2`. This is only for the price OF one unit of something.
 *
 * Index levels are also not prices: the ticker quotes XJO in points with its
 * own `dp`, and that stays as it is.
 */

const PRICE = new Intl.NumberFormat("en-AU", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 3,
});

/** `0.105`, `40.25` — no currency symbol, for callers that add their own. */
export function priceDigits(n: number): string {
  return PRICE.format(n);
}

/**
 * `$0.105`, or an em dash when there is no price.
 *
 * Null is rendered rather than defaulted to zero: a security we have no quote
 * for is not a security worth nothing, and `$0.00` is the wrong answer to
 * "what is this trading at".
 */
export function priceText(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  // Sign outside the symbol — `-$0.105`, not `$-0.105`. A last price is never
  // negative, but this helper has no way to insist on that and the wrong form
  // would be a small ugliness in whatever screen first hands it one.
  const sign = n < 0 ? "-" : "";
  return `${sign}$${PRICE.format(Math.abs(n))}`;
}
