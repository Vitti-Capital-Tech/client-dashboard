import "server-only";

import { createAdminClient } from "../supabase/admin";
import { selectAll, type AdminDb } from "../import/runner.ts";
import { deskDate } from "../asx/session.ts";
import { toStoredPnlRow, type PnlSummaryDbRow } from "../data/pnl";
import {
  optionsFromSources,
  withLiveSpots,
  type OptionTableItem,
} from "../options/from-stored-pnl";
import { scanBook, type OptionScanState, type ScannableOption } from "./scan.ts";
import type { Moneyness } from "../options/moneyness.ts";

/**
 * The half of the alert scanner that touches Supabase.
 *
 * `scan.ts` holds every rule and is pure; this reads the book, hands it over,
 * and writes back what came out.
 *
 * ── Where the options come from, and the mistake that was here first ────────
 * This first read `option_holdings` — the table whose name says it holds
 * options — and its first production run reported `scanned: 0` against a book
 * of 33 series with one of them in the money.
 *
 * `option_holdings` has never held a row. It was demo-seed data; nothing in the
 * broker import or the Placement Tracker pipeline writes it, and LLD §8.33
 * records the same discovery being made the first time, when the client Options
 * tab was empty for every client. Both screens were moved onto `pnl_summary`
 * then, through `lib/options/from-stored-pnl.ts`.
 *
 * The scanner now reads what the screens read, through the same function. That
 * is not a tidiness argument: an alert that quotes a strike the client's own
 * Options tab does not show is worse than no alert, and the only way to
 * guarantee they agree is to derive both from one place.
 *
 * ── Why service_role ────────────────────────────────────────────────────────
 * There is no user here. The job runs from cron and writes rows for every
 * client at once — the case `lib/supabase/admin.ts` exists for, and the reason
 * nothing reached from a page may use that client.
 *
 * ── Why it is safe to run repeatedly ────────────────────────────────────────
 * Every alert carries a key naming the event it reports, and
 * `alerts_client_key_uniq` refuses a second row for the same event. The insert
 * ignores conflicts rather than failing on them, so a rerun is a no-op — which
 * is what lets the cron be a net rather than a time, exactly as the morning
 * ingest's attachment dedupe does.
 *
 * ── Scheduling ──────────────────────────────────────────────────────────────
 * This runs every day, weekends and exchange holidays included, and does not
 * consult `asxSession`. An expiry ladder crossing is a CALENDAR event: a grant
 * entering its 7-day window on a Saturday should reach the client that morning
 * and be waiting on Monday, not be reported two days closer to lapsing. Prices
 * do not move when the market is shut, so a weekend run finds no moneyness
 * crossing and inserts nothing.
 */

export type AlertScanReport = {
  /** `YYYY-MM-DD` on the desk's clock — the day the scan was taken for. */
  date: string;
  /** Option-register rows read, of which `live` were eligible. */
  register: number;
  live: number;
  /** Alerts the rules produced, before dedupe. */
  produced: number;
  /** Rows actually written. The rest were events already reported. */
  inserted: number;
};

type OptionHoldingRow = {
  id: string;
  account_id: string | null;
  client_id: string;
  ref: string | null;
  code: string;
  name: string;
  listed: boolean;
  option_type: "Call" | "Put" | null;
  qty: number;
  strike: number;
  underlying_code: string | null;
  expiry_date: string;
  source: string | null;
  status: "open" | "pending" | "expired";
};

type StateRow = { option_key: string; moneyness: string; spell: number; in_spell: boolean };

/**
 * The register row, as the scan rules want it.
 *
 * `OptionTableItem.status` is the register's vocabulary — live / expired /
 * exercised / pending — and `ScannableOption.status` is the database enum. Only
 * `live` is a position worth warning about, so everything else collapses to
 * `expired`: an exercised grant has been acted on, and a pending one is not yet
 * a holding.
 */
