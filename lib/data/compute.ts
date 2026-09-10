import type { Position, OptionRow, TradeRow } from "./queries";
import {
  replayLedger,
  type LedgerLine,
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
  /**
   * The bucket: `YYYY-MM`, `YYYY-Qn` or `YYYY`, whichever grain the range was
   * drawn at (see `grainFor`). Every form sorts lexicographically, which
   * inside one grain is also chronologically.
   */
  key: string;
  label: string; // 'Mar 26' | 'Q1 26' | '2026'
  realizedPl: number;
  proceeds: number;
  costOfSold: number;
  saleCount: number;
  /**
   * Instruments that contributed, largest absolute result first.
   *
   * The INSTRUMENT, matching the table beside this chart. It was the parent,
   * which folded an option into its ordinary — so a month whose result came
   * from selling `OD6O` credited `OD6`, and the tooltip and the table named
   * different things for the same money. `parent` rides along for a rollup.
   */
  contributors: {
    code: string;
    parent: string;
    realizedPl: number;
    noCostBasis: boolean;
  }[];
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
 *
 * ── `offLedger`: the purchases the ledger never recorded ────────────────────
 * A placement reaches the client as a SALE with no matching purchase: it is
 * transacted through the house account and journalled out, so no client
 * contract note exists. Replaying the ledger alone therefore costed those sales
 * at zero and reported the whole proceeds as profit — while the stored P&L
 * beside it showed the real cost, which the tracker merge had filled in.
 *
 * `lib/pnl/off-ledger-buys.ts` recovers those parcels; they are handed in here
 * so the replay pools them like any other purchase. Callers that have no stored
 * rows to recover from pass nothing and get the old behaviour, which for a book
 * of purely on-market trades is the same answer.
 */
export function attributeSells(
  trades: TradeRow[],
  offLedger: LedgerLine[] = [],
): SellAttribution[] {
  return replayLedger([
    ...trades.map(
      (t): LedgerLine => ({
        scope: "",
        parent: t.parent,
        code: t.code,
        cnote: t.cnote,
        side: t.side,
        tradeDate: t.tradeDate,
        units: t.units,
        value: t.value,
        status: t.status,
        fees: t.brokerage + t.otherCharges + t.gst,
      }),
    ),
    ...offLedger,
  ]).sells;
}

/**
 * Fold the desk's per-ticker P&L corrections into dated sales.
 *
 * An override is a company-level figure with no date of its own, so its delta
 * is spread across that company's sales **pro-rata by units sold** — which is
 * exactly where the corrected cost would have landed had it been in the ledger.
 * A company with no sales gets nothing: correcting an unsold position changes
 * unrealised P&L, and nothing unrealised belongs on a realised figure.
 *
 * Shared by `realizedByPeriod` and `realizedBetween` so a bucket on the chart
 * and a date range on the client's own screen cannot apply corrections
 * differently.
 * It MUST run over the whole sale history before any date filter: the pro-rata
 * weights are shares of a company's total units sold, and re-deriving them from
 * a window would hand that window a share of the correction sized to the window
 * rather than to the sale.
 */
function applyOverrideDeltas(
  sells: SellAttribution[],
  deltaByTicker: Map<string, number>,
): SellAttribution[] {
  if (deltaByTicker.size === 0) return sells;

  const soldByTicker = new Map<string, number>();
  for (const s of sells) {
    soldByTicker.set(s.parent, (soldByTicker.get(s.parent) ?? 0) + s.units);
  }
  return sells.map((s) => {
    const delta = deltaByTicker.get(s.parent);
    const totalUnits = soldByTicker.get(s.parent) ?? 0;
    if (!delta || totalUnits <= 0) return s;
    return { ...s, realizedPl: s.realizedPl + delta * (s.units / totalUnits) };
  });
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

/** How wide one column is. Chosen from the range, never asked for. */
export type PeriodGrain = "month" | "quarter" | "year";

/**
 * Read the grain back off a bucket key, so the key format has ONE owner.
 *
 * The chart wants it only for its prose — "by quarter", "no sales settled this
 * quarter". The row shape is identical at every grain, which is why the
 * columns, the tooltip and the contributor list did not have to change.
 */
export function grainOfKey(key: string): PeriodGrain {
  if (key.length === 4) return "year";
  return key.includes("Q") ? "quarter" : "month";
}

/** Months since year zero, so spans and walks are plain arithmetic. */
const monthIndex = (ym: string) => {
  const [y, m] = ym.split("-").map(Number);
  return y * 12 + (m - 1);
};

/**
 * Bucket width from the span, so the axis never carries much more than a
 * dozen columns.
 *
 * Thirty-six monthly columns in a 668px plot is 18px a slot — bars thin enough
 * to read as hairlines and labels that have to be thinned to every third one
 * to fit. Widening the bucket instead keeps the count near twelve at any range
 * the picker can produce, which is 55px+ per label and a column wide enough to
 * be a column. Twelve quarters are also simply easier to read than thirty-six
 * months: the eye is being asked for a trend, not for March.
 */
function grainFor(firstMonth: string, lastMonth: string): PeriodGrain {
  const months = monthIndex(lastMonth) - monthIndex(firstMonth) + 1;
  if (months <= 12) return "month";
  if (months <= 36) return "quarter";
  return "year";
}

/** The bucket a month belongs to at a given grain. */
function bucketKey(month: string, grain: PeriodGrain): string {
  const [y, m] = month.split("-");
  if (grain === "year") return y;
  if (grain === "quarter") return `${y}-Q${Math.floor((Number(m) - 1) / 3) + 1}`;
  return month;
}

function bucketLabel(key: string, grain: PeriodGrain): string {
  if (grain === "year") return key; // '2026' — the century is not noise here
  const [y, tail] = key.split("-");
  return grain === "quarter"
    ? `${tail} ${y.slice(2)}` // 'Q1 26'
    : `${MONTHS[Number(tail) - 1]} ${y.slice(2)}`; // 'Mar 26'
}

/** The next bucket along, which is how the quiet ones get filled in. */
function nextKey(key: string, grain: PeriodGrain): string {
  if (grain === "year") return String(Number(key) + 1);
  const [y, tail] = key.split("-");
  if (grain === "quarter") {
    const q = Number(tail.slice(1));
    return q === 4 ? `${Number(y) + 1}-Q1` : `${y}-Q${q + 1}`;
  }
  const m = Number(tail);
  return m === 12
    ? `${Number(y) + 1}-01`
    : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/**
 * Bucket realised P&L over time, at whatever grain the span calls for.
 *
 * The per-ticker rollup in `realized_pnl` cannot answer "how much did we make
 * in March" — it has no dates on the money. This replays the ledger to
 * attribute each realised dollar to the sale that produced it, then groups
 * those sales into calendar buckets.
 *
 * **The bucket is chosen, not fixed.** A year of sales is drawn in months, up
 * to three years in quarters, anything longer in years (`grainFor`) — so the
 * column count stays near a dozen however wide the caller's range is, and the
 * axis never has to be squeezed to fit. Only `key` and `label` differ between
 * grains; every other field means the same thing, so the chart, its tooltip
 * and the contributor rollup are grain-agnostic.
 *
 * **Empty buckets are filled in.** A time axis that silently skips the periods
 * nothing happened in compresses the gaps and makes activity look steadier
 * than it was.
 */
export function realizedByPeriod(
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

  sells = applyOverrideDeltas(sells, deltaByTicker);

  // The grain comes off the span of the SALES, which is also the span the
  // axis will be drawn over — the empty-bucket fill runs between the same two
  // endpoints, so what is measured here is exactly what gets rendered.
  const months = sells.map((s) => s.tradeDate.slice(0, 7)).sort();
  const grain = grainFor(months[0], months[months.length - 1]);

  const blank = (key: string): RealizedPeriod => ({
    key,
    label: bucketLabel(key, grain),
    realizedPl: 0,
    proceeds: 0,
    costOfSold: 0,
    saleCount: 0,
    contributors: [],
    hasUncosted: false,
  });

  const byKey = new Map<string, RealizedPeriod>();

  for (const s of sells) {
    const key = bucketKey(s.tradeDate.slice(0, 7), grain);
    let p = byKey.get(key);
    if (!p) {
      p = blank(key);
      byKey.set(key, p);
    }

    p.realizedPl += s.realizedPl;
    p.proceeds += s.proceeds;
    p.costOfSold += s.costOfSold;
    p.saleCount += 1;
    p.hasUncosted = p.hasUncosted || s.noCostBasis;

    // Several sales of one instrument in a period read as one contributor.
    const code = s.code || s.parent;
    const existing = p.contributors.find((c) => c.code === code);
    if (existing) {
      existing.realizedPl += s.realizedPl;
      existing.noCostBasis = existing.noCostBasis || s.noCostBasis;
    } else {
      p.contributors.push({
        code,
        parent: s.parent,
        realizedPl: s.realizedPl,
        noCostBasis: s.noCostBasis,
      });
    }
  }

  const keys = [...byKey.keys()].sort();
  const last = keys[keys.length - 1];
  const out: RealizedPeriod[] = [];

  // Walk every bucket from first to last, inserting the quiet ones. The guard
  // is `>=` rather than `===` so a key that somehow overshoots ends the walk
  // instead of running it forever.
  for (let key = keys[0]; ; key = nextKey(key, grain)) {
    out.push(byKey.get(key) ?? blank(key));
    if (key >= last) break;
  }

  for (const p of out) {
    p.realizedPl = money(p.realizedPl);
    p.proceeds = money(p.proceeds);
    p.costOfSold = money(p.costOfSold);
    p.contributors.sort((a, b) => Math.abs(b.realizedPl) - Math.abs(a.realizedPl));
  }

  return out;
}

// ---------------------------------------------------------------------------
// Realized P&L over an arbitrary window ("from this date to that date")
// ---------------------------------------------------------------------------

/** What one company contributed to a window's realised P&L. */
export type WindowContributor = {
  parent: string;
  /** The instrument, which is what a row is labelled with. */
  code: string;
  realizedPl: number;
  proceeds: number;
  costOfSold: number;
  units: number;
  saleCount: number;
  /** At least one of these sales drew on no cost basis. */
  noCostBasis: boolean;
  /**
   * Every sale here is a free grant — an option that cost nothing by the firm's
   * own treatment, rather than one whose cost is unknown. Kept apart from
   * `noCostBasis` so the row reads "no cost" instead of "cost missing".
   */
  freeGrant: boolean;
};

export type RealizedWindow = {
  /** `YYYY-MM-DD`, inclusive both ends. */
  from: string;
  to: string;
  realizedPl: number;
  proceeds: number;
  costOfSold: number;
  saleCount: number;
  /** Largest absolute result first. */
  contributors: WindowContributor[];
  /**
   * Some of this window's profit has no cost behind it, so it is overstated.
   *
   * Worth surfacing rather than hiding: where the ledger never saw the buy, the
   * "profit" on a sale is really the whole proceeds.
   */
  hasUncosted: boolean;
};

/**
 * Realised P&L between two dates, inclusive.
 *
 * ── This is REALISED only, and that is not a shortcut ───────────────────────
 * A date range can only ever describe realised money. Unrealised P&L is the
 * difference between a cost base and a price today: it belongs to no date in
 * particular, and there is no price history in this app to value a holding as
 * at some earlier date. So "P&L between March and June" means the profit on
 * what was SOLD in that window, and the UI has to say so — a figure captioned
 * as the portfolio's return over a period, that silently covered only its
 * sales, would be the wrong number with no way to tell.
 *
 * Bounds are compared as `YYYY-MM-DD` strings, which is safe because
 * `trades.trade_date` is a DATE and the DAL hands it over in that form. No
 * `new Date()` anywhere: parsing these to local time is how a trade on the 1st
 * ends up in the previous month for anyone east of UTC.
 */
export function realizedBetween(
  sells: SellAttribution[],
  from: string,
  to: string,
  deltaByTicker: Map<string, number> = new Map(),
): RealizedWindow {
  // Swapped bounds are a slip, not a request for nothing. The alternative is a
  // screen that reads "$0 realised" for a range that has plenty in it.
  const [lo, hi] = from <= to ? [from, to] : [to, from];

  // Corrections are spread over the FULL history first — see applyOverrideDeltas.
  const inWindow = applyOverrideDeltas(sells, deltaByTicker).filter(
    (s) => s.tradeDate >= lo && s.tradeDate <= hi,
  );

  /**
   * Keyed on the INSTRUMENT, not the parent.
   *
   * It was `byParent`, and that quietly folded an option into its ordinary:
   * `getParentTicker("OD6O")` is `OD6`, so a sale of the option and a sale of
   * the shares became one row carrying one name. The client's all-time table is
   * ticker grain — "an option line is a position in its own right (EOS and EOSO
   * have different prices)" — so picking a date range silently changed the
   * table's grain under the reader, and every option line the reference view
   * shows disappeared into an ordinary.
   *
   * This is a GROUPING change only. The FIFO in `replayLedger` is still keyed
   * on the parent, so not one dollar of attributed cost moves — the same
   * realised total simply arrives split across the instruments that earned it.
   * Whether an option sale should draw cost from ordinary parcels at all is a
   * separate question, and a change to the money rather than to the display.
   */
  const byCode = new Map<string, WindowContributor>();
  let realizedPl = 0;
  let proceeds = 0;
  let costOfSold = 0;
  let hasUncosted = false;

  for (const s of inWindow) {
    realizedPl += s.realizedPl;
    proceeds += s.proceeds;
    costOfSold += s.costOfSold;
    // A free grant is not uncosted; it cost nothing. Only a genuine
    // gap should raise the window's warning.
    hasUncosted = hasUncosted || s.noCostBasis;

    const key = s.code || s.parent;
    const existing = byCode.get(key);
    if (existing) {
      existing.realizedPl += s.realizedPl;
      existing.proceeds += s.proceeds;
      existing.costOfSold += s.costOfSold;
      existing.units += s.units;
      existing.saleCount += 1;
      existing.noCostBasis = existing.noCostBasis || s.noCostBasis;
      existing.freeGrant = existing.freeGrant && Boolean(s.freeGrant);
    } else {
      byCode.set(key, {
        parent: s.parent,
        code: key,
        realizedPl: s.realizedPl,
        proceeds: s.proceeds,
        costOfSold: s.costOfSold,
        units: s.units,
        saleCount: 1,
        noCostBasis: s.noCostBasis,
        // ALL of them, not any: one costed sale among grants means the row does
        // have a cost base and should not be described as free.
        freeGrant: Boolean(s.freeGrant),
      });
    }
  }

  const contributors = [...byCode.values()]
    .map((c) => ({
      ...c,
      realizedPl: money(c.realizedPl),
      proceeds: money(c.proceeds),
      costOfSold: money(c.costOfSold),
    }))
    .sort((a, b) => Math.abs(b.realizedPl) - Math.abs(a.realizedPl));

  return {
    from: lo,
    to: hi,
    realizedPl: money(realizedPl),
    proceeds: money(proceeds),
    costOfSold: money(costOfSold),
    saleCount: inWindow.length,
    contributors,
    hasUncosted,
  };
}

/**
 * The window a "last N months" preset covers, ending on `today`.
 *
 * Built by arithmetic on the date parts rather than `setMonth`, which rolls a
 * 31st into the following month (31 March minus one month is 3 March, not
 * 28 February). Clamped to the last day of the target month instead.
 */
export function monthsBack(today: string, months: number): { from: string; to: string } {
  const [y, m, d] = today.split("-").map(Number);
  const targetMonthIndex = (y * 12 + (m - 1)) - months;
  const ty = Math.floor(targetMonthIndex / 12);
  const tm = (targetMonthIndex % 12) + 1;
  const lastOfTarget = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  const td = Math.min(d, lastOfTarget);
  const pad = (n: number) => String(n).padStart(2, "0");
  return { from: `${ty}-${pad(tm)}-${pad(td)}`, to: today };
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
