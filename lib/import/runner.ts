// Shared plumbing for the broker importers.
// ----------------------------------------------------------------------------
// The import logic used to live inside scripts/import-*.mjs as top-level
// statements: it read argv, wrote to stdout and called process.exit(). That is
// fine for one caller and impossible for a second, and there is now a second —
// the morning mail ingest runs the very same imports unattended.
//
// So the work moved here, behind two rules that make it callable from anywhere:
//
//   1. Nothing prints. Every number a caller might want to show is returned in
//      the result object; the CLI renders it, the ingest job logs it.
//   2. Nothing exits. A refusal is an `ImportError` with a `code`, so the
//      caller can decide between "tell the operator" and "quarantine the
//      attachment and alert the desk".
//
// The CLI scripts are now thin renderers over these functions, which is the
// point: one implementation of the money, two front doors.

import type { SupabaseClient } from "@supabase/supabase-js";
import { parseCsvRecords } from "./csv.ts";
import { HOLDINGS_REQUIRED_HEADERS } from "./holdings.ts";
import { TRADE_REQUIRED_HEADERS } from "./trades.ts";
import { CONTRACT_NOTES_LISTING_HEADERS } from "./trade-formats.ts";

/**
 * A service-role Supabase client. Both importers write across every client's
 * rows, so they bypass RLS entirely — the key behind this must never reach a
 * browser bundle.
 *
 * Deliberately loose in its generic: the CLI passes a plain untyped client, the
 * server passes the generated-types one, and the tests pass a fake. All three
 * are structurally the same for the handful of calls made here.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the looseness IS the contract; see above.
export type AdminDb = SupabaseClient<any>;

/**
 * An `accounts` row as both importers read it back.
 *
 * Hand-written rather than taken from the generated `Database` types, because
 * `AdminDb` is deliberately un-generic — naming just the three columns the
 * importers select documents the query at the same time.
 */
export type AccountRefRow = {
  id: string;
  external_ref: string;
  client_id: string;
};

export type ImportErrorCode =
  /** The file parsed, but produced no usable rows. */
  | "NO_ROWS"
  /** Trades reference accounts that no holdings snapshot has created yet. */
  | "UNKNOWN_ACCOUNTS"
  /** The headers match neither known export. */
  | "UNRECOGNISED_FILE";

/**
 * A refusal to import, carrying enough structure for an unattended caller to
 * act on it without parsing an error message.
 */
export class ImportError extends Error {
  readonly code: ImportErrorCode;
  /** The offending values — account numbers, header names — for the operator. */
  readonly details: string[];

