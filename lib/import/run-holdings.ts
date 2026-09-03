// Import a broker HOLDINGS SNAPSHOT into clients / accounts / securities / positions.
// ----------------------------------------------------------------------------
// The snapshot is the authoritative answer to "what is held right now", so this
// is a FULL REPLACE of `positions` for every account present in the file:
// anything the broker no longer reports has been sold, and must disappear.
// Accounts absent from the file are left completely untouched.
//
// That full-replace is also why the caller — not this function — decides
// whether a given file is safe to apply. An export that arrives truncated
// would faithfully delete every position it fails to mention. `--dry-run`
// (CLI) and the coverage guardrail (mail ingest) both exist for that reason.
//
// It is also the platform's only price source today, so Market Price lands in
// securities.last_price on the way through.
//
// Idempotent: re-running the same file converges to the same rows.

import {
  parseHoldingsCsv,
  extractAccounts,
  extractSecurities,
} from "./holdings.ts";
import type { RowError } from "./trades.ts";
import {
  ImportError,
  upsertChunked,
  type AccountRefRow,
  type AdminDb,
} from "./runner.ts";

export type HoldingsImportResult = {
  /** False for a dry run — nothing was written. */
  applied: boolean;
  /** Rows the parser rejected. Never hidden behind a count. */
  rowErrors: RowError[];

  parsed: {
    holdings: number;
    accounts: number;
    securities: number;
    marketValue: number;
    costBase: number;
  };

  /** Distinct securities per broker class, for the operator's sanity check. */
  securitiesByClass: Record<string, number>;
  /** `ADNOD→ADN` style samples of the derivative → ordinary linkage. */
  derivativeLinks: string[];

  written: {
    securities: number;
    derivativesLinked: number;
    clients: number;
    accounts: number;
    positions: number;
    staleRemoved: number;
  } | null;

  /**
   * The accounts this file touched.
   *
   * Returned rather than derived by the caller because it is the recompute
   * scope for everything downstream: only these accounts' P&L can have moved.
   */
  touched: { accountIds: string[]; accountRefs: string[] };
};

