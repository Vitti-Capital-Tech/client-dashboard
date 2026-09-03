import type { AdminDb } from "../import/runner.ts";
import {
  SYSTEM_PROMPT,
  OUTPUT_SCHEMA,
  userPrompt,
  parseNote,
  type CommentarySubject,
} from "./prompt.ts";
import { commentaryWeek, withinCommentaryWindow } from "./week.ts";

// The service-role client and the Anthropic SDK are pulled in ON DEMAND, inside
// the run — the same arrangement as lib/ingest/morning.ts, for the same two
// reasons:
//
//   • they are the modules carrying the secrets and the network access, and a
//     deployment with no ANTHROPIC_API_KEY should never load the SDK at all;
//   • it keeps this module free of `server-only`, so the choreography can be
//     tested without a Next runtime — which is how the two silent failure modes
//     below (submitting twice, never collecting) are covered by tests at all.

/**
 * The weekly commentary job.
 *
 * ── Two phases, because of a 60-second ceiling ──────────────────────────────
 * 142 securities are currently held across the book, and each note needs a web
 * search before it can be written. That does not fit in one serverless
 * invocation on the host's free tier however it is ordered — see the note on
 * `maxDuration` in app/api/ingest/morning/route.ts.
 *
 * So the work runs on the Message Batches API and this function is idempotent
 * and re-entrant. One tick SUBMITS the week's batch (a single HTTP call), a
 * later tick COLLECTS it. `commentary_runs` is keyed on the week, so a schedule
 * that fires hourly all weekend submits once and then polls; there is no
 * separate queue to keep in step with anything.
 *
 * Batch is also half the price, which for a job nobody is waiting on is free.
 *
 * ── Degrading without a key ─────────────────────────────────────────────────
 * With no `ANTHROPIC_API_KEY` the job reports that it is not configured and
 * returns `ok: true`. A deployment that has not been wired up yet is not a
 * fault worth reddening the cron monitor over every week, and the portal
 * already renders correctly with no commentary on file.
 */

export type CommentaryPhase =
  | "not-configured"
  | "outside-window"
  | "nothing-to-do"
  | "submitted"
  | "waiting"
  | "collected"
  | "failed";

export type CommentaryReport = {
  ok: boolean;
  /** The Friday this run belongs to. */
  weekOf: string;
  phase: CommentaryPhase;
  /** Securities in the batch. */
  requested: number;
  /** Notes actually stored. */
  written: number;
  /** Items that came back unusable, each named in `notes`. */
  errored: number;
  batchId: string | null;
  notes: string[];
};

/** Seams for the tests: production passes nothing. */
export type CommentaryDeps = {
  db?: AdminDb;
  /** Stands in for the Anthropic client. */
  api?: CommentaryApi;
  now?: Date;
  /** Run even outside the Friday-evening-to-Sunday window. */
  force?: boolean;
  /** Cap on securities per batch; the default covers the whole book. */
  limit?: number;
};

/**
 * The slice of the Anthropic API this job uses.
 *
 * Narrowed to three calls so the runner can be tested without the SDK, a key,
 * or a network — the logic worth covering is which phase a tick lands in, and
 * that has nothing to do with HTTP.
 */
export type CommentaryApi = {
  submit(items: BatchItem[]): Promise<{ batchId: string }>;
  status(batchId: string): Promise<{ ended: boolean }>;
  results(batchId: string): Promise<BatchResult[]>;
};

export type BatchItem = {
  customId: string;
  system: string;
  prompt: string;
};

export type BatchResult = {
  customId: string;
  /** Parsed JSON body the model returned, or null where the item failed. */
  output: unknown;
  sources: { title: string; url: string }[];
  /** Set where the item itself errored rather than returning a note. */
  error?: string;
};

/** Model and generation settings, in one place. */
export const COMMENTARY_MODEL = "claude-opus-5";

