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
  isUnlistedOption: boolean;
  placementYearUnresolved: boolean;
  placementYearNote: string | null;
  /** The buy side is genuinely unknown — this row is left out of the total. */
  buySideUnknown: boolean;

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

export const getClientStoredPnl = cache(
  async (clientId: string): Promise<StoredPnlRow[]> => {
    const supabase = await createClient();
    // Paged — see lib/data/paged.ts.
    const data = await pagedSelect<Record<string, any>>(
      supabase,
      "pnl_summary",
      "*",
      (b) => b.eq("client_id", clientId),
    );

    return data.map((r) => ({
      accountId: r.account_id,
      clientId: r.client_id,
      ticker: r.ticker,
      parentTicker: r.parent_ticker,
      company: r.company ?? "",
      instrument: r.instrument,

      buyQty: num(r.buy_qty),
      sellQty: num(r.sell_qty),
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
      isUnlistedOption: !!r.is_unlisted_option,
      placementYearUnresolved: !!r.placement_year_unresolved,
      placementYearNote: r.placement_year_note,
      buySideUnknown: !!r.buy_side_unknown,

      comment: r.comment,
      computedAt: r.computed_at,
    }));
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
    const data = await pagedSelect<Record<string, any>>(
      supabase,
      "pnl_summary",
      "*",
      (b) => b.order("ticker"),
    );

    return data.map((r) => ({
      accountId: r.account_id,
      clientId: r.client_id,
      ticker: r.ticker,
      parentTicker: r.parent_ticker,
      company: r.company ?? "",
      instrument: r.instrument,

      buyQty: num(r.buy_qty),
      sellQty: num(r.sell_qty),
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
      isUnlistedOption: !!r.is_unlisted_option,
      placementYearUnresolved: !!r.placement_year_unresolved,
      placementYearNote: r.placement_year_note,
      buySideUnknown: !!r.buy_side_unknown,

      comment: r.comment,
      computedAt: r.computed_at,
    }));
  },
);

