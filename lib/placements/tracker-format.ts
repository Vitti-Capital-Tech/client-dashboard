/**
 * The shape of a Placement Tracker workbook, as data.
 *
 * Everything here is pure: given a deal and what the workbook already contains,
 * it says which sheet to create, which cells to fill and what the Overview row
 * should say. No network, no Graph, no dates read from the clock — so the part
 * that is easy to get wrong is the part that is covered by tests.
 *
 * ── The workbook this describes ──────────────────────────────────────────────
 * `2026 Placements.xlsx` — one file per year, ~190 sheets:
 *
 *   Template        the blueprint for a new deal tab: every formula already
 *                   wired, row 3 (the deal's own terms) left blank
 *   Index           lead managers and their seller-fee %, looked up by the tabs
 *   <TICKER>        one tab per placement — terms in rows 2-4, the client
 *                   allocation table in rows 5-22, the fee split in 23-30
 *   YYYY Overview   one row per placement, header on row 3, data from row 4:
 *                   a counter, the ticker, and then FORMULAS that read the
 *                   deal's own tab. The Overview computes nothing itself.
 *
 * That last point is the whole reason this module is small. A new deal does not
 * need eighteen values written into the Overview — it needs eighteen formulas
 * pointing at a tab, and the tab is a copy of Template with five cells filled.
 */

/** What we know about a deal at the moment it arrives. Everything is optional
 *  except the ticker, because the mail is a summary and may not carry the rest. */
export type TrackerDeal = {
  ticker: string;
  /** `yyyy-mm-dd` — the tab's B3, and what the Overview shows as Date Issued. */
  issueDate?: string | null;
  /** Issue price per share → F3. */
  price?: number | null;
  /** Settlement / DVP date → L3. */
  settleDate?: string | null;
  /** Attaching options, as written in the mail → B2. */
  addOns?: string | null;
};

/** The Overview's data rows start here; rows 1-3 are the header block. */
export const OVERVIEW_FIRST_DATA_ROW = 4;

/** The sheet a new tab is copied from. */
export const TEMPLATE_SHEET = "Template";

/**
 * Sheets that are not deals.
 *
 * Kept as an explicit list rather than a pattern: `Options` and `Invoice` look
 * exactly like tickers, and a rule clever enough to exclude them would exclude
 * a real three-letter code eventually.
 */
export const NON_DEAL_SHEETS = new Set(["Template", "Index", "Invoice", "Options"]);

/**
 * Excel's serial day number for an ISO date.
 *
 * Dates must be written as numbers, not strings: `"2026-08-12"` lands in the
 * cell as TEXT, and the Overview's `=SHEET!B3` would then show the text while
 * every date comparison against it silently stops working. The epoch is
 * 1899-12-30 — Excel's deliberate off-by-one for the 1900 leap year that never
 * existed — and the arithmetic is done in UTC so a machine in Sydney and one in
 * London produce the same serial.
 */
export function excelSerialDate(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim());
  if (!m) return null;
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(utc)) return null;
  const serial = Math.round((utc - Date.UTC(1899, 11, 30)) / 86_400_000);
  return serial > 0 ? serial : null;
}

/**
 * A sheet name as it must appear inside a formula.
 *
 * Always quoted, even when it does not have to be. Excel needs quotes for names
 * with spaces (`'CBE (a)'`) and — less obviously — for anything that could be
 * read as a cell reference: the workbook already contains tabs called `BM1`,
 * `AR3`, `PC2` and `MC2`, and `=BM1!B3` is ambiguous enough that Excel rewrites
 * it. Quoting unconditionally removes the judgement call. An apostrophe inside
 * a name is escaped by doubling, which is Excel's own rule.
 */
export function formulaSheetRef(sheet: string): string {
  return `'${sheet.replace(/'/g, "''")}'`;
}

/**
 * The name for this deal's tab, given the sheets that already exist.
 *
 * A stock can be placed more than once in a year, and the desk's convention for
 * the second one is a letter suffix — the workbook holds `KNI` and `KNI (b)`,
 * `CBE (a)` and `CBE (b)`. So a clash is not an error to report, it is the
 * normal case for a repeat issuer, and the next free letter is taken.
 *
 * Returns null past `(z)`, which cannot happen for a real issuer and is not
 * worth inventing a scheme for — it becomes a reported failure instead of a
 * 27th sheet with a name nobody can predict.
 */
export function nextSheetName(ticker: string, existing: Iterable<string>): string | null {
  const taken = new Set([...existing].map((s) => s.trim().toLowerCase()));
  const base = ticker.trim().toUpperCase();
  if (!base) return null;

  if (!taken.has(base.toLowerCase())) return base;

  // `(a)` is skipped when the bare ticker is present: the bare name IS the first
  // one. It is only used when the desk has already renamed the original.
  for (let i = 0; i < 25; i++) {
    const suffixed = `${base} (${String.fromCharCode(98 + i)})`; // b, c, d…
    if (!taken.has(suffixed.toLowerCase())) return suffixed;
  }
  return null;
}

/** One cell to write on the newly created tab. */
export type CellWrite = {
  address: string;
  value: string | number;
  /** Set for dates, so the serial renders as a date rather than as 46,000. */
  numberFormat?: string;
};

/**
 * The cells that turn a copy of Template into this deal's tab.
 *
 * Only what the mail actually carries. Industry (C3), Lead Manager (E3), Seller
 * Fee (J3), Shares on Issue (G3) and Trading Resumes (M3) are left exactly as
 * Template has them — the desk fills those, and a guessed lead manager would
 * feed the fee split in rows 23-30 and turn an unknown into a number someone
 * downstream would reconcile against.
 */
