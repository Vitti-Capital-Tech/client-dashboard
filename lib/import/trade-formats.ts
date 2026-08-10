import type { CsvRow } from "./csv.ts";

/**
 * The broker sends the trade ledger in more than one shape.
 *
 * The importer was written against a fuller export whose columns already say
 * what they mean (`CNote`, `Security`, `Value`, `Status` = `SETTLED`). The
 * scheduled mail carries a different report — `ContractNotesListing` — with the
 * same underlying data under different names and, more importantly, different
 * *encodings*: sides are `B`/`S`, statuses are single letters, and a sale's
 * units are negative.
 *
 * Rather than teach `parseTradeCsv` two dialects, this normalises the second
 * into the first. One mapping, in one file, that a person can read against a
 * sample row — and `trades.ts` keeps knowing exactly one shape.
 *
 * Every translation below is a decision, so each is written down:
 *
 *   • `B`/`S` → `BUY`/`SELL`. The only two values the export uses.
 *   • Units are made POSITIVE. The sign encodes the side, which `Type` already
 *     states; leaving it negative would trip the settled-units check and, worse,
 *     make a sale reduce the quantity sold.
 *   • `Nett` → `Value`. Verified against the data: for a BUY it is
 *     consideration + brokerage + GST, for a SELL consideration − brokerage −
 *     GST. That is exactly the fee-inclusive net cash flow the reducer needs.
 *   • Status `S` → `SETTLED`. Every other code is passed through UNCHANGED
 *     rather than being mapped to a guess. The desk confirmed only `S` counts
 *     toward P&L; what `R`, `V` and `P` mean precisely is not established, and
 *     inventing `CANCELLED` for one of them would put a specific claim into the
 *     audit trail that nobody made. Unknown codes are stored verbatim and are
 *     excluded from P&L by not being `SETTLED` — which is the whole requirement.
 *   • There is NO company name in this export. The field is left empty rather
 *     than filled with the account holder's name (which is what `Account Name`
 *     actually holds). Company names reach the database through the holdings
 *     snapshot, which does carry them.
 */

/**
 * The columns that identify a `ContractNotesListing` export.
 *
 * A subset — enough to be unambiguous without breaking if the broker adds a
 * column. Exported so `detectCsvKind` can recognise the file by its shape,
 * never by its filename.
 */
export const CONTRACT_NOTES_LISTING_HEADERS = [
  "C/Note Number",
  "Contract Status",
  "Type",
  "Account",
  "Security Code",
  "Contract Date",
  "Units",
  "Nett",
] as const;

export function isContractNotesListing(headers: string[]): boolean {
  const present = new Set(headers);
  return CONTRACT_NOTES_LISTING_HEADERS.every((h) => present.has(h));
}

/** `B` → `BUY`, `S` → `SELL`; anything else is left alone so it fails loudly. */
function side(raw: unknown): string {
  const v = String(raw ?? "").trim().toUpperCase();
  if (v === "B") return "BUY";
  if (v === "S") return "SELL";
  return v;
}

/**
 * Strip the sign from a quantity.
 *
 * A sale exports as `-58,824`. The minus is a second statement of the side,
 * which `Type` already made; carried through it would fail the settled-units
 * check and, if that check ever moved, quietly subtract from units sold.
 */
function magnitude(raw: unknown): string {
  const v = String(raw ?? "").trim();
  return v.startsWith("-") ? v.slice(1) : v;
}

/**
 * `S` is settled. Everything else keeps its own code.
 *
 * Deliberately not a lookup table: mapping `V` to `CANCELLED` would record a
 * meaning nobody has confirmed. Only `SETTLED` is load-bearing — the reducer
 * tests for exactly that string — so an unrecognised code is already excluded
 * from P&L while remaining honest about what the broker actually said.
 */
function status(raw: unknown): string {
  const v = String(raw ?? "").trim().toUpperCase();
  return v === "S" ? "SETTLED" : v;
}

/** Rewrite one `ContractNotesListing` row into the canonical column names. */
export function normaliseContractNotesRow(row: CsvRow): CsvRow {
  return {
    ...row,
    CNote: row["C/Note Number"] ?? "",
    Account: row["Account"] ?? "",
    Type: side(row["Type"]),
    Security: row["Security Code"] ?? "",
    // No company name in this export — see the note above.
    Company: "",
    "Contract Date": row["Contract Date"] ?? "",
    Units: magnitude(row["Units"]),
    Value: row["Nett"] ?? "",
    Status: status(row["Contract Status"]),
    // Present under the same names; named here so the mapping is complete
    // rather than half-explicit.
    "Avg Price": row["Avg Price"] ?? "",
    Consideration: row["Consideration"] ?? "",
    Brokerage: row["Brokerage"] ?? "",
    GST: row["GST"] ?? "",
    // Not itemised in this export. Zero rather than absent, because `Nett`
    // already includes whatever was charged — leaving it blank would be read as
    // "unknown" when it is really "already accounted for".
    "Other Charges": "0",
    Adviser: row["Adviser"] ?? "",
  };
}
