import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { Database } from "./database.types";

/**
 * Supabase client for Server Components, Server Functions, and Route Handlers.
 *
 * NOTE (this Next.js version): `cookies()` is ASYNC — it must be awaited, so
 * this factory is async too. See node_modules/next/dist/docs/.../cookies.md.
 */
export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // `setAll` was called from a Server Component, where cookies are
            // read-only. Safe to ignore: the Proxy (added with auth in Stage 5)
            // is what refreshes the session cookie on each request.
          }
        },
      },
    },
  );
}
