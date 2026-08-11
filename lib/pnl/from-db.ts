// The database as an input to the P&L calculator.
// ----------------------------------------------------------------------------
// There is exactly one P&L engine in this codebase — lib/pnl-calculator.ts —
// and it was written to consume an uploaded broker file. The client profile
// needs the same numbers from the stored ledger instead.
//
// The temptation is to write a second engine that reads the database. That is
// how two P&L figures for the same client start disagreeing, and the desk then
// has to work out which one to believe. So nothing is reimplemented here: this
// module only reshapes stored `trades` rows into the `ParsedTradeRow` the
// engine already takes, and every downstream stage — aggregation, Placement
// Tracker merge, DB-holdings valuation, Black-Scholes option pricing — is the
// very code the calculator page runs.
//
// The file upload and the morning ingest are two front doors to one engine.
//
// Imports carry explicit `.ts` extensions so this module can also be reached
// from a plain-Node backfill script, the way lib/import/* is.

import {
  getParentTicker,
  getSummaryGroupKey,
  normalizeAccountNo,
  type ParsedTradeRow,
} from "../pnl-calculator.ts";
import { selectAll, type AdminDb } from "../import/runner.ts";

/**
 * The stored rows these queries read back.
 *
 * Narrow, hand-written shapes rather than the generated `Database` types: the
 * importers and this module both run against the service-role client, which is
 * deliberately un-generic (see `AdminDb`), and every numeric arrives as a
 * string over the wire anyway. Spelling out just the columns each query selects
 * documents the query and keeps the coercions honest.
 */
type AccountRow = {
  id: string;
  external_ref: string | null;
  ref: string | null;
  client_id: string;
};

type SecurityRow = { code: string | null; name: string | null; last_price?: number | string | null };

type PositionRow = {
  account_id: string;
  security_code: string | null;
  qty: number | string | null;
  avg_cost: number | string | null;
};

type AccountHolderRow = {
  id: string;
  label: string | null;
  clients: {
    display_name: string | null;
    /** Extra spellings the Placement Tracker uses — see `loadAccountHolders`. */
    placement_aliases: string[] | null;
  } | null;
};

/** A `trades` row as PostgREST returns it. */
export type DbTradeRow = {
  cnote: string | null;
  account_id: string;
  raw_security: string;
  security_code: string | null;
  parent_code: string | null;
  instrument: string | null;
  side: "BUY" | "SELL";
  trade_date: string;
  units: number | string;
  avg_price: number | string;
  consideration: number | string | null;
  value: number | string;
  status: string;
};

/**
 * Postgres returns `numeric` as a string over PostgREST whenever precision
 * could be lost. Feeding those straight to the engine turns every sum into
 * string concatenation, so coerce at the boundary and nowhere else.
 */
const n = (v: number | string | null | undefined): number => Number(v ?? 0) || 0;

/**
 * Reshape stored trades into the engine's input.
 *
 * ── Only SETTLED rows survive ────────────────────────────────────────────────
 * This is the one rule that is easy to miss and expensive to get wrong. The
 * file parser drops non-settled contract notes while reading the sheet, so
 * `aggregateTradesToSummary` has never had to think about status and does not
 * check it. The database, by design, keeps CANCELLED / REVERSAL / REVERSED
 * rows for the audit trail — a REVERSAL is stored as the negative of the line
 * it undoes. Passing those through would let a cancelled trade move the P&L.
 *
 * `accountRefById` maps the surrogate `accounts.id` to the broker's own account
 * number, because that is what the engine's account filter compares against.
 * `securityNames` is cosmetic — the company label on the row.
 */
export function dbTradesToParsedRows(
  rows: DbTradeRow[],
  accountRefById: Map<string, string>,
  securityNames: Map<string, string> = new Map(),
): ParsedTradeRow[] {
  const parsed: ParsedTradeRow[] = [];

  for (const t of rows) {
    if (String(t.status ?? "").toUpperCase() !== "SETTLED") continue;

    const ticker = String(t.raw_security ?? "").trim().toUpperCase();
    if (!ticker) continue;

    parsed.push({
      cnote: t.cnote ?? undefined,
      account: accountRefById.get(t.account_id) ?? t.account_id,
      type: t.side,
      ticker,
      company: securityNames.get(ticker) ?? ticker,
      // `trades.trade_date` is a Postgres date, so it arrives as `YYYY-MM-DD` —
      // the first form `parseTrackerDate` recognises. No reformatting needed,
      // and none wanted: re-rendering it day-first would invite the exact
      // ambiguity the ledger import already resolved.
      contractDate: t.trade_date,
      units: n(t.units),
      avgPrice: n(t.avg_price),
      consideration: n(t.consideration),
      value: n(t.value),
      status: t.status,
    });
  }

  return parsed;
}

