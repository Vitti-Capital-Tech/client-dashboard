import { createHash } from "node:crypto";
import { detectCsvKind, ImportError, type AdminDb } from "../import/runner.ts";
import { runHoldingsImport } from "../import/run-holdings.ts";
import { runTradeImport } from "../import/run-trades.ts";
import type { fetchBrokerAttachments, BrokerAttachment } from "./graph-mail.ts";
import type { recomputeAccounts } from "../pnl/batch.ts";

// Only the pure importers are imported eagerly. The service-role client, the
// Graph mailbox and the P&L batch are pulled in ON DEMAND, inside the run:
//
//   • they are the modules carrying secrets, network access and ExcelJS, and
//     nothing should load a ~1 MB spreadsheet library to decide it has no mail;
//   • it keeps this module free of `server-only`, so the orchestration can be
//     tested without a Next runtime — which is how the guardrail below, the one
//     thing standing between a truncated export and an emptied book, is covered
//     by tests at all.

/**
 * The morning ingest: read the broker's mail, import what it carries, and
 * rebuild the P&L for whatever it touched.
 *
 * Sequenced deliberately:
 *
 *   1. holdings before trades — the snapshot CREATES the accounts, and a trade
 *      for an unknown account is refused outright rather than guessed at;
 *   2. all imports before any recompute — so the P&L is computed once, from a
 *      settled database, rather than twice from a half-applied one.
 *
 * Safe to run more than once. Attachments dedupe on Graph's own ids, and both
 * importers are idempotent, so the DST-proof habit of scheduling several
 * wake-ups costs nothing.
 */

export type IngestOutcome =
  | "imported"
  | "quarantined"
  | "unrecognised"
  | "failed"
  | "duplicate";

export type AttachmentReport = {
  filename: string;
  kind: string;
  outcome: IngestOutcome;
  rows?: number;
  accountRefs: string[];
  error?: string;
};

export type IngestReport = {
  runId: string | null;
  ok: boolean;
  messagesSeen: number;
  attachments: AttachmentReport[];
  accountsRecomputed: number;
  notes: string[];
  error?: string;
};

/**
 * How much of the existing book a holdings snapshot must still mention before
 * it is allowed to apply.
 *
 * The import is a FULL REPLACE: every account in the file has its positions
 * deleted and rewritten. A truncated export — the broker's job half-finished,
 * a filtered view mailed by mistake — would therefore wipe the accounts it
 * omits. Clients do close accounts, so some shrinkage is legitimate; a tenth of
 * the book vanishing overnight is not.
 */
const MIN_ACCOUNT_COVERAGE = 0.9;

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * Attachments this mailbox has already SETTLED, by Graph's own ids.
 *
 * Deliberately not "already seen". Only two outcomes are final:
 *
 *   imported     — the work is done; re-running is a waste even though the
 *                  importers would tolerate it
 *   unrecognised — the headers match no known export, and a file's columns do
 *                  not change between runs
 *
 * A `failed` or `quarantined` attachment is explicitly NOT final. Its cause is
 * usually something the next run can fix — a missing account that a later
 * holdings snapshot creates, a coverage shortfall that a corrected file
 * resolves — and treating those as done is how a permanent skip is manufactured
 * out of a temporary problem. That is not hypothetical: three trade files
 * failed on unknown accounts, and once the importer was taught to create them
 * the fix could not take effect, because the files had been marked seen.
 */
async function alreadySettled(
  db: AdminDb,
  atts: BrokerAttachment[],
): Promise<{ ids: Set<string>; hashes: Set<string> }> {
  if (atts.length === 0) return { ids: new Set(), hashes: new Set() };

  const { data, error } = await db
    .from("ingest_attachments")
    .select("message_id, attachment_id, outcome, sha256");
  if (error) throw error;

  const rows = (data ?? []) as unknown as {
    message_id: string;
    attachment_id: string;
    outcome: string;
    sha256: string | null;
  }[];

  const settled = rows.filter(
    (r) => r.outcome === "imported" || r.outcome === "unrecognised",
  );

  return {
    ids: new Set(settled.map((r) => `${r.message_id}:${r.attachment_id}`)),
    /**
     * Content hashes of files already imported.
     *
     * The broker re-sends the SAME full-history export every morning — three
     * byte-identical `ContractNotesListing` files sat in the mailbox, each
     * 4,026 rows. The importers tolerate that, but tolerating is not free: one
     * measured at **10.8s**, so re-importing two more spends thirty seconds of
     * a sixty-second budget to reach a state the database was already in.
     *
     * Identical bytes cannot produce a different outcome, so the second copy is
     * skipped outright. This is why the hash is stored at all.
     */
    hashes: new Set(
      settled
        .filter((r) => r.outcome === "imported" && r.sha256)
        .map((r) => r.sha256 as string),
    ),
  };
}

