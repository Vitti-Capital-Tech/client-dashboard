import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { AdminDb } from "../import/runner.ts";

/**
 * Service-role Supabase client — BYPASSES ROW-LEVEL SECURITY ENTIRELY.
 *
 * Use this only where there is genuinely no user to act as, and where the work
 * spans every client's rows by design:
 *
 *   • the morning mail ingest (a cron request, no session at all)
 *   • the P&L recompute it triggers, which writes rows for many clients
 *
 * Everywhere else — anything reached from a page or a form — must keep using
 * `./server.ts`, so a staff member's own permissions and the RLS policies stay
 * in force. Reaching for this client to "fix" a permissions error would silently
 * hand one client's figures to another.
 *
 * `import "server-only"` above is what stops the key ever reaching a browser
 * bundle: importing this from a Client Component is a build error, not a
 * runtime leak.
 */
export function createAdminClient(): AdminDb {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error(
      "Missing Supabase admin credentials. Set NEXT_PUBLIC_SUPABASE_URL and " +
        "SUPABASE_SERVICE_ROLE_KEY (Supabase → Project Settings → API).",
    );
  }

  return createSupabaseClient(url, serviceKey, {
    // There is no user and no browser here, so there is no session to persist
    // and nothing to refresh a token for.
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