export function tabCellWrites(deal: TrackerDeal): CellWrite[] {
  const writes: CellWrite[] = [{ address: "D3", value: deal.ticker.trim().toUpperCase() }];

  const issued = excelSerialDate(deal.issueDate);
  if (issued !== null) writes.push({ address: "B3", value: issued, numberFormat: "dd/mm/yyyy" });

  if (typeof deal.price === "number" && deal.price > 0) {
    writes.push({ address: "F3", value: deal.price });
  }

  const dvp = excelSerialDate(deal.settleDate);
  if (dvp !== null) writes.push({ address: "L3", value: dvp, numberFormat: "dd/mm/yyyy" });

  // B2 sits under the "Options" label and holds the attaching-options text, or
  // the word the desk uses when there are none.
  if (deal.addOns?.trim()) writes.push({ address: "B2", value: deal.addOns.trim() });

  return writes;
}

/**
 * The Overview row: a counter, a ticker, and sixteen formulas into the tab.
 *
 * The pattern is copied from the rows already in the file rather than invented.
 * Two of them are self-referential (`N` grosses `M` up by GST, `T` totals the
 * per-entity fees), so they need the row number they will live on.
 *
 * `F` — T2 Settlement — is deliberately left empty. Most rows have nothing in
 * it, and the few that do point at `L4`, a cell Template does not fill; a
 * formula there would render every new deal as settling on 0 January 1900.
 */
export function overviewRowFormulas(
  sheet: string,
  ticker: string,
  row: number,
  counter: number,
): (string | number)[] {
  const s = formulaSheetRef(sheet);
  return [
    counter, // B — the desk's own sequence number
    ticker.trim().toUpperCase(), // C — Counter (the stock), plain text
    `=${s}!B3`, // D — Date Issued
    `=${s}!L3`, // E — Settlement Date
    "", // F — T2 Settlement, filled by hand when a deal has one
    `=${s}!F3`, // G — Issue Price
    `=${s}!E3`, // H — Lead Manager
    `=${s}!O3`, // I — Trade Booked
    `=${s}!C6`, // J — Bid
    `=${s}!D6`, // K — Allocation
    `=${s}!F4`, // L — Ratio
    `=${s}!L30`, // M — Total Fee
    `=M${row}*(1.1)`, // N — Total Fee inc GST
    `=${s}!L25`, // O — VTC Fee
    `=${s}!L26`, // P — IZR Fee
    `=${s}!L27`, // Q — VIZ Fee
    `=${s}!L28`, // R — XX3 Fee
    `=${s}!L29`, // S — XX4 Fee
    `=O${row}+P${row}+Q${row}+R${row}+S${row}`, // T — All Fees
  ];
}

/** The range one Overview row occupies. B through T, matching the header. */
export function overviewRowAddress(sheetName: string, row: number): string {
  return `${formulaSheetRef(sheetName)}!B${row}:T${row}`;
}

/**
 * Where the next deal goes, read from the Overview's own B and C columns.
 *
 * Two things about the real sheet make this less obvious than it looks:
 *
 *  1. **The row is the first one with an empty TICKER, not an empty row.** The
 *     sheet is hundreds of rows of pre-formatted emptiness and its used range
 *     runs well past the data, so `lastRow + 1` lands in the middle of nowhere.
 *  2. **The counter follows the last DEAL, not the highest number in column B.**
 *     Column B is pre-numbered all the way down — row 188 already says 185 with
 *     nothing beside it — so "highest + 1" reads the scaffolding and jumps the
 *     sequence by thirty. The live file taught this one: the first attempt
 *     produced 218 for what should have been 185.
 */
export function nextOverviewSlot(
  rows: { counter: unknown; ticker: unknown }[],
): { row: number; counter: number } {
  let lastDealCounter = 0;
  let firstEmpty = -1;

  rows.forEach((cell, i) => {
    const hasTicker = String(cell.ticker ?? "").trim() !== "";
    if (hasTicker) {
      const n = Number(cell.counter);
      // The last row that is actually a deal wins, even if an earlier one
      // carries a higher number — the desk's sequence is what it is.
      if (Number.isFinite(n) && n > 0) lastDealCounter = n;
    } else if (firstEmpty === -1) {
      firstEmpty = i;
    }
  });

  const row =
    firstEmpty === -1
      ? OVERVIEW_FIRST_DATA_ROW + rows.length
      : OVERVIEW_FIRST_DATA_ROW + firstEmpty;

  return { row, counter: lastDealCounter + 1 };
}

/**
 * Has this deal already been written?
 *
 * Ticker AND issue date together, because a repeat placement in the same stock
 * is legitimate and must not be swallowed as a duplicate — that is what the
 * `(b)` suffix exists for. When the deal has no date, the ticker alone has to
 * do; writing a second tab for a deal we cannot date is the worse mistake.
 */
export function alreadyInOverview(
  rows: { ticker: unknown; issued: unknown }[],
  deal: TrackerDeal,
): boolean {
  const want = deal.ticker.trim().toUpperCase();
  const wantSerial = excelSerialDate(deal.issueDate);

  return rows.some((r) => {
    if (String(r.ticker ?? "").trim().toUpperCase() !== want) return false;
    if (wantSerial === null) return true;
    const got = Number(r.issued);
    return Number.isFinite(got) && Math.round(got) === wantSerial;
  });
}