/** Where the last successful run got to. */
async function lastWatermark(db: AdminDb): Promise<Date | null> {
  const { data, error } = await db
    .from("ingest_runs")
    .select("watermark")
    .eq("status", "ok")
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) throw error;

  const raw = ((data ?? []) as unknown as { watermark: string | null }[])[0]?.watermark;
  return raw ? new Date(raw) : null;
}

/**
 * Would applying this snapshot quietly empty part of the book?
 *
 * Compares the file's account numbers against the accounts that currently hold
 * positions. Returns null when it is safe, or the reason to quarantine.
 */
async function coverageRefusal(
  db: AdminDb,
  fileRefs: string[],
): Promise<string | null> {
  const { data, error } = await db
    .from("positions")
    .select("accounts(external_ref)");
  if (error) throw error;

  const existing = new Set(
    ((data ?? []) as unknown as { accounts: { external_ref: string | null } | null }[])
      .map((p) => p.accounts?.external_ref)
      .filter((r): r is string => Boolean(r)),
  );

  // Nothing held yet — this is the first snapshot, and there is nothing it
  // could destroy.
  if (existing.size === 0) return null;

  const covered = [...existing].filter((r) => fileRefs.includes(r)).length;
  const coverage = covered / existing.size;
  if (coverage >= MIN_ACCOUNT_COVERAGE) return null;

  const missing = [...existing].filter((r) => !fileRefs.includes(r));
  return (
    `Snapshot covers ${covered} of ${existing.size} accounts that currently hold ` +
    `positions (${(coverage * 100).toFixed(0)}%, below the ${MIN_ACCOUNT_COVERAGE * 100}% ` +
    `floor). Applying it would delete the positions of ${missing.length} account(s), ` +
    `starting with ${missing.slice(0, 5).join(", ")}. Import it by hand if it is genuine.`
  );
}

/**
 * Seams for the tests.
 *
 * Production passes nothing and gets the real service-role client, the real
 * mailbox and the real recompute. The tests pass all three, because what is
 * worth covering here — does the guardrail refuse a truncated snapshot, are
 * holdings applied before trades, is an already-seen attachment skipped — needs
 * no network and no database to be true.
 */
export type IngestDeps = {
  db?: AdminDb;
  fetchAttachments?: typeof fetchBrokerAttachments;
  recompute?: typeof recomputeAccounts;
  /** Overrides `INGEST_BUDGET_MS`; tests use it to force the deferral path. */
  budgetMs?: number;
};

/**
 * How long the whole run may take before it stops starting new recomputes.
 *
 * Sized for the ceiling this actually runs against — 60s on the host's free
 * tier — and the import must finish inside it whatever else does not. The first
 * real scheduled run was killed at exactly that point having recomputed 13 of
 * 43 accounts, and because the kill came before any run row was written, the
 * failure was silent. Raise via `INGEST_BUDGET_MS` where the host allows more.
 */
const DEFAULT_BUDGET_MS = Number(process.env.INGEST_BUDGET_MS) || 40_000;

