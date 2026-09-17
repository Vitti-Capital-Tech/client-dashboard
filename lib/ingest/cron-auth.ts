import { timingSafeEqual } from "node:crypto";

/**
 * The shared secret guarding the cron endpoints.
 *
 * These routes run with no user session and the work behind them writes across
 * every client's rows as service_role, so this string IS the security boundary
 * — there is nothing else. Two consequences:
 *
 *   • an unset CRON_SECRET denies everything rather than defaulting open;
 *   • the comparison is constant-time. A timing oracle on a secret that can
 *     rewrite the book is not a theoretical concern, and `timingSafeEqual`
 *     costs nothing here.
 *
 * `timingSafeEqual` throws on a length mismatch — which would itself leak the
 * length — so length is checked separately and something is always compared.
 */
export function authorisedCronRequest(request: Request): boolean {
  return authorisedSharedSecret(request, process.env.CRON_SECRET);
}

/**
 * The same check against any shared secret, for endpoints that are not cron.
 *
 * Split out so a second caller cannot end up with its own hand-rolled compare:
 * the unset-denies-everything rule and the constant-time comparison are the
 * whole security boundary, and they are easy to get subtly wrong twice.
 *
 * Each caller passes its OWN secret rather than reusing `CRON_SECRET`. That
 * one triggers the morning ingest and the P&L recompute; a sibling app that
 * only needs to read a list of ticker codes has no business holding it.
 */
export function authorisedSharedSecret(
  request: Request,
  expected: string | undefined,
): boolean {
  if (!expected) return false;

  // Vercel Cron sends the secret as a bearer token; a manual curl and the
  // sibling dashboards use the same header.
  const provided =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    request.headers.get("x-api-key") ??
    "";

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
