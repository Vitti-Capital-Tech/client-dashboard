import test from "node:test";
import assert from "node:assert/strict";

import { normaliseAccountNumber, accountNumberProblem } from "./account-number.ts";

/**
 * These are not cosmetic string tests. The database's partial unique index
 * (one pending claim per client per number) and the lookup that resolves a
 * claim on approval are both written in terms of the SQL
 * `normalise_account_number`; this function has to agree with it or a client
 * can hold two live claims on one account, or file one that never resolves.
 */

test("account number: whitespace and punctuation are not part of the number", () => {
  assert.equal(normaliseAccountNumber(" 1102004 "), "1102004");
  assert.equal(normaliseAccountNumber("1-102-004"), "1102004");
  assert.equal(normaliseAccountNumber("A/c 1102004"), "AC1102004");
});

test("account number: non-numeric refs are real, and survive upper-cased", () => {
  // 'PLACEVITT' is an actual account in the broker export, which is why the
  // rule cannot simply be "keep the digits".
  assert.equal(normaliseAccountNumber("placevitt"), "PLACEVITT");
  assert.equal(normaliseAccountNumber("PlaceVitt"), "PLACEVITT");
});

test("account number: the empty and the unusable are refused", () => {
  assert.ok(accountNumberProblem(""));
  assert.ok(accountNumberProblem("   "));
  assert.ok(accountNumberProblem("---"), "punctuation alone is not a number");
  assert.ok(accountNumberProblem("1".repeat(33)));
});

test("account number: a real ref passes, however it was typed", () => {
  assert.equal(accountNumberProblem("1102004"), null);
  assert.equal(accountNumberProblem(" 1102004"), null);
  assert.equal(accountNumberProblem("1 102 004"), null);
});

test("account number: normalising is idempotent", () => {
  // The stored value is already normalised, and approval normalises again on
  // both sides of the comparison. A second pass must not change it.
  const once = normaliseAccountNumber("A/c 1-102-004");
  assert.equal(normaliseAccountNumber(once), once);
});
