import "server-only";
import { cache } from "react";
import { createClient } from "../supabase/server";
import { getSecurityMap, getClients, getAccounts } from "./queries";
import type { Database } from "../supabase/database.types";

type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];

/**
 * Admin holdings view — the read side of the broker data pipeline.
 *
 * Two independent sources are joined here, and the distinction matters:
 *
 *   • `positions`    — the holdings snapshot. Current units, average cost and
 *                      market price. Answers "what is held and what is it worth".
 *   • `realized_pnl` — replayed from the `trades` ledger. Answers "what was
 *                      made on what has already been sold".
 *
 * A position can exist with no ledger history (bought before the export window)
 * and a ledger rollup can exist with no position (fully exited). Both are
 * legitimate, so the join is a full outer join in spirit — neither side is
 * allowed to hide the other.
 *
 * Rollup grain is the PARENT code, so a company held as both ordinary and
 * options (ADN + ADNOD) reads as one line with the instruments broken out
 * beneath it. Units are never summed across instruments — they trade at
 * different prices, so only their dollar values are additive.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One instrument line: a single security code within a company rollup. */
export type HoldingLine = {
  code: string; // raw code as held, e.g. 'ADNOD'
  name: string;
  securityClass: string | null;
  isDerivative: boolean;
  qty: number;
  avgCost: number;
  last: number | null;
  marketValue: number;
  costBase: number;
  unrealizedPl: number;
};

/** Realized side, replayed from the trade ledger. */
export type RealizedSummary = {
  realizedPl: number;
  proceeds: number;
  costOfSold: number;
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

/** One company (parent code) within one account. */
export type HoldingGroup = {
  parent: string;
  name: string;
  lines: HoldingLine[];
  marketValue: number;
  costBase: number;
  unrealizedPl: number;
  realized: RealizedSummary | null;
  /** Unrealized + realized. The only number that answers "did we make money". */
  totalPl: number;
};

export type AccountHoldings = {
  accountId: string;
  accountRef: string | null; // broker account number
  label: string;
  adviserName: string | null;
  clientId: string;
  clientName: string;
  groups: HoldingGroup[];
  marketValue: number;
  costBase: number;
  unrealizedPl: number;
  realizedPl: number;
  totalPl: number;
  /** True if any rollup in the account is missing cost basis. */
  hasWarnings: boolean;
};

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

type PnlKey = string; // `${accountId}::${parentCode}`

/**
 * Read a whole table in pages.
 *
 * PostgREST caps a single response (1000 rows by default) and returns the
 * truncated set WITHOUT erroring. On a firm-wide holdings view that would show
 * a quietly understated portfolio total — the worst possible failure mode here,
 * because it looks completely normal. 36 accounts fit in one page today; this
 * keeps the totals correct as the book grows.
 */
const PAGE = 1000;

async function selectAll<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  build: () => any,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data as T[]));
    if (data.length < PAGE) return out;
  }
}

const getRealizedMap = cache(
  async (): Promise<Map<PnlKey, RealizedSummary>> => {
    const supabase = await createClient();
    const data = await selectAll<Tables<"realized_pnl">>(() =>
      supabase.from("realized_pnl").select("*"),
    );

    return new Map(
      data.map((r) => [
        `${r.account_id}::${r.parent_code}`,
        {
          realizedPl: r.realized_pl,
          proceeds: r.proceeds,
          costOfSold: r.cost_of_sold,
          unitsSold: r.units_sold,
          fees: r.fees,
          tradeCount: r.trade_count,
          firstTrade: r.first_trade,
          lastTrade: r.last_trade,
          hasPartial: r.has_partial,
          shortHistory: r.short_history,
        },
      ]),
    );
  },
);

/**
 * Every account's holdings, grouped by company. RLS scopes the reads: staff get
 * all accounts, a signed-in client gets only their own.
 *
 * Four table reads, no N+1 — the grouping is done in JS because it needs the
 * parent-code rollup, which is cheaper to express here than as a SQL view that
 * would then need its own RLS policy.
 */