/**
 * Every security's display name and last traded price, keyed by code.
 *
 * A CATALOGUE, not a per-account fact: it is the same table for every account
 * in a batch, and it is read whole because the loaders below look codes up
 * rather than filter by them.
 *
 * That is exactly why it is worth passing in. Both loaders used to read this
 * table themselves, so a batch of 43 accounts read the whole of `securities`
 * **86 times** — and it is the read that made a single account cost ~5.8s,
 * which is what kept a morning from finishing inside its 40s budget. Resolving
 * it once per batch is the same bargain `batch.ts` already strikes for the
 * Placement Trackers and for spot prices.
 */
export type SecurityCatalogue = Map<string, { name: string; lastClose: number }>;

/** Read the catalogue once. Callers in a batch should do this and share it. */
export async function loadSecurityCatalogue(db: AdminDb): Promise<SecurityCatalogue> {
  const rows = await selectAll<SecurityRow>(db, "securities", "code, name, last_price");

  const out: SecurityCatalogue = new Map();
  for (const s of rows) {
    if (!s.code) continue;
    out.set(String(s.code).trim().toUpperCase(), {
      name: s.name || s.code,
      lastClose: Number(s.last_price) || 0,
    });
  }
  return out;
}

export type LoadedTrades = {
  trades: ParsedTradeRow[];
  /** Broker account numbers, in the shape the engine's account filter wants. */
  accountRefs: string[];
  /** `accounts.id` → broker account number, for writing results back. */
  accountRefById: Map<string, string>;
  /** `accounts.id` → owning client, ditto. */
  clientIdByAccountId: Map<string, string>;
};

/**
 * Load one or more accounts' full settled ledger, ready for the engine.
 *
 * Deliberately whole-history: a reporting window is applied downstream by
 * `filterTradesByDateRange`, and the open positions that a window's P&L is
 * marked against only make sense against the complete ledger behind them.
 */
export async function loadCalculatorTrades(
  db: AdminDb,
  accountIds: string[],
  /** Share one across a batch; omitted, this reads its own. */
  securities?: SecurityCatalogue,
): Promise<LoadedTrades> {
  if (accountIds.length === 0) {
    return {
      trades: [],
      accountRefs: [],
      accountRefById: new Map(),
      clientIdByAccountId: new Map(),
    };
  }

  // All three are paged. The trade read is the one that matters most — a
  // truncated ledger gives the engine a complete-looking, wrong P&L — but
  // securities passed a thousand rows long ago and positions will.
  const [accounts, tradeRows, catalogue] = await Promise.all([
    selectAll<AccountRow>(db, "accounts", "id, external_ref, ref, client_id", (q) =>
      q.in("id", accountIds),
    ),
    selectAll<DbTradeRow>(
      db,
      "trades",
      "cnote, account_id, raw_security, security_code, parent_code, instrument, " +
        "side, trade_date, units, avg_price, consideration, value, status",
      (q) => q.in("account_id", accountIds),
    ),
    securities ?? loadSecurityCatalogue(db),
  ]);

  const accountRefById = new Map<string, string>();
  const clientIdByAccountId = new Map<string, string>();
  for (const a of accounts) {
    // `external_ref` is the broker's number and the one trade files carry;
    // `ref` is the legacy demo id, kept only as a fallback so an account
    // created before the broker pipeline still resolves to something.
    accountRefById.set(a.id, a.external_ref || a.ref || a.id);
    clientIdByAccountId.set(a.id, a.client_id);
  }

  const securityNames = new Map<string, string>();
  for (const [code, s] of catalogue) securityNames.set(code, s.name);

  return {
    trades: dbTradesToParsedRows(tradeRows, accountRefById, securityNames),
    accountRefs: [...new Set(accountRefById.values())],
    accountRefById,
    clientIdByAccountId,
  };
}

/** Broker account numbers compare on their normalised form, never raw. */
export const sameAccount = (a: string, b: string): boolean =>
  normalizeAccountNo(a) === normalizeAccountNo(b);

// ---------------------------------------------------------------------------
// Holdings snapshot
// ---------------------------------------------------------------------------

