import { parseCsvRecords, requireHeaders } from "./csv.ts";
import {
  clean,
  cleanOrNull,
  initialsOf,
  money,
  num,
  numOrNull,
  parentCode,
  securityClass,
  titleCase,
} from "./normalize.ts";
import type { RowError } from "./trades.ts";

/**
 * Holdings snapshot — the broker's "what is held right now" export.
 *
 * One row per account × security. Unlike the trade ledger this file carries a
 * Market Price, which is the only price source the platform currently has, so
 * it feeds `securities.last_price` as well as `positions`.
 *
 * Columns:
 *   Organisation Code, Branch Code, Branch Name, Status, Account Number,
 *   Account Name, Client Address (Line 1..5), Client Address Country,
 *   Advisor Code, Advisor Name, Security Code, Company Name,
 *   Short Company Name, Security description, Holding Qty, Market Price,
 *   Market Value, Franking, Dividend per Share, Yield (%),
 *   Dividend Rate per Share, Average Cost, Portfolio Value, Security Type,
 *   Security Class
 */

/**
 * Exported because these columns are also how a file is IDENTIFIED as a
 * holdings snapshot — see `detectCsvKind`. Filenames are a broker's convention
 * and change without notice; the column set is the shape itself.
 */
export const HOLDINGS_REQUIRED_HEADERS = [
  "Account Number",
  "Account Name",
  "Security Code",
  "Company Name",
  "Holding Qty",
  "Market Price",
  "Average Cost",
] as const;

const REQUIRED = HOLDINGS_REQUIRED_HEADERS;

export type ParsedHolding = {
  accountRef: string;
  accountName: string;
  accountStatus: string | null;
  adviserCode: string | null;
  adviserName: string | null;
  address: string | null;

  rawSecurity: string;
  parent: string;
  companyName: string;
  description: string | null;
  securityClass: string;

  qty: number;
  marketPrice: number | null;
  marketValue: number;
  avgCost: number;
  costBase: number;
};

export function parseHoldingsCsv(text: string): {
  holdings: ParsedHolding[];
  errors: RowError[];
} {
  const { headers, rows } = parseCsvRecords(text);
  requireHeaders(headers, REQUIRED);

  const holdings: ParsedHolding[] = [];
  const errors: RowError[] = [];

  rows.forEach((row, i) => {
    try {
      const rawSecurity = clean(row["Security Code"]).toUpperCase();
      const address = [1, 2, 3, 4, 5]
        .map((n) => clean(row[`Client Address (Line ${n})`]))
        .filter(Boolean)
        .join(", ");

      holdings.push({
        accountRef: clean(row["Account Number"]),
        accountName: clean(row["Account Name"]),
        accountStatus: cleanOrNull(row["Status"]),
        adviserCode: cleanOrNull(row["Advisor Code"]),
        adviserName: cleanOrNull(row["Advisor Name"]),
        address: address || null,

        rawSecurity,
        parent: parentCode(rawSecurity),
        companyName: clean(row["Company Name"]),
        description: cleanOrNull(row["Security description"]),
        securityClass: securityClass(
          row["Security Type"],
          row["Security Class"],
          rawSecurity,
        ),

        qty: num(row["Holding Qty"]),
        marketPrice: numOrNull(row["Market Price"]),
        marketValue: money(num(row["Market Value"])),
        avgCost: num(row["Average Cost"]),
        costBase: money(num(row["Portfolio Value"])),
      });
    } catch (err) {
      errors.push({ line: i + 2, reason: (err as Error).message, row });
    }
  });

  return { holdings, errors };
}

// ---------------------------------------------------------------------------
// Derived entity sets
// ---------------------------------------------------------------------------

export type ParsedAccount = {
  externalRef: string;
  rawName: string;
  displayName: string;
  initials: string;
  adviserCode: string | null;
  adviserName: string | null;
  status: string | null;
  address: string | null;
};

/**
 * One account per Account Number. The broker export models a person/entity and
 * their account as the same thing, so each becomes one `clients` row owning one
 * `accounts` row; the existing multi-account schema then lets staff merge them
 * later without any further migration.
 */
export function extractAccounts(holdings: ParsedHolding[]): ParsedAccount[] {
  const byRef = new Map<string, ParsedAccount>();
  for (const h of holdings) {
    if (byRef.has(h.accountRef)) continue;
    byRef.set(h.accountRef, {
      externalRef: h.accountRef,
      rawName: h.accountName,
      displayName: titleCase(h.accountName),
      initials: initialsOf(h.accountName),
      adviserCode: h.adviserCode,
      adviserName: h.adviserName,
      status: h.accountStatus,
      address: h.address,
    });
  }
  return [...byRef.values()].sort((a, b) =>
    a.externalRef.localeCompare(b.externalRef),
  );
}

export type ParsedSecurity = {
  code: string;
  parent: string | null; // null when the row IS the ordinary
  name: string;
  description: string | null;
  securityClass: string;
  lastPrice: number | null;
};

/**
 * Every distinct security code, plus a synthetic ordinary row for any parent
 * that only ever appears as a derivative — `securities.parent_code` is a real
 * foreign key, so 'EOS' must exist before 'EOSXX' can point at it.
 *
 * Extra codes seen only in the trade ledger (sold out since the snapshot was
 * taken) are passed in via `alsoInclude` so their trades still satisfy the FK.
 */
export function extractSecurities(
  holdings: ParsedHolding[],
  alsoInclude: { code: string; name: string }[] = [],
): ParsedSecurity[] {
  const byCode = new Map<string, ParsedSecurity>();

  const put = (s: ParsedSecurity) => {
    const existing = byCode.get(s.code);
    // Prefer whichever record carries a price (the snapshot) over a bare
    // ledger-derived stub.
    if (!existing || (existing.lastPrice === null && s.lastPrice !== null)) {
      byCode.set(s.code, { ...existing, ...s });
    }
  };

  for (const h of holdings) {
    put({
      code: h.rawSecurity,
      parent: h.rawSecurity === h.parent ? null : h.parent,
      name: h.companyName,
      description: h.description,
      securityClass: h.securityClass,
      lastPrice: h.marketPrice,
    });
  }

  for (const extra of alsoInclude) {
    const code = extra.code.trim().toUpperCase();
    if (byCode.has(code)) continue;
    const parent = parentCode(code);
    put({
      code,
      parent: code === parent ? null : parent,
      name: extra.name,
      description: null,
      securityClass: code === parent ? "Ordinary" : "Options",
      lastPrice: null,
    });
  }

  // Backfill missing ordinaries so parent_code always resolves.
  for (const s of [...byCode.values()]) {
    if (s.parent && !byCode.has(s.parent)) {
      byCode.set(s.parent, {
        code: s.parent,
        parent: null,
        name: s.name,
        description: null,
        securityClass: "Ordinary",
        lastPrice: null,
      });
    }
  }

  return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
}
