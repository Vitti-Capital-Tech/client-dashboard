import test from "node:test";
import assert from "node:assert/strict";

import {
  EXPIRY_FILTERS,
  formatExpiryDate,
  matchesExpiryFilter,
  optionExpiry,
  timeToExpiryLabel,
} from "./time-to-expiry.ts";

test("time-to-expiry: days while it matters, months and years beyond", () => {
  assert.equal(timeToExpiryLabel(null), "—");
  assert.equal(timeToExpiryLabel(0), "Expires today");
  assert.equal(timeToExpiryLabel(1), "1 day");
  assert.equal(timeToExpiryLabel(45), "45 days");
  assert.equal(timeToExpiryLabel(60), "60 days");
  // Past two months a day count stops being readable as a time.
  assert.equal(timeToExpiryLabel(152), "5 months");
  assert.equal(timeToExpiryLabel(365), "1 yr");
  assert.equal(timeToExpiryLabel(456), "1 yr 3 mo");
  // The last days before an anniversary must not read "1 yr 12 mo".
  assert.equal(timeToExpiryLabel(728), "2 yr");
});

test("time-to-expiry: an expired option says so, and how long ago", () => {
  assert.equal(timeToExpiryLabel(-1), "Expired 1 day ago");
  assert.equal(timeToExpiryLabel(-40), "Expired 40 days ago");
});

test("time-to-expiry: 'within' filters are cumulative and never include the expired", () => {
  // 20 days out is within 30, 90 and 12 months — the question is "before when?".
  assert.equal(matchesExpiryFilter(20, "30d"), true);
  assert.equal(matchesExpiryFilter(20, "90d"), true);
  assert.equal(matchesExpiryFilter(20, "12m"), true);
  assert.equal(matchesExpiryFilter(20, "later"), false);

  // A lapsed option is not one about to lapse.
  for (const f of ["30d", "90d", "12m", "later"] as const) {
    assert.equal(matchesExpiryFilter(-5, f), false, f);
  }
  assert.equal(matchesExpiryFilter(-5, "expired"), true);

  assert.equal(matchesExpiryFilter(400, "later"), true);
  assert.equal(matchesExpiryFilter(400, "12m"), false);
});

test("time-to-expiry: an option with no date is findable, and only under its own filter", () => {
  assert.equal(matchesExpiryFilter(null, "unknown"), true);
  assert.equal(matchesExpiryFilter(null, "all"), true);
  for (const f of EXPIRY_FILTERS.filter((x) => x !== "unknown" && x !== "all")) {
    assert.equal(matchesExpiryFilter(null, f), false, f);
  }
});

test("time-to-expiry: the stored date wins, the series name is the fallback", () => {
  assert.equal(optionExpiry({ expiry: "2027-06-30", name: "X OPTION 01-JAN-30" }).date, "2027-06-30");
  // A listed series carries its expiry only in its name.
  assert.equal(optionExpiry({ expiry: null, name: "ELECTRO OPTIC OPTION 30-JUN-27" }).date, "2027-06-30");
  // Neither → no guess.
  assert.deepEqual(optionExpiry({ expiry: null, name: "ACME OPTIONS" }), { date: null, dte: null });
});

test("time-to-expiry: dates read the way people write them", () => {
  assert.equal(formatExpiryDate("2027-06-30"), "30 Jun 2027");
  assert.equal(formatExpiryDate("2026-01-05"), "5 Jan 2026");
  assert.equal(formatExpiryDate(null), "—");
});
