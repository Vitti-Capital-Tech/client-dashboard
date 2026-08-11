import "server-only";
import { cache } from "react";
import { createClient } from "../supabase/server";
import { getAuditLog } from "./queries";

/**
 * The morning ingest's own record, folded into the operations register.
 *
 * `ingest_runs` existed from the start and nothing rendered it, so the only way
 * to answer "did this morning's mail land?" was a SQL console. That is a bad
 * place to keep an operational answer, because the pipeline's worst failure is
 * a SILENT one: a run killed at the host's 60s ceiling writes no row at all, so
 * the evidence is an ABSENCE — and nobody goes looking for an absence they
 * cannot see. Sitting the runs in the same chronological list as every human
 * action is what makes a missing morning noticeable.
 *
 * Deliberately NOT a page of its own. The audit log is already the register of
 * "what happened and when", and the overview already renders the head of it —
 * so one merged read lights up both surfaces and adds no navigation.
 *
 * Staff-only by RLS (`is_staff()`). Unlike positions or P&L these rows belong to
 * no client: one attachment covers the whole book, and its sender and subject
 * are internal operational detail.
 */

/** One cron invocation, as stored. */
export type IngestRunRow = {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  /** 'ok' | 'partial' | 'failed'. */
  status: string;
  messagesSeen: number;
  attachments: number;
  imported: number;
  quarantined: number;
  /** The run's own narration — what it read, recomputed, and left owed. */
  notes: string[];
  error: string | null;
};

/** As PostgREST returns it — see the note on the cast below. */
type IngestRunRecord = {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  messages_seen: number | null;
  attachments: number | null;
  imported: number | null;
  quarantined: number | null;
  notes: string[] | null;
  error: string | null;
};

export const getIngestRuns = cache(
  async (limit = 30): Promise<IngestRunRow[]> => {
    const supabase = await createClient();

    /* eslint-disable-next-line @typescript-eslint/no-explicit-any --
     * `ingest_runs` is ABSENT from the generated `Database` types: the file
     * carries 29 tables and neither of the mail-ingest pair is among them, so
     * the typed client rejects the table name outright rather than mistyping a
     * column. The escape is deliberately narrow — one `from`, with the row
     * shape spelled out above so the mapping below is still checked — and the
     * real fix is `supabase gen types`, which needs project credentials this
     * repo does not carry. */
    const { data, error } = await (supabase as any)
      .from("ingest_runs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(limit);
    if (error) throw error;

    return ((data ?? []) as IngestRunRecord[]).map((r) => ({
      id: r.id,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      status: r.status,
      messagesSeen: Number(r.messages_seen ?? 0),
      attachments: Number(r.attachments ?? 0),
      imported: Number(r.imported ?? 0),
      quarantined: Number(r.quarantined ?? 0),
      notes: r.notes ?? [],
      error: r.error,
    }));
  },
);

/**
 * One line in the operations register — a human action or an ingest run.
 *
 * `key` is a string because the two sources are keyed differently (`audit_log`
 * by bigint, `ingest_runs` by uuid) and prefixing is what keeps them from
 * colliding once merged.
 */
export type RegisterEntry = {
  key: string;
  ts: string;
  actor: string;
  role: string;
  action: string;
  detail: string | null;
  /** True for the ingest's own rows, so the UI can mark them as unattended. */
  system: boolean;
};

/** How a run's status reads in the register, and how loudly. */
const RUN_LABEL: Record<string, string> = {
  ok: "Morning ingest completed",
  partial: "Morning ingest finished with work owed",
  failed: "Morning ingest failed",
};

function describeRun(run: IngestRunRow): string {
  // A failed run's error is the whole story and the notes are usually just the
  // watermark it never got past, so it leads. Everything else reads best in the
  // order the run itself narrated: what it read, what it imported, what it
  // recomputed, what it left queued.
  const parts = run.error ? [run.error, ...run.notes] : run.notes;
  return parts.join(" · ");
}

/**
 * Human actions and ingest runs as ONE chronological register.
 *
 * `limit` bounds the merged result, not each source: asking for 200 and getting
 * 200 audit rows plus however many runs happened to exist would silently return
 * more than the caller sized its page for.
 */
export const getOperationsRegister = cache(
  async (limit = 200): Promise<RegisterEntry[]> => {
    const [audit, runs] = await Promise.all([getAuditLog(limit), getIngestRuns()]);

    const human: RegisterEntry[] = audit.map((a) => ({
      key: `audit:${a.id}`,
      ts: a.ts,
      actor: a.actor,
      role: a.role,
      action: a.action,
      detail: a.detail,
      system: false,
    }));

    const machine: RegisterEntry[] = runs.map((r) => ({
      key: `ingest:${r.id}`,
      ts: r.startedAt,
      actor: "Morning ingest",
      role: "system",
      action: RUN_LABEL[r.status] ?? `Morning ingest ${r.status}`,
      detail: describeRun(r) || null,
      system: true,
    }));

    return [...human, ...machine]
      .sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0))
      .slice(0, limit);
  },
);

/**
 * The account ids one client still owes a recompute.
 *
 * A stale stored figure is indistinguishable from a fresh one on the page — it
 * simply carries an older "Calculated" stamp, which reads as "nothing has
 * happened since" rather than "this is waiting to be rebuilt". On a morning
 * where the budget ran out that difference is the whole answer, so the profile
 * asks the queue directly.
 */
export const getQueuedAccountIds = cache(
  async (clientId: string): Promise<string[]> => {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("pnl_recompute_queue")
      .select("account_id, accounts!inner(client_id)")
      .eq("accounts.client_id", clientId);
    if (error) throw error;

    return (data ?? []).map((q) => q.account_id as string);
  },
);