export async function runWeeklyCommentary(
  deps: CommentaryDeps = {},
): Promise<CommentaryReport> {
  const now = deps.now ?? new Date();
  const weekOf = commentaryWeek(now);
  const notes: string[] = [];

  const base = (
    phase: CommentaryPhase,
    over: Partial<CommentaryReport> = {},
  ): CommentaryReport => ({
    ok: phase !== "failed",
    weekOf,
    phase,
    requested: 0,
    written: 0,
    errored: 0,
    batchId: null,
    notes,
    ...over,
  });

  if (!deps.force && !withinCommentaryWindow(now)) {
    notes.push(
      "Outside the Friday-evening-to-Sunday window; the market has not closed for the week.",
    );
    return base("outside-window");
  }

  const db = deps.db ?? (await import("../supabase/admin.ts")).createAdminClient();

  let api = deps.api;
  if (!api) {
    if (!process.env.ANTHROPIC_API_KEY) {
      notes.push(
        "ANTHROPIC_API_KEY is not set, so no commentary was generated. The portal " +
          "renders without it; set the key to turn this on.",
      );
      return base("not-configured");
    }
    api = await anthropicApi();
  }

  // ── Where is this week up to? ─────────────────────────────────────────────
  const { data: run, error: runErr } = await db
    .from("commentary_runs")
    .select("*")
    .eq("week_of", weekOf)
    .maybeSingle();
  if (runErr) throw runErr;

  if (run && run.status === "collected") {
    notes.push(`This week's commentary was already written (${run.written} notes).`);
    return base("nothing-to-do", { requested: run.requested, written: run.written });
  }

  // ── Phase 2: a batch is in flight ────────────────────────────────────────
  if (run && run.status === "submitted") {
    return collect(db, api, run.batch_id, weekOf, run.requested, notes);
  }

  // ── Phase 1: submit ──────────────────────────────────────────────────────
  const subjects = await heldSecuritiesWithoutNote(db, weekOf, deps.limit);
  if (subjects.length === 0) {
    notes.push("Every held security already has a note for this week.");
    return base("nothing-to-do");
  }

  const items: BatchItem[] = subjects.map((s) => ({
    // The security code IS the id: it is unique per batch by construction, and
    // results arrive in any order, so this is what they are matched back on.
    customId: s.code,
    system: SYSTEM_PROMPT,
    prompt: userPrompt(s, weekOf),
  }));

  let batchId: string;
  try {
    ({ batchId } = await api.submit(items));
  } catch (e) {
    notes.push(`Could not submit the batch: ${message(e)}`);
    return base("failed");
  }

  const { error: insErr } = await db.from("commentary_runs").insert({
    week_of: weekOf,
    batch_id: batchId,
    status: "submitted",
    requested: items.length,
    model: COMMENTARY_MODEL,
    notes: [`Submitted ${items.length} securities.`],
  });
  if (insErr) throw insErr;

  notes.push(
    `Submitted ${items.length} securities as batch ${batchId}. A later run collects the results.`,
  );
  return base("submitted", { requested: items.length, batchId });
}

/** Read the finished batch and store what is usable. */
async function collect(
  db: AdminDb,
  api: CommentaryApi,
  batchId: string,
  weekOf: string,
  requested: number,
  notes: string[],
): Promise<CommentaryReport> {
  let ended: boolean;
  try {
    ({ ended } = await api.status(batchId));
  } catch (e) {
    notes.push(`Could not read batch ${batchId}: ${message(e)}`);
    return {
      ok: false,
      weekOf,
      phase: "failed",
      requested,
      written: 0,
      errored: 0,
      batchId,
      notes,
    };
  }

  if (!ended) {
    notes.push(`Batch ${batchId} is still processing. Nothing to do yet.`);
    return {
      ok: true,
      weekOf,
      phase: "waiting",
      requested,
      written: 0,
      errored: 0,
      batchId,
      notes,
    };
  }

  const results = await api.results(batchId);

  const rows: {
    security_code: string;
    week_of: string;
    loss_note: string;
    profit_note: string;
    sources: { title: string; url: string }[];
    model: string;
  }[] = [];
  const problems: string[] = [];

  for (const r of results) {
    if (r.error) {
      problems.push(`${r.customId}: ${r.error}`);
      continue;
    }
    const parsed = parseNote(r.output, r.sources);
    if ("problem" in parsed) {
      // One rejected note costs that security its note and nothing else. The
      // reason is kept so the desk can see WHY rather than just a count.
      problems.push(`${r.customId}: ${parsed.problem}`);
      continue;
    }
    rows.push({
      security_code: r.customId,
      week_of: weekOf,
      loss_note: parsed.note.lossNote,
      profit_note: parsed.note.profitNote,
      sources: parsed.note.sources,
      model: COMMENTARY_MODEL,
    });
  }

  // Upsert rather than insert: a re-collected batch must converge on the same
  // rows rather than fail on the primary key.
  //
  // `edited_by` is deliberately NOT in the payload, so a note the desk has
  // corrected by hand keeps its attribution when a re-collection overwrites the
  // text. A desk edit that a retry silently reattributed to the model would be
  // worse than either.
  for (let i = 0; i < rows.length; i += 100) {
    const { error } = await db
      .from("security_commentary")
      .upsert(rows.slice(i, i + 100), { onConflict: "security_code,week_of" });
    if (error) throw error;
  }

  notes.push(`Collected batch ${batchId}: ${rows.length} notes stored.`);
  if (problems.length > 0) {
    notes.push(`${problems.length} could not be used: ${problems.slice(0, 10).join("; ")}`);
  }

  const { error: updErr } = await db
    .from("commentary_runs")
    .update({
      status: "collected",
      written: rows.length,
      errored: problems.length,
      collected_at: new Date().toISOString(),
      notes: problems.length > 0 ? problems.slice(0, 50) : ["All notes usable."],
    })
    .eq("week_of", weekOf);
  if (updErr) throw updErr;

  return {
    ok: true,
    weekOf,
    phase: "collected",
    requested,
    written: rows.length,
    errored: problems.length,
    batchId,
    notes,
  };
}

/**
 * The securities that need a note this week: currently held, and not already
 * written.
 *
 * Scoped to what is HELD rather than to everything in the catalogue — 142 of
 * 775 — because a note about a security nobody owns is a note nobody reads. A
 * position that closed during the week loses its note, which is correct: the
 * client's P&L table still shows the closed parcel, and a "what to watch from
 * here" note about something they no longer hold would be noise.
 */
