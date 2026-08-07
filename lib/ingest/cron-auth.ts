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
  const expected = process.env.CRON_SECRET;
  if (!expected) return false;

  // Vercel Cron sends the secret as a bearer token; a manual curl uses the
  // same header.
  const provided =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
