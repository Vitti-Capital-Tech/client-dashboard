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
 * Backfill: rebuild every account that has a stored ledger.
 *
 * Meant to be run once, after the tables are first created — the client profile
 * reads stored rows and an account that has never been recomputed simply has
 * none. Cheap to re-run, and the batch shares one Placement Tracker parse across
 * the lot.
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
