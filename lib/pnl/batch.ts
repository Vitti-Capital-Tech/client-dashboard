import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchSpots, loadStandingPlacementMap } from "./providers";
import { recomputeAccountPnl, type RecomputeResult, type SpotFetcher } from "./recompute";

/**
 * Recompute a set of accounts as one batch.
 *
 * This is the only thing that should ever call `recomputeAccountPnl` in bulk,
 * because it is what makes the expensive inputs shared:
 *
 *   • the Placement Trackers are parsed once (~48s cold) and passed to every
 *     account;
 *   • spot prices are memoised across the batch, so twenty accounts holding the
 *     same option cost one quote, not twenty.
 *
 * ── One account's failure is not the batch's ─────────────────────────────────
 * A single account with, say, a trade referencing a deleted security must not
 * cost every other client their morning refresh. Failures are collected and
 * returned; the caller decides whether that is an alert or an exception.
 */

export type BatchResult = {
  batchId: string;
  results: RecomputeResult[];
  failures: { accountId: string; error: string }[];
  /** Null when no Placement Tracker was configured or readable — see providers. */
  placementTickers: number | null;
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
  opts: { trigger?: string; batchId?: string; dryRun?: boolean } = {},
): Promise<BatchResult> {
  const batchId = opts.batchId ?? crypto.randomUUID();
  const trigger = opts.trigger ?? "manual";
  const dryRun = opts.dryRun ?? false;

  const unique = [...new Set(accountIds)].filter(Boolean);
  if (unique.length === 0) {
    return { batchId, results: [], failures: [], placementTickers: null };
  }

  const db = createAdminClient();

  // Once for the whole batch — the entire reason this function exists.
  const placements = await loadStandingPlacementMap();
  const spots = memoiseSpots(fetchSpots);

  const results: RecomputeResult[] = [];
  const failures: { accountId: string; error: string }[] = [];

  // A fixed-size pool rather than `Promise.all` over everything: the recompute
  // is chatty with the database, and firing hundreds at once just queues them
  // somewhere less visible while risking connection exhaustion.
  const queue = [...unique];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const accountId = queue.shift();
      if (!accountId) return;

      try {
        results.push(
          await recomputeAccountPnl(db, accountId, {
            placements,
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
    placementTickers: placements?.size ?? null,
  };
}

/** Every account belonging to one client — what the Recalculate button uses. */
export async function recomputeClient(
  clientId: string,
  opts: { trigger?: string; dryRun?: boolean } = {},
): Promise<BatchResult> {
  const db = createAdminClient();

  const { data, error } = await db
    .from("accounts")
    .select("id")
    .eq("client_id", clientId);
  if (error) throw error;

  const accountIds = ((data ?? []) as unknown as { id: string }[]).map((a) => a.id);
  return recomputeAccounts(accountIds, opts);
}
