import { parseCsvRecords, requireHeaders, type CsvRow } from "./csv.ts";
import {
  isContractNotesListing,
  normaliseContractNotesRow,
} from "./trade-formats.ts";
import {
  clean,
  cleanOrNull,
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
  cnote: string;
  tradeDate: string;
  units: number;
  proceeds: number;
  costOfSold: number;
  realizedPl: number;
  /** This sale drew on no cost basis, so its "profit" is really just proceeds. */
  noCostBasis: boolean;
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
    .sort((a, b) =>
      a.tradeDate === b.tradeDate
        ? a.cnote.localeCompare(b.cnote)
        : a.tradeDate.localeCompare(b.tradeDate),
    );

  const byKey = new Map<string, PnlRollup>();
  const sells: SellAttribution[] = [];
  // Per-key set of distinct per-unit costs making up the CURRENTLY open parcel.
  // Weighted-average cost is exact whenever a sell closes the whole parcel, and
  // also whenever the parcel came from a single price — it is only ever an
  // approximation when a sell partially closes a parcel assembled at two or
  // more different prices. Tracking this keeps `hasPartial` meaningful instead
  // of flagging every position that was sold down in two goes.
  const openCosts = new Map<string, Set<number>>();

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

    let costs = openCosts.get(key);
    if (!costs) {
      costs = new Set<number>();
      openCosts.set(key, costs);
    }

    if (t.side === "BUY") {
      r.unitsBought += t.units;
      r.costTotal += t.value;
      r.openUnits += t.units;
      r.openCost += t.value;
      // Round the unit cost before recording it, so float noise doesn't make
      // two economically identical parcels look like different prices.
      costs.add(Math.round((t.value / t.units) * 1e6) / 1e6);
      continue;
    }

    // SELL
    r.unitsSold += t.units;
    r.proceeds += t.value;

    let costOut = 0;
    let noCostBasis = false;

    if (r.openUnits <= 0) {
      // Sold something the ledger never saw bought: the export starts mid
      // history. Proceeds are real, cost basis is unknown — record zero cost
      // and flag it rather than inventing a number.
      r.shortHistory = true;
      noCostBasis = true;
    } else {
      const closing = Math.min(t.units, r.openUnits);
      if (closing < t.units) {
        r.shortHistory = true;
        noCostBasis = true; // part of this sale is uncosted
      }
      // Approximate only if this leaves units open AND the parcel was built at
      // more than one price — otherwise WAC is the exact answer.
      if (closing < r.openUnits && costs.size > 1) r.hasPartial = true;

      costOut = (r.openCost * closing) / r.openUnits;
      r.openUnits -= closing;
      r.openCost -= costOut;

      // Snap to zero once flat, so float dust never shows as a $0.00 residue.
      if (r.openUnits <= 1e-9) {
        r.openUnits = 0;
        r.openCost = 0;
        costs.clear();
      }
    }

    r.costOfSold += costOut;
    r.realizedPl += t.value - costOut;

    sells.push({
      scope: t.scope,
      parent: t.parent,
      cnote: t.cnote,
      tradeDate: t.tradeDate,
      units: t.units,
      proceeds: money(t.value),
      costOfSold: money(costOut),
      realizedPl: money(t.value - costOut),
      noCostBasis,
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

