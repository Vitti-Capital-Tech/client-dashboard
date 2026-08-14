import type { TradeRow } from "../data/queries";
import type { RealizedSummary } from "../data/compute";

/**
 * P&L summary export for the Order History tab — one row per company.
 *
 * Pure and client-safe (no DOM, no server imports) so the download handlers
 * stay two-liners and the numbers themselves are unit-testable.
 *
 * ── How each row is built ────────────────────────────────────────────────
 * A company's money has two halves, and each half has exactly one trustworthy
 * source. Mixing them is what makes portfolio exports wrong, so they are kept
 * strictly apart:
 *
 *   SOLD units  → the trade ledger    (proceeds, and the cost attributed to them)
 *   HELD units  → the holdings snapshot (cost base, and market value)
 *
 *   Buy Price            = cost of sold + cost base of held
 *   Sell / Current Price = proceeds     + market value of held
 *   P&L                  = the difference  ( = realised + unrealised )
 *
 * Because the ledger only ever contributes the *sold* side and the snapshot
 * only the *held* side, there is no overlap to double-count and no sensitivity
 * to the two disagreeing about how many units remain open.
 */

export type ExportGroup = {
  parent: string;
  name: string;
  trades: TradeRow[];
  realized: RealizedSummary | null;
};

/** The still-held side of a company, rolled up from the holdings snapshot. */
export type HeldPosition = {
  qty: number;
  costBase: number; // qty × average cost
  marketValue: number; // qty × last price
  /** False when no snapshot price exists — market value is then unknown, not 0. */
  hasPrice: boolean;
};

/**
 * A desk correction to one row's inputs. Every field is optional and `null`
 * means "keep the computed value", so an override patches the derivation
 * rather than replacing it — clearing a field puts it back on the ledger.
 */
export type PnlOverride = {
  parent: string;
  buyQty: number | null;
  sellQty: number | null;
  buyPrice: number | null;
  sellOrCurrent: number | null;
  note: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
};

/** Which fields on a row came from an override rather than the sources. */
export type OverriddenFields = {
  buyQty: boolean;
  sellQty: boolean;
  buyPrice: boolean;
  sellOrCurrent: boolean;
};

export type PnlSummaryRow = {
  ticker: string;
  name: string;
  /** Units the LEDGER saw bought/sold, unless overridden. Zero on a holding
   *  that predates the export window — `type` is what explains that. */
  buyQty: number;
  sellQty: number;
  buyPrice: number;
  sellOrCurrent: number;
  pnl: number;
  openPosition: boolean;
  type: string;
  /** Something does not add up — the row needs a human before it is trusted. */
  flagged: boolean;

  /**
   * Leave this row OUT of the Grand Total.
   *
   * Set only when the buy side is genuinely UNKNOWN rather than zero — the
   * placement could not be resolved, so the row's cost is blank. Summing it
   * would report the entire sale proceeds as profit, which is precisely the
   * error the blank is there to prevent. A blank cannot be added up, so it
   * is not added up.
   */
  excludedFromTotal?: boolean;

  /** True if any field on this row was set by hand. */
  edited: boolean;
  overridden: OverriddenFields;
  note: string | null;
  /** What the sources said, kept so the UI can show what was changed from. */
  computed: {
    buyQty: number;
    sellQty: number;
    buyPrice: number;
    sellOrCurrent: number;
    pnl: number;
  };
  isMatched?: boolean;
  isOption?: boolean;
  isUnlistedOption?: boolean;
  isDbOpenValued?: boolean;
  isDbOnly?: boolean;
  /** A still-held parcel sits on top of a realised part-sale. */
  isPartialExit?: boolean;
  openQty?: number;

  /**
   * Option terms — what moneyness is judged on (`lib/options/moneyness.ts`).
   *
   * Present on MODELLED option rows, which carry their own valuation inputs.
   * A listed series has neither here: its strike lives in the option register,
   * so the caller joins it on. Absent means "not known", never "zero" — a
   * fabricated strike would put an ITM badge on a row nobody can check.
   */
  strike?: number | null;
  /** Underlying spot the row was valued at, not the option's own price. */
  underlyingPrice?: number | null;
  expiry?: string | null;
};

/**
 * Classify the exit against the unit counts, and say so plainly when the two
 * sources contradict each other. A clean `Partial exit` / `Full exit` is only
 * claimed when the ledger and the snapshot agree; anything else is flagged
 * rather than quietly rounded into the nearest tidy label.
 */
