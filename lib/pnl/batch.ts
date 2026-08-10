import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AdminDb } from "@/lib/import/runner";
import { fetchSpots, loadCachedPlacements } from "./providers";
import { clearRecomputes, noteRecomputeFailures } from "./queue";
import { recomputeAccountPnl, type RecomputeResult, type SpotFetcher } from "./recompute";

/**
 * Recompute a set of accounts as one batch.
 *
 * The only thing that should ever call `recomputeAccountPnl` in bulk, because
 * it is what makes the shared inputs shared:
 *
 *   • the Placement Trackers are READ ONCE from the database cache and passed
 *     to every account;
 *   • spot prices are memoised across the batch, so twenty accounts holding the
 *     same option cost one quote, not twenty.
 *
 * ── Two refusals worth knowing about ─────────────────────────────────────────
 * 1. **No placements, no stored figures.** If the tracker cache is empty the
 *    batch does not fall back to computing without it: the rows would be
 *    missing every placement buy side and every unlisted option, and once
 *    stored they are indistinguishable from correct ones.
 * 2. **A deadline stops the batch, it does not rush it.** Accounts that do not
 *    fit are left queued and reported, never half-done. The first real
 *    scheduled run was killed by the host mid-recompute at 60s, having managed
 *    13 of 43 accounts; the deadline is what turns that into a deferral rather
 *    than a lost morning.
 *
 * One account's failure is collected rather than thrown: a single bad account
 * must not cost every other client their morning refresh.
 */

export type BatchResult = {
  batchId: string;
  results: RecomputeResult[];
  failures: { accountId: string; error: string }[];
  /** Queued but not attempted — the deadline arrived first. */
  deferred: string[];
  /** Null when the tracker cache was empty and nothing was computed. */
  placementTickers: number | null;
  /** When those trackers were last parsed from the workbooks. */
  placementsParsedAt: string | null;
  /** Set when the whole batch declined to run. */
  skippedReason?: string;
};

export type BatchOptions = {
  trigger?: string;
  batchId?: string;
  dryRun?: boolean;
  /**
   * Epoch ms after which no NEW account is started.
   *
   * A running account is always allowed to finish — abandoning one mid-write is
   * how a half-replaced `pnl_summary` happens.
   */
  deadline?: number;
  /** Supply a client; defaults to the service-role one. */
  db?: AdminDb;
};

/** How many accounts to recompute at once. */
const CONCURRENCY = 4;

/**
 * Wrap the spot fetcher so a ticker is only ever quoted once per batch.
 *
 * Without this each account fetches its own quotes, and a desk where fifty
 * clients hold the same placement makes fifty identical round trips — slow, and
 * rude to the upstream feed. Worse, quotes drift between calls, so two clients
 * could be shown different values for the same option in the same run.
 */
function memoiseSpots(inner: SpotFetcher): SpotFetcher {
  const seen: Awaited<ReturnType<SpotFetcher>> = new Map();

  return async (tickers) => {
    const missing = tickers.filter((t) => !seen.has(t));
    if (missing.length > 0) {
      const fresh = await inner(missing);
      for (const [ticker, quote] of fresh) seen.set(ticker, quote);
    }

    // Return only what was asked for, so a caller never sees another account's
    // tickers leak into its own valuation.
    const out: Awaited<ReturnType<SpotFetcher>> = new Map();
    for (const t of tickers) {
      const quote = seen.get(t);
      if (quote) out.set(t, quote);
    }
    return out;
  };
}

export async function recomputeAccounts(
  accountIds: string[],
  opts: BatchOptions = {},
): Promise<BatchResult> {
  const batchId = opts.batchId ?? crypto.randomUUID();
  const trigger = opts.trigger ?? "manual";
  const dryRun = opts.dryRun ?? false;
  const deadline = opts.deadline ?? Infinity;

  const unique = [...new Set(accountIds)].filter(Boolean);
  const empty: BatchResult = {
    batchId,
    results: [],
    failures: [],
    deferred: [],
    placementTickers: null,
    placementsParsedAt: null,
  };
  if (unique.length === 0) return empty;

  const db = opts.db ?? createAdminClient();

  // Once for the whole batch — the entire reason this function exists.
  const placements = await loadCachedPlacements(db);
  if (!placements) {
    return {
      ...empty,
      deferred: unique,
      skippedReason:
        "The Placement Tracker cache is empty, so placement buy sides and unlisted " +
        "option rows could not be computed. Nothing was stored — a figure missing " +
        "those is not a figure worth keeping. Run 'Refresh trackers' and retry.",
    };
  }

  const spots = memoiseSpots(fetchSpots);

  const results: RecomputeResult[] = [];
  const failures: { accountId: string; error: string }[] = [];
  const deferred: string[] = [];

  // A fixed-size pool rather than `Promise.all` over everything: the recompute
  // is chatty with the database, and firing hundreds at once just queues them
  // somewhere less visible while risking connection exhaustion.
  const queue = [...unique];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const accountId = queue.shift();
      if (!accountId) return;

      if (Date.now() >= deadline) {
        deferred.push(accountId);
        continue;
      }

      try {
        results.push(
          await recomputeAccountPnl(db, accountId, {
            placements: placements.map,
            fetchSpots: spots,
            trigger,
            batchId,
            dryRun,
          }),
        );
      } catch (err) {
        failures.push({
          accountId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });

  await Promise.all(workers);

  // The queue is the record of what still needs doing, so it is updated from
  // the outcome rather than optimistically cleared up front.
  if (!dryRun) {
    await clearRecomputes(db, results.map((r) => r.accountId));
    if (failures.length > 0) await noteRecomputeFailures(db, failures);
  }

  if (failures.length > 0) {
    console.error(
      `P&L recompute batch ${batchId}: ${failures.length} of ${unique.length} account(s) failed.`,
      failures.map((f) => `${f.accountId}: ${f.error}`).join(" | "),
    );
  }

  return {
    batchId,
    results,
    failures,
    deferred,
    placementTickers: placements.map.size,
    placementsParsedAt: placements.parsedAt,
  };
}

/** Every account belonging to one client — what the Recalculate button uses. */
export async function recomputeClient(
  clientId: string,
  opts: BatchOptions = {},
): Promise<BatchResult> {
  const db = opts.db ?? createAdminClient();

  const { data, error } = await db
    .from("accounts")
    .select("id")
    .eq("client_id", clientId);
  if (error) throw error;

  const accountIds = ((data ?? []) as unknown as { id: string }[]).map((a) => a.id);
  return recomputeAccounts(accountIds, { ...opts, db });
}
