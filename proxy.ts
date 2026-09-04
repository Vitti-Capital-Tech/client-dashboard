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

  const { pathname } = request.nextUrl;

  // Route protection: the portal requires a signed-in user. Unauthenticated
  // requests to /portal are redirected to the login page. Real per-row
  // authorization is enforced by RLS.
  if (!user && pathname.startsWith("/portal")) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    return NextResponse.redirect(loginUrl);
  }

  // The other direction: a signed-in user has no business on the sign-in form.
  // Without this, "sign in" on a session that is already valid renders a form
  // that authenticates you as the person you already are — and the browser's
  // back button after signing in lands on it, which reads as having been logged
  // out.
  //
  // `/signup` is NOT in this list, and that is deliberate rather than an
  // oversight: registration mints its session at step 2 and still has a step 3,
  // so the page is reached signed-in BY DESIGN. Bouncing it here would make
  // linking the first account unreachable — and, because the portal sends an
  // account-less client back to /signup, would be a redirect loop. What stops
  // anyone loitering there is app/signup/page.tsx, which redirects to the portal
  // once an account or a pending claim exists.
  //
  // `/reset-password` is also left open: somebody signed in on a session they no
  // longer trust is exactly who needs it.
  if (
    user &&
    (pathname === "/login" || pathname === "/staff/login" || pathname === "/")
  ) {
    const portalUrl = request.nextUrl.clone();
    portalUrl.pathname =
      user.app_metadata?.role === "admin" ? "/portal/staff" : "/portal/client";
    portalUrl.search = "";
    return NextResponse.redirect(portalUrl);
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
