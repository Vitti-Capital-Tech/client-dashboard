import type { Position, OptionRow } from "./queries";

/**
 * Pure financial helpers over DAL shapes. No server-only imports (types are
 * erased at compile time), so these are safe to use in Client Components too.
 * Ports the math from lib/db.ts onto the normalized DAL types.
 */

export function posValue(p: Position): number {
  return p.qty * (p.last ?? 0);
}

export function posCost(p: Position): number {
  return p.qty * p.cost;
}

export function posPL(p: Position): number {
  return posValue(p) - posCost(p);
}

export function portfolioValue(positions: Position[], cash: number): number {
  return positions.reduce((sum, p) => sum + posValue(p), 0) + cash;
}

export function totalPL(positions: Position[]): number {
  return positions.reduce((sum, p) => sum + posPL(p), 0);
}

export function moneyness(o: OptionRow): number {
  const d = o.under - o.strike;
  return o.type === "Put" ? -d : d;
}

export function isITM(o: OptionRow): boolean {
  return moneyness(o) > 0.0001;
}

export function intrinsic(o: OptionRow): number {
  return Math.max(0, moneyness(o)) * o.qty;
}

/** Intrinsic value of open, unlisted options (the "at-risk" exercise value). */
export function unlistedValue(options: OptionRow[]): number {
  return options.reduce(
    (sum, o) =>
      !o.listed && o.status === "open"
        ? sum + o.qty * Math.max(0, o.under - o.strike)
        : sum,
    0,
  );
}
