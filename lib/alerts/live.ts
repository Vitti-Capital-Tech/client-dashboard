import "server-only";

import { createAdminClient } from "../supabase/admin";
import { selectAll, type AdminDb } from "../import/runner.ts";
import { asxSession, deskDate } from "../asx/session.ts";
import { getQuotes, type Quote } from "../asx/quotes";
import { movesForBook, type HeldPosition } from "./moves.ts";
import { runAlertScan, type AlertScanReport } from "./run";

/**
 * The intraday tick: fresh prices, then everything that depends on them.
 *
 * ── The problem this solves ─────────────────────────────────────────────────
 * The daily scan (`run.ts`) reads the underlying price out of `pnl_summary`,
 * where it was written at the last P&L recompute — once a morning. That is fine
 * for an expiry ladder, which moves on the calendar, and useless for a
 * moneyness crossing, which moves on the market. Scanning more often changed
 * nothing, because the INPUT was not changing: the same frozen spot, re-read
 * every five minutes, produces the same verdict forever.
 *
 * So the fix is not a faster scan. It is a fresh price.
 *
 * ── Why the price is written back ───────────────────────────────────────────
 * The obvious version fetches quotes, computes moneyness against them, and
 * alerts. It also creates a portal where the alert says the underlying is $0.82
 * and the client opens their Options tab ten seconds later and reads $0.78 —
 * because the screen is still on the morning's number. An alert whose figure
 * cannot be checked is worse than no alert.
 *
 * So the tick writes what it fetched into `securities.last_price` FIRST, and
 * everything downstream — this job, the screens — reads that one column. One
 * price, one answer, and the discrepancy cannot arise because there is only
 * ever one number.
 *
 * ── Why it stops dead when the market is shut ───────────────────────────────
 * `asxSession` is asked before anything else. Outside trading hours there is no
 * new price to fetch, so a run would spend a Yahoo request and a database write
 * to rediscover this morning's close. Weekends, public holidays, the two half
 * days and every night are all covered by the one check — which is the whole
 * reason that module knows the trading calendar.
 *
 * This is exactly the opposite of `run.ts`'s scheduling and for a reason worth
 * keeping straight: an expiry crossing is a CALENDAR event and must be found on
 * a Saturday; a price crossing is a MARKET event and cannot happen on one.
 */

export type LiveTickReport = {
  date: string;
  phase: string;
  /** Set, with everything else zero, when the market was shut. */
  skipped: boolean;
  /** Distinct codes we asked the feed about. */
  requested: number;
  /**
   * Distinct codes it answered for.
   *
   * Reported next to `requested` on purpose. `quoted: 0` alone is the same
   * number whether the feed refused the request or the book is empty, and the
   * first version reported exactly that for three days while the quote call was
   * failing — a silence indistinguishable from calm, which is the failure shape
   * this codebase keeps producing (§8.42, §8.51, §8.52). A `requested` well
   * above `quoted` is the feed being down; both zero is a book with nothing in
   * it.
   */
  quoted: number;
  /** `securities.last_price` rows updated. */
  pricesWritten: number;
  /** Move alerts produced / written. */
  movesProduced: number;
  movesInserted: number;
  /** The option scan, re-run against the fresh prices. */
  options: AlertScanReport | null;
};

type PositionRow = { client_id: string; security_code: string; qty: number };
/**
 * `name` is selected even though nothing here reads it.
 *
 * `securities.name` is NOT NULL with no default, and PostgREST's upsert is an
 * INSERT … ON CONFLICT DO UPDATE — so the tuple has to be valid as an insert
 * even when every row is certain to conflict. Sending only `{code, last_price}`
 * raises a not-null violation and fails the whole batch, which is a failure
 * mode that only appears against a real database.
 */
type SecurityRow = { code: string; name: string; last_price: number | null };

/**
 * Every code worth a quote: what clients hold, plus the underlyings of the
 * options register.
 *
 * `securities` is the union of both by construction — the holdings import
 * writes a row per code it sees — so one read covers it, and quoting a code
 * nobody holds costs nothing but is pointless. Positions are the filter.
 */
