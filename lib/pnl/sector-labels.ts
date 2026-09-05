/**
 * One vocabulary for sectors.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `securities.sector` is filled by whatever source could classify the code, and
 * the sources do not agree on names. Yahoo says "Basic Materials", "Healthcare",
 * "Technology"; the ASX company directory says "Materials", "Health Care
 * Equipment & Services", "Software & Services". Stored raw, a portfolio holding
 * one of each draws two slices for the same exposure and a legend that reads
 * like a data-entry error.
 *
 * So every sector name is passed through `canonicalSector` on the way in (the
 * backfill) AND on the way out (`getSecurities`), and the chart only ever sees
 * the eleven GICS sectors. Doing it on read as well as on write is deliberate:
 * rows classified before this file existed still render correctly without
 * anybody having to re-run the backfill first.
 *
 * ── Why GICS sectors and not the ASX's industry groups ─────────────────────
 * The ASX directory publishes the 24 GICS *industry groups*, which is finer
 * than a pie chart wants — a register this size would draw slices for both
 * "Capital Goods" and "Transportation" where the question being asked is
 * "how much industrials". The 11 sectors are the standard level for exactly
 * this chart, and the group → sector rollup is fixed and published, so nothing
 * here is a judgement call.
 */

/** The eleven GICS sectors — the only labels the rest of the app should see. */
export const GICS_SECTORS = [
  "Energy",
  "Materials",
  "Industrials",
  "Consumer Discretionary",
  "Consumer Staples",
  "Health Care",
  "Financials",
  "Information Technology",
  "Communication Services",
  "Utilities",
  "Real Estate",
] as const;

export type GicsSector = (typeof GICS_SECTORS)[number];

/**
 * Everything that has ever been seen in this column, keyed by its normalised
 * form, mapped to the sector it belongs to.
 *
 * Three families of key:
 *   • the 24 GICS industry groups, as the ASX directory spells them;
 *   • Yahoo's own sector names, which are the values already in the table;
 *   • the eleven sector names themselves, so canonicalising twice is a no-op.
 *
 * A name that is not here is NOT guessed at — see `canonicalSector`.
 */
const BY_NAME: Record<string, GicsSector> = {};

const add = (sector: GicsSector, ...names: string[]) => {
  for (const n of names) BY_NAME[normalise(n)] = sector;
};

/** Case, punctuation and spacing vary between sources; the words do not. */
function normalise(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// ── GICS sectors (identity) ─────────────────────────────────────────────────
for (const s of GICS_SECTORS) add(s, s);

// ── GICS industry groups → sector (the ASX directory's vocabulary) ──────────
add("Energy", "Energy");
add("Materials", "Materials");
add("Industrials", "Capital Goods", "Commercial & Professional Services", "Transportation");
add(
  "Consumer Discretionary",
  "Automobiles & Components",
  "Consumer Durables & Apparel",
  "Consumer Services",
  "Retailing",
  "Consumer Discretionary Distribution & Retail",
);
add(
  "Consumer Staples",
  "Food & Staples Retailing",
  "Consumer Staples Distribution & Retail",
  "Food, Beverage & Tobacco",
  "Household & Personal Products",
);
add(
  "Health Care",
  "Health Care Equipment & Services",
  "Pharmaceuticals, Biotechnology & Life Sciences",
  "Healthcare",
);
add("Financials", "Banks", "Diversified Financials", "Financial Services", "Insurance");
add(
  "Information Technology",
  "Software & Services",
  "Technology Hardware & Equipment",
  "Semiconductors & Semiconductor Equipment",
  "Technology",
);
add("Communication Services", "Telecommunication Services", "Media & Entertainment", "Media");
add("Utilities", "Utilities");
add(
  "Real Estate",
  "Equity Real Estate Investment Trusts (REITs)",
  "Real Estate Management & Development",
  "Real Estate Investment Trusts",
);

// ── Yahoo's sector names, where they differ from GICS ───────────────────────
add("Materials", "Basic Materials");
add("Consumer Discretionary", "Consumer Cyclical");
add("Consumer Staples", "Consumer Defensive");

/**
 * The ASX publishes these two for companies it has not classified (a recent
 * listing, or a code that is not a company). Mapped to null so they read as
 * "not classified" rather than becoming sectors of their own.
 */
const NOT_A_SECTOR = new Set([normalise("Not Applic"), normalise("Class Pend")]);

/**
 * The GICS sector for a stored or freshly-fetched classification.
 *
 * Returns null for a blank, for the ASX's own "unclassified" placeholders, and
 * for anything not in the table above. Unrecognised is deliberately null and
 * not passed through: an unmapped name is a source this file does not know
 * about, and letting it through is how the chart grew two names for one sector
 * in the first place. It shows as "Other", which is the honest answer, and the
 * fix is to add the name here.
 */
export function canonicalSector(raw: string | null | undefined): GicsSector | null {
  if (!raw) return null;
  const key = normalise(raw);
  if (!key || NOT_A_SECTOR.has(key)) return null;
  return BY_NAME[key] ?? null;
}
