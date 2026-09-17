import assert from "node:assert/strict";
import { test } from "node:test";
import { priceDigits, priceText } from "./price.ts";

test("a sub-dollar price keeps its third decimal", () => {
  /**
   * The case this module was written for. `toFixed(2)` printed a $0.105
   * underlying as `$0.11` — rounding it UP past a $0.10 strike, so a 5% edge
   * read as a 10% one in an alert whose whole subject is the gap between them.
   */
  assert.equal(priceText(0.105), "$0.105");
  assert.equal(priceText(0.1), "$0.10");
  assert.equal(priceText(0.012), "$0.012");
});

test("a dollar price does not grow a trailing zero", () => {
  // "Up to" three, not exactly three: `$40.250` claims a precision the quote
  // does not have.
  assert.equal(priceText(40.25), "$40.25");
  assert.equal(priceText(40), "$40.00");
  assert.equal(priceText(40.125), "$40.125");
});

test("thousands are separated", () => {
  assert.equal(priceText(1234.5), "$1,234.50");
});

test("a fourth decimal rounds to the third", () => {
  // Deliberate: three places is the limit. Strikes quoted in fractions of a
  // cent keep four, through the options tables' own `money4`.
  assert.equal(priceText(0.10549), "$0.105");
  assert.equal(priceText(0.10551), "$0.106");
});

test("no price is an em dash, never zero", () => {
  // A security we have no quote for is not a security worth nothing, and
  // `$0.00` is the wrong answer to "what is this trading at".
  assert.equal(priceText(null), "—");
  assert.equal(priceText(undefined), "—");
  assert.equal(priceText(Number.NaN), "—");
  assert.equal(priceText(Number.POSITIVE_INFINITY), "—");
  // Zero itself is a real quote and is printed.
  assert.equal(priceText(0), "$0.00");
});

test("negatives keep their sign, for callers that have one", () => {
  assert.equal(priceText(-0.105), "-$0.105");
});

test("priceDigits omits the symbol for callers that add their own", () => {
  assert.equal(priceDigits(0.105), "0.105");
  assert.equal(priceDigits(40.25), "40.25");
});
