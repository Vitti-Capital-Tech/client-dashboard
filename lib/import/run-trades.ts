// Import a broker TRADE LEDGER (contract notes) and rebuild realized P&L.
// ----------------------------------------------------------------------------
// The ledger is append-only history, so trades are UPSERTED on
// (cnote, raw_security, side) — re-running the same export, or a longer export
// that overlaps it, never double-counts a contract note. That idempotency is
// what makes this safe to run unattended every morning.
//
// `realized_pnl` is then rebuilt from scratch for every account the file
// touches, by replaying that account's full settled ledger from the database
// (not just this file's rows) so a partial export still produces correct
// cumulative numbers.
//
// Only SETTLED trades are counted. CANCELLED / REVERSAL / REVERSED rows are
// still stored for the audit trail, but never reach the P&L reducer.

import { parseTradeCsv, reduceTrades, SETTLED } from "./trades.ts";
import type { ParsedTrade, PnlRollup, RowError } from "./trades.ts";
import { extractSecurities } from "./holdings.ts";
import { reconcile, findDrift } from "./reconcile.ts";
import type { DriftRow, ReconcileException } from "./reconcile.ts";
import {
  ImportError,
  upsertChunked,
  type AccountRefRow,
  type AdminDb,
} from "./runner.ts";

/** A stored ledger row, as replayed to rebuild the rollups. */
type StoredTradeRow = {
  cnote: string;
  account_id: string;
  raw_security: string;
  parent_code: string;
  side: "BUY" | "SELL";
  trade_date: string;
  units: number | string;
  avg_price: number | string;
  consideration: number | string;
  brokerage: number | string;
  other_charges: number | string;
  gst: number | string;
  value: number | string;
  status: string;
};

/** A held position joined to its security, for the ledger-vs-snapshot check. */
type HeldRow = {
  account_id: string;
  qty: number | string;
  securities: { code: string; parent_code: string | null } | null;
};

export type TradeImportResult = {
  /** False for a dry run — nothing was written. */
  applied: boolean;
  rowErrors: RowError[];

  parsed: {
    trades: number;
    settled: number;
    skipped: number;
    /** Non-settled rows by status — stored for the audit trail, not counted. */
    byStatus: Record<string, number>;
    accountRefs: string[];
    firstDate: string | null;
    lastDate: string | null;
  };

  /**
   * The realized-P&L rollups.
   *
   * On a dry run these come from THIS FILE alone, which is a preview and may be
   * short of history. On a real run they are replayed from the full stored
   * ledger, which is the number that lands in the database.
   */
  rollups: PnlRollup[];
  totalRealized: number;
  partialCount: number;

  /** Sales whose cost basis could not be established — the human worklist. */
  exceptions: ReconcileException[];
  /**
   * Positions where the replayed ledger and the holdings snapshot disagree.
   * Always empty on a dry run: it needs the stored snapshot to compare against.
   */
  drift: DriftRow[];

  written: {
    /** Ledger-only codes that had to be created as priceless stubs. */
    securityStubs: string[];
    trades: number;
    realizedRows: number;
  } | null;

  /** The recompute scope for everything downstream. */
  touched: { accountIds: string[]; accountRefs: string[] };
};