function classify(
  bought: number,
  sold: number,
  heldQty: number,
): { type: string; flagged: boolean } {
  const held = heldQty > 0;

  // Sold units that were never bought: the ledger starts mid-history, so the
  // cost side is incomplete and the P&L on this row is overstated.
  if (sold > bought) {
    return { type: "CHECK - sold more than bought", flagged: true };
  }

  if (sold === 0) {
    if (bought === 0) {
      // Held, but the ledger has no record of acquiring it.
      return { type: "Open - no ledger history", flagged: true };
    }
    return { type: "Open", flagged: false };
  }

  if (bought > sold) {
    return held
      ? { type: "Partial exit", flagged: false }
      : // The ledger says units remain; the snapshot says none are held.
        // A lapse, conversion or transfer the ledger never recorded.
        { type: "CHECK - partial exit but nothing held", flagged: true };
  }

  // bought === sold
  return held
    ? { type: "CHECK - full exit but still holding", flagged: true }
    : { type: "Full exit", flagged: false };
}

/**
 * Build one summary row per company across both sources, then apply any desk
 * overrides on top.
 *
 * P&L is never taken from an override — it stays `sell − buy`, recomputed from
 * whichever values are in force. That is what keeps a hand-edited row internally
 * consistent instead of letting someone type a total that its own columns
 * contradict.
 */
export function buildPnlSummary(
  groups: ExportGroup[],
  held: Map<string, HeldPosition>,
  overrides: Map<string, PnlOverride> = new Map(),
): PnlSummaryRow[] {
  const tickers = new Set<string>([
    ...groups.map((g) => g.parent),
    ...held.keys(),
    // An override can exist for a company that has since dropped out of both
    // sources; it must not silently vanish along with them.
    ...overrides.keys(),
  ]);
  const nameOf = new Map(groups.map((g) => [g.parent, g.name]));

  const rows: PnlSummaryRow[] = [];

  for (const ticker of tickers) {
    const rz = groups.find((g) => g.parent === ticker)?.realized ?? null;
    const h = held.get(ticker);
    const o = overrides.get(ticker);

    const computed = {
      buyQty: rz?.unitsBought ?? 0,
      sellQty: rz?.unitsSold ?? 0,
      buyPrice: (rz?.costOfSold ?? 0) + (h?.costBase ?? 0),
      sellOrCurrent: (rz?.proceeds ?? 0) + (h?.marketValue ?? 0),
      pnl: 0,
    };
    computed.pnl = computed.sellOrCurrent - computed.buyPrice;

    const overridden: OverriddenFields = {
      buyQty: o?.buyQty != null,
      sellQty: o?.sellQty != null,
      buyPrice: o?.buyPrice != null,
      sellOrCurrent: o?.sellOrCurrent != null,
    };
    const edited =
      overridden.buyQty ||
      overridden.sellQty ||
      overridden.buyPrice ||
      overridden.sellOrCurrent;

    const buyQty = o?.buyQty ?? computed.buyQty;
    const sellQty = o?.sellQty ?? computed.sellQty;
    const buyPrice = o?.buyPrice ?? computed.buyPrice;
    const sellOrCurrent = o?.sellOrCurrent ?? computed.sellOrCurrent;

    // Classify against the values actually in force — correcting the quantities
    // is precisely how a `CHECK - …` row becomes a clean `Full exit`.
    const { type, flagged } = classify(buyQty, sellQty, h?.qty ?? 0);

    const withPrice = h && !h.hasPrice ? `${type} (no market price)` : type;

    rows.push({
      ticker,
      name: nameOf.get(ticker) ?? ticker,
      buyQty,
      sellQty,
      buyPrice,
      sellOrCurrent,
      pnl: sellOrCurrent - buyPrice,
      openPosition: (h?.qty ?? 0) > 0,
      // A held position with no snapshot price cannot be valued, so its "P&L"
      // would read as a total loss. Say so instead.
      type: edited ? `${withPrice} (edited)` : withPrice,
      // An edited row is no longer a pure derivation. That is not an error, but
      // it is a fact the reader is entitled to, so it never travels silently.
      flagged: flagged || (!!h && !h.hasPrice),
      edited,
      overridden,
      note: o?.note ?? null,
      computed,
    });
  }

  // Biggest result first; flagged rows are visible by colour, not by position.
  return rows.sort((a, b) => b.pnl - a.pnl || a.ticker.localeCompare(b.ticker));
}

/**
 * Whether the position behind a row is still held.
 *
 * A word, not a `Yes`/`No`. The flag could only ever answer "is any of this
 * still open?", which on an OPTION line is barely a question — a free grant is
 * never bought, so "Open Position: No" read as though the client had disposed
 * of something they still hold. Naming the state instead means the same cell
 * says something true for an equity, a listed series and a modelled grant alike.
 */
