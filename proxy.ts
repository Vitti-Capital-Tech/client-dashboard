import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Proxy (Next.js 16's renamed Middleware — see node_modules/next/dist/docs/
 * .../16-proxy.md). Runs on the Node runtime before every matched route and
 * REFRESHES the Supabase auth session cookie so Server Components always read a
 * valid, non-expired token via `getUser()`.
 *
 * Critical ordering (per @supabase/ssr guidance): do not run any logic between
 * `createServerClient` and `getUser()`, and always return the same `response`
 * object the cookie adapter wrote to — otherwise the refreshed cookies are lost
 * and users get logged out intermittently.
 *
 * This is an optimistic refresh only. Real authorization is enforced inside the
 * DAL/server actions (and, later, Postgres RLS) — never in the proxy alone.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // Write to both the request (for downstream reads) and the response
          // (so the browser receives the refreshed Set-Cookie headers).
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Touch the session so an expired access token is refreshed on this request.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Route protection: the portal requires a signed-in user. Unauthenticated
  // requests to /portal are redirected to the login page. (The landing page
  // and /login stay public.) Real per-row authorization is enforced by RLS.
  if (!user && request.nextUrl.pathname.startsWith("/portal")) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Run on every path EXCEPT static assets and image files — auth logic must
     * never block CSS/JS/images from loading (see the Proxy matcher docs).
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
