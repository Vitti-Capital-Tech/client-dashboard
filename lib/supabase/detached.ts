import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";

/**
 * An anon-key Supabase client that CANNOT touch the caller's session.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * Adding a second login address has to prove the person can read mail at that
 * address, and the only proof this system has is `verifyOtp`. But `verifyOtp`
 * succeeds by *returning a session* — and `./server.ts` is wired to write
 * whatever session it is handed into the request's cookies. Called from a
 * server action, where cookies are writable, verifying a code for the new
 * address would therefore sign the caller OUT of the account they are editing
 * and IN as the address they were only trying to add. They would be sitting on
 * the Settings page of a different login by the time the action returned.
 *
 * So the verification runs here instead: same anon key, same endpoint, no
 * cookie adapter at all. The session `verifyOtp` returns is created, read for
 * its "yes, this address is real", and dropped when the request ends.
 *
 * ── Why not the service role ────────────────────────────────────────────────
 * `./admin.ts` could confirm an address without any code at all, which is
 * exactly what must not happen: the whole value of the step is that somebody
 * proved they can read that mailbox. This client has no more authority than a
 * signed-out browser, which is the right amount for checking a code.
 */
export function createDetachedClient() {
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // The three of these together are what "detached" means: nothing is
      // written anywhere, nothing is read back on the next call, and no timer
      // outlives the request.
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
}
