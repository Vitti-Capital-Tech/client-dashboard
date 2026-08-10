import type { AdminDb } from "../import/runner.ts";

/**
 * Accounts whose stored P&L is known to be out of date.
 *
 * Importing and recomputing are one logical morning, but they are not equally
 * urgent and they are wildly unequal in cost. Measured on the first real run:
 * the imports finished, and the recompute managed 13 of 43 accounts before the
 * host killed the request at 60s. Coupling the two means one slow morning costs
 * the day's import as well.
 *
 * So they are decoupled. The ingest always imports, enqueues what it touched,
 * and recomputes as much as its time budget allows. Whatever is left stays here
 * for the next run or for the desk's Recalculate — visible, counted, and
 * impossible to mistake for finished work.
 */

type QueueRow = { account_id: string; attempts: number; last_error: string | null };

/** Mark accounts as needing a recompute. Idempotent. */
export async function enqueueRecompute(
  db: AdminDb,
  accountIds: string[],
  reason = "ingest",
): Promise<void> {
  const unique = [...new Set(accountIds)].filter(Boolean);
  if (unique.length === 0) return;

  const { error } = await db.from("pnl_recompute_queue").upsert(
    unique.map((account_id) => ({
      account_id,
      reason,
      queued_at: new Date().toISOString(),
    })),
    { onConflict: "account_id" },
  );
  if (error) throw error;
}

/** Everything waiting, oldest first — so nothing can starve behind new work. */
export async function pendingRecomputes(db: AdminDb): Promise<QueueRow[]> {
  const { data, error } = await db
    .from("pnl_recompute_queue")
    .select("account_id, attempts, last_error")
    .order("queued_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as QueueRow[];
}

/** Drop accounts that have been recomputed successfully. */
export async function clearRecomputes(db: AdminDb, accountIds: string[]): Promise<void> {
  if (accountIds.length === 0) return;
  const { error } = await db
    .from("pnl_recompute_queue")
    .delete()
    .in("account_id", accountIds);
  if (error) throw error;
}

/**
 * Record that an account was tried and did not succeed.
 *
 * The attempt counter is the point: an account that fails every morning would
 * otherwise sit in the queue looking like ordinary backlog forever. A rising
 * count with a stored reason is how it becomes someone's problem.
 */
export async function noteRecomputeFailures(
  db: AdminDb,
  failures: { accountId: string; error: string }[],
): Promise<void> {
  for (const f of failures) {
    const { data } = await db
      .from("pnl_recompute_queue")
      .select("attempts")
      .eq("account_id", f.accountId);

    const attempts =
      (((data ?? []) as unknown as { attempts: number }[])[0]?.attempts ?? 0) + 1;

    const { error } = await db.from("pnl_recompute_queue").upsert(
      {
        account_id: f.accountId,
        reason: "ingest",
        attempts,
        last_error: f.error.slice(0, 500),
      },
      { onConflict: "account_id" },
    );
    if (error) throw error;
  }
}
