import "server-only";

import { createAdminClient } from "../supabase/admin";
import { selectAll, type AdminDb } from "../import/runner.ts";
import { deskDate } from "../asx/session.ts";
import { scanBook, type OptionScanState, type ScannableOption } from "./scan.ts";
import type { Moneyness } from "../options/moneyness.ts";

/**
 * The half of the alert scanner that touches Supabase.
 *
 * `scan.ts` holds every rule and is pure; this reads the book, hands it over,
 * and writes back what came out. The split is what makes the rules testable
 * without a database and this file short enough to read in one go.
 *
 * ── Why service_role ────────────────────────────────────────────────────────
 * There is no user here. The job runs from cron, and it writes rows for every
 * client at once — which is exactly the case `lib/supabase/admin.ts` exists for
 * and exactly why nothing reached from a page may use that client.
 *
 * ── Why it is safe to run repeatedly ────────────────────────────────────────
 * Every alert carries a key naming the event it reports, and
 * `alerts_client_key_uniq` refuses a second row for the same event. The insert
 * below therefore ignores conflicts rather than failing on them, which makes a
 * rerun a no-op and lets the cron be scheduled as a net rather than a time —
 * the same property the morning ingest gets from its attachment dedupe.
 */

export type AlertScanReport = {
  /** `YYYY-MM-DD` on the desk's clock — the day the scan was taken for. */
  date: string;
  /** Live option rows considered. */
  scanned: number;
  /** Alerts the rules produced, before dedupe. */
  produced: number;
  /** Rows actually written. The rest were events already reported. */
  inserted: number;
};

/**
 * Note on scheduling: this scan runs every day, weekends and exchange holidays
 * included, and does NOT consult `asxSession`.
 *
 * That is deliberate rather than an oversight. An expiry ladder crossing is a
 * calendar event, not a market one — a grant entering its 7-day window on a
 * Saturday should reach the client that morning, so it is waiting for them on
 * Monday rather than a day closer to lapsing. Prices do not move when the
 * market is shut, so a weekend run simply finds no moneyness crossing and
 * inserts nothing.
 *
 * The intraday price-move scan is the one that must ask the session before it
 * does anything, because there the market being open IS the precondition.
 */

type OptionRow = {
  id: string;
  client_id: string;
  code: string;
  listed: boolean;
  option_type: "Call" | "Put" | null;
  qty: number;
  strike: number | null;
  underlying_code: string | null;
  expiry_date: string;
  status: "open" | "pending" | "expired";
};

type StateRow = { option_id: string; moneyness: string; spell: number };

/**
 * The underlying price, from the same column every screen reads.
 *
 * Deliberately `securities.last_price` rather than a live quote feed. An alert
 * that disagrees with the Options tab the client opens ten seconds later is
 * worse than an alert an hour behind: the figure in the alert has to be the
 * figure they can check. The holdings import refreshes this each morning, and
 * the scan is scheduled after it for that reason.
 */
async function lastPrices(db: AdminDb): Promise<Map<string, number | null>> {
  const rows = await selectAll<{ code: string; last_price: number | null }>(
    db,
    "securities",
    "code, last_price",
  );
  return new Map(rows.map((r) => [r.code, r.last_price]));
}

export async function runAlertScan(db: AdminDb = createAdminClient()): Promise<AlertScanReport> {
  const date = deskDate();

  const [options, prices, states] = await Promise.all([
    // `status` is filtered in the query rather than in the scan: an expired
    // grant is the bulk of a long-lived register and there is no rule that
    // applies to one.
    selectAll<OptionRow>(
      db,
      "option_holdings",
      "id, client_id, code, listed, option_type, qty, strike, underlying_code, expiry_date, status",
      (q) => q.eq("status", "open"),
    ),
    lastPrices(db),
    selectAll<StateRow>(db, "alert_scan_state", "option_id, moneyness, spell"),
  ]);

  const prior = new Map<string, OptionScanState>(
    states.map((s) => [s.option_id, { moneyness: s.moneyness as Moneyness, spell: s.spell }]),
  );

  const book: ScannableOption[] = options.map((o) => ({
    id: o.id,
    clientId: o.client_id,
    code: o.code,
    listed: o.listed,
    type: o.option_type,
    qty: o.qty,
    strike: o.strike,
    under: o.underlying_code ? (prices.get(o.underlying_code) ?? null) : null,
    expiryDate: o.expiry_date,
    status: o.status,
  }));

  const { alerts, states: next } = scanBook(book, date, prior);

  let inserted = 0;
  if (alerts.length > 0) {
    /**
     * `ignoreDuplicates` is the whole dedupe contract, and `select()` is how we
     * learn what it did: PostgREST returns only the rows it actually wrote, so
     * the difference between `alerts.length` and this count is the number of
     * events that had already been reported. That number is the one worth
     * watching — a scan that suddenly inserts hundreds is a scan whose keys
     * have stopped being stable.
     */
    const { data, error } = await db
      .from("alerts")
      .upsert(
        alerts.map((a) => ({
          client_id: a.clientId,
          option_id: a.optionId,
          kind: a.kind,
          severity: a.severity,
          title: a.title,
          subtitle: a.subtitle,
          alert_key: a.key,
          acknowledged: false,
        })),
        { onConflict: "client_id,alert_key", ignoreDuplicates: true },
      )
      .select("id");
    if (error) throw error;
    inserted = data?.length ?? 0;
  }

  /**
   * State is written even when nothing alerted, because "it was out of the
   * money yesterday" is exactly what makes tomorrow's crossing detectable.
   * Skipping this on a quiet day would make the first alert after a quiet
   * stretch fire twice.
   */
  if (next.size > 0) {
    const { error } = await db.from("alert_scan_state").upsert(
      [...next].map(([option_id, s]) => ({
        option_id,
        moneyness: s.moneyness,
        spell: s.spell,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: "option_id" },
    );
    if (error) throw error;
  }

  return { date, scanned: book.length, produced: alerts.length, inserted };
}