  constructor(code: ImportErrorCode, message: string, details: string[] = []) {
    super(message);
    this.name = "ImportError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Upsert in chunks. PostgREST caps payload size and a single 300-row statement
 * is no faster than three of 100, so keep batches modest and predictable.
 */
export async function upsertChunked(
  db: AdminDb,
  table: string,
  rows: Record<string, unknown>[],
  options: { chunkSize?: number; onConflict?: string } = {},
): Promise<void> {
  const { chunkSize = 250, ...rest } = options;

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await db.from(table).upsert(chunk, rest);
    if (error) {
      throw new Error(
        `upsert ${table} [rows ${i}-${i + chunk.length - 1}] failed: ${error.message}` +
          (error.details ? `\n  details: ${error.details}` : "") +
          (error.hint ? `\n  hint: ${error.hint}` : ""),
      );
    }
  }
}

/** How many rows PostgREST returns before it silently stops. */
const PAGE = 1000;

/**
 * Read EVERY row a query matches, not the first thousand.
 *
 * PostgREST caps a response at its `max-rows` setting — 1000 on Supabase — and
 * says nothing about it: no error, no flag, just a short array. `.range()` does
 * not lift the cap either; it only moves the window.
 *
 * That is a quiet correctness bug wherever a full set is assumed, and this
 * codebase assumed it in the worst possible place. The realised-P&L replay
 * re-reads an account's whole stored ledger and walks it chronologically to
 * attribute cost; handed the first 1,000 of 3,996 trades it produced a complete
 * looking, entirely wrong answer. The same applied to the P&L recompute's own
 * trade load.
 *
 * So any select that can exceed a thousand rows goes through here. Pages until
 * a short page arrives, which is the only reliable end-of-set signal.
 *
 *     const rows = await selectAll(db, "trades", "cnote, side",
 *       (q) => q.in("account_id", ids));
 */
export async function selectAll<T>(
  db: AdminDb,
  table: string,
  columns: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the PostgREST builder is not usefully typeable here.
  filter?: (query: any) => any,
): Promise<T[]> {
  const out: T[] = [];

  for (let from = 0; ; from += PAGE) {
    let query = db.from(table).select(columns).range(from, from + PAGE - 1);
    if (filter) query = filter(query);

    const { data, error } = await query;
    if (error) throw error;

    const page = (data ?? []) as unknown as T[];
    out.push(...page);

    // A short page means the end. Stopping on `length === 0` instead would cost
    // one wasted round trip whenever the total is an exact multiple of the cap.
    if (page.length < PAGE) return out;
  }
}

export type CsvKind = "holdings" | "trades" | "unknown";

/**
 * Which broker export this is, decided by its HEADERS.
 *
 * Not by its filename. The morning mail carries both files and the broker is
 * free to rename them, re-order the columns or add new ones at any time; the
 * set of columns is the only thing that actually identifies the shape. A file
 * matching neither returns `"unknown"` so the caller can skip and alert —
 * guessing which importer to run would let a mistyped attachment full-replace
 * every position in the database.
 */
export function detectCsvKind(text: string): CsvKind {
  let headers: string[];
  try {
    headers = parseCsvRecords(text).headers;
  } catch {
    return "unknown";
  }

  const present = new Set(headers);
  const hasAll = (required: readonly string[]) =>
    required.every((h) => present.has(h));

  if (hasAll(HOLDINGS_REQUIRED_HEADERS)) return "holdings";
  // Either dialect of the trade ledger — see lib/import/trade-formats.ts.
  if (hasAll(TRADE_REQUIRED_HEADERS)) return "trades";
  if (hasAll(CONTRACT_NOTES_LISTING_HEADERS)) return "trades";
  return "unknown";
}

/**
 * Broker entity ref → the `clients.id` that should OWN an account for it.
 *
 * Not simply the row carrying the ref. When an account claim is approved
 * (`approve_account_claim`, 20260904090000) the broker-created client row is
 * left behind marked `merged_into`, and the real owner is a different row — the
 * one holding the login. The stub keeps its `external_ref` on purpose: the ref
 * is UNIQUE and this importer re-creates any ref it does not find, so deleting
 * the stub would bring it back as a fresh empty client every morning.
 *
 * That is exactly why looking the ref up and stopping there is wrong. It was:
 * a new account arriving for an entity whose accounts had all been claimed got
 * created under the stub — a row `getClients()` filters out of the register for
 * owning nothing. The account existed, the client could not see it in their
 * switcher, and the desk could not see it either, because its owner was hidden.
 * `clients.merged_into` says "this entity is now part of that one" and this was
 * the one place that did not read it.
 *
 * ── Why the pointer is followed as a CHAIN ──────────────────────────────────
 * `approve_account_claim` refuses to claim *onto* a merged-away row, so a chain
 * cannot be built in one step. It can still form over time: A merges into B, and
 * later B's own last account is claimed by C. Following one hop would then land
 * on B — hidden, owning nothing, the same bug one level down.
 *
 * The loop is bounded and cycle-guarded rather than trusting the data to be a
 * tree. A cycle should be impossible (a row must be emptied to be marked, and a
 * claim onto a marked row is refused), but "should be impossible" is a poor
 * reason for an importer that runs unattended at 9am to hang. On hitting the cap
 * or a cycle it keeps the last row it resolved, which is the most correct answer
 * available and never worse than not following the pointer at all.
 */
export async function ownerIdByExternalRef(
  db: AdminDb,
  refs: string[],
): Promise<Map<string, string>> {
  type Row = { id: string; external_ref: string | null; merged_into: string | null };

  if (refs.length === 0) return new Map();

  const { data, error } = await db
    .from("clients")
    .select("id, external_ref, merged_into")
    .in("external_ref", refs);
  if (error) throw new Error(`resolve client owners: ${error.message}`);

  const rows = (data ?? []) as unknown as Row[];

  // Every row reachable by following the pointers, keyed by id. Seeded with what
  // the refs matched; targets are fetched in batches below.
  const byId = new Map<string, Row>(rows.map((r) => [r.id, r]));

  const MAX_HOPS = 8;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const wanted = [
      ...new Set(
        [...byId.values()]
          .map((r) => r.merged_into)
          .filter((id): id is string => !!id && !byId.has(id)),
      ),
    ];
    if (wanted.length === 0) break;

    const { data: more, error: moreError } = await db
      .from("clients")
      .select("id, external_ref, merged_into")
      .in("id", wanted);
    if (moreError) throw new Error(`resolve client owners: ${moreError.message}`);

    for (const r of (more ?? []) as unknown as Row[]) byId.set(r.id, r);
  }

  const owners = new Map<string, string>();
  for (const start of rows) {
    let current = start;
    const seen = new Set<string>([current.id]);

    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const next = current.merged_into;
      if (!next) break;
      const target = byId.get(next);
      // Unfetched (ran out of hops above) or already visited (a cycle) — stop on
      // the last row known to be real rather than following a pointer nowhere.
      if (!target || seen.has(target.id)) break;
      seen.add(target.id);
      current = target;
    }

    if (start.external_ref) owners.set(start.external_ref, current.id);
  }

  return owners;
}
