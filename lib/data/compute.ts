import type { Position, OptionRow, TradeRow } from "./queries";
import {
  replayLedger,
  type SellAttribution,
} from "../import/trades.ts";
import { money } from "../import/normalize.ts";

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

// ---------------------------------------------------------------------------
// Realized P&L over time
// ---------------------------------------------------------------------------

/** One period on the P&L-over-time chart. */
export type RealizedPeriod = {
  /** `YYYY-MM` — sorts lexicographically, which is also chronologically. */
  key: string;
  label: string; // 'Mar 26'
  realizedPl: number;
  proceeds: number;
  costOfSold: number;
  saleCount: number;
  /** Companies that contributed, largest absolute result first. */
  contributors: { parent: string; realizedPl: number; noCostBasis: boolean }[];
  /** At least one sale in this period drew on no cost basis. */
  hasUncosted: boolean;
};

/**
 * Attribute realised P&L to the individual sales that produced it, by replaying
 * the DAL's trade rows through the **same** cost-basis walk the importer uses.
 * One implementation, so the dated chart and the stored `realized_pnl` totals
 * cannot drift apart.
 *
 * Pass trades already scoped to one account — the account dimension is dropped
 * here (`scope: ""`) because the caller has filtered.
 */
export function attributeSells(trades: TradeRow[]): SellAttribution[] {
  return replayLedger(
    trades.map((t) => ({
      scope: "",
      parent: t.parent,
      cnote: t.cnote,
      side: t.side,
      tradeDate: t.tradeDate,
      units: t.units,
      value: t.value,
      status: t.status,
      fees: t.brokerage + t.otherCharges + t.gst,
    })),
  ).sells;
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function monthLabel(key: string): string {
  const [y, m] = key.split("-");
  return `${MONTHS[Number(m) - 1]} ${y.slice(2)}`;
}

/**
 * Bucket realised P&L by calendar month.
 *
 * The per-ticker rollup in `realized_pnl` cannot answer "how much did we make
 * in March" — it has no dates on the money. This replays the ledger to
 * attribute each realised dollar to the sale that produced it, then groups by
 * month.
 *
 * **Empty months are filled in.** A time axis that silently skips the months
 * nothing happened in compresses the gaps and makes activity look steadier
 * than it was.
 */
export function realizedByMonth(
  sells: SellAttribution[],
  /**
   * Per-ticker P&L corrections from the summary table, so the chart totals
   * agree with it. An override is a company-level figure with no date of its
   * own, so its delta is spread across that company's sale months **pro-rata
   * by units sold** — which is exactly where the corrected cost would have
   * landed had it been in the ledger. A company with no sales gets no chart
   * impact at all: correcting an unsold position changes unrealised P&L, and
   * nothing unrealised belongs on a realised chart.
   */
  deltaByTicker: Map<string, number> = new Map(),
): RealizedPeriod[] {
  if (sells.length === 0) return [];

  if (deltaByTicker.size > 0) {
    const soldByTicker = new Map<string, number>();
    for (const s of sells) {
      soldByTicker.set(s.parent, (soldByTicker.get(s.parent) ?? 0) + s.units);
    }
    sells = sells.map((s) => {
      const delta = deltaByTicker.get(s.parent);
      const totalUnits = soldByTicker.get(s.parent) ?? 0;
      if (!delta || totalUnits <= 0) return s;
      return { ...s, realizedPl: s.realizedPl + delta * (s.units / totalUnits) };
    });
  }

  const byKey = new Map<string, RealizedPeriod>();

  for (const s of sells) {
    const key = s.tradeDate.slice(0, 7); // YYYY-MM
    let p = byKey.get(key);
    if (!p) {
      p = {
        key,
        label: monthLabel(key),
        realizedPl: 0,
        proceeds: 0,
        costOfSold: 0,
        saleCount: 0,
        contributors: [],
        hasUncosted: false,
      };
      byKey.set(key, p);
    }

    p.realizedPl += s.realizedPl;
    p.proceeds += s.proceeds;
    p.costOfSold += s.costOfSold;
    p.saleCount += 1;
    p.hasUncosted = p.hasUncosted || s.noCostBasis;

    // Several sales of one company in a month read as one contributor.
    const existing = p.contributors.find((c) => c.parent === s.parent);
    if (existing) {
      existing.realizedPl += s.realizedPl;
      existing.noCostBasis = existing.noCostBasis || s.noCostBasis;
    } else {
      p.contributors.push({
        parent: s.parent,
        realizedPl: s.realizedPl,
        noCostBasis: s.noCostBasis,
      });
    }
  }

  const keys = [...byKey.keys()].sort();
  const out: RealizedPeriod[] = [];

  // Walk every month from first to last, inserting the quiet ones.
  const [startY, startM] = keys[0].split("-").map(Number);
  const [endY, endM] = keys[keys.length - 1].split("-").map(Number);

  for (let y = startY, m = startM; y < endY || (y === endY && m <= endM); ) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    out.push(
      byKey.get(key) ?? {
        key,
        label: monthLabel(key),
        realizedPl: 0,
        proceeds: 0,
        costOfSold: 0,
        saleCount: 0,
        contributors: [],
        hasUncosted: false,
      },
    );
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }

  for (const p of out) {
    p.realizedPl = money(p.realizedPl);
    p.proceeds = money(p.proceeds);
    p.costOfSold = money(p.costOfSold);
    p.contributors.sort((a, b) => Math.abs(b.realizedPl) - Math.abs(a.realizedPl));
  }

  return out;
}

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
