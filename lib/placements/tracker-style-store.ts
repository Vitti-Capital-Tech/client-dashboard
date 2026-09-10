import { createHash } from "node:crypto";
import type { AdminDb } from "../import/runner.ts";
import type { TemplatePlan, ScannedProperty } from "./tracker-style.ts";

/**
 * Template's formatting plan, kept in Postgres instead of re-learned per deal.
 *
 * ── What it costs, measured ──────────────────────────────────────────────────
 * Recovering Template's look, at the same budget and the same read count both
 * times:
 *
 *   no workbook session : 438,500 ms   1,210 format reads
 *   with a session      :  18,500 ms   1,212 format reads
 *   borders per cell    :  24,800 ms   1,691 format reads   (exact — the border
 *                                                            scan reads cells,
 *                                                            see `tracker-style.ts`)
 *   applying the plan   :       113 writes — six batches
 *
 * Graph has no worksheet copy and no `range copyFrom`, in v1.0 or beta, so the
 * reconstruction is not optional. The 24x is the workbook being reloaded per
 * request without a session; the ingest path always had one, so it was never
 * paying that. An earlier version of the seed script was, and the 504s figure
 * this file used to quote came from there — recorded because the wrong number
 * made storing the plan look necessary rather than merely right.
 *
 * ── Why store it, at 18.5s ───────────────────────────────────────────────────
 * Two reasons, and the second is the one that actually bit.
 *
 * **The budget is shared.** A route has 60 seconds for the upstream feed reads,
 * the deal write and the paint together. A measured mail-hook run had ~20s left
 * of its 60 after 39s of upstream reads — that is the budget a tab write fits
 * into, and BMN on 9 Sep 2026 did not fit it: stored at 05:15:03, never
 * attempted, picked up by the 06:00 sweep. Spending ~18s of that re-learning a
 * plan that changes maybe twice a year is waste, however affordable it looks in
 * isolation.
 *
 * **Nothing recorded which Template a tab was shaded from.** `IPT` and `IPT (b)`
 * carry identical column widths, all sixteen ~20pt narrower than Template's, and
 * there was no way to tell a stale in-process plan from a Template edited
 * afterwards because neither fact was written down. That is why `shape` and
 * `scannedAt` travel with the plan: the writer already reads Template's used
 * range for the cell seed, so comparing it costs nothing and turns a question
 * nobody could answer into a note.
 *
 * ── The trap: a stored plan has the style RULES baked into it ────────────────
 * `readTemplatePlan` runs `ensurePlacementStyleCompleteness` before returning,
 * so what gets stored is the finished plan — Template's scan *plus* every rule
 * this codebase adds on top of it, the client-input yellow clamp included. A
 * stored plan therefore does not pick up a change to those rules; editing
 * `CLIENT_INPUT_LAST_ROW` and deploying changes nothing until someone re-runs
 * `npm run tracker:plan`.
 *
 * Kept this way on purpose — the alternative is re-deriving the rules on every
 * read, which puts two versions of them in play and makes a tab's shading depend
 * on when its plan was scanned AND when the reader was deployed. One place, one
 * answer, and a re-seed is the documented step.
 *
 * No `server-only` and no `@/` aliases, matching `tracker-state.ts`: the scan
 * half needs Graph, but the storage half is plain so anything that can reach the
 * database can read a plan.
 */

/** How old a stored plan may be before a run starts calling it out. */
export const STYLE_PLAN_STALE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The row key: the workbook and the sheet the plan describes.
 *
 * Hashed rather than stored. `item` is `/drives/{driveId}/items/{itemId}/workbook`
 * and those ids address a link-shared workbook, while this table is readable by
 * every staff member — the same reasoning as `placement_tracker_cache`'s
 * `url_hash`. Two workbooks (2025 and 2026) therefore get two rows, which is
 * correct: they have different Templates.
 */
export function stylePlanKey(item: string, templateSheet: string): string {
  return createHash("sha256").update(`${item.trim()}|${templateSheet.trim()}`).digest("hex");
}

export type StoredStylePlan = {
  plan: TemplatePlan;
  /** Template's used range as at the scan. Compared against the live one. */
  shape: string;
  scannedAt: string;
  incomplete: ScannedProperty[];
};

