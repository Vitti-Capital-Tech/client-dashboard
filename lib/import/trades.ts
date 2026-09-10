import { parseCsvRecords, requireHeaders, type CsvRow } from "./csv.ts";
import {
  isContractNotesListing,
  normaliseContractNotesRow,
} from "./trade-formats.ts";
import {
  clean,
  cleanOrNull,
  isOptionCode,
  money,
  num,
  numOrNull,
  parentCode,
  parseTradeDate,
} from "./normalize.ts";

/**
 * Trade ledger (contract notes) — parsing and the realized-P&L reducer.
 *
 * Columns in the broker export:
 *   CNote, Account, Type, Security, Company, Description, Contract Date,
 *   Adviser, Units, Avg Price, Consideration, Brokerage, Other Charges, GST,
 *   Value, Brokerage %, Status
 */

/**
 * Exported because these columns are also how a file is IDENTIFIED as a trade
 * ledger — see `detectCsvKind`. Filenames are a broker's convention and change
 * without notice; the column set is the shape itself.
 */
export const TRADE_REQUIRED_HEADERS = [
  "CNote",
  "Account",
  "Type",
  "Security",
  "Company",
  "Contract Date",
  "Units",
  "Value",
  "Status",
] as const;

const REQUIRED = TRADE_REQUIRED_HEADERS;

/** Only settled trades count. CANCELLED / REVERSAL / REVERSED never happened. */
export const SETTLED = "SETTLED";

export type TradeSide = "BUY" | "SELL";

export type ParsedTrade = {
  cnote: string;
  accountRef: string;
  /**
   * The account holder as the ledger names them.
   *
   * Carried because the ledger is sometimes the ONLY place an account appears:
   * a client who has sold everything has no holdings row, so the snapshot —
   * which normally creates accounts — never mentions them. Without this the
   * importer could only refuse their trades.
   */
  accountName: string;
  side: TradeSide;
  rawSecurity: string;
  parent: string;
  company: string;
  instrument: string | null;
  tradeDate: string; // ISO yyyy-mm-dd
  units: number;
  avgPrice: number;
  consideration: number;
  brokerage: number;
  otherCharges: number;
  gst: number;
  value: number;
  brokeragePct: number | null;
  adviser: string | null;
  status: string;
};

export type RowError = { line: number; reason: string; row: CsvRow };

export function parseTradeCsv(text: string): {
  trades: ParsedTrade[];
  errors: RowError[];
} {
  const { headers, rows: rawRows } = parseCsvRecords(text);

  // The broker sends this ledger in two shapes. The scheduled mail carries
  // `ContractNotesListing`, whose columns hold the same data under different
  // names and different encodings; `trade-formats.ts` rewrites it into the one
  // shape everything below understands. See that file for each decision.
  const rows = isContractNotesListing(headers)
    ? rawRows.map(normaliseContractNotesRow)
    : rawRows;

  // Checked against the ORIGINAL headers when the file is already canonical,
  // and skipped when it has just been normalised — the normaliser guarantees
  // the columns exist, and re-deriving a header list from rewritten rows would
  // only be able to confirm its own work.
  if (rows === rawRows) requireHeaders(headers, REQUIRED);

  const trades: ParsedTrade[] = [];
  const errors: RowError[] = [];

  rows.forEach((row, i) => {
    try {
      const side = clean(row["Type"]).toUpperCase();
      if (side !== "BUY" && side !== "SELL") {
        throw new Error(`Unrecognised trade type "${row["Type"]}"`);
      }

      const rawSecurity = clean(row["Security"]).toUpperCase();
      const status = clean(row["Status"]).toUpperCase();
      const units = num(row["Units"]);

      // Only settled trades must have real quantities. CANCELLED rows export as
      // 0 units and a REVERSAL exports as the negative of the trade it undoes —
      // both are kept verbatim for the audit trail, and the reducer filters
      // them out by status rather than by shape.
      if (status === SETTLED && units <= 0) {
        throw new Error(`Settled trade has non-positive units: "${row["Units"]}"`);
      }

      trades.push({
        cnote: clean(row["CNote"]),
        accountRef: clean(row["Account"]),
        accountName: clean(row["Account Name"]),
        side,
        rawSecurity,
        parent: parentCode(rawSecurity),
        company: clean(row["Company"]),
        instrument: cleanOrNull(row["Description"]),
        tradeDate: parseTradeDate(row["Contract Date"]),
        units,
        avgPrice: num(row["Avg Price"]),
        consideration: money(num(row["Consideration"])),
        brokerage: money(num(row["Brokerage"])),
        otherCharges: money(num(row["Other Charges"])),
        gst: money(num(row["GST"])),
        value: money(num(row["Value"])),
        brokeragePct: numOrNull(row["Brokerage %"]),
        adviser: cleanOrNull(row["Adviser"]),
        status,
      });
    } catch (err) {
      // +2: one for the header row, one for 1-based line numbers.
      errors.push({ line: i + 2, reason: (err as Error).message, row });
    }
  });

  return { trades, errors };
}

