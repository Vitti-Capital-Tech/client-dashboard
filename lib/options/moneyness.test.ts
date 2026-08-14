import test from "node:test";
import assert from "node:assert/strict";

import { moneynessOf, UNKNOWN_MONEYNESS } from "./moneyness.ts";

/**
 * The badge is a claim about money, so these cover the two things that make it
 * wrong on screen: calling a row ITM when it is not, and reporting an exercise
 * value the strike and spot beside it do not produce.
 */

test("moneyness: a call above its strike is ITM and worth the difference", () => {
  const m = moneynessOf({ spot: 0.22, strike: 0.14, qty: 50_000 });
  assert.equal(m.moneyness, "ITM");
  assert.equal(m.isItm, true);
  assert.ok(Math.abs(m.intrinsicPerOption - 0.08) < 1e-9);
  assert.ok(Math.abs(m.intrinsicValue - 4000) < 1e-6, "50,000 × $0.08");
});

test("moneyness: a call below its strike is OTM and worth nothing to exercise", () => {
  const m = moneynessOf({ spot: 0.09, strike: 0.14, qty: 50_000 });
  assert.equal(m.moneyness, "OTM");
  assert.equal(m.isItm, false);
  assert.equal(m.intrinsicValue, 0, "never negative — nobody exercises at a loss");
});

test("moneyness: within a tenth of a cent is ATM, not ITM by floating-point noise", () => {
  const spot = 0.1 + 0.04; // 0.14000000000000001
  assert.equal(moneynessOf({ spot, strike: 0.14, qty: 1000 }).moneyness, "ATM");
  // A real tick's difference is still a real difference.
  assert.equal(moneynessOf({ spot: 0.141, strike: 0.14, qty: 1000 }).moneyness, "ITM");
});

test("moneyness: a put is ITM on the other side of the strike", () => {
  const m = moneynessOf({ spot: 0.09, strike: 0.14, qty: 1000, kind: "Put" });
  assert.equal(m.moneyness, "ITM");
  assert.ok(Math.abs(m.intrinsicValue - 50) < 1e-9, "1,000 × $0.05");
  assert.equal(moneynessOf({ spot: 0.22, strike: 0.14, kind: "Put" }).moneyness, "OTM");
});

test("moneyness: an unknown strike or spot claims nothing", () => {
  // The badge has to be absent rather than guessed: a missing strike is a row
  // the tracker could not parse, and "OTM" would read as a finding.
  for (const args of [
    { spot: 0.22, strike: null },
    { spot: null, strike: 0.14 },
    { spot: 0.22, strike: 0 },
    { spot: Number.NaN, strike: 0.14 },
    { spot: 0.22, strike: Number.POSITIVE_INFINITY },
  ]) {
    const m = moneynessOf({ ...args, qty: 1000 });
    assert.equal(m.moneyness, "unknown", JSON.stringify(args));
    assert.equal(m.isItm, false);
    assert.equal(m.intrinsicValue, 0);
  }
});

test("moneyness: the no-verdict constant totals as zero and badges as nothing", () => {
  // Passed deliberately for LISTED series, which trade on their own market and
  // have no intrinsic figure worth reporting. It has to be inert: the register
  // sums `intrinsicValue` across every row to fill the ITM total.
  assert.equal(UNKNOWN_MONEYNESS.moneyness, "unknown");
  assert.equal(UNKNOWN_MONEYNESS.isItm, false);
  assert.equal(UNKNOWN_MONEYNESS.intrinsicValue, 0);
  assert.equal(UNKNOWN_MONEYNESS.intrinsicPerOption, 0);
});

test("moneyness: quantity scales the value but never the verdict", () => {
  const base = { spot: 0.22, strike: 0.14 };
  assert.equal(moneynessOf({ ...base }).moneyness, "ITM");
  assert.equal(moneynessOf({ ...base }).intrinsicValue, 0, "no qty, no parcel value");
  // Unlisted option rows carry their count as a NEGATIVE open quantity, so the
  // magnitude is what the parcel is worth — a sign flip must not zero it.
  assert.ok(
    Math.abs(moneynessOf({ ...base, qty: -50_000 }).intrinsicValue - 4000) < 1e-6,
  );
});
