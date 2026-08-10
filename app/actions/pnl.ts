"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getActor } from "@/lib/session";
import { recomputeAccounts, recomputeClient } from "@/lib/pnl/batch";

/**
 * Rebuild the stored P&L on demand.
 *
 * The morning ingest does this unattended for every account it touched; this is
 * the desk's "Recalculate" button, for when a placement sheet has been amended,
 * a spot price has moved, or someone simply wants to see today's marks.
 *
 * Staff only. The recompute runs as service_role — it writes across accounts and
 * has no session of its own — so the permission check HAS to happen here, before
 * that client is ever created.
 */

type Result =
  | { ok: true; accounts: number; totalPnl: number; warnings: string[] }
  | { ok: false; error: string };

export async function recalculateClientPnl(clientId: string): Promise<Result> {
  const { role, actor } = await getActor();
  if (role !== "admin") return { ok: false, error: "Staff only." };

  try {
    const batch = await recomputeClient(clientId, { trigger: "manual" });

    // A partial failure is reported, never swallowed: the figures on screen
    // would otherwise look complete while an account quietly kept stale rows.
    if (batch.failures.length > 0 && batch.results.length === 0) {
      return {
        ok: false,
        error: `Recalculation failed: ${batch.failures[0].error}`,
      };
    }

    const supabase = await createClient();
    await supabase.from("audit_log").insert({
      actor,
      role,
      action: "Recalculated P&L",
      detail:
        `${batch.results.length} account(s)` +
        (batch.placementTickers === null
          ? " — no Placement Tracker was readable, so placement buy sides and option lines are missing"
          : ` against ${batch.placementTickers} placement ticker(s)`) +
        (batch.failures.length > 0 ? ` · ${batch.failures.length} failed` : ""),
      client_id: clientId,
    });

    const warnings = [
      ...batch.results.flatMap((r) => r.warnings),
      ...batch.failures.map((f) => `Account ${f.accountId} failed: ${f.error}`),
    ];

    revalidatePath("/portal", "layout");

    return {
      ok: true,
      accounts: batch.results.length,
      totalPnl: batch.results.reduce((s, r) => s + r.totalPnl, 0),
      warnings,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Recalculation failed.",
    };
  }
}

/**
 * Compute this client's P&L and hand it back as a CSV **without storing it**.
 *
 * The verification tool. A recompute is a wholesale replace of the account's
 * `pnl_summary`, so "just run it and see" is exactly what you cannot do while
 * the previous figures still matter.
 *
 * The CSV is deliberately in the **P&L Calculator's own format**, not the
 * client profile's: the calculator is the reference implementation, and the
 * point of this file is to be diffed against its export. Identical columns
 * means a plain diff answers the question — no column mapping to get wrong,
 * and no way for the comparison itself to hide a discrepancy.
 *
 * `scripts/diff-pnl-csv.mjs` does the comparison.
 */
export async function previewClientPnlCsv(
  clientId: string,
): Promise<
  | { ok: true; csv: string; filename: string; rows: number; warnings: string[] }
  | { ok: false; error: string }
> {
  const { role } = await getActor();
  if (role !== "admin") return { ok: false, error: "Staff only." };

  try {
    const batch = await recomputeClient(clientId, { trigger: "manual", dryRun: true });

    if (batch.results.length === 0) {
      return {
        ok: false,
        error:
          batch.failures[0]?.error ?? "This client has no accounts to compute.",
      };
    }

    // The dry run returns the engine's own `PnlSummaryItem[]`, which is exactly
    // what the calculator's exporter takes — so this needs no mapping at all.
    const rows = batch.results.flatMap((r) => r.rows);
    const { exportPnlCsvAction } = await import("./pnl-calculator");
    const { csv } = await exportPnlCsvAction(rows);

    return {
      ok: true,
      csv,
      filename: `pnl-preview-${clientId}-${new Date().toISOString().slice(0, 10)}.csv`,
      rows: rows.length,
      warnings: [
        ...batch.results.flatMap((r) => r.warnings),
        ...batch.failures.map((f) => `Account ${f.accountId} failed: ${f.error}`),
      ],
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Preview failed.",
    };
  }
}

/**
 * Re-parse the Placement Tracker workbooks and store the result.
 *
 * This is where the ~17s of downloading and parsing lives, and the point of it
 * living somewhere deliberate: the scheduled ingest must not spend it. Every
 * cron invocation is a cold function, so an in-process cache never hits — on
 * the first real run that was a third of the request budget gone before any
 * account had been recomputed. And a recompute that skipped the trackers would
 * produce figures missing every placement buy side and every unlisted option,
 * indistinguishable once stored from correct ones.
 *
 * So the parse happens here, on a warm request, when a human asks. Placements
 * are issued occasionally rather than daily, so refreshing is an occasional
 * action too — but its age is shown wherever the figures are, because a stale
 * cache silently misses anything placed since it was parsed.
 */
export async function refreshPlacementTrackers(): Promise<
  | { ok: true; refreshed: number; tickerCount: number; failed: string[] }
  | { ok: false; error: string }
> {
  const { role, actor } = await getActor();
  if (role !== "admin") return { ok: false, error: "Staff only." };

  try {
    const { createAdminClient } = await import("@/lib/supabase/admin");
    const { refreshTrackerCache } = await import("@/lib/pnl/tracker-cache");

    const res = await refreshTrackerCache(createAdminClient());

    if (res.refreshed === 0) {
      return {
        ok: false,
        error:
          `No tracker could be parsed. ${res.failed.join(" ")} ` +
          `Until one is cached, no recompute will store figures.`,
      };
    }

    const supabase = await createClient();
    await supabase.from("audit_log").insert({
      actor,
      role,
      action: "Refreshed Placement Trackers",
      detail:
        `${res.refreshed} workbook(s), ${res.tickerCount} ticker(s)` +
        (res.failed.length > 0 ? ` · ${res.failed.length} failed` : ""),
    });

    revalidatePath("/portal", "layout");
    return {
      ok: true,
      refreshed: res.refreshed,
      tickerCount: res.tickerCount,
      failed: res.failed,
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Tracker refresh failed.",
    };
  }
}

/**
 * Backfill: rebuild every account that has a stored ledger.
 *
 * Meant to be run once, after the tables are first created — the client profile
 * reads stored rows and an account that has never been recomputed simply has
 * none. Cheap to re-run, and the batch shares one cached Placement Tracker read
 * across the lot.
 */
export async function recalculateAllPnl(): Promise<
  { ok: true; accounts: number; failed: number } | { ok: false; error: string }
> {
  const { role, actor } = await getActor();
  if (role !== "admin") return { ok: false, error: "Staff only." };

  try {
    const supabase = await createClient();
    const { data, error } = await supabase.from("accounts").select("id");
    if (error) return { ok: false, error: error.message };

    const accountIds = (data ?? []).map((a) => a.id);
    const batch = await recomputeAccounts(accountIds, { trigger: "backfill" });

    await supabase.from("audit_log").insert({
      actor,
      role,
      action: "Backfilled P&L",
      detail: `${batch.results.length} account(s) rebuilt, ${batch.failures.length} failed`,
    });

    revalidatePath("/portal", "layout");
    return { ok: true, accounts: batch.results.length, failed: batch.failures.length };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Backfill failed.",
    };
  }
}
