import "server-only";
import { cache } from "react";
import { createClient } from "../supabase/server";
import { pagedSelect } from "./paged";

/**
 * Reads of the STORED P&L — the calculator's output, as written by
 * lib/pnl/recompute.ts.
 *
 * This is the desk's P&L view and is deliberately not the same thing as
 * `realized_pnl` (lib/data/holdings.ts), which remains the cost-basis rollup
 * over the ledger alone. These rows carry the placement enrichment, the
 * open-position valuation and the modelled option lines that the ledger by
 * itself cannot produce.
 *
 * Rows are left at ACCOUNT grain so the client island can apply the same
 * account filter as everything else on the page.
 */

/**
 * The part of a modelled option row's audit payload the UI actually asks
 * questions of.
 *
 * `pnl_summary.unlisted_option` stores every input behind a Black-Scholes price
 * — volatility, rate, dividend yield, the lot. Only strike and spot decide
 * MONEYNESS, so only those are lifted into a named shape; the rest stays in the
 * jsonb where the audit trail wants it. Every field is nullable because the
 * column is nullable and its contents were written by an earlier engine
 * version: a row stored before a field existed must read as "not known" rather
 * than crash the register.
 */
export type StoredUnlistedOption = {
  /** Exercise price. */
  strike: number | null;
  /** Underlying spot used at valuation time. */
  spot: number | null;
  /** `yahoo` / `asx` are live; `database` is the last holdings snapshot. */
  spotSource: string | null;
  expiry: string | null;
  /** The expiry was DERIVED from the issue date, not read off the tracker. */
  expiryAssumed: boolean;
  /** Value of ONE option, by `pricingMethod`. */
  optionPrice: number | null;
  pricingMethod: string | null;
  /** Verbatim tranche text from the tracker, e.g. "1:3 @ $0.14 exp 30/06/27". */
  raw: string | null;
};

/** One stored P&L row, at account × ticker grain. */
export type StoredPnlRow = {
  accountId: string;
  clientId: string;
  ticker: string;
  parentTicker: string | null;
  company: string;
  instrument: string | null;

  buyQty: number;
  sellQty: number;
  /**
   * Units the holdings snapshot says are STILL HELD.
   *
   * Its own leg, and not folded into `sellQty`, because a parcel that is held
   * was not sold — see the 20260826 migration for what that fold reported. The
   * two derived facts it used to carry are unchanged: a row reconciles when
   * `buyQty === sellQty + heldQty`, and `openQty` is what neither accounts for.
   */
  heldQty: number;
  openQty: number;
  /** Value sums, not per-unit prices — the calculator's naming, kept. */
  buyPrice: number;
  sellPrice: number;
  pnl: number;
  tradeCount: number;

  isMatched: boolean;
  isOption: boolean;
  isEnriched: boolean;
  isDbMarketValued: boolean;
  isDbOpenValued: boolean;
  isDbOnly: boolean;
  isPartialExit: boolean;
  isPartialBuy: boolean;
  /**
   * The holdings snapshot was CHECKED and holds nothing for this row.
   *
   * The one flag that can close a position the quantities call open. `openQty`
   * only ever said "the ledger has units it never saw sold"; whether anyone
   * still holds them is a question only the snapshot can answer, and where the
   * answer is no, the units were sold and the sell trades are missing.
   *
   * `false` also covers "no snapshot was consulted", so it can never be read as
   * evidence of a disposal — see the 20260825 migration.
   */
  notInHoldings: boolean;
  isUnlistedOption: boolean;
  placementYearUnresolved: boolean;
  placementYearNote: string | null;
  /** The buy side is genuinely unknown — this row is left out of the total. */
  buySideUnknown: boolean;

  /** Null on every row that is not a modelled option. */
  unlistedOption: StoredUnlistedOption | null;

  comment: string | null;
  computedAt: string;
};

/** When an account's stored figures were produced, and what to know about them. */
export type PnlRunRow = {
  id: string;
  accountId: string;
  computedAt: string;
  totalPnl: number;
  rowCount: number;
  trigger: string;
  warnings: string[];
  engineVersion: string;
};

const num = (v: unknown): number => Number(v ?? 0) || 0;

interface PnlSummaryDbRow {
  account_id: string;
  client_id: string;
  ticker: string;
  parent_ticker: string | null;
  company?: string | null;
  instrument?: string | null;
  buy_qty?: number | string | null;
  sell_qty?: number | string | null;
  held_qty?: number | string | null;
  open_qty?: number | string | null;
  buy_price?: number | string | null;
  sell_price?: number | string | null;
  pnl?: number | string | null;
  trade_count?: number | string | null;
  is_matched?: boolean | null;
  is_option?: boolean | null;
  is_enriched?: boolean | null;
  is_db_market_valued?: boolean | null;
  is_db_open_valued?: boolean | null;
  is_db_only?: boolean | null;
  is_partial_exit?: boolean | null;
  is_partial_buy?: boolean | null;
  not_in_holdings?: boolean | null;
  is_unlisted_option?: boolean | null;
  placement_year_unresolved?: boolean | null;
  placement_year_note?: string | null;
  buy_side_unknown?: boolean | null;
  unlisted_option?: unknown;
  comment?: string | null;
  computed_at: string;
}