/**
 * The stored plan, or null when there is none.
 *
 * Null is not an error and must not be treated as one: a deployment that has
 * never run the seed, or a fresh year's workbook, simply has no row yet. The
 * caller falls back to scanning — slower and possibly cut short, which is
 * exactly today's behaviour and still better than refusing to shade a tab.
 *
 * A read failure is also null, with a note rather than a throw, for the same
 * reason every failure in the style path is a note: the deal is already filed by
 * the time any of this runs.
 */
export async function readStylePlan(
  db: AdminDb,
  item: string,
  templateSheet: string,
): Promise<{ stored: StoredStylePlan | null; note?: string }> {
  const { data, error } = await db
    .from("placement_style_plans")
    .select("plan,shape,scanned_at,incomplete")
    .eq("plan_key", stylePlanKey(item, templateSheet))
    .maybeSingle();

  if (error) {
    const message = error.message ?? String(error);
    return {
      stored: null,
      // Naming the migration, because "no stored plan" and "the table does not
      // exist" want completely different things done about them, and the second
      // one otherwise reads as the first for as long as nobody looks.
      note: /placement_style_plans|relation|column/i.test(message)
        ? `The style plan table is missing — apply supabase/migrations/20260910030000_placement_style_plan.sql. ` +
          `Until then every tab pays the full Template scan and will not finish it inside the route's 60s.`
        : `Could not read the stored style plan: ${message}`,
    };
  }

  const row = data as {
    plan?: unknown;
    shape?: unknown;
    scanned_at?: unknown;
    incomplete?: unknown;
  } | null;
  if (!row?.plan) return { stored: null };

  return {
    stored: {
      plan: row.plan as TemplatePlan,
      shape: String(row.shape ?? ""),
      scannedAt: String(row.scanned_at ?? ""),
      incomplete: Array.isArray(row.incomplete) ? (row.incomplete as ScannedProperty[]) : [],
    },
  };
}

/** Written by the seed script. Upserts, so re-running replaces rather than stacks. */
export async function writeStylePlan(
  db: AdminDb,
  item: string,
  templateSheet: string,
  plan: TemplatePlan,
  meta: { label: string; scanMs?: number; reads?: number; now?: Date },
): Promise<void> {
  const { error } = await db.from("placement_style_plans").upsert(
    {
      plan_key: stylePlanKey(item, templateSheet),
      label: meta.label,
      shape: plan.shape,
      plan,
      incomplete: plan.incomplete,
      scanned_at: (meta.now ?? new Date()).toISOString(),
      scan_ms: meta.scanMs ?? null,
      reads: meta.reads ?? null,
    },
    { onConflict: "plan_key" },
  );
  if (error) throw new Error(error.message ?? String(error));
}

/**
 * What is wrong with this plan, said in the run's own notes.
 *
 * Three things are worth saying and each has a different answer:
 *
 *  • **the shape moved** — Template's used range is no longer the one the plan
 *    was scanned against, so the plan describes a sheet that has changed. This
 *    is the check that would have caught the column-width drift, and it is free:
 *    the writer already holds the live shape.
 *  • **the plan is old** — not wrong in itself, but a month of edits to Template
 *    with nobody re-seeding is worth a line.
 *  • **the scan ran short** — some cells were never read, so parts of the tab
 *    will not be shaded. Re-seed with a larger budget.
 *
 * Returns notes, never an error. Nothing about shading is worth failing over.
 */
export function stylePlanNotes(
  stored: StoredStylePlan,
  liveShape: string,
  now: Date = new Date(),
): string[] {
  const notes: string[] = [];

  if (liveShape && stored.shape && liveShape !== stored.shape) {
    notes.push(
      `The stored style plan was scanned against Template at ${stored.shape}, but Template is now ` +
        `${liveShape} — new tabs are being shaded to the old sheet. Re-run \`npm run tracker:plan\`.`,
    );
  }

  const age = now.getTime() - Date.parse(stored.scannedAt || "");
  if (Number.isFinite(age) && age > STYLE_PLAN_STALE_MS) {
    notes.push(
      `The stored style plan is ${Math.floor(age / 86_400_000)} days old (scanned ${stored.scannedAt}). ` +
        `Re-run \`npm run tracker:plan\` if Template has been edited since.`,
    );
  }

  if (stored.incomplete.length > 0) {
    notes.push(
      `The stored style plan is incomplete — ${stored.incomplete.join(" and ")} ran short of the ` +
        `read budget when it was scanned, so parts of every new tab go unshaded. Re-seed with a larger budget.`,
    );
  }

  return notes;
}
