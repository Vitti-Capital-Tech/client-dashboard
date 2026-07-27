// Shared plumbing for the broker importers (scripts/import-*.mjs).
// ----------------------------------------------------------------------------
// Both importers write across every client's rows, so they run as service_role
// and bypass RLS. That key must never reach the browser — these scripts are the
// only place it is used, alongside seed-auth-users.mjs.

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

/** Create the admin Supabase client, failing with a usable message if unset. */
export function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    console.error(
      "Missing env. Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.\n" +
        "Get the service role key from Supabase → Project Settings → API,\n" +
        "add it to .env.local, then run with: node --env-file=.env.local <script> <file.csv>",
    );
    process.exit(1);
  }

  return createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** Parse `<file.csv> [--dry-run]` style argv. */
export function parseArgs(usage) {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const positional = argv.filter((a) => !a.startsWith("--"));

  if (positional.length !== 1) {
    console.error(usage);
    process.exit(1);
  }

  const file = path.resolve(positional[0]);
  if (!fs.existsSync(file)) {
    console.error(`No such file: ${file}`);
    process.exit(1);
  }

  return { file, dryRun: flags.has("--dry-run") };
}

export function readCsv(file) {
  return fs.readFileSync(file, "utf8");
}

/**
 * Upsert in chunks. PostgREST caps payload size and a single 300-row statement
 * is no faster than three of 100, so keep batches modest and predictable.
 */
export async function upsertChunked(supabase, table, rows, options = {}) {
  const { chunkSize = 250, ...rest } = options;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await supabase.from(table).upsert(chunk, rest);
    if (error) {
      throw new Error(
        `upsert ${table} [rows ${i}-${i + chunk.length - 1}] failed: ${error.message}` +
          (error.details ? `\n  details: ${error.details}` : "") +
          (error.hint ? `\n  hint: ${error.hint}` : ""),
      );
    }
  }
}

/** Report parse failures without hiding them behind a count. */
export function reportRowErrors(errors, label) {
  if (errors.length === 0) return;
  console.warn(`\n  ${errors.length} ${label} row(s) could not be parsed:`);
  for (const e of errors.slice(0, 20)) {
    console.warn(`    line ${e.line}: ${e.reason}`);
  }
  if (errors.length > 20) console.warn(`    … and ${errors.length - 20} more`);
}

export const fmtMoney = (n) =>
  (n < 0 ? "-" : "") +
  "$" +
  Math.abs(n).toLocaleString("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