export async function runTradeImport(
  db: AdminDb,
  csvText: string,
  opts: { sourceFile?: string; dryRun?: boolean } = {},
): Promise<TradeImportResult> {
  const dryRun = opts.dryRun ?? false;
  const sourceFile = opts.sourceFile ?? null;

  // -------------------------------------------------------------------------
  // 1. Parse
  // -------------------------------------------------------------------------
  const { trades, errors } = parseTradeCsv(csvText);

  if (trades.length === 0) {
    throw new ImportError(
      "NO_ROWS",
      "No parseable trade rows — nothing to do.",
      errors.slice(0, 20).map((e) => `line ${e.line}: ${e.reason}`),
    );
  }

  const settled = trades.filter((t) => t.status === SETTLED);
  const accountRefs = [...new Set(trades.map((t) => t.accountRef))];

  const byStatus: Record<string, number> = {};
  for (const t of trades) {
    if (t.status === SETTLED) continue;
    byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  }

  const parsed = {
    trades: trades.length,
    settled: settled.length,
    skipped: trades.length - settled.length,
    byStatus,
    accountRefs,
    firstDate: settled.length
      ? settled.reduce((a, t) => (t.tradeDate < a ? t.tradeDate : a), "9999")
      : null,
    lastDate: settled.length
      ? settled.reduce((a, t) => (t.tradeDate > a ? t.tradeDate : a), "0000")
      : null,
  };

  if (dryRun) {
    // Preview from this file alone — deliberately NOT the stored ledger, so the
    // operator sees exactly what the file on their disk claims.
    const preview = reduceTrades(trades);
    return {
      applied: false,
      rowErrors: errors,
      parsed,
      rollups: preview,
      totalRealized: preview.reduce((s, r) => s + r.realizedPl, 0),
      partialCount: preview.filter((r) => r.hasPartial).length,
      exceptions: reconcile(trades, preview),
      drift: [],
      written: null,
      touched: { accountIds: [], accountRefs },
    };
  }

  // -------------------------------------------------------------------------
  // 2. Resolve accounts. The holdings snapshot creates them; a trade for an
  //    unknown account is a hard error, because guessing an owner in a
  //    financial system is never the right call.
  // -------------------------------------------------------------------------
  const { data: accountRows, error: accountErr } = await db
    .from("accounts")
    .select("id, external_ref, client_id")
    .in("external_ref", accountRefs);
  if (accountErr) throw accountErr;

  const resolvedAccounts = (accountRows ?? []) as unknown as AccountRefRow[];
  const accountByRef = new Map(resolvedAccounts.map((a) => [a.external_ref, a]));
  const unknown = accountRefs.filter((r) => !accountByRef.has(r));
  if (unknown.length > 0) {
    throw new ImportError(
      "UNKNOWN_ACCOUNTS",
      "Trade ledger references account number(s) with no account row. " +
        "Import the holdings snapshot first, or add these accounts manually.",
      unknown,
    );
  }

  // -------------------------------------------------------------------------
  // 3. Securities — a fully exited holding is absent from the snapshot but
  //    still present in the ledger, and trades.security_code is a real FK.
  //    Create stubs (no price) for anything missing so nothing is dropped.
  // -------------------------------------------------------------------------
  const codesInFile = [
    ...new Map(trades.map((t) => [t.rawSecurity, t.company])).entries(),
  ].map(([code, name]) => ({ code, name }));

  const { data: knownSecs, error: secErr } = await db
    .from("securities")
    .select("code");
  if (secErr) throw secErr;
  const known = new Set(
    ((knownSecs ?? []) as unknown as { code: string }[]).map((s) => s.code),
  );

  const missing = extractSecurities(
    [],
    codesInFile.filter((c) => !known.has(c.code)),
  ).filter((s) => !known.has(s.code));

  if (missing.length > 0) {
    await upsertChunked(
      db,
      "securities",
      missing.map((s) => ({
        code: s.code,
        name: s.name,
        security_class: s.securityClass,
        listed: true,
      })),
      { onConflict: "code" },
    );
    for (const s of missing.filter((s) => s.parent)) {
      const { error } = await db
        .from("securities")
        .update({ parent_code: s.parent })
        .eq("code", s.code);
      if (error) throw new Error(`link ${s.code}→${s.parent}: ${error.message}`);
    }
  }

  // -------------------------------------------------------------------------
  // 4. Trades
  // -------------------------------------------------------------------------
  await upsertChunked(
    db,
    "trades",
    trades.map((t) => {
      const acct = accountByRef.get(t.accountRef)!;
      return {
        cnote: t.cnote,
        account_id: acct.id,
        client_id: acct.client_id,
        raw_security: t.rawSecurity,
        security_code: t.rawSecurity,
        parent_code: t.parent,
        instrument: t.instrument,
        side: t.side,
        trade_date: t.tradeDate,
        units: t.units,
        avg_price: t.avgPrice,
        consideration: t.consideration,
        brokerage: t.brokerage,
        other_charges: t.otherCharges,
        gst: t.gst,
        value: t.value,
        brokerage_pct: t.brokeragePct,
        adviser: t.adviser,
        status: t.status,
        source_file: sourceFile,
      };
    }),
    { onConflict: "cnote,raw_security,side" },
  );

  // -------------------------------------------------------------------------
  // 5. Rebuild realized_pnl from the FULL stored ledger for these accounts
  // -------------------------------------------------------------------------
  const accountIds = resolvedAccounts.map((a) => a.id);

  const { data: allTrades, error: ledgerErr } = await db
    .from("trades")
    .select(
      "cnote, raw_security, parent_code, side, trade_date, units, avg_price, " +
        "consideration, brokerage, other_charges, gst, value, status, account_id",
    )
    .in("account_id", accountIds);
  if (ledgerErr) throw ledgerErr;

  const refById = new Map(resolvedAccounts.map((a) => [a.id, a.external_ref]));

  // Re-shape DB rows into the reducer's input type. Postgres returns numerics
  // as strings over PostgREST when precision could be lost, so coerce.
  const rollups = reduceTrades(
    ((allTrades ?? []) as unknown as StoredTradeRow[]).map(
      (t): ParsedTrade => ({
        cnote: t.cnote,
        accountRef: refById.get(t.account_id)!,
        side: t.side,
        rawSecurity: t.raw_security,
        parent: t.parent_code,
        company: "",
        instrument: null,
        tradeDate: t.trade_date,
        units: Number(t.units),
        avgPrice: Number(t.avg_price),
        consideration: Number(t.consideration),
        brokerage: Number(t.brokerage),
        otherCharges: Number(t.other_charges),
        gst: Number(t.gst),
        value: Number(t.value),
        brokeragePct: null,
        adviser: null,
        status: t.status,
      }),
    ),
  );

  const { error: purgeErr } = await db
    .from("realized_pnl")
    .delete()
    .in("account_id", accountIds);
  if (purgeErr) throw purgeErr;

  const computedAt = new Date().toISOString();

  await upsertChunked(
    db,
    "realized_pnl",
    rollups.map((r) => {
      const acct = accountByRef.get(r.accountRef)!;
      return {
        account_id: acct.id,
        client_id: acct.client_id,
        parent_code: r.parent,
        units_bought: r.unitsBought,
        units_sold: r.unitsSold,
        open_units: r.openUnits,
        cost_total: r.costTotal,
        proceeds: r.proceeds,
        cost_of_sold: r.costOfSold,
        open_cost: r.openCost,
        realized_pl: r.realizedPl,
        fees: r.fees,
        trade_count: r.tradeCount,
        first_trade: r.firstTrade,
        last_trade: r.lastTrade,
        has_partial: r.hasPartial,
        short_history: r.shortHistory,
        computed_at: computedAt,
      };
    }),
    { onConflict: "account_id,parent_code" },
  );

  // -------------------------------------------------------------------------
  // 6. Reconciliation — the worklist of everything that needs a human
  // -------------------------------------------------------------------------
  // Ledger-vs-snapshot drift. `positions` is the broker's statement of what is
  // actually held; where the replayed ledger disagrees, one of the two is
  // incomplete and the split between realised and unrealised P&L is wrong.
  const { data: heldRows, error: heldErr } = await db
    .from("positions")
    .select("account_id, qty, securities(code, parent_code)")
    .in("account_id", accountIds);
  if (heldErr) throw heldErr;

  const snapshotUnits = new Map<string, number>();
  for (const p of (heldRows ?? []) as unknown as HeldRow[]) {
    const parent = p.securities?.parent_code ?? p.securities?.code;
    if (!parent) continue;
    const key = `${refById.get(p.account_id)}::${parent}`;
    snapshotUnits.set(key, (snapshotUnits.get(key) ?? 0) + Number(p.qty));
  }

  return {
    applied: true,
    rowErrors: errors,
    parsed,
    rollups,
    totalRealized: rollups.reduce((s, r) => s + r.realizedPl, 0),
    partialCount: rollups.filter((r) => r.hasPartial).length,
    exceptions: reconcile(trades, rollups),
    drift: findDrift(rollups, snapshotUnits),
    written: {
      securityStubs: missing.map((s) => s.code),
      trades: trades.length,
      realizedRows: rollups.length,
    },
    touched: { accountIds, accountRefs },
  };
}