export async function runHoldingsImport(
  db: AdminDb,
  csvText: string,
  opts: { dryRun?: boolean } = {},
): Promise<HoldingsImportResult> {
  const dryRun = opts.dryRun ?? false;

  // -------------------------------------------------------------------------
  // 1. Parse
  // -------------------------------------------------------------------------
  const { holdings, errors } = parseHoldingsCsv(csvText);

  if (holdings.length === 0) {
    throw new ImportError(
      "NO_ROWS",
      "No parseable holdings rows — nothing to do.",
      errors.slice(0, 20).map((e) => `line ${e.line}: ${e.reason}`),
    );
  }

  const accounts = extractAccounts(holdings);
  const securities = extractSecurities(holdings);

  const byClass: Record<string, number> = {};
  for (const s of securities) {
    const key = s.securityClass ?? "unclassified";
    byClass[key] = (byClass[key] ?? 0) + 1;
  }

  const derivatives = securities.filter((s) => s.parent);

  const summary: HoldingsImportResult = {
    applied: false,
    rowErrors: errors,
    parsed: {
      holdings: holdings.length,
      accounts: accounts.length,
      securities: securities.length,
      marketValue: holdings.reduce((s, h) => s + h.marketValue, 0),
      costBase: holdings.reduce((s, h) => s + h.costBase, 0),
    },
    securitiesByClass: byClass,
    derivativeLinks: derivatives.map((s) => `${s.code}→${s.parent}`),
    written: null,
    // Refs are known from the parse alone; ids need the database. Populating
    // refs even on a dry run is what lets the mail ingest test a file's account
    // COVERAGE — "does today's snapshot still mention everyone yesterday's
    // did?" — before deciding whether it is safe to apply.
    touched: { accountIds: [], accountRefs: accounts.map((a) => a.externalRef) },
  };

  if (dryRun) return summary;

  // -------------------------------------------------------------------------
  // 2. Securities — two phase, because parent_code is a self-referencing FK.
  //    Pass one writes every code with a null parent; pass two wires the links
  //    up once every parent is guaranteed to exist.
  // -------------------------------------------------------------------------
  const pricedAt = new Date().toISOString();

  await upsertChunked(
    db,
    "securities",
    securities.map((s) => ({
      code: s.code,
      name: s.name,
      description: s.description,
      security_class: s.securityClass,
      listed: true,
      last_price: s.lastPrice,
      last_price_at: s.lastPrice === null ? null : pricedAt,
    })),
    { onConflict: "code" },
  );

  for (const s of derivatives) {
    const { error } = await db
      .from("securities")
      .update({ parent_code: s.parent })
      .eq("code", s.code);
    if (error) throw new Error(`link ${s.code}→${s.parent}: ${error.message}`);
  }

  // -------------------------------------------------------------------------
  // 3. Clients & accounts
  // -------------------------------------------------------------------------
  // The broker models the entity and its account as one thing, so each Account
  // Number becomes one client owning one account. The multi-account schema
  // still applies — staff can merge two of these later with no migration.
  await upsertChunked(
    db,
    "clients",
    accounts.map((a) => ({
      external_ref: a.externalRef,
      display_name: a.displayName,
      initials: a.initials,
      // No email in the broker export. Client logins stay disabled until one is
      // attached (lib/session.ts resolves the client row by JWT email).
    })),
    { onConflict: "external_ref" },
  );

  const accountRefs = accounts.map((a) => a.externalRef);

  const { data: clientRows, error: clientErr } = await db
    .from("clients")
    .select("id, external_ref")
    .in("external_ref", accountRefs);
  if (clientErr) throw clientErr;

  const clientIdByRef = new Map(
    ((clientRows ?? []) as unknown as { id: string; external_ref: string }[]).map((c) => [
      c.external_ref,
      c.id,
    ]),
  );

  // ── Who owns an account is NOT the importer's to decide, after the first time
  //
  // This was one upsert carrying `client_id`, which meant every run reset the
  // owner to the auto-created client row for that ref. That is harmless while
  // accounts are 1:1 with clients — and it silently undoes an approved account
  // claim (`approve_account_claim`, 20260904090000), which exists precisely to
  // put one person's several accounts onto one login. The next morning's
  // snapshot would hand the account back to the empty stub row, and the client
  // would watch an account disappear from their switcher overnight.
  //
  // So ownership is written when the account is CREATED and never afterwards.
  // The broker still owns everything it is actually the authority on — label,
  // adviser, status — and those keep updating on every run.
  const { data: knownAccountRows, error: knownErr } = await db
    .from("accounts")
    .select("external_ref")
    .in("external_ref", accountRefs);
  if (knownErr) throw knownErr;

  const existingRefs = new Set(
    ((knownAccountRows ?? []) as unknown as { external_ref: string }[]).map(
      (a) => a.external_ref,
    ),
  );

  const brokerOwned = (a: (typeof accounts)[number]) => ({
    external_ref: a.externalRef,
    label: a.displayName,
    account_type: "Wholesale",
    adviser_code: a.adviserCode,
    adviser_name: a.adviserName,
    status: a.status,
  });

  const newAccounts = accounts.filter((a) => !existingRefs.has(a.externalRef));
  if (newAccounts.length > 0) {
    await upsertChunked(
      db,
      "accounts",
      newAccounts.map((a) => ({
        ...brokerOwned(a),
        client_id: clientIdByRef.get(a.externalRef),
      })),
      { onConflict: "external_ref" },
    );
  }

  const knownAccounts = accounts.filter((a) => existingRefs.has(a.externalRef));
  if (knownAccounts.length > 0) {
    await upsertChunked(db, "accounts", knownAccounts.map(brokerOwned), {
      onConflict: "external_ref",
    });
  }

  const { data: accountRows, error: accountErr } = await db
    .from("accounts")
    .select("id, external_ref, client_id")
    .in("external_ref", accountRefs);
  if (accountErr) throw accountErr;

  const resolvedAccounts = (accountRows ?? []) as unknown as AccountRefRow[];
  const accountByRef = new Map(resolvedAccounts.map((a) => [a.external_ref, a]));

  // -------------------------------------------------------------------------
  // 4. Positions — full replace, scoped to the accounts in this file
  // -------------------------------------------------------------------------
  const accountIds = resolvedAccounts.map((a) => a.id);

  const {
    error: delErr,
    count: deleted,
  } = await db.from("positions").delete({ count: "exact" }).in("account_id", accountIds);
  if (delErr) throw delErr;

  const positionRows = holdings.map((h) => {
    const acct = accountByRef.get(h.accountRef)!;
    return {
      account_id: acct.id,
      client_id: acct.client_id,
      security_code: h.rawSecurity,
      qty: h.qty,
      avg_cost: h.avgCost,
    };
  });

  await upsertChunked(db, "positions", positionRows, {
    onConflict: "account_id,security_code",
  });

  return {
    ...summary,
    applied: true,
    written: {
      securities: securities.length,
      derivativesLinked: derivatives.length,
      clients: accounts.length,
      accounts: resolvedAccounts.length,
      positions: positionRows.length,
      staleRemoved: deleted ?? 0,
    },
    touched: { accountIds, accountRefs },
  };
}
