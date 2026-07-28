import type { TradeRow } from "../data/queries";
import type { RealizedSummary } from "../data/compute";

/**
 * CSV export for the Order History tab.
 *
 * Pure and client-safe — no DOM, no server imports — so the download handler
 * stays a two-liner and the format itself is unit-testable.
 *
 * SHAPE: the file mirrors what is on screen, which means two grains in one
 * table (a company's realised result, then the contract notes behind it).
 * Rather than repeat the realised figure on every trade row — where a careless
 * SUM would multiply it by the trade count — each row is tagged in a leading
 * `Row type` column:
 *
 *   SUMMARY  one per company: units sold, realised P&L, data-quality flags
 *   TRADE    one per contract note line: the money detail
 *
 * Filtering on that column in Excel gives either grain cleanly, and summing a
 * money column never mixes the two.
 */

export type ExportGroup = {
  parent: string;
  name: string;
  trades: TradeRow[];
  realized: RealizedSummary | null;
};

const HEADERS = [
  "Row type",
  "Ticker",
  "Company",
  "Contract note",
  "Date",
  "Side",
  "Traded code",
  "Instrument",
  "Units",
  "Avg price",
  "Consideration",
  "Brokerage",
  "Other charges",
  "GST",
  "Value",
  "Status",
  "Units sold",
  "Proceeds",
  "Cost of sold",
  "Realised P&L",
  "Fees",
  "First trade",
  "Last trade",
  "Cost basis",
] as const;

/**
 * RFC 4180 field. Quote whenever the value could otherwise break the row, and
 * double any embedded quote. Company names really do contain commas
 * ("SMITH, JOHN + JANE"), so this is not theoretical.
 */
function field(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Money and prices export unrounded to the cent — never as whole dollars. */
const money = (n: number): string => n.toFixed(2);

export function buildOrderHistoryCsv(groups: ExportGroup[]): string {
  const rows: string[] = [HEADERS.join(",")];

  for (const g of groups) {
    const rz = g.realized;
    const sold = (rz?.unitsSold ?? 0) > 0;

    rows.push(
      [
        "SUMMARY",
        g.parent,
        g.name,
        "", // contract note
        "", // date
        "", // side
        "", // traded code
        "", // instrument
        "", // units
        "", // avg price
        "", // consideration
        "", // brokerage
        "", // other charges
        "", // gst
        "", // value
        "", // status
        sold ? rz!.unitsSold : "",
        sold ? money(rz!.proceeds) : "",
        sold ? money(rz!.costOfSold) : "",
        sold ? money(rz!.realizedPl) : "",
        rz ? money(rz.fees) : "",
        rz?.firstTrade ?? "",
        rz?.lastTrade ?? "",
        // Say plainly whether the realised figure can be trusted, so the number
        // never travels into a spreadsheet without its caveat attached.
        !sold
          ? "still open"
          : rz!.shortHistory
            ? "MISSING - sold units never bought; realised P&L overstated"
            : rz!.hasPartial
              ? "approximate - partial close of a mixed-price parcel"
              : "complete",
      ]
        .map(field)
        .join(","),
    );

    for (const t of g.trades) {
      rows.push(
        [
          "TRADE",
          g.parent,
          g.name,
          t.cnote,
          t.tradeDate,
          t.side,
          t.code,
          t.instrument ?? "",
          t.units,
          t.avgPrice,
          money(t.consideration),
          money(t.brokerage),
          money(t.otherCharges),
          money(t.gst),
          money(t.value),
          t.status,
          "", // units sold
          "", // proceeds
          "", // cost of sold
          "", // realised
          "", // fees
          "", // first trade
          "", // last trade
          "", // cost basis
        ]
          .map(field)
          .join(","),
      );
    }
  }

  // CRLF is the RFC 4180 line ending and the one Excel is happiest with.
  return rows.join("\r\n");
}

/** `order-history-sri-guru-nanak-pty-ltd-2026-07-28.csv` */
export function orderHistoryFilename(
  clientName: string,
  accountLabel: string | null,
  isoDate: string,
): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");

  return [
    "order-history",
    slug(clientName),
    accountLabel ? slug(accountLabel) : null,
    isoDate,
  ]
    .filter(Boolean)
    .join("-")
    .concat(".csv");
}