async function heldSecuritiesWithoutNote(
  db: AdminDb,
  weekOf: string,
  limit?: number,
): Promise<CommentarySubject[]> {
  const [{ data: positions, error: posErr }, { data: done, error: doneErr }] =
    await Promise.all([
      db.from("positions").select("security_code, client_id, qty").gt("qty", 0),
      db.from("security_commentary").select("security_code").eq("week_of", weekOf),
    ]);
  if (posErr) throw posErr;
  if (doneErr) throw doneErr;

  const already = new Set((done ?? []).map((d) => d.security_code));

  const holders = new Map<string, Set<string>>();
  for (const p of positions ?? []) {
    if (already.has(p.security_code)) continue;
    const set = holders.get(p.security_code) ?? new Set<string>();
    set.add(p.client_id);
    holders.set(p.security_code, set);
  }
  if (holders.size === 0) return [];

  const codes = [...holders.keys()];
  const { data: secs, error: secErr } = await db
    .from("securities")
    .select("code, name, sector, last_price")
    .in("code", codes);
  if (secErr) throw secErr;
  const byCode = new Map((secs ?? []).map((s) => [s.code, s]));

  const subjects = codes.map((code) => ({
    code,
    name: byCode.get(code)?.name ?? code,
    sector: byCode.get(code)?.sector ?? null,
    lastPrice: byCode.get(code)?.last_price ?? null,
    holders: holders.get(code)!.size,
  }));

  // Most-held first, so a truncated run covers the most clients. Ordering is
  // stable on the code so a re-run picks the same set rather than a new one.
  subjects.sort((a, b) => b.holders - a.holders || a.code.localeCompare(b.code));

  return limit ? subjects.slice(0, limit) : subjects;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * The real Anthropic client, behind the narrow `CommentaryApi`.
 *
 * Imported lazily so the SDK is not pulled into any bundle that merely imports
 * this module, and so a deployment with no key never loads it at all.
 */
async function anthropicApi(): Promise<CommentaryApi> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic();

  return {
    async submit(items) {
      const batch = await client.messages.batches.create({
        requests: items.map((it) => ({
          custom_id: it.customId,
          params: {
            model: COMMENTARY_MODEL,
            // Generous: a couple of short notes, but the model also spends
            // tokens on searching and reasoning before it writes them.
            max_tokens: 8000,
            // The system prompt is byte-identical across all 142 requests, so
            // a breakpoint on it is the one cache that matters here.
            system: [
              {
                type: "text",
                text: it.system,
                cache_control: { type: "ephemeral" },
              },
            ],
            // Adaptive rather than a fixed budget: `budget_tokens` is rejected
            // on this model. `medium` effort because the task is a short
            // grounded summary, not a hard reasoning problem.
            thinking: { type: "adaptive" },
            output_config: {
              effort: "medium",
              // Guarantees the response parses, so `parseNote` only has to
              // judge the CONTENT rather than also cope with prose or fences.
              format: {
                type: "json_schema",
                schema: OUTPUT_SCHEMA,
              },
            },
            tools: [
              {
                type: "web_search_20260209",
                name: "web_search",
                // Enough to check the company and its sector; a cap because
                // this runs 142 times and an unbounded search is unbounded
                // spend.
                max_uses: 5,
                user_location: {
                  type: "approximate",
                  country: "AU",
                  timezone: "Australia/Sydney",
                },
              },
            ],
            messages: [{ role: "user", content: it.prompt }],
          },
        })),
      });
      return { batchId: batch.id };
    },

    async status(batchId) {
      const batch = await client.messages.batches.retrieve(batchId);
      return { ended: batch.processing_status === "ended" };
    },

    async results(batchId) {
      const out: BatchResult[] = [];
      for await (const entry of await client.messages.batches.results(batchId)) {
        if (entry.result.type !== "succeeded") {
          out.push({
            customId: entry.custom_id,
            output: null,
            sources: [],
            error: `batch item ${entry.result.type}`,
          });
          continue;
        }

        const content = entry.result.message.content;

        // Structured output still arrives as a text block; the schema is what
        // guarantees it parses. Joined rather than taking the first, because a
        // response that used a server tool is split across several blocks.
        const text = content
          .map((b) => (b.type === "text" ? b.text : ""))
          .join("");

        // Every URL the search actually returned, so the note is checkable.
        const sources: { title: string; url: string }[] = [];
        for (const block of content) {
          if (block.type !== "web_search_tool_result") continue;
          // An errored search returns an object here rather than a list — see
          // "Server-tool errors don't raise".
          if (!Array.isArray(block.content)) continue;
          for (const r of block.content) {
            if (r.type === "web_search_result") {
              sources.push({ title: r.title ?? r.url, url: r.url });
            }
          }
        }

        let output: unknown = null;
        try {
          output = JSON.parse(text);
        } catch {
          out.push({
            customId: entry.custom_id,
            output: null,
            sources,
            error: "response was not JSON",
          });
          continue;
        }

        out.push({ customId: entry.custom_id, output, sources });
      }
      return out;
    },
  };
}