export const getAccountHoldings = cache(async (): Promise<AccountHoldings[]> => {
  const supabase = await createClient();

  const [positions, securities, realized, clients, accounts] = await Promise.all([
    selectAll<Tables<"positions">>(() => supabase.from("positions").select("*")),
    getSecurityMap(),
    getRealizedMap(),
    getClients(),
    getAccounts(),
  ]);

  const clientNameById = new Map(clients.map((c) => [c.id, c.name]));

  // Bucket positions by account, then by parent code.
  const byAccount = new Map<string, Map<string, HoldingLine[]>>();

  for (const p of positions) {
    if (!p.account_id) continue;
    const sec = securities.get(p.security_code);
    const parent = sec?.parent ?? p.security_code;

    const last = sec?.last ?? null;
    const marketValue = last === null ? 0 : p.qty * last;
    const costBase = p.qty * p.avg_cost;

    const line: HoldingLine = {
      code: p.security_code,
      name: sec?.name ?? p.security_code,
      securityClass: sec?.securityClass ?? null,
      isDerivative: (sec?.parent ?? null) !== null,
      qty: p.qty,
      avgCost: p.avg_cost,
      last,
      marketValue,
      costBase,
      // With no price we cannot value the position; reporting a full loss would
      // be worse than reporting nothing, so unrealized is 0 until a price lands.
      unrealizedPl: last === null ? 0 : marketValue - costBase,
    };

    let groups = byAccount.get(p.account_id);
    if (!groups) {
      groups = new Map();
      byAccount.set(p.account_id, groups);
    }
    const lines = groups.get(parent);
    if (lines) lines.push(line);
    else groups.set(parent, [line]);
  }

  // Fully-exited companies have realized P&L but no position — make sure they
  // still appear, otherwise the account total silently omits closed trades.
  for (const [key] of realized) {
    const [accountId, parent] = key.split("::");
    let groups = byAccount.get(accountId);
    if (!groups) {
      groups = new Map();
      byAccount.set(accountId, groups);
    }
    if (!groups.has(parent)) groups.set(parent, []);
  }

  const result: AccountHoldings[] = [];

  for (const account of accounts) {
    const groupMap = byAccount.get(account.id);
    if (!groupMap) continue;

    const groups: HoldingGroup[] = [...groupMap.entries()].map(
      ([parent, lines]) => {
        const marketValue = lines.reduce((s, l) => s + l.marketValue, 0);
        const costBase = lines.reduce((s, l) => s + l.costBase, 0);
        const unrealizedPl = lines.reduce((s, l) => s + l.unrealizedPl, 0);
        const rz = realized.get(`${account.id}::${parent}`) ?? null;

        return {
          parent,
          name:
            lines[0]?.name ??
            securities.get(parent)?.name ??
            parent,
          // Ordinary first, then derivatives; largest holding first within each.
          lines: lines.sort(
            (a, b) =>
              Number(a.isDerivative) - Number(b.isDerivative) ||
              b.marketValue - a.marketValue,
          ),
          marketValue,
          costBase,
          unrealizedPl,
          realized: rz,
          totalPl: unrealizedPl + (rz?.realizedPl ?? 0),
        };
      },
    );

    groups.sort((a, b) => b.marketValue - a.marketValue || a.parent.localeCompare(b.parent));

    const marketValue = groups.reduce((s, g) => s + g.marketValue, 0);
    const costBase = groups.reduce((s, g) => s + g.costBase, 0);
    const unrealizedPl = groups.reduce((s, g) => s + g.unrealizedPl, 0);
    const realizedPl = groups.reduce((s, g) => s + (g.realized?.realizedPl ?? 0), 0);

    result.push({
      accountId: account.id,
      accountRef: account.externalRef ?? account.ref,
      label: account.label,
      adviserName: account.adviserName,
      clientId: account.clientId,
      clientName: clientNameById.get(account.clientId) ?? account.label,
      groups,
      marketValue,
      costBase,
      unrealizedPl,
      realizedPl,
      totalPl: unrealizedPl + realizedPl,
      hasWarnings: groups.some((g) => g.realized?.shortHistory ?? false),
    });
  }

  return result.sort((a, b) => b.marketValue - a.marketValue);
});

/** Firm-wide totals for the admin overview strip. */
export function summariseHoldings(accounts: AccountHoldings[]) {
  const marketValue = accounts.reduce((s, a) => s + a.marketValue, 0);
  const costBase = accounts.reduce((s, a) => s + a.costBase, 0);
  const unrealizedPl = accounts.reduce((s, a) => s + a.unrealizedPl, 0);
  const realizedPl = accounts.reduce((s, a) => s + a.realizedPl, 0);
  const positionCount = accounts.reduce(
    (s, a) => s + a.groups.reduce((n, g) => n + g.lines.length, 0),
    0,
  );

  return {
    accountCount: accounts.length,
    positionCount,
    marketValue,
    costBase,
    unrealizedPl,
    realizedPl,
    totalPl: unrealizedPl + realizedPl,
    // Percentage on cost — the only denominator that is meaningful when some
    // holdings have no market price yet.
    unrealizedPct: costBase === 0 ? 0 : (unrealizedPl / costBase) * 100,
    withWarnings: accounts.filter((a) => a.hasWarnings).length,
  };
}