async function codesToQuote(db: AdminDb): Promise<{ codes: string[]; positions: PositionRow[] }> {
  const positions = await selectAll<PositionRow>(db, "positions", "client_id, security_code, qty");
  const codes = [...new Set(positions.map((p) => p.security_code).filter(Boolean))];
  return { codes, positions };
}

export async function runLiveTick(db: AdminDb = createAdminClient()): Promise<LiveTickReport> {
  const session = asxSession();
  const date = deskDate();

  const idle: LiveTickReport = {
    date,
    phase: session.phase,
    skipped: true,
    requested: 0,
    quoted: 0,
    pricesWritten: 0,
    movesProduced: 0,
    movesInserted: 0,
    options: null,
  };

  // The closing auction is included: the last price of the day is struck in it,
  // and a grant that crosses on the close is a crossing like any other.
  if (session.phase !== "open" && session.phase !== "closing-auction") return idle;

  const { codes, positions } = await codesToQuote(db);
  if (codes.length === 0) return { ...idle, skipped: false };

  const quotes = await getQuotes(codes);
  if (quotes.size === 0) {
    // The feed is rate-limited or down. `getQuotes` logs which batches failed
    // and returns what it has rather than throwing; carrying on with nothing
    // would mean scanning against prices we did not refresh and calling that a
    // live tick. `requested` is carried out so the response says which of the
    // two zeroes this is.
    return { ...idle, skipped: false, requested: codes.length };
  }

  /**
   * Write the prices before anything reads them.
   *
   * Only where the value actually changed — an intraday tick on a thinly traded
   * register would otherwise rewrite hundreds of identical rows every ten
   * minutes and bump `updated_at` on all of them, which makes the column
   * useless for telling when a price last moved.
   */
  const existing = await selectAll<SecurityRow>(db, "securities", "code, name, last_price");
  const known = new Map(existing.map((s) => [s.code, s]));
  const struckAt = new Date().toISOString();

  const changed: { code: string; name: string; last_price: number; last_price_at: string }[] = [];
  for (const [code, q] of quotes) {
    if (q.last === null) continue;
    const row = known.get(code);
    if (!row) continue; // not a security we track; nothing to update
    if (row.last_price === q.last) continue;
    // `last_price_at` is what makes a stale price visible. Without it a feed
    // that quietly stopped returning quotes looks exactly like a quiet market.
    changed.push({ code, name: row.name, last_price: q.last, last_price_at: struckAt });
  }

  if (changed.length > 0) {
    const { error } = await db.from("securities").upsert(changed, { onConflict: "code" });
    if (error) throw error;
  }

  /* ─────────────────────────── moves on holdings ─────────────────────────── */

  const held: HeldPosition[] = positions.map((p) => {
    const q: Quote | undefined = quotes.get(p.security_code);
    return {
      clientId: p.client_id,
      code: p.security_code,
      qty: p.qty,
      last: q?.last ?? null,
      changePct: q?.changePct ?? null,
    };
  });

  const moves = movesForBook(held, date);
  let movesInserted = 0;
  if (moves.length > 0) {
    const { data, error } = await db
      .from("alerts")
      .upsert(
        moves.map((m) => ({
          client_id: m.clientId,
          kind: m.kind,
          severity: m.severity,
          title: m.title,
          subtitle: m.subtitle,
          alert_key: m.key,
          acknowledged: false,
        })),
        { onConflict: "client_id,alert_key", ignoreDuplicates: true },
      )
      .select("id");
    if (error) throw error;
    movesInserted = data?.length ?? 0;
  }

  /* ───────────────────── the option scan, on fresh prices ─────────────────── */

  /**
   * Re-run in the same request, deliberately.
   *
   * The prices it will read were written seconds ago by the block above, so the
   * alert and the screen quote the same number from the same instant. Running
   * it on its own schedule instead would reintroduce the gap this whole file
   * exists to close.
   *
   * It is cheap to repeat: every alert it can produce carries a key naming the
   * event, so the ninety-ninth tick of the day inserts nothing.
   */
  const options = await runAlertScan(db);

  return {
    date,
    phase: session.phase,
    skipped: false,
    requested: codes.length,
    quoted: quotes.size,
    pricesWritten: changed.length,
    movesProduced: moves.length,
    movesInserted,
    options,
  };
}