// ---------------------------------------------------------------------------
// Realized P&L
// ---------------------------------------------------------------------------

export type PnlRollup = {
  accountRef: string;
  parent: string;
  unitsBought: number;
  unitsSold: number;
  openUnits: number;
  costTotal: number;
  proceeds: number;
  costOfSold: number;
  openCost: number;
  realizedPl: number;
  fees: number;
  tradeCount: number;
  firstTrade: string;
  lastTrade: string;
  hasPartial: boolean;
  shortHistory: boolean;
};

/**
 * ── The cost-basis replay ────────────────────────────────────────────────
 *
 * Settled trades are grouped by PARENT code, so a placement bought as EOSXX
 * and sold as EOS nets out as the one round trip it really was.
 *
 * Cost basis is weighted average. For a SELL that closes the whole open parcel
 * WAC is exact: the realized result is simply proceeds minus everything paid
 * for those units. Sells that close only part of a parcel assembled at several
 * prices are still valued, but flagged `hasPartial` so the UI can mark them
 * approximate until parcel-level FIFO matching lands.
 *
 * `value` is already net of brokerage and GST (BUY adds fees, SELL deducts
 * them), so realized P&L is fee-inclusive without any extra arithmetic.
 */

/**
 * The minimal shape the cost-basis replay needs. Both `ParsedTrade` (from the
 * CSV) and the DAL's `TradeRow` (from the database) map onto it, so the ledger
 * is walked by ONE implementation no matter which side is asking.
 */
export type LedgerLine = {
  /** Rollup scope — the account. Pass "" when the caller already filtered. */
  scope: string;
  parent: string;
  /**
   * The instrument AS TRADED — `EOSXX`, `FRSOB` — where `parent` is `EOS`/`FRS`.
   *
   * Carried alongside `parent`, not instead of it. The FIFO is keyed on the
   * parent and stays that way: a deferred-settlement line (`AVRXX`) IS the
   * ordinary and its cost must carry across. But which INSTRUMENT a sale closed
   * is a different fact, and it was being thrown away here — which is why the
   * client's dated P&L table folded `OD6O`'s option sale into `OD6`'s row and
   * lost every option line the all-time table shows. See `realizedBetween`.
   */
  code: string;
  cnote: string;
  side: TradeSide;
  tradeDate: string;
  units: number;
  value: number;
  status: string;
  fees: number;
};

/**
 * What one SELL actually realised, with the cost the replay attributed to it.
 * The per-ticker rollup cannot answer "how much did we make in March" — this
 * can, because every realised dollar keeps the date it was realised on.
 */
