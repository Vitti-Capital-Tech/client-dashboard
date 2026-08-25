// Recompute one account's P&L and store it.
// ----------------------------------------------------------------------------
// This is the pipeline the P&L Calculator page runs, driven from the database
// instead of an uploaded file, with the result written to `pnl_summary`:
//
//   trades → aggregate → merge Placement Trackers → value open positions off
//   the holdings snapshot → price unlisted placement options → persist
//
// Every stage is the calculator's own function. Nothing about the maths is
// reimplemented here; see lib/pnl/from-db.ts for why that matters.
//
// ── Why the expensive inputs are injected ────────────────────────────────────
// Parsing the Placement Tracker workbooks costs ~48s on a cold cache and spot
// prices are a network round trip. Both are IDENTICAL across every account in a
// morning batch, so this function refuses to fetch them itself: the caller
// resolves each once and passes it in. Doing it per account would turn a
// two-minute batch into an overnight one.
//
// It also makes the whole thing testable — a fake spot fetcher and a literal
// placement map are all a test needs.

import {
  aggregateTradesToSummary,
  buildUnlistedOptionRows,
  collectUnlistedOptionTickers,
  mergeDbHoldingsIntoSummary,
  mergePlacementTrackerIntoSummary,
  sumPnl,
  isBuySideUnknown,
  type PlacementTickerInfo,
  type PnlSummaryItem,
  type SpotSource,
} from "../pnl-calculator.ts";
import { upsertChunked, type AdminDb } from "../import/runner.ts";
import { isNonClientAccount } from "../import/normalize.ts";
import {
  loadAccountHolders,
  loadCalculatorTrades,
  loadDbHoldings,
  type SecurityCatalogue,
} from "./from-db.ts";

/** Bump when the maths changes, so an old row is never compared to a new one. */
export const ENGINE_VERSION = "v1";

export type SpotPriceMap = Map<string, { price: number; source: SpotSource }>;

/** Resolves live spot prices for the unlisted options that need one. */
export type SpotFetcher = (tickers: string[]) => Promise<SpotPriceMap>;

export type RecomputeOptions = {
  /**
   * Parsed Placement Trackers, combined into one map. Pass `null` for "no
   * placements" — the buy side of a placement row then stays as the ledger has
   * it, and no free-option rows are generated.
   */
  placements?: Map<string, PlacementTickerInfo> | null;
  /** Omit to skip option pricing entirely (rows are still built, valued at 0). */
  fetchSpots?: SpotFetcher;
  /**
   * The security catalogue, resolved once by the caller.
   *
   * Third of the shared inputs, and the one that was missing. Omitted, the two
   * loaders below each read the whole `securities` table themselves — which in
   * a batch is that table read twice per account.
   */
  securities?: SecurityCatalogue;
  /** What caused this run: 'ingest' | 'manual' | 'backfill'. */
  trigger?: string;
  /** Groups the per-account runs of a single trigger. */
  batchId?: string | null;
  /** Injected so a test can pin option time-to-expiry. */
  now?: Date;
  /**
   * Compute and return the rows WITHOUT writing them.
   *
   * For checking the engine against the P&L Calculator before trusting it with
   * the stored figures: a recompute is a wholesale replace of an account's
   * `pnl_summary`, so verifying by running it is exactly the thing you cannot
   * do if you want the previous numbers still there afterwards. No `pnl_runs`
   * row is written either — a run nobody can point a stored row at is noise in
   * the audit trail.
   */
  dryRun?: boolean;
};

export type RecomputeResult = {
  accountId: string;
  /** Null on a dry run — nothing was recorded to point at. */
  runId: string | null;
  rows: PnlSummaryItem[];
  totalPnl: number;
  warnings: string[];
  /**
   * Rows whose buy side a placement could have filled and did not, because no
   * participant in the sheet resolved to this account holder.
   *
   * Carried as a NUMBER rather than left inside `warnings` so a caller can add
   * it up. After a rebuild of every account the warnings live one-per-run in
   * `pnl_runs`, which means "who still needs an alias" costs opening fifty
   * client profiles — the one question the operator has right then.
   * `clients.placement_aliases` (§8.23) is the fix, `npm run suggest:aliases`
   * finds the candidates.
   */
  unfilledPlacements: number;
  /** False when this was a dry run. */
  persisted: boolean;
};

/**
 * Rebuild and store the P&L for a single account.
 *
 * Always the LIFETIME view: no reporting window. A stored figure has to mean
 * one thing, and `pnl_summary` is keyed by (account, ticker) with nowhere to
 * record which period a row belongs to. Windowed views stay ad-hoc on the
 * calculator page, where the desk can see the dates it picked.
 */