function toScannable(o: OptionTableItem): ScannableOption | null {
  // A row with no expiry has no window to close and no ladder to climb. The
  // terms could not be read (see `parseExpiry`), and guessing one would put a
  // wrong exercise window in front of a client.
  if (!o.expiryDate) return null;

  return {
    id: o.id,
    clientId: o.clientId,
    code: o.ticker,
    listed: o.isListed,
    // The register carries no put/call flag; placement grants are calls, which
    // is what `moneynessOf` assumes when it is not told otherwise.
    type: "Call",
    qty: o.quantity,
    strike: o.strike,
    under: o.underlyingPrice,
    expiryDate: o.expiryDate,
    status: o.status === "live" ? "open" : "expired",
  };
}

export async function runAlertScan(db: AdminDb = createAdminClient()): Promise<AlertScanReport> {
  const date = deskDate();

  const [pnlRows, holdingRows, states, securities] = await Promise.all([
    selectAll<PnlSummaryDbRow>(db, "pnl_summary", "*"),
    selectAll<OptionHoldingRow>(db, "option_holdings", "*"),
    selectAll<StateRow>(db, "alert_scan_state", "option_key, moneyness, spell, in_spell"),
    selectAll<{ code: string; last_price: number | null }>(db, "securities", "code, last_price"),
  ]);

  const prices = new Map(securities.map((s) => [s.code, s.last_price]));

  /**
   * The register, exactly as the screens build it, then repriced.
   *
   * `withLiveSpots` puts `securities.last_price` over the spot frozen into
   * `pnl_summary` at the morning recompute — the same overlay the Options page
   * applies, so the alert quotes the figure the client will see. Without it no
   * intraday crossing is detectable however often this runs, because the input
   * would not be changing.
   *
   * `option_holdings` is still read, empty as it is, for the reason the Options
   * page gives: anything ever entered there should show up rather than be
   * silently dropped. Its `dte` is left at 0 because nothing downstream reads
   * it — the scan recomputes days from `expiryDate` against the desk's date, so
   * a second countdown here would only be a second chance to be wrong.
   */
  const register = withLiveSpots(
    optionsFromSources(
      pnlRows.map(toStoredPnlRow),
      holdingRows.map((o) => ({
        id: o.id,
        ref: o.ref,
        accountId: o.account_id,
        clientId: o.client_id,
        code: o.code,
        name: o.name,
        listed: o.listed,
        type: o.option_type ?? "Call",
        qty: o.qty,
        strike: o.strike,
        under: 0,
        dte: 0,
        expiryDate: o.expiry_date,
        source: o.source,
        status: o.status,
      })),
    ),
    prices,
  );

  const book = register
    .map(toScannable)
    .filter((o): o is ScannableOption => o !== null && o.status === "open");

  const prior = new Map<string, OptionScanState>(
    states.map((s) => [
      s.option_key,
      { moneyness: s.moneyness as Moneyness, spell: s.spell, inSpell: s.in_spell },
    ]),
  );

  const { alerts, states: next } = scanBook(book, date, prior);

  let inserted = 0;
  if (alerts.length > 0) {
    /**
     * `ignoreDuplicates` is the dedupe contract and `select()` is how we learn
     * what it did: PostgREST returns only the rows actually written, so the gap
     * between `produced` and `inserted` is the number of events already
     * reported. That gap is the number to watch — a scan suddenly inserting
     * hundreds is a scan whose keys have stopped being stable.
     *
     * `option_id` is left unset. It is a uuid foreign key to `option_holdings`,
     * and these rows are identified by a derived register key instead; nothing
     * in the UI reads the column, and the alert's identity is `alert_key`.
     */
    const { data, error } = await db
      .from("alerts")
      .upsert(
        alerts.map((a) => ({
          client_id: a.clientId,
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
   * State is written even on a silent run, because "it was out of the money
   * yesterday" is exactly what makes tomorrow's crossing detectable. Skipping
   * it on a quiet day would make the first alert after a quiet stretch fire
   * twice.
   */
  if (next.size > 0) {
    const { error } = await db.from("alert_scan_state").upsert(
      [...next].map(([option_key, s]) => ({
        option_key,
        moneyness: s.moneyness,
        spell: s.spell,
        in_spell: s.inSpell,
        updated_at: new Date().toISOString(),
      })),
      { onConflict: "option_key" },
    );
    if (error) throw error;
  }

  return { date, register: register.length, live: book.length, produced: alerts.length, inserted };
}
