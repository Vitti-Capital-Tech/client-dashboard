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
  if (hasAll(TRADE_REQUIRED_HEADERS)) return "trades";
  return "unknown";
}
