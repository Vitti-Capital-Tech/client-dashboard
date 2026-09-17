import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { pagedSelect } from "@/lib/data/paged";
import { authorisedSharedSecret } from "@/lib/ingest/cron-auth";

/**
 * The set of ASX codes the firm's clients actually hold.
 *
 * Read by the ASX Intelligence dashboard, which filters each trading day's
 * announcements down to this list — the reverse of the flow already in place,
 * where this app reads that one's `/api/market-sensitive` (see `lib/asx/news.ts`).
 *
 * ── Codes, and nothing else ────────────────────────────────────────────────
 * The response is a flat list of tickers. No client ids, no names, no
 * quantities, no costs. That is not a simplification of a richer payload for
 * convenience — it is the point. The consumer's question is "is there news on
 * anything we hold today", which a set of codes answers completely, and a
 * dashboard with a different auth model should not be able to learn who holds
 * what from an endpoint that never needed to say. Anyone adding `client_id`
 * here should move this behind a session first.
 *
 * ── Why service_role ───────────────────────────────────────────────────────
 * There is no user to act as: the caller is another server, and the question
 * spans every client's rows by design. The shared secret below is therefore the
 * entire boundary, which is why it is compared in constant time and why an
 * unset key denies rather than defaults open.
 *
 *   curl -H "Authorization: Bearer $HOLDINGS_API_KEY" https://<host>/api/holdings/codes
 */

export const dynamic = "force-dynamic";

/** Both sources of a held ASX code. Options are included because a client with
 *  calls over a stock cares about that stock's announcements exactly as much as
 *  a holder of the shares — the table is empty today, and would have been a
 *  silent gap the first time it is not. */
type PositionRow = { security_code: string | null };
type OptionRow = { underlying_code: string | null };

/**
 * The code an ASX announcement would be filed under, or null if there is none.
 *
 * An ASX ticker is three characters; anything longer in the register is a
 * listed option — `HYDOC` is "HYDRIX LIMITED - OPTION 30-JUN-29" — whose series
 * suffix follows the three-character underlying. The company files under `HYD`,
 * and a client holding the option cares about those filings exactly as much as
 * a holder of the shares, so the code is cut back to the underlying. All 43
 * long codes in the register today are options, and none is a four-character
 * ETF code, which is the only case this rule would mis-cut.
 *
 * Foreign listings are the exception and are dropped rather than cut. Their
 * codes carry an exchange suffix — `RKLB:NAS`, `KRI:TSXV` — and the company
 * does not file with the ASX at all, so cutting one down to `RKL` could only
 * ever produce a FALSE match against an unrelated ASX company. Nothing is lost:
 * an ASX feed was never going to carry Rocket Lab's news.
 */
function asxCodeFor(code: string): string | null {
  const c = code.trim().toUpperCase();
  if (!c || c.includes(":")) return null;
  return c.length > 3 ? c.slice(0, 3) : c;
}

export async function GET(request: Request) {
  if (!authorisedSharedSecret(request, process.env.HOLDINGS_API_KEY)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  try {
    const db = createAdminClient();

    // Paged, not a plain select: PostgREST stops at 1,000 rows and says
    // nothing about it. 307 positions today, but a list that silently loses
    // its tail as the book grows is the bug this codebase has already had.
    const [positions, options] = await Promise.all([
      pagedSelect<PositionRow>(db, "positions", "security_code"),
      pagedSelect<OptionRow>(db, "option_holdings", "underlying_code", (q) =>
        q.eq("status", "open"),
      ),
    ]);

    const held = new Set<string>();
    for (const r of positions) {
      const c = r.security_code?.trim().toUpperCase();
      if (c) held.add(c);
    }
    // An option holding already names its underlying, so it needs no resolving.
    const resolved = new Set<string>();
    for (const r of options) {
      const c = r.underlying_code?.trim().toUpperCase();
      if (c) resolved.add(c);
    }

    for (const c of held) {
      const asx = asxCodeFor(c);
      if (asx) resolved.add(asx);
    }

    return NextResponse.json(
      {
        generated_at: new Date().toISOString(),
        count: resolved.size,
        codes: [...resolved].sort(),
        // What the resolution did, so a caller comparing this against the
        // register's own row count is not left wondering where rows went.
        held_rows: held.size,
      },
      // Held codes change when the morning import lands, not between requests.
      // A minute of cache absorbs a reader refreshing the tab without letting
      // the list go stale across the trading day.
      { headers: { "cache-control": "private, max-age=60" } },
    );
  } catch (err) {
    console.error("[holdings/codes]", err);
    // 503, not 500: nothing here is broken, the database it needs is not
    // reachable. The consumer treats any failure as an empty list and says so
    // on screen rather than showing an unfiltered feed as if it were filtered.
    return NextResponse.json(
      { error: "Holdings unavailable" },
      { status: 503 },
    );
  }
}