export type PositionStatus = "Open" | "Partly open" | "Closed" | "Unknown";

export function positionStatus(r: PnlSummaryRow): PositionStatus {
  // Ahead of everything: this row's own figures are blank, so no claim about
  // what is left of the position can be true — including "Closed", which would
  // report a disposal nobody has evidence of.
  if (r.excludedFromTotal) return "Unknown";

  // A modelled grant was never bought and cannot be sold; it is an outstanding
  // entitlement for as long as the row exists.
  if (r.isUnlistedOption) return "Open";

  // The row exists ONLY because the holdings snapshot carries it — so it is
  // held, by definition, whatever the ledger does or does not say.
  if (r.isDbOnly) return "Open";

  // Nothing was sold: the whole "sell side" is this parcel marked to the
  // snapshot. Checked BEFORE the quantities, because valuing an open parcel
  // sets both legs from the same held count — `openQty` is 0 on exactly the
  // rows that are most open, and reading it alone reported them as Closed.
  if (r.isDbOpenValued) return "Open";

  if (r.isPartialExit || r.type.toLowerCase().startsWith("partial")) return "Partly open";

  if ((r.openQty ?? 0) > 0) return "Open";
  // The computed path has no flags, only this — see `buildPnlSummary`.
  if (r.openPosition) return "Open";

  return "Closed";
}

/** Amber vs green, and the on-screen fills: anything not fully exited is open. */
export const isStillHeld = (s: PositionStatus): boolean =>
  s === "Open" || s === "Partly open";

export function grandTotal(rows: PnlSummaryRow[]) {
  // A row whose cost is unknown contributes nothing to any column, not even its
  // real sale proceeds: showing proceeds against a blank cost would make the
  // total read as profit the client never made.
  const summable = rows.filter((r) => !r.excludedFromTotal);
  return {
    buyPrice: summable.reduce((s, r) => s + r.buyPrice, 0),
    sellOrCurrent: summable.reduce((s, r) => s + r.sellOrCurrent, 0),
    pnl: summable.reduce((s, r) => s + r.pnl, 0),
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** Shared by the CSV, the .xlsx and the on-screen table, so all three agree. */
export const SUMMARY_HEADERS = [
  "Row Labels",
  "Company",
  "Buy Qty",
  "Sell Qty",
  "Buy Price",
  "Sell Price / Current Price",
  "PnL",
  "Position",
  "Type",
] as const;

/** RFC 4180 field — company names really do contain commas and quotes. */
function csvField(value: string | number): string {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Money is written as a bare 2-decimal number — no `$`, no thousands
 * separator — so the cells stay numeric and the Grand Total actually sums in
 * a spreadsheet. Cents are never rounded away.
 */
const n2 = (n: number): string => n.toFixed(2);

/**
 * CSV is plain text and cannot carry a fill, so the colour-coded deliverable is
 * a real `.xlsx` built by ExcelJS in `app/actions/exports.ts` — kept server-side
 * so the ~1 MB library never reaches the browser. Both formats render the same
 * `PnlSummaryRow[]`, so the two files always agree.
 */
export function buildPnlSummaryCsv(rows: PnlSummaryRow[]): string {
  const total = grandTotal(rows);

  const lines = [
    SUMMARY_HEADERS.join(","),
    ...rows.map((r) =>
      [
        r.ticker,
        r.name,
        r.buyQty,
        r.sellQty,
        n2(r.buyPrice),
        n2(r.sellOrCurrent),
        n2(r.pnl),
        positionStatus(r),
        r.type,
      ]
        .map(csvField)
        .join(","),
    ),
    // Quantities are deliberately NOT totalled — units of different companies
    // are not the same thing, so a sum of them would be meaningless.
    [
      "Grand Total",
      "",
      "",
      "",
      n2(total.buyPrice),
      n2(total.sellOrCurrent),
      n2(total.pnl),
      "",
      "",
    ]
      .map(csvField)
      .join(","),
  ];

  // CRLF is the RFC 4180 line ending and the one Excel is happiest with.
  return lines.join("\r\n");
}

/** `pnl-summary-sri-guru-nanak-pty-ltd-2026-07-29.csv` */
export function pnlSummaryFilename(
  clientName: string,
  accountLabel: string | null,
  isoDate: string,
  ext: "csv" | "xlsx",
): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

  return [
    "pnl-summary",
    slug(clientName),
    accountLabel ? slug(accountLabel) : null,
    isoDate,
  ]
    .filter(Boolean)
    .join("-")
    .concat(`.${ext}`);
}