export async function runMorningIngest(deps: IngestDeps = {}): Promise<IngestReport> {
  const budgetMs = deps.budgetMs ?? DEFAULT_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const db = deps.db ?? (await import("../supabase/admin.ts")).createAdminClient();
  const fetchAttachments =
    deps.fetchAttachments ?? (await import("./graph-mail.ts")).fetchBrokerAttachments;
  const recompute = deps.recompute ?? (await import("../pnl/batch.ts")).recomputeAccounts;
  const startedAt = new Date();

  const notes: string[] = [];
  const reports: AttachmentReport[] = [];
  const touchedAccountIds = new Set<string>();

  let runId: string | null = null;

  try {
    const since = await lastWatermark(db);
    notes.push(
      since ? `Reading mail received after ${since.toISOString()}.` : "First run — no watermark.",
    );

    const mail = await fetchAttachments(since);
    if (!mail.ok) {
      runId = await recordRun(db, {
        startedAt,
        watermark: since,
        messagesSeen: 0,
        reports: [],
        notes,
        status: "failed",
        error: mail.error ?? "Mail fetch failed.",
        pnlBatchId: null,
      });
      return {
        runId,
        ok: false,
        messagesSeen: 0,
        attachments: [],
        accountsRecomputed: 0,
        notes,
        error: mail.error,
      };
    }

    const settled = await alreadySettled(db, mail.attachments);
    const fresh = mail.attachments.filter(
      (a) => !settled.ids.has(`${a.messageId}:${a.attachmentId}`),
    );

    if (fresh.length < mail.attachments.length) {
      notes.push(
        `${mail.attachments.length - fresh.length} attachment(s) already imported — skipped.`,
      );
    }

    // Holdings first: the snapshot creates the accounts the ledger needs.
    const ordered = [
      ...fresh.filter((a) => detectCsvKind(a.content) === "holdings"),
      ...fresh.filter((a) => detectCsvKind(a.content) !== "holdings"),
    ];

    // Content hashes imported during THIS run as well as previous ones, so the
    // three identical files in one mailbox collapse to one import.
    const importedHashes = new Set(settled.hashes);

    for (const att of ordered) {
      const kind = detectCsvKind(att.content);
      const hash = sha256(att.content);

      if (importedHashes.has(hash)) {
        const report: AttachmentReport = {
          filename: att.filename,
          kind,
          outcome: "duplicate",
          accountRefs: [],
          error: "Byte-identical to a file already imported — nothing to do.",
        };
        reports.push(report);
        await recordAttachment(db, att, kind, report);
        continue;
      }

      const report = await processOne(db, att, kind);
      reports.push(report);

      if (report.outcome === "imported") importedHashes.add(hash);

      await recordAttachment(db, att, kind, report);

      if (report.outcome === "imported" && report.accountRefs.length > 0) {
        for (const id of await accountIdsFor(db, report.accountRefs)) {
          touchedAccountIds.add(id);
        }
      }
    }

    // ---------------------------------------------------------------------
    // Recompute: QUEUED first, so an interrupted run still owes the work.
    // ---------------------------------------------------------------------
    // Importing and recomputing are one logical morning but wildly unequal in
    // cost, so the recompute must never be able to cost the import. Enqueueing
    // after a successful recompute would lose exactly the case the queue exists
    // for — which is the case that actually happened on the first real run.
    let pnlBatchId: string | null = null;
    let deferredCount = 0;

    const { enqueueRecompute, pendingRecomputes } = await import("../pnl/queue.ts");
    if (touchedAccountIds.size > 0) {
      await enqueueRecompute(db, [...touchedAccountIds], "ingest");
    }

    // Everything owed, not just today's — an account deferred yesterday must
    // not wait behind the accident of which accounts today's file mentions.
    const owed = (await pendingRecomputes(db)).map((r) => r.account_id);

    if (owed.length > 0) {
      const batch = await recompute(owed, { trigger: "ingest", deadline });
      pnlBatchId = batch.batchId;
      deferredCount = batch.deferred.length;

      if (batch.skippedReason) {
        notes.push(batch.skippedReason);
      } else {
        notes.push(
          `Recomputed ${batch.results.length} of ${owed.length} owed account(s) against ` +
            `${batch.placementTickers} placement ticker(s) parsed ${batch.placementsParsedAt}.`,
        );
      }
      if (batch.deferred.length > 0) {
        notes.push(
          `${batch.deferred.length} account(s) left queued — the ${Math.round(budgetMs / 1000)}s ` +
            `budget ran out. The next run or Rebuild all P&L will take them.`,
        );
      }
      if (batch.failures.length > 0) {
        notes.push(`${batch.failures.length} account(s) failed to recompute.`);
      }
    } else if (reports.length === 0) {
      notes.push("No new broker mail.");
    }

    // A quarantined or failed file, or work left owed, all mean this morning is
    // not finished. Saying "ok" would be a lie the watermark then makes
    // permanent by skipping past what was never done.
    const failed = reports.filter(
      (r) => r.outcome === "failed" || r.outcome === "quarantined",
    ).length;
    const status = failed > 0 || deferredCount > 0 ? "partial" : "ok";

    /**
     * The watermark advances only when EVERY attachment in the window is
     * settled — imported or unrecognised — and nothing is still owed.
     *
     * The status check alone is not enough, and the gap is not hypothetical: a
     * run that skipped three previously-failed files as "already processed" did
     * no work, reported `ok`, and moved the watermark past them. They then fell
     * outside the mail window entirely and could not be retried even after the
     * bug that failed them was fixed.
     *
     * The attachment table is what guarantees correctness; the watermark is only
     * an optimisation to avoid re-listing old mail. So when the two disagree,
     * the watermark yields — re-reading a message costs a Graph call, and
     * skipping one costs the day's data.
     */
    const unsettled = fresh.filter(
      (a) =>
        !reports.some(
          (r) =>
            r.filename === a.filename &&
            (r.outcome === "imported" ||
              r.outcome === "unrecognised" ||
              r.outcome === "duplicate"),
        ),
    ).length;

    const watermark =
      status === "ok" && unsettled === 0 && mail.attachments.length > 0
        ? new Date(mail.attachments[mail.attachments.length - 1].receivedAt)
        : since;

    runId = await recordRun(db, {
      startedAt,
      watermark,
      messagesSeen: mail.messagesSeen,
      reports,
      notes,
      status,
      error: null,
      pnlBatchId,
    });

    return {
      runId,
      ok: status === "ok",
      messagesSeen: mail.messagesSeen,
      attachments: reports,
      accountsRecomputed: touchedAccountIds.size,
      notes,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Morning ingest failed:", err);

    runId = await recordRun(db, {
      startedAt,
      watermark: null,
      messagesSeen: 0,
      reports,
      notes,
      status: "failed",
      error: message,
      pnlBatchId: null,
    }).catch(() => null);

    return {
      runId,
      ok: false,
      messagesSeen: 0,
      attachments: reports,
      accountsRecomputed: 0,
      notes,
      error: message,
    };
  }
}

/** Import one attachment, or explain why it was not imported. */
async function processOne(
  db: AdminDb,
  att: BrokerAttachment,
  kind: string,
): Promise<AttachmentReport> {
  const base = { filename: att.filename, kind, accountRefs: [] as string[] };

  if (kind === "unknown") {
    return {
      ...base,
      outcome: "unrecognised",
      error:
        "Headers match neither the holdings snapshot nor the trade ledger. " +
        "Nothing was attempted — running the wrong importer on this would be worse.",
    };
  }

  try {
    if (kind === "holdings") {
      // Parse first without writing, so the guardrail sees the file's real
      // account list before a single position is deleted.
      const preview = await runHoldingsImport(db, att.content, { dryRun: true });
      const refusal = await coverageRefusal(db, preview.touched.accountRefs);
      if (refusal) {
        return {
          ...base,
          outcome: "quarantined",
          rows: preview.parsed.holdings,
          accountRefs: preview.touched.accountRefs,
          error: refusal,
        };
      }

      const res = await runHoldingsImport(db, att.content);
      return {
        ...base,
        outcome: "imported",
        rows: res.parsed.holdings,
        accountRefs: res.touched.accountRefs,
      };
    }

    const res = await runTradeImport(db, att.content, { sourceFile: att.filename });
    const skipped = res.written?.skippedAccounts ?? [];
    return {
      ...base,
      outcome: "imported",
      rows: res.parsed.trades,
      accountRefs: res.touched.accountRefs,
      // A skipped account is a decision, not a footnote. It travels into
      // `ingest_attachments.error` so it is visible in the table rather than
      // only in a log nobody reads at 10am.
      error:
        skipped.length > 0
          ? `Skipped ${skipped.length} account(s): ${skipped.join("; ")}`
          : undefined,
    };
  } catch (err) {
    const detail =
      err instanceof ImportError
        ? `${err.message}${err.details.length ? ` (${err.details.join(", ")})` : ""}`
        : err instanceof Error
          ? err.message
          : String(err);
    return { ...base, outcome: "failed", error: detail };
  }
}

async function accountIdsFor(db: AdminDb, refs: string[]): Promise<string[]> {
  if (refs.length === 0) return [];
  const { data, error } = await db
    .from("accounts")
    .select("id")
    .in("external_ref", refs);
  if (error) throw error;
  return ((data ?? []) as unknown as { id: string }[]).map((a) => a.id);
}

async function recordAttachment(
  db: AdminDb,
  att: BrokerAttachment,
  kind: string,
  report: AttachmentReport,
): Promise<void> {
  const { error } = await db.from("ingest_attachments").upsert(
    {
      message_id: att.messageId,
      attachment_id: att.attachmentId,
      received_at: att.receivedAt,
      sender: att.sender,
      subject: att.subject,
      filename: att.filename,
      size_bytes: att.sizeBytes,
      sha256: sha256(att.content),
      kind,
      outcome: report.outcome,
      rows_parsed: report.rows ?? null,
      error: report.error ?? null,
      account_refs: report.accountRefs,
    },
    { onConflict: "message_id,attachment_id" },
  );
  if (error) throw error;
}

async function recordRun(
  db: AdminDb,
  args: {
    startedAt: Date;
    watermark: Date | null;
    messagesSeen: number;
    reports: AttachmentReport[];
    notes: string[];
    status: string;
    error: string | null;
    pnlBatchId: string | null;
  },
): Promise<string | null> {
  const { data, error } = await db
    .from("ingest_runs")
    .insert({
      started_at: args.startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      watermark: args.watermark?.toISOString() ?? null,
      messages_seen: args.messagesSeen,
      attachments: args.reports.length,
      imported: args.reports.filter((r) => r.outcome === "imported").length,
      quarantined: args.reports.filter((r) => r.outcome === "quarantined").length,
      status: args.status,
      error: args.error,
      notes: args.notes,
      pnl_batch_id: args.pnlBatchId,
    })
    .select("id");
  if (error) throw error;

  return ((data ?? []) as unknown as { id: string }[])[0]?.id ?? null;
}
