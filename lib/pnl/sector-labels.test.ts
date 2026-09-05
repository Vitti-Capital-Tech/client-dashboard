import test from "node:test";
import assert from "node:assert/strict";

import { canonicalSector, GICS_SECTORS } from "./sector-labels.ts";

/**
 * The point of this file is that two sources describing the same exposure end
 * up as one slice. Everything below is a pair of names that must agree, or a
 * name that must NOT be invented into a sector.
 */

test("sector labels: Yahoo and ASX names for one sector agree", () => {
  // Yahoo's name, then the ASX industry group(s) under that sector.
  const pairs: [string, string][] = [
    ["Basic Materials", "Materials"],
    ["Healthcare", "Pharmaceuticals, Biotechnology & Life Sciences"],
    ["Healthcare", "Health Care Equipment & Services"],
    ["Technology", "Software & Services"],
    ["Technology", "Technology Hardware & Equipment"],
    ["Financial Services", "Banks"],
    ["Consumer Cyclical", "Consumer Discretionary Distribution & Retail"],
    ["Consumer Defensive", "Food, Beverage & Tobacco"],
    ["Industrials", "Capital Goods"],
    ["Industrials", "Transportation"],
    ["Communication Services", "Media & Entertainment"],
    ["Real Estate", "Equity Real Estate Investment Trusts (REITs)"],
  ];

  for (const [yahoo, asx] of pairs) {
    const a = canonicalSector(yahoo);
    assert.equal(a, canonicalSector(asx), `${yahoo} vs ${asx}`);
    assert.ok(a && GICS_SECTORS.includes(a), `${yahoo} → a GICS sector`);
  }
});

test("sector labels: every GICS industry group the ASX publishes maps somewhere", () => {
  // The 24 groups exactly as they appear in the ASX listed-companies directory.
  const groups = [
    "Energy",
    "Materials",
    "Capital Goods",
    "Commercial & Professional Services",
    "Transportation",
    "Automobiles & Components",
    "Consumer Durables & Apparel",
    "Consumer Services",
    "Consumer Discretionary Distribution & Retail",
    "Consumer Staples Distribution & Retail",
    "Food, Beverage & Tobacco",
    "Household & Personal Products",
    "Health Care Equipment & Services",
    "Pharmaceuticals, Biotechnology & Life Sciences",
    "Banks",
    "Financial Services",
    "Insurance",
    "Software & Services",
    "Technology Hardware & Equipment",
    "Semiconductors & Semiconductor Equipment",
    "Telecommunication Services",
    "Media & Entertainment",
    "Utilities",
    "Equity Real Estate Investment Trusts (REITs)",
    "Real Estate Management & Development",
  ];

  for (const g of groups) {
    assert.ok(canonicalSector(g), `${g} has no sector`);
  }
});

test("sector labels: canonicalising twice changes nothing", () => {
  for (const s of GICS_SECTORS) assert.equal(canonicalSector(s), s);
});

test("sector labels: spelling, case and punctuation do not matter", () => {
  assert.equal(canonicalSector("health care"), "Health Care");
  assert.equal(canonicalSector("  Basic   Materials "), "Materials");
  assert.equal(canonicalSector("Commercial and Professional Services"), "Industrials");
});

test("sector labels: unclassified stays unclassified", () => {
  // The ASX's own placeholders, and anything nobody has mapped.
  assert.equal(canonicalSector("Not Applic"), null);
  assert.equal(canonicalSector("Class Pend"), null);
  assert.equal(canonicalSector(""), null);
  assert.equal(canonicalSector(null), null);
  assert.equal(canonicalSector("Wombat Futures"), null);
});
