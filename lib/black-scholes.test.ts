import test from "node:test";
import assert from "node:assert/strict";
import {
  blackScholesCall,
  normalCdf,
  yearsToExpiry,
  UNLISTED_OPTION_ASSUMPTIONS,
  DAYS_PER_YEAR,
} from "./black-scholes.ts";

const near = (actual: number, expected: number, tol: number, label = "") =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${label} expected ~${expected} (±${tol}), got ${actual}`
  );

test("normalCdf - anchors and symmetry", async () => {
  near(normalCdf(0), 0.5, 1e-9, "N(0)");
  near(normalCdf(1), 0.8413447, 1e-6, "N(1)");
  near(normalCdf(-1), 0.1586553, 1e-6, "N(-1)");
  near(normalCdf(1.96), 0.9750021, 1e-6, "N(1.96)");
  // N(-x) = 1 - N(x) must hold exactly enough not to skew a price.
  for (const x of [0.3, 1.1, 2.4, 3.7]) {
    near(normalCdf(-x), 1 - normalCdf(x), 1e-9, `symmetry at ${x}`);
  }
  near(normalCdf(-8), 0, 1e-6, "far left tail");
  near(normalCdf(8), 1, 1e-6, "far right tail");
});

test("blackScholesCall - matches a known textbook value", async () => {
  // S=100, K=100, T=1, r=5%, q=0, vol=20% -> 10.4506 (standard reference case).
  const call = blackScholesCall({
    spot: 100,
    strike: 100,
    timeToExpiryYears: 1,
    volatility: 0.2,
    riskFreeRate: 0.05,
    dividendYield: 0,
  });
  near(call, 10.4506, 0.001, "ATM 1y call");
});

test("blackScholesCall - deep in/out of the money behave sanely", async () => {
  const base = {
    timeToExpiryYears: 1,
    volatility: UNLISTED_OPTION_ASSUMPTIONS.volatility,
    riskFreeRate: UNLISTED_OPTION_ASSUMPTIONS.riskFreeRate,
    dividendYield: UNLISTED_OPTION_ASSUMPTIONS.dividendYield,
  };

  // Deep ITM approaches spot - discounted strike.
  const itm = blackScholesCall({ ...base, spot: 10, strike: 0.01 });
  near(itm, 10 - 0.01 * Math.exp(-0.05), 0.01, "deep ITM");

  // Deep OTM is worth almost nothing but never negative.
  const otm = blackScholesCall({ ...base, spot: 0.01, strike: 10 });
  assert.ok(otm >= 0 && otm < 0.001, `deep OTM should be ~0, got ${otm}`);

  // Monotonic in spot.
  const lo = blackScholesCall({ ...base, spot: 0.05, strike: 0.1 });
  const hi = blackScholesCall({ ...base, spot: 0.15, strike: 0.1 });
  assert.ok(hi > lo, "call value must increase with spot");
});

test("blackScholesCall - degenerate inputs collapse to intrinsic, never NaN", async () => {
  const base = { volatility: 0.5, riskFreeRate: 0.05, dividendYield: 0 };

  // Expired: worth exactly what it is worth exercised.
  assert.equal(blackScholesCall({ ...base, spot: 0.2, strike: 0.14, timeToExpiryYears: 0 }), 0.2 - 0.14);
  assert.equal(blackScholesCall({ ...base, spot: 0.1, strike: 0.14, timeToExpiryYears: 0 }), 0);
  assert.equal(blackScholesCall({ ...base, spot: 0.2, strike: 0.14, timeToExpiryYears: -1 }), 0.2 - 0.14);

  // Zero volatility is also intrinsic — no uncertainty left to pay for.
  assert.equal(
    blackScholesCall({ ...base, volatility: 0, spot: 0.2, strike: 0.14, timeToExpiryYears: 2 }),
    0.2 - 0.14
  );

  // No spot (suspended / unquoted) is worth nothing, not NaN.
  assert.equal(blackScholesCall({ ...base, spot: 0, strike: 0.14, timeToExpiryYears: 1 }), 0);
  assert.equal(blackScholesCall({ ...base, spot: NaN, strike: 0.14, timeToExpiryYears: 1 }), 0);
  assert.equal(blackScholesCall({ ...base, spot: 0.2, strike: 0, timeToExpiryYears: 1 }), 0);

  // Nothing above may produce NaN — one NaN would poison a P&L total.
  for (const t of [0, -1, 1, NaN]) {
    for (const s of [0, NaN, 0.2]) {
      const v = blackScholesCall({ ...base, spot: s, strike: 0.14, timeToExpiryYears: t });
      assert.ok(Number.isFinite(v), `NaN leaked for spot=${s} T=${t}`);
    }
  }
});

test("yearsToExpiry - calendar-only, clamped at zero", async () => {
  const asOf = new Date("2026-08-04T00:00:00Z");

  near(yearsToExpiry(new Date("2027-08-04T00:00:00Z"), asOf), 365 / DAYS_PER_YEAR, 1e-9, "one year");
  near(yearsToExpiry(new Date("2026-08-05T00:00:00Z"), asOf), 1 / DAYS_PER_YEAR, 1e-9, "one day");

  // Same day and any past date are both 0 — never negative.
  assert.equal(yearsToExpiry(new Date("2026-08-04T00:00:00Z"), asOf), 0);
  assert.equal(yearsToExpiry(new Date("2020-01-01T00:00:00Z"), asOf), 0);

  // The clock time the calculator happened to be opened must not change the answer,
  // or the same file priced twice in one day gives two different numbers.
  const morning = yearsToExpiry(new Date("2027-12-31T00:00:00Z"), new Date("2026-08-04T01:00:00Z"));
  const evening = yearsToExpiry(new Date("2027-12-31T00:00:00Z"), new Date("2026-08-04T23:59:00Z"));
  assert.equal(morning, evening);
});