export async function recomputeAccountPnl(
  db: AdminDb,
  accountId: string,
  opts: RecomputeOptions = {},
): Promise<RecomputeResult> {
  const {
    placements = null,
    fetchSpots,
    securities,
    trigger = "manual",
    batchId = null,
    dryRun = false,
  } = opts;
  const now = opts.now ?? new Date();
  const warnings: string[] = [];
  let unfilledPlacements = 0;

  const accountIds = [accountId];

  const [loaded, holdings, holders] = await Promise.all([
    loadCalculatorTrades(db, accountIds, securities),
    loadDbHoldings(db, accountIds, new Map(), securities),
    loadAccountHolders(db, accountIds),
  ]);

  const clientId = loaded.clientIdByAccountId.get(accountId);
  if (!clientId) {
    throw new Error(`Account ${accountId} has no client — cannot store its P&L.`);
  }

  // 1. The ledger.
  let { summary } = aggregateTradesToSummary(loaded.trades);

  // 2. Placement Trackers fill the buy side of a placement the contract notes
  //    never recorded, matched to THIS account holder's allocation rows.
  if (placements && placements.size > 0) {
    // `soleParticipantFallback: false` — this runs unattended over EVERY client
    // against one tracker, and the hints came from the database rather than a
    // filename. So "the only name in this sheet is not this client" is evidence,
    // not a spelling accident: filling from it would store a stranger's parcel on
    // this client's row, where nothing downstream could tell it apart from a real
    // figure. The calculator page keeps the fallback, because there a human
    // uploaded one client's ledger and is watching the result.
    const merged = mergePlacementTrackerIntoSummary(summary, placements, holders, {
      soleParticipantFallback: false,
    });
    summary = merged.summary;

    /**
     * The broker's suspense and house placement accounts are not clients, so a
     * tracker's participant list will never name them — that is what those
     * accounts ARE, not a spelling problem someone can fix.
     *
     * Reporting them anyway made the message useless where it matters: the house
     * account holds parcels on their way out to clients, so almost every ticker
     * has a buy side the contract notes never recorded, and one profile listed
     * 134 tickers "left unfilled". An alias is the documented remedy and is the
     * one thing that must NOT be applied here — filling from a participant row
     * would store a real client's parcel against the house account.
     */
    const houseAccount = holders.some(isNonClientAccount);

    unfilledPlacements = houseAccount ? 0 : merged.ambiguousTickers.length;

    if (!houseAccount && merged.ambiguousTickers.length > 0) {
      // Only rows a placement could actually have completed reach this list — a
      // holding bought on-market in a stock that was placed to other people is
      // not a problem and is no longer reported as one. So what is left is a
      // real gap, and it has one usual cause worth naming: the tracker spells
      // the account holder differently from `clients.display_name`.
      warnings.push(
        `${merged.ambiguousTickers.length} ticker(s) have an incomplete buy side that a ` +
          `placement could have filled, but the sheet lists several account holders and ` +
          `none matched ${holders.join(", ") || "this account"} — check how the tracker ` +
          `spells the name: ` +
          merged.ambiguousTickers.join(", "),
      );
    }
    if (merged.unresolvedYearTickers.length > 0) {
      warnings.push(
        `${merged.unresolvedYearTickers.length} ticker(s) appear in more than one tracker ` +
          `year and the trade dates match none of them, so nothing was filled: ` +
          merged.unresolvedYearTickers.join(", "),
      );
    }
  }

  // 3. Open positions are marked to the holdings snapshot.
  //
  //    `createMissingRowsFor` is deliberately OMITTED, which lets any holding
  //    invent a row. That is correct precisely because this is the lifetime
  //    view: the snapshot carries no date, so restricting it only matters when
  //    a reporting period exists for a position to land on the wrong side of.
  //    A free attaching option — never bought, so no contract note names it —
  //    exists only here, and would otherwise vanish from the client's P&L.
  if (holdings.length > 0) {
    const merged = mergeDbHoldingsIntoSummary(summary, holdings);
    summary = merged.summary;
  }

  // 4. Free unlisted placement options. Nothing is ever paid for these, so the
  //    whole modelled value is P&L — which is exactly why the inputs behind the
  //    price are stored alongside the row.
  if (placements && placements.size > 0) {
    const tickers = collectUnlistedOptionTickers(summary, placements);
    if (tickers.length > 0) {
      const spots: SpotPriceMap = fetchSpots
        ? await fetchSpots(tickers)
        : new Map();

      const built = buildUnlistedOptionRows(summary, placements, spots, now);
      summary = built.summary;

      if (built.skipped.length > 0) {
        warnings.push(
          `No spot price for ${built.skipped.join(", ")} — those option lines are ` +
            `valued at $0 until a quote is available.`,
        );
      }
      if (built.unresolvedPiggybacks.length > 0) {
        warnings.push(
          `Skipped ${built.unresolvedPiggybacks.length} piggyback grant(s) with no base ` +
            `tranche to compute from: ${built.unresolvedPiggybacks.join("; ")}`,
        );
      }

      const stale = [...spots.values()].filter((s) => s.source === "database").length;
      if (stale > 0) {
        warnings.push(
          `${stale} option(s) priced from the last holdings snapshot rather than a live ` +
            `feed — as stale as the last import.`,
        );
      }
    }
  }

  // A row whose buy side is unknown is deliberately left OUT of the total: a
  // blank cannot be summed, and treating it as zero would report the entire
  // sale proceeds as profit.
  const totalPnl = sumPnl(summary);

  const unknownBuy = summary.filter(isBuySideUnknown).length;
  if (unknownBuy > 0) {
    warnings.push(
      `${unknownBuy} row(s) have an unknown buy side and are excluded from the total.`,
    );
  }

  if (dryRun) {
    return {
      accountId,
      runId: null,
      rows: summary,
      totalPnl,
      warnings,
      unfilledPlacements,
      persisted: false,
    };
  }

  const runId = await persist(db, {
    accountId,
    clientId,
    summary,
    totalPnl,
    warnings,
    trigger,
    batchId,
    now,
    placementCount: placements?.size ?? 0,
  });

  return {
    accountId,
    runId,
    rows: summary,
    totalPnl,
    warnings,
    unfilledPlacements,
    persisted: true,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function persist(
  db: AdminDb,
  args: {
    accountId: string;
    clientId: string;
    summary: PnlSummaryItem[];
    totalPnl: number;
    warnings: string[];
    trigger: string;
    batchId: string | null;
    now: Date;
    placementCount: number;
  },
): Promise<string> {
  const computedAt = args.now.toISOString();

  const { data: runRows, error: runErr } = await db
    .from("pnl_runs")
    .insert({
      account_id: args.accountId,
      client_id: args.clientId,
      batch_id: args.batchId,
      trigger: args.trigger,
      computed_at: computedAt,
      total_pnl: round2(args.totalPnl),
      row_count: args.summary.length,
      sources: {
        placementTickers: args.placementCount,
        spotSources: spotSourceTally(args.summary),
      },
      warnings: args.warnings,
      engine_version: ENGINE_VERSION,
    })
    .select("id");
  if (runErr) throw runErr;

  const runId = ((runRows ?? []) as unknown as { id: string }[])[0]?.id;
  if (!runId) throw new Error("pnl_runs insert returned no id — nothing to attach rows to.");

  // Replace, not merge. A ticker that has dropped out of both the ledger and
  // the snapshot must disappear from the stored P&L too — leaving it behind
  // would keep a position on the client's page that they no longer hold.
  const { error: purgeErr } = await db
    .from("pnl_summary")
    .delete()
    .eq("account_id", args.accountId);
  if (purgeErr) throw purgeErr;

  if (args.summary.length === 0) return runId;

  await upsertChunked(
    db,
    "pnl_summary",
    args.summary.map((s) => {
      const isOpt = Boolean(
        s.isOption ||
        s.isUnlistedOption ||
        s.ticker.endsWith("-UO") ||
        (s.instrument && s.instrument.toLowerCase().includes("option"))
      );
      const optQty = isOpt ? (s.sellQty || s.buyQty || Math.abs(s.openQty)) : 0;
      const bQty = isOpt && s.buyQty === 0 && optQty > 0 ? optQty : s.buyQty;
      const sQty = isOpt && s.sellQty === 0 && optQty > 0 ? optQty : s.sellQty;

      return {
        account_id: args.accountId,
        client_id: args.clientId,
        ticker: s.ticker,
        run_id: runId,
        parent_ticker: s.parentTicker ?? null,
        company: s.company ?? "",
        instrument: s.instrument ?? null,
        buy_qty: bQty,
        sell_qty: sQty,
        open_qty: isOpt ? 0 : s.openQty,
        buy_price: round2(s.buyPrice),
        sell_price: round2(s.sellPrice),
        pnl: round2(s.pnlCalculated),
        trade_count: s.tradeCount,
        is_matched: Boolean(isOpt ? (bQty > 0 && bQty === sQty) : s.isMatched),
        is_option: Boolean(s.isOption),
        is_enriched: Boolean(s.isEnriched),
        is_db_market_valued: Boolean(s.isDbMarketValued),
        is_db_open_valued: Boolean(s.isDbOpenValued),
        is_db_only: Boolean(s.isDbOnly),
        is_partial_exit: Boolean(s.isPartialExit),
        is_partial_buy: Boolean(s.isPartialBuy),
        // "Checked, and the client holds none of it" — see the migration. An
        // account with no snapshot at all never reaches the merge, so every row
        // stores `false` and keeps being judged on its quantities alone.
        not_in_holdings: Boolean(s.notInHoldings),
        is_unlisted_option: Boolean(s.isUnlistedOption),
        placement_year_unresolved: Boolean(s.placementYearUnresolved),
        placement_year_note: s.placementYearNote ?? null,
        buy_side_unknown: isBuySideUnknown(s),
        unlisted_option: s.unlistedOption ?? null,
        comment: s.comment ?? null,
        computed_at: computedAt,
      };
    }),
    { onConflict: "account_id,ticker" },
  );

  return runId;
}

/** How many option prices came from each source — provenance for the run. */
function spotSourceTally(summary: PnlSummaryItem[]): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const s of summary) {
    const source = s.unlistedOption?.spotSource;
    if (source) tally[source] = (tally[source] ?? 0) + 1;
  }
  return tally;
}

const round2 = (v: number): number => Math.round(v * 100) / 100;