/** `numeric` arrives as a string; absent and unparseable both mean "not known". */
const numOrNull = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Read the option audit payload out of the jsonb.
 *
 * Hand-narrowed rather than cast, because this column is written by whichever
 * engine version was current when the row was last recomputed — an older row
 * legitimately lacks fields a newer one has, and a cast would turn that into an
 * `undefined.strike` at render time.
 */
function toUnlistedOption(v: unknown): StoredUnlistedOption | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const addOn = (o.addOn && typeof o.addOn === "object" ? o.addOn : {}) as Record<
    string,
    unknown
  >;

  return {
    strike: numOrNull(addOn.strike),
    spot: numOrNull(o.spot),
    spotSource: typeof o.spotSource === "string" ? o.spotSource : null,
    expiry: typeof addOn.expiry === "string" ? addOn.expiry : null,
    expiryAssumed: addOn.expiryAssumed === true,
    optionPrice: numOrNull(o.optionPrice),
    pricingMethod: typeof o.pricingMethod === "string" ? o.pricingMethod : null,
    raw: typeof addOn.raw === "string" ? addOn.raw : null,
  };
}

/**
 * ONE mapping, used by every read below.
 *
 * The client profile and the staff registers must see the same row for the same
 * `pnl_summary` record — two hand-maintained copies of thirty field names is
 * how one page ends up with a column the other silently drops, which is exactly
 * what had happened to `unlisted_option`: stored on write, absent on read, so
 * every strike and spot on the Options register was blank.
 */
function toStoredPnlRow(r: PnlSummaryDbRow): StoredPnlRow {
  return {
    accountId: r.account_id,
    clientId: r.client_id,
    ticker: r.ticker,
    parentTicker: r.parent_ticker,
    company: r.company ?? "",
    instrument: r.instrument ?? null,

    buyQty: num(r.buy_qty),
    sellQty: num(r.sell_qty),
    heldQty: num(r.held_qty),
    openQty: num(r.open_qty),
    buyPrice: num(r.buy_price),
    sellPrice: num(r.sell_price),
    pnl: num(r.pnl),
    tradeCount: num(r.trade_count),

    isMatched: !!r.is_matched,
    isOption: !!r.is_option,
    isEnriched: !!r.is_enriched,
    isDbMarketValued: !!r.is_db_market_valued,
    isDbOpenValued: !!r.is_db_open_valued,
    isDbOnly: !!r.is_db_only,
    isPartialExit: !!r.is_partial_exit,
    isPartialBuy: !!r.is_partial_buy,
    // Absent on a row stored before the column existed, which coerces to false
    // — "not verified", the reading that leaves the old status alone.
    notInHoldings: !!r.not_in_holdings,
    isUnlistedOption: !!r.is_unlisted_option,
    placementYearUnresolved: !!r.placement_year_unresolved,
    placementYearNote: r.placement_year_note ?? null,
    buySideUnknown: !!r.buy_side_unknown,

    unlistedOption: toUnlistedOption(r.unlisted_option),

    comment: r.comment ?? null,
    computedAt: r.computed_at,
  };
}

export const getClientStoredPnl = cache(
  async (clientId: string): Promise<StoredPnlRow[]> => {
    const supabase = await createClient();
    // Paged — see lib/data/paged.ts.
    const data = await pagedSelect<PnlSummaryDbRow>(
      supabase,
      "pnl_summary",
      "*",
      (b) => b.eq("client_id", clientId),
    );

    return data.map(toStoredPnlRow);
  },
);

/**
 * The most recent run per account.
 *
 * Fetched newest-first and reduced client-side rather than with a per-account
 * `LIMIT 1`: a client has a handful of accounts, and one round trip beats N.
 */
export const getClientLatestPnlRuns = cache(
  async (clientId: string): Promise<PnlRunRow[]> => {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("pnl_runs")
      .select("*")
      .eq("client_id", clientId)
      .order("computed_at", { ascending: false });
    if (error) throw error;

    const latestByAccount = new Map<string, PnlRunRow>();
    for (const r of data ?? []) {
      if (latestByAccount.has(r.account_id)) continue;
      latestByAccount.set(r.account_id, {
        id: r.id,
        accountId: r.account_id,
        computedAt: r.computed_at,
        totalPnl: num(r.total_pnl),
        rowCount: num(r.row_count),
        trigger: r.trigger,
        warnings: r.warnings ?? [],
        engineVersion: r.engine_version,
      });
    }
    return [...latestByAccount.values()];
  },
);

/**
 * All stored P&L rows across all accounts and clients.
 */
export const getAllStoredPnl = cache(
  async (): Promise<StoredPnlRow[]> => {
    const supabase = await createClient();
    const data = await pagedSelect<PnlSummaryDbRow>(
      supabase,
      "pnl_summary",
      "*",
      (b) => b.order("ticker"),
    );

    return data.map(toStoredPnlRow);
  },
);