export type SellAttribution = {
  scope: string;
  parent: string;
  /** The instrument this sale closed, where `parent` is its rollup code. */
  code: string;
  cnote: string;
  tradeDate: string;
  units: number;
  proceeds: number;
  costOfSold: number;
  realizedPl: number;
  /** This sale drew on no cost basis, so its "profit" is really just proceeds. */
  noCostBasis: boolean;
  /**
   * A FREE GRANT sold: an option the ledger never saw bought.
   *
   * Distinct from `noCostBasis`, and the difference is the difference between
   * "we do not know what this cost" and "this cost nothing". The firm's own
   * treatment puts a placement's whole cost on the shares and none on the
   * attaching options — 106 of 108 option positions in the database carry
   * `avg_cost = 0` — so zero here is the answer, not a gap in the data.
   *
   * Both were `noCostBasis` until 10 Sep 2026, which was survivable only
   * because options were quietly borrowing the ordinary's parcel and never
   * reached the branch. Once they stopped, 187 free-grant sales worth $255,139
   * started reporting themselves as *cost base not on file* — a red flag asking
   * a human to find something that was never missing.
   */
  freeGrant?: boolean;
};

/**
 * Walk the settled ledger once, producing both the per-ticker rollup and the
 * per-sale attribution. Keeping them in a single pass is what guarantees the
 * date-bucketed chart and the ticker table can never disagree: they are two
 * views of the same arithmetic, not two implementations of it.
 */
