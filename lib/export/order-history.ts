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

export type PnlSummaryRow = {
  ticker: string;
  name: string;
  buyPrice: number;
  sellOrCurrent: number;
  pnl: number;
  openPosition: boolean;
  type: string;
  /** Something does not add up — the row needs a human before it is trusted. */
  flagged: boolean;
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

/** Build one summary row per company across both sources. */
export function buildPnlSummary(
  groups: ExportGroup[],
  held: Map<string, HeldPosition>,
): PnlSummaryRow[] {
  const tickers = new Set<string>([...groups.map((g) => g.parent), ...held.keys()]);
  const nameOf = new Map(groups.map((g) => [g.parent, g.name]));

  const rows: PnlSummaryRow[] = [];

  for (const ticker of tickers) {
    const rz = groups.find((g) => g.parent === ticker)?.realized ?? null;
    const h = held.get(ticker);

    const buyPrice = (rz?.costOfSold ?? 0) + (h?.costBase ?? 0);
    const sellOrCurrent = (rz?.proceeds ?? 0) + (h?.marketValue ?? 0);
    const { type, flagged } = classify(
      rz?.unitsBought ?? 0,
      rz?.unitsSold ?? 0,
      h?.qty ?? 0,
    );

    rows.push({
      ticker,
      name: nameOf.get(ticker) ?? ticker,
      buyPrice,
      sellOrCurrent,
      pnl: sellOrCurrent - buyPrice,
      openPosition: (h?.qty ?? 0) > 0,
      // A held position with no snapshot price cannot be valued, so its "P&L"
      // would read as a total loss. Say so instead.
      type: h && !h.hasPrice ? `${type} (no market price)` : type,
      flagged: flagged || (!!h && !h.hasPrice),
    });
  }

  // Biggest result first; flagged rows are visible by colour, not by position.
  return rows.sort((a, b) => b.pnl - a.pnl || a.ticker.localeCompare(b.ticker));
}

export function grandTotal(rows: PnlSummaryRow[]) {
  return {
    buyPrice: rows.reduce((s, r) => s + r.buyPrice, 0),
    sellOrCurrent: rows.reduce((s, r) => s + r.sellOrCurrent, 0),
    pnl: rows.reduce((s, r) => s + r.pnl, 0),
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

const HEADERS = [
  "Row Labels",
  "Company",
  "Buy Price",
  "Sell Price / Current Price",
  "PnL",
  "Open Positions",
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
    HEADERS.join(","),
    ...rows.map((r) =>
      [
        r.ticker,
        r.name,
        n2(r.buyPrice),
        n2(r.sellOrCurrent),
        n2(r.pnl),
        r.openPosition ? "Yes" : "No",
        r.type,
      ]
        .map(csvField)
        .join(","),
    ),
    ["Grand Total", "", n2(total.buyPrice), n2(total.sellOrCurrent), n2(total.pnl), "", ""]
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
