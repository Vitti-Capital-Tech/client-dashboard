import { money } from "./normalize.ts";
import { SETTLED, type ParsedTrade, type PnlRollup } from "./trades.ts";

/**
 * Reconciliation — finds the trades whose cost basis the reducer could not
 * establish, and where possible suggests where the missing buy value is.
 *
 * The reducer deliberately refuses to guess: a SELL with no matching BUY gets
 * zero cost and a `shortHistory` flag. That keeps the arithmetic honest but
 * leaves a human to resolve it. This module produces that worklist.
 *
 * Two distinct causes, which need different fixes:
 *
 *   1. TICKER CHANGE — the units were bought under a different code and the
 *      company was renamed or restructured mid-holding. The buy IS in the
 *      ledger, just filed under another ticker, so it can be matched
 *      automatically on an exact unit count and proposed for confirmation.
 *      (Real case: BUY JBY 4,681 → SELL BKB 4,681.)
 *
 *   2. PRE-WINDOW PURCHASE — the units were genuinely bought before the export
 *      starts. Nothing in this file can recover the cost; it has to be entered
 *      from an earlier statement.
 *
 * Options are reported but never auto-matched. An option and its ordinary are
 * different instruments, so a unit-count coincidence between them means
 * exercise or conversion, not a rename — and that carries tax treatment this
 * module has no business inferring.
 */

export type ExceptionKind =
  | "probable-ticker-change"
  | "missing-opening-balance"
  | "unsold-option";

export type Suggestion = {
  fromParent: string; // ticker the units were bought under
  rawSecurity: string;
  tradeDate: string;
  units: number;
  value: number; // the buy value to adopt as cost basis
  cnote: string;
};

export type ReconcileException = {
  kind: ExceptionKind;
  accountRef: string;
  parent: string;
  unitsSold: number;
  proceeds: number;
  /** Realized P&L as currently reported — overstated by the missing cost. */
  reportedRealized: number;
  isOption: boolean;
  suggestion: Suggestion | null;
  /** Realized P&L if the suggestion were adopted. */
  correctedRealized: number | null;
};

/** Description codes that mark a derivative rather than an ordinary holding. */
const OPTION_DESCRIPTIONS = /^(INSTOPLAC|INSTPLAC|OPTION)/i;

function isOptionTrade(t: ParsedTrade): boolean {
  return (
    t.rawSecurity.length > 3 && OPTION_DESCRIPTIONS.test(t.instrument ?? "")
  );
}

/**
 * Build the worklist from the parsed ledger plus the rollups the reducer
 * produced from it. Both are passed in so the caller controls which trades were
 * considered (the importer replays the whole stored ledger, not just one file).
 */
export function reconcile(
  trades: ParsedTrade[],
  rollups: PnlRollup[],
): ReconcileException[] {
  const settled = trades.filter((t) => t.status === SETTLED);
  const exceptions: ReconcileException[] = [];

  // Buys that still have units sitting open are the candidate pool for a ticker
  // change: the units were never sold under that code, because they were sold
  // under the new one.
  const openByKey = new Map<string, PnlRollup>();
  for (const r of rollups) {
    if (r.openUnits > 0) openByKey.set(`${r.accountRef}::${r.parent}`, r);
  }

  for (const r of rollups) {
    if (!r.shortHistory) continue;

    const optionSells = settled.filter(
      (t) =>
        t.accountRef === r.accountRef &&
        t.parent === r.parent &&
        t.side === "SELL",
    );
    const isOption = optionSells.some(isOptionTrade);

    // Look for an orphaned buy of exactly this many units under another ticker,
    // in the same account, dated before the sale.
    let suggestion: Suggestion | null = null;

    if (!isOption) {
      const firstSale = optionSells
        .map((t) => t.tradeDate)
        .sort()[0];

      const candidates = settled.filter((t) => {
        if (t.side !== "BUY") return false;
        if (t.accountRef !== r.accountRef) return false;
        if (t.parent === r.parent) return false;
        if (isOptionTrade(t)) return false;
        if (Math.abs(t.units - r.unitsSold) > 1e-6) return false;
        if (firstSale && t.tradeDate > firstSale) return false;
        // Only a buy whose units are still open can have been renamed away.
        const open = openByKey.get(`${t.accountRef}::${t.parent}`);
        return !!open && Math.abs(open.openUnits - t.units) < 1e-6;
      });

      // Ambiguity is not a suggestion. Two candidates means a human decides.
      if (candidates.length === 1) {
        const c = candidates[0];
        suggestion = {
          fromParent: c.parent,
          rawSecurity: c.rawSecurity,
          tradeDate: c.tradeDate,
          units: c.units,
          value: c.value,
          cnote: c.cnote,
        };
      }
    }

    exceptions.push({
      kind: suggestion
        ? "probable-ticker-change"
        : isOption
          ? "unsold-option"
          : "missing-opening-balance",
      accountRef: r.accountRef,
      parent: r.parent,
      unitsSold: r.unitsSold,
      proceeds: r.proceeds,
      reportedRealized: r.realizedPl,
      isOption,
      suggestion,
      correctedRealized: suggestion
        ? money(r.realizedPl - suggestion.value)
        : null,
    });
  }

  return exceptions.sort(
    (a, b) =>
      a.accountRef.localeCompare(b.accountRef) ||
      b.proceeds - a.proceeds,
  );
}

/**
 * Ledger-vs-snapshot drift. `positions` is the broker's authoritative statement
 * of what is held; the ledger's own open units should agree. Where they do not,
 * one of the two is incomplete — and a silent disagreement is exactly the kind
 * of thing that makes a P&L number wrong in a way nobody notices.
 */
export type DriftRow = {
  accountRef: string;
  parent: string;
  ledgerOpenUnits: number;
  snapshotUnits: number;
  /** Cost still attributed to units the snapshot says are not held. */
  strandedCost: number;
};

export function findDrift(
  rollups: PnlRollup[],
  snapshotUnitsByKey: Map<string, number>, // `${accountRef}::${parentCode}` → units
): DriftRow[] {
  const drift: DriftRow[] = [];

  for (const r of rollups) {
    const key = `${r.accountRef}::${r.parent}`;
    const snapshotUnits = snapshotUnitsByKey.get(key) ?? 0;
    if (Math.abs(r.openUnits - snapshotUnits) < 1e-6) continue;

    drift.push({
      accountRef: r.accountRef,
      parent: r.parent,
      ledgerOpenUnits: r.openUnits,
      snapshotUnits,
      strandedCost: snapshotUnits === 0 ? money(r.openCost) : 0,
    });
  }

  return drift.sort(
    (a, b) =>
      a.accountRef.localeCompare(b.accountRef) ||
      b.strandedCost - a.strandedCost,
  );
}