/** One still-held position, grouped the way the P&L table groups its rows. */
export type DbHolding = {
  accountRef: string;
  ticker: string;
  parentTicker: string;
  companyName: string;
  qty: number;
  costBase: number;
  marketValue: number;
  unrealizedPnl: number;
};

const round2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * The open side of an account, valued off the latest snapshot.
 *
 * Grouped by `getSummaryGroupKey`, which keeps an option under its own code
 * (ENVO) while ordinaries roll up to the parent (ENV, NVO). That distinction is
 * load-bearing: valuing an option line at the underlying's share price would
 * overstate it by orders of magnitude.
 *
 * Scoped by `accounts.id` rather than by broker account number — the caller
 * already resolved the accounts, so there is nothing left to match on and no
 * way for a near-miss on an account number to pull in someone else's position.
 */
export async function loadDbHoldings(
  db: AdminDb,
  accountIds: string[],
  accountRefById: Map<string, string> = new Map(),
  /** Share one across a batch; omitted, this reads its own. */
  securities?: SecurityCatalogue,
): Promise<DbHolding[]> {
  if (accountIds.length === 0) return [];

  const [positions, secMap] = await Promise.all([
    selectAll<PositionRow>(db, "positions", "account_id, security_code, qty, avg_cost", (q) =>
      q.in("account_id", accountIds),
    ),
    securities ?? loadSecurityCatalogue(db),
  ]);

  const byGroup = new Map<string, DbHolding>();

  for (const p of positions) {
    const code = String(p.security_code || "").trim().toUpperCase();
    if (!code) continue;

    const parent = getParentTicker(code);
    const groupKey = getSummaryGroupKey(code);
    const qty = Number(p.qty) || 0;
    const costBase = round2(qty * (Number(p.avg_cost) || 0));

    const secInfo = secMap.get(code) || secMap.get(parent);
    const lastClose = secInfo?.lastClose || 0;

    // No quote is not the same as worthless. Falling back to cost base marks
    // the position flat rather than writing it off to zero, which is the more
    // honest of the two available lies until a price arrives.
    const marketValue =
      qty > 0 && lastClose > 0 ? round2(qty * lastClose) : costBase > 0 ? costBase : 0;

    const existing = byGroup.get(groupKey);
    if (!existing) {
      byGroup.set(groupKey, {
        accountRef: accountRefById.get(p.account_id) ?? "",
        ticker: groupKey,
        parentTicker: parent,
        companyName: secInfo?.name || groupKey,
        qty,
        costBase,
        marketValue,
        unrealizedPnl: round2(marketValue - costBase),
      });
    } else {
      existing.qty += qty;
      existing.costBase = round2(existing.costBase + costBase);
      existing.marketValue = round2(existing.marketValue + marketValue);
      existing.unrealizedPnl = round2(existing.marketValue - existing.costBase);
    }
  }

  return [...byGroup.values()];
}

/**
 * The names a Placement Tracker sheet might call the holders of these accounts.
 *
 * Needed because a sheet lists every participant in the placement; merging
 * without knowing WHOSE allocation to read sums everyone's and inflates the
 * client's Buy Qty by the number of participants.
 *
 * `clients.placement_aliases` is returned alongside `display_name` and carries
 * equal weight. The tracker is hand-typed, so one party is written several ways —
 * and the differences that remain after normalising spelling are not spelling at
 * all: the real workbooks contain `PSG Capital Ltd` and `PSG Super` against two
 * SEPARATE clients. Which is which is a fact about the desk's records, so it is
 * stated in that column rather than inferred by a looser matcher, which would
 * move a parcel between two real clients without anything downstream noticing.
 *
 * Read live on every recompute, so correcting an alias needs a Recalculate and
 * nothing else — no tracker re-parse, since the sheets have not changed.
 */
export async function loadAccountHolders(
  db: AdminDb,
  accountIds: string[],
): Promise<string[]> {
  if (accountIds.length === 0) return [];

  const { data, error } = await db
    .from("accounts")
    .select("id, label, clients(display_name, placement_aliases)")
    .in("id", accountIds);
  if (error) throw error;

  const names = new Set<string>();
  for (const a of (data ?? []) as unknown as AccountHolderRow[]) {
    // The account label is a fallback for an account with no client row at all;
    // it is a desk label rather than a legal name, so it never wins.
    const name = a.clients?.display_name || a.label;
    if (name) names.add(String(name).trim());

    for (const alias of a.clients?.placement_aliases ?? []) {
      const trimmed = String(alias ?? "").trim();
      if (trimmed) names.add(trimmed);
    }
  }
  return [...names];
}