export function replayLedger(lines: LedgerLine[]): {
  rollups: PnlRollup[];
  sells: SellAttribution[];
} {
  const settled = lines
    // Chronological, then by contract note so same-day trades replay in a
    // stable order — the walk is order-dependent and must be deterministic.
    .filter((t) => t.status === SETTLED)
    .sort((a, b) => {
      if (a.tradeDate !== b.tradeDate) return a.tradeDate.localeCompare(b.tradeDate);
      /**
       * A same-day BUY is replayed before the SELL, whatever the note numbers say.
       *
       * The walk is order-dependent, and `cnote` is an issuing sequence, not an
       * economic one. Saturn's `ING`, both legs on 22 Jun 2026:
       *
       *   SELL 7,000 @ $13,302.50   cnote 2505031
       *   BUY  7,000 @ $14,000.00   cnote 2506714
       *
       * By note number the sale came first, met an empty parcel, and reported
       * its whole $13,302.50 as profit — on a day trade that actually LOST
       * $697.50. Nothing can be sold before it is bought, so the buy leads.
       *
       * ── Why this is worth a −$781,286 correction ──────────────────────────
       * Because it is verified rather than reasoned. Replaying buy-first
       * reproduces the desk's own figures to the cent on every ticker its
       * report covers: `4DX` −3,636.97, `CU6` −19,761.19, `EOS` −13,851.50,
       * `LTR` −3,454.77, `PLS` −18,410.00, `ZIP` −12,683.42. Our stored
       * numbers had those six at +$78,652, +$25,915, +$36,106, +$45,414,
       * +$24,896 and +$27,025 — inflated by exactly this, across 42 groups.
       *
       * `cnote` still breaks ties within a side, so the walk stays deterministic.
       */
      if (a.side !== b.side) return a.side === "BUY" ? -1 : 1;
      return a.cnote.localeCompare(b.cnote);
    });

  const byKey = new Map<string, PnlRollup>();
  const sells: SellAttribution[] = [];

  /**
   * The open parcel, held PER INSTRUMENT while the rollup stays per parent.
   *
   * ── Why these are two different keys ────────────────────────────────────────
   * The rollup is reported at parent grain and `realized_pnl` is keyed that way,
   * so that does not move. But the FIFO was keyed there too, which meant a sale
   * of `FRSOB` drew its cost from parcels of `FRS` — an option costed against
   * ordinary shares. `pnl_summary` states the rule this breaks: "an option line
   * is a position in its own right (EOS and EOSO have different prices)".
   *
   * So an OPTION gets its own parcel and everything else pools by parent. That
   * distinction is the whole point of splitting on `isOptionCode` rather than on
   * the code: `AVRXX` is a deferred-settlement line that IS the ordinary, and
   * its cost must carry across. Measured over the live ledger, keying on the
   * code outright would have moved 714 of 1,371 parcels (48% of trades); the
   * option-only split moves 145 (13.8%), and those are the ones that were wrong.
   *
   * `costs` is the set of distinct per-unit prices making up the parcel.
   * Weighted-average cost is exact when a sell closes the whole parcel, and also
   * when the parcel came from one price — it is only an approximation when a
   * sell partly closes a parcel assembled at two or more prices, which is what
   * `hasPartial` records.
   */
  type OpenParcel = {
    units: number;
    cost: number;
    costs: Set<number>;
    /**
     * The purchases making up the parcel, still individually identified.
     *
     * Weighted-average cost only needs the two totals; these are what let a
     * sale be matched to the ONE purchase that closed it — see `sameDayPair`
     * below for when that is allowed.
     */
    lots: { units: number; value: number }[];
  };
  const parcels = new Map<string, OpenParcel>();
  const parcelKey = (t: LedgerLine) =>
    `${t.scope}::${isOptionCode(t.code) ? t.code : t.parent}`;

  /**
   * Parcel keys the ledger ever records a buy WITH MONEY IN IT against.
   *
   * A pre-pass, because the walk is chronological and this is a fact about the
   * whole file: an option sold in March with its purchase in June is not a
   * grant, it is a short, and only looking at every line can tell.
   *
   * ── Why "for value" and not merely "ever bought" ────────────────────────────
   * A grant is not always absent from the ledger — it is often present at ZERO.
   * The real EPMO rows are the case: each account has an `EPMO BUY` at
   * `value = 0` for roughly HALF the units later sold (23,810 bought against
   * 47,620 sold, and the same ratio on four other accounts). So the parcel
   * exists, is exhausted mid-sale, and the excess looked like missing data —
   * except the units that ARE recorded cost nothing, so the missing ones would
   * have cost nothing either. The P&L is identical; only the warning was wrong.
   *
   * Keying on a POSITIVE-value buy separates the two properly: an option the
   * client actually paid for and whose history is short is still unknown and
   * still flagged, while a grant booked at zero — however many of its units the
   * broker got round to recording — is free.
   */
  const boughtForValue = new Set<string>();
  for (const t of settled) {
    if (t.side === "BUY" && t.value > 0) boughtForValue.add(parcelKey(t));
  }

  /**
   * Pools that buy AND sell on the same day — where lot matching is switched
   * off, and why.
   *
   * ── The rule this guards ────────────────────────────────────────────────────
   * A client can hold two parcels of one stock at once: a placement parcel and
   * an on-market one. Weighted-average cost pools them, so selling ONE draws
   * blended cost from both. Real case, `ACW` on a live account:
   *
   *   2026-01-23  ACW    BUY     95,882 @ $5,095.86   (on-market, sold in July)
   *   2026-02-03  ACWXX  BUY    238,095 @ $9,999.99   (placement)
   *   2026-04-20  ACW    SELL   238,095 @ $10,360.94
   *
   * WAC costed that sale at $10,761.96 by blending in the January parcel — a
   * parcel whose own sale is in JULY, outside the period being reported. The
   * broker's own closed-trades report costs it at $9,999.99, the placement lot
   * it actually closed, and `ARL` independently confirms the pairing: its buys
   * are `ARLXX` and its sells `ARL`, quantities equal, and our figure already
   * matches the desk's corrected one to the cent.
   *
   * So a sale that exactly matches ONE open lot is costed at that lot.
   *
   * ── Why same-day two-way pools are excluded ────────────────────────────────
   * Because there the answer is decided by ORDERING, not by costing. This
   * ledger records a same-day round trip's SELL before its BUY often enough
   * that the sale meets an empty parcel and reports its whole proceeds as
   * profit. Measured over the live book, lot matching moves 22 groups: **17 of
   * them are same-day two-way pools** carrying ~$38k of that (4DX alone
   * −$53.5k), and only 5 are the two-parcel shape above, worth ~+$5k in total.
   * Fixing the ordering is a separate, larger question; until it is answered,
   * applying lot matching there would be reading a number out of a sequence
   * nobody has established.
   */
  const sameDayPair = new Set<string>();
  {
    const seen = new Map<string, TradeSide>();
    for (const t of settled) {
      const k = `${parcelKey(t)}::${t.tradeDate}`;
      const other = seen.get(k);
      if (other && other !== t.side) sameDayPair.add(parcelKey(t));
      else if (!other) seen.set(k, t.side);
    }
  }

  for (const t of settled) {
    const key = `${t.scope}::${t.parent}`;
    let r = byKey.get(key);
    if (!r) {
      r = {
        accountRef: t.scope,
        parent: t.parent,
        unitsBought: 0,
        unitsSold: 0,
        openUnits: 0,
        costTotal: 0,
        proceeds: 0,
        costOfSold: 0,
        openCost: 0,
        realizedPl: 0,
        fees: 0,
        tradeCount: 0,
        firstTrade: t.tradeDate,
        lastTrade: t.tradeDate,
        hasPartial: false,
        shortHistory: false,
      };
      byKey.set(key, r);
    }

    r.tradeCount += 1;
    r.lastTrade = t.tradeDate;
    r.fees += t.fees;

    const pk = parcelKey(t);
    let p = parcels.get(pk);
    if (!p) {
      p = { units: 0, cost: 0, costs: new Set<number>(), lots: [] };
      parcels.set(pk, p);
    }

    if (t.side === "BUY") {
      r.unitsBought += t.units;
      r.costTotal += t.value;
      // The parent's reported open parcel is the sum of its instruments'.
      r.openUnits += t.units;
      r.openCost += t.value;
      p.units += t.units;
      p.cost += t.value;
      p.lots.push({ units: t.units, value: t.value });
      // Round the unit cost before recording it, so float noise doesn't make
      // two economically identical parcels look like different prices.
      p.costs.add(Math.round((t.value / t.units) * 1e6) / 1e6);
      continue;
    }

    // SELL
    r.unitsSold += t.units;
    r.proceeds += t.value;

    let costOut = 0;
    let noCostBasis = false;
    let freeGrant = false;

    /**
     * The ONE open lot this sale closes, if there is exactly one.
     *
     * "Exactly one" is the whole safety condition. Placement parcels are round
     * numbers — 200,000, 333,333 — and two of them under one parent collide by
     * coincidence often enough that picking the first match would pair the
     * wrong purchase. Where the quantity is ambiguous the sale falls through to
     * weighted average, which is the answer it has always had.
     */
    const exactLot = sameDayPair.has(pk)
      ? -1
      : (() => {
          let found = -1;
          for (let i = 0; i < p.lots.length; i++) {
            if (p.lots[i].units <= 0 || Math.abs(p.lots[i].units - t.units) > 0.5) continue;
            if (found !== -1) return -1; // ambiguous: two lots of this size
            found = i;
          }
          return found;
        })();

    if (exactLot !== -1) {
      const lot = p.lots[exactLot];
      costOut = lot.value;

      // The parcel loses the lot, and the PARENT's reported open position loses
      // it with them. Missing the second half left `openUnits` carrying a
      // parcel that had just been closed.
      p.units -= lot.units;
      p.cost -= lot.value;
      p.lots.splice(exactLot, 1);
      r.openUnits -= lot.units;
      r.openCost -= lot.value;

      // Snapped independently: one instrument going flat says nothing about
      // the others under the same parent.
      if (p.units <= 1e-9) {
        p.units = 0;
        p.cost = 0;
        p.costs.clear();
        p.lots.length = 0;
      }
      if (r.openUnits <= 1e-9) {
        r.openUnits = 0;
        r.openCost = 0;
      }
    }
    // Drawn from THIS INSTRUMENT's parcel, not the parent's pool.
    else if (p.units <= 0) {
      if (isOptionCode(t.code) && !boughtForValue.has(pk)) {
        // A free attaching option, sold. Zero cost is the FIRM'S ANSWER, not a
        // gap: the placement's whole cost sits on the shares. Recorded as such
        // so the row does not wear a warning about data nobody is missing, and
        // deliberately not `shortHistory` — the export is not short of
        // anything here.
        freeGrant = true;
      } else {
        // Sold something the ledger never saw bought: the export starts mid
        // history. Proceeds are real, cost basis is unknown — record zero cost
        // and flag it rather than inventing a number.
        r.shortHistory = true;
        noCostBasis = true;
      }
    } else {
      const closing = Math.min(t.units, p.units);
      if (closing < t.units) {
        // Part of this sale is uncosted — unless it is a free grant, where the
        // units the broker did not record would have cost nothing either. See
        // `boughtForValue`; EPMO is the live case.
        if (isOptionCode(t.code) && !boughtForValue.has(pk)) {
          freeGrant = true;
        } else {
          r.shortHistory = true;
          noCostBasis = true;
        }
      }
      // Approximate only if this leaves units open AND the parcel was built at
      // more than one price — otherwise WAC is the exact answer.
      if (closing < p.units && p.costs.size > 1) r.hasPartial = true;

      costOut = (p.cost * closing) / p.units;
      p.units -= closing;
      p.cost -= costOut;

      // Draw the same units out of the individual lots, oldest first. Without
      // this a parcel already consumed by weighted average would still offer
      // its original quantities to a later exact match.
      let draining = closing;
      while (draining > 1e-9 && p.lots.length > 0) {
        const take = Math.min(draining, p.lots[0].units);
        p.lots[0].value -= (p.lots[0].value * take) / p.lots[0].units;
        p.lots[0].units -= take;
        draining -= take;
        if (p.lots[0].units <= 1e-9) p.lots.shift();
      }
      r.openUnits -= closing;
      r.openCost -= costOut;

      // Snap to zero once flat, so float dust never shows as a $0.00 residue.
      // The parcel and the parent are snapped independently: one instrument
      // going flat says nothing about the others under the same parent.
      if (p.units <= 1e-9) {
        p.units = 0;
        p.cost = 0;
        p.costs.clear();
        p.lots.length = 0;
      }
      if (r.openUnits <= 1e-9) {
        r.openUnits = 0;
        r.openCost = 0;
      }
    }

    // One rule, whichever branch got here. An option that drew NO cost and was
    // never bought for value is a free grant — that is true of an empty parcel,
    // a part-covered one, and a parcel recovered at zero value by
    // `offLedgerBuyLines`. Deciding it per-branch left the third case reading as
    // a plain sale while the other two said "free grant", for the same thing.
    if (!freeGrant && costOut === 0 && isOptionCode(t.code) && !boughtForValue.has(pk)) {
      freeGrant = true;
      noCostBasis = false;
    }

    r.costOfSold += costOut;
    r.realizedPl += t.value - costOut;

    sells.push({
      scope: t.scope,
      parent: t.parent,
      code: t.code,
      cnote: t.cnote,
      tradeDate: t.tradeDate,
      units: t.units,
      proceeds: money(t.value),
      costOfSold: money(costOut),
      realizedPl: money(t.value - costOut),
      noCostBasis,
      ...(freeGrant ? { freeGrant: true } : {}),
    });
  }

  for (const r of byKey.values()) {
    r.costTotal = money(r.costTotal);
    r.proceeds = money(r.proceeds);
    r.costOfSold = money(r.costOfSold);
    r.openCost = money(r.openCost);
    r.realizedPl = money(r.realizedPl);
    r.fees = money(r.fees);
  }

  const rollups = [...byKey.values()].sort(
    (a, b) =>
      a.accountRef.localeCompare(b.accountRef) || a.parent.localeCompare(b.parent),
  );

  return { rollups, sells };
}

/** Per-ticker rollup from parsed CSV rows — the importers' entry point. */
export function reduceTrades(trades: ParsedTrade[]): PnlRollup[] {
  return replayLedger(
    trades.map((t) => ({
      scope: t.accountRef,
      parent: t.parent,
      // `rawSecurity` is the code as traded; `parent` is its rollup. The
      // importers' rollup is parent-grain and does not read this, but the type
      // requires it and a wrong value here would be worse than a redundant one.
      code: t.rawSecurity,
      cnote: t.cnote,
      side: t.side,
      tradeDate: t.tradeDate,
      units: t.units,
      value: t.value,
      status: t.status,
      fees: t.brokerage + t.otherCharges + t.gst,
    })),
  ).rollups;
}

