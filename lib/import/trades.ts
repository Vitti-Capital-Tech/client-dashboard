import { parseCsvRecords, requireHeaders, type CsvRow } from "./csv.ts";
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

const REQUIRED = [
  "CNote",
  "Account",
  "Type",
  "Security",
  "Company",
  "Contract Date",
  "Units",
  "Value",
  "Status",
];

/** Only settled trades count. CANCELLED / REVERSAL / REVERSED never happened. */
export const SETTLED = "SETTLED";

export type TradeSide = "BUY" | "SELL";

export type ParsedTrade = {
  cnote: string;
  accountRef: string;
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
  const { headers, rows } = parseCsvRecords(text);
  requireHeaders(headers, REQUIRED);

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
 * Replay settled trades into a per-(account, parent code) P&L rollup.
 *
 * Grouping is by PARENT code, so a placement bought as EOSXX and sold as EOS
 * nets out as the one round trip it really was.
 *
 * Cost basis is weighted average. For a SELL that closes the whole open
 * parcel — the only case in the current data — WAC is exact: the realized
 * result is simply proceeds minus everything paid for those units. Sells that
 * close only part of a parcel are still valued, but flagged `hasPartial` so the
 * UI can mark them approximate until parcel-level FIFO matching lands.
 *
 * `value` is already net of brokerage and GST (BUY adds fees, SELL deducts
 * them), so realized P&L is fee-inclusive without any extra arithmetic.
 */
export function reduceTrades(trades: ParsedTrade[]): PnlRollup[] {
  const settled = trades
    .filter((t) => t.status === SETTLED)
    // Chronological, then by contract note so same-day trades replay in a
    // stable order — the reducer is order-dependent and must be deterministic.
    .sort((a, b) =>
      a.tradeDate === b.tradeDate
        ? a.cnote.localeCompare(b.cnote)
        : a.tradeDate.localeCompare(b.tradeDate),
    );

  const byKey = new Map<string, PnlRollup>();
  // Per-key set of distinct per-unit costs making up the CURRENTLY open parcel.
  // Weighted-average cost is exact whenever a sell closes the whole parcel, and
  // also whenever the parcel came from a single price — it is only ever an
  // approximation when a sell partially closes a parcel assembled at two or
  // more different prices. Tracking this keeps `hasPartial` meaningful instead
  // of flagging every position that was sold down in two goes.
  const openCosts = new Map<string, Set<number>>();

  for (const t of settled) {
    const key = `${t.accountRef}::${t.parent}`;
    let r = byKey.get(key);
    if (!r) {
      r = {
        accountRef: t.accountRef,
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
    r.fees += t.brokerage + t.otherCharges + t.gst;

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
    if (r.openUnits <= 0) {
      // Sold something the ledger never saw bought: the export starts mid
      // history. Proceeds are real, cost basis is unknown — record zero cost
      // and flag it rather than inventing a number.
      r.shortHistory = true;
    } else {
      const closing = Math.min(t.units, r.openUnits);
      if (closing < t.units) r.shortHistory = true;
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
  }

  for (const r of byKey.values()) {
    r.costTotal = money(r.costTotal);
    r.proceeds = money(r.proceeds);
    r.costOfSold = money(r.costOfSold);
    r.openCost = money(r.openCost);
    r.realizedPl = money(r.realizedPl);
    r.fees = money(r.fees);
  }

  return [...byKey.values()].sort(
    (a, b) =>
      a.accountRef.localeCompare(b.accountRef) || a.parent.localeCompare(b.parent),
  );
}
