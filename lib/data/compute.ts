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

/**
 * Illustrative daily P&L. The demo has no intraday price history, so the day
 * move is modelled with deterministic per-security factors (ported from the
 * legacy lib/db.ts). Deterministic keeps server render and client hydration in
 * sync — a random factor would flip values between the two.
 */
export function dailyPL(positions: Position[]): number {
  return positions.reduce((sum, p) => {
    const factor =
      p.code === "PLS"
        ? 0.021
        : p.code === "BHP"
          ? 0.008
          : p.code === "FMG"
            ? -0.006
            : p.code === "WDS"
              ? -0.004
              : 0.003;
    return sum + posValue(p) * factor;
  }, 0);
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

// ---------------------------------------------------------------------------
// Realized P&L (from the trade ledger)
// ---------------------------------------------------------------------------
// These live here rather than in lib/data/holdings.ts because that module is
// `server-only` and Client Components need to re-aggregate realized rows when
// the account filter changes.

/** Realized side of a holding, replayed from the settled trade ledger. */
export type RealizedSummary = {
  realizedPl: number;
  proceeds: number;
  costOfSold: number;
  /** Units the ledger saw bought. Compared against `unitsSold` to classify the
   *  exit — and to catch a ledger that sold more than it ever acquired. */
  unitsBought: number;
  unitsSold: number;
  fees: number;
  tradeCount: number;
  firstTrade: string | null;
  lastTrade: string | null;
  /** WAC was an approximation here (partial close of a mixed-price parcel). */
  hasPartial: boolean;
  /** Sold units the ledger never saw bought — realized P&L is overstated. */
  shortHistory: boolean;
};

/** Realized P&L at its natural grain: one row per account × parent code. */
export type RealizedRow = RealizedSummary & {
  accountId: string;
  parent: string;
};

/** Collapse account-grain rows to one entry per company. */
export function rollUpRealized(
  rows: RealizedRow[],
): Map<string, RealizedSummary> {
  const byParent = new Map<string, RealizedSummary>();

  for (const r of rows) {
    const prev = byParent.get(r.parent);
    byParent.set(r.parent, {
      realizedPl: (prev?.realizedPl ?? 0) + r.realizedPl,
      proceeds: (prev?.proceeds ?? 0) + r.proceeds,
      costOfSold: (prev?.costOfSold ?? 0) + r.costOfSold,
      unitsBought: (prev?.unitsBought ?? 0) + r.unitsBought,
      unitsSold: (prev?.unitsSold ?? 0) + r.unitsSold,
      fees: (prev?.fees ?? 0) + r.fees,
      tradeCount: (prev?.tradeCount ?? 0) + r.tradeCount,
      // Rows arrive unordered, so take the true extremes, not the first seen.
      firstTrade:
        !prev?.firstTrade || (r.firstTrade && r.firstTrade < prev.firstTrade)
          ? r.firstTrade
          : prev.firstTrade,
      lastTrade:
        !prev?.lastTrade || (r.lastTrade && r.lastTrade > prev.lastTrade)
          ? r.lastTrade
          : prev.lastTrade,
      hasPartial: (prev?.hasPartial ?? false) || r.hasPartial,
      shortHistory: (prev?.shortHistory ?? false) || r.shortHistory,
    });
  }

  return byParent;
}
