import "server-only";
import { cache } from "react";
import { createClient } from "../supabase/server";
import type { RealizedRow } from "./compute";

/**
 * Realized P&L reads, sourced from the `realized_pnl` table that
 * scripts/import-trades.mjs rebuilds by replaying the settled trade ledger.
 *
 * Unrealized P&L is NOT here — it comes from `positions` via the normal DAL
 * (getClientPositions + lib/data/compute), because the holdings snapshot
 * already carries units, average cost and market price. The two halves stay
 * separate on purpose: a snapshot cannot express what was made on units that
 * have already been sold, and a ledger that starts mid-history cannot value
 * what is still held.
 */

// The pure shapes and the roll-up live in ./compute (not server-only) so Client
// Components can re-aggregate them when the account filter changes.
export type { RealizedSummary, RealizedRow } from "./compute";

/**
 * Realized P&L for one client, left at account grain so the caller can apply
 * the same account filter the rest of the client view uses. Drives the Order
 * History tab: it is what lets a SELL be marked as having no cost basis, which
 * is exactly the row a human needs to fix.
 */
export const getClientRealized = cache(
  async (clientId: string): Promise<RealizedRow[]> => {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("realized_pnl")
      .select("*")
      .eq("client_id", clientId);
    if (error) throw error;

    return data.map((r) => ({
      accountId: r.account_id,
      parent: r.parent_code,
      realizedPl: r.realized_pl,
      proceeds: r.proceeds,
      costOfSold: r.cost_of_sold,
      unitsBought: r.units_bought,
      unitsSold: r.units_sold,
      fees: r.fees,
      tradeCount: r.trade_count,
      firstTrade: r.first_trade,
      lastTrade: r.last_trade,
      hasPartial: r.has_partial,
      shortHistory: r.short_history,
    }));
  },
);
