import assert from "node:assert/strict";
import { test } from "node:test";
import {
  daysBetween,
  edgePct,
  ladderRung,
  scanBook,
  scanOption,
  type OptionScanState,
  type ScannableOption,
} from "./scan.ts";

const OPT: ScannableOption = {
  id: "opt-1",
  clientId: "cl-1",
  code: "MRD",
  listed: false,
  type: "Call",
  qty: 100_000,
  strike: 0.5,
  under: 0.4,
  expiryDate: "2026-12-31",
  status: "open",
};

const opt = (over: Partial<ScannableOption> = {}): ScannableOption => ({ ...OPT, ...over });
const TODAY = "2026-09-15";
/** Expiry `n` days after TODAY. */
const inDays = (n: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + n * 86_400_000)
  .toISOString()
  .slice(0, 10);

const keys = (o: ScannableOption, prev: OptionScanState | null = null) =>
  scanOption(o, TODAY, prev).alerts.map((a) => a.key);
const kinds = (o: ScannableOption, prev: OptionScanState | null = null) =>
  scanOption(o, TODAY, prev).alerts.map((a) => a.kind);

/* ───────────────────────────── the arithmetic ───────────────────────────── */

test("daysBetween counts whole days and has no clock in it", () => {
  assert.equal(daysBetween("2026-09-15", "2026-09-15"), 0);
  assert.equal(daysBetween("2026-09-15", "2026-09-16"), 1);
  assert.equal(daysBetween("2026-09-15", "2026-09-14"), -1);
  // Across the Sydney daylight-saving changeover, which is why both sides are
  // parsed at UTC midnight rather than through a local Date.
  assert.equal(daysBetween("2026-10-03", "2026-10-05"), 2);
});

test("the ladder reports the NARROWEST rung a date falls in", () => {
  assert.equal(ladderRung(45), null);
  assert.equal(ladderRung(30), 30);
  assert.equal(ladderRung(15), 30);
  assert.equal(ladderRung(14), 14);
  assert.equal(ladderRung(6), 7);
  assert.equal(ladderRung(1), 1);
  assert.equal(ladderRung(0), 1);
  assert.equal(ladderRung(-1), null);
});

/* ─────────────────────────── what does not alert ────────────────────────── */

test("an expiry beyond the widest rung says nothing", () => {
  assert.deepEqual(keys(opt({ expiryDate: inDays(45), under: 0.4 })), []);
});

test("an already-expired grant says nothing — the warning was due before it lapsed", () => {
  assert.deepEqual(keys(opt({ expiryDate: inDays(-1) })), []);
});

test("pending and expired rows are not live positions", () => {
  for (const status of ["pending", "expired"] as const) {
    const result = scanOption(opt({ status, expiryDate: inDays(5) }), TODAY, null);
    assert.deepEqual(result.alerts, []);
    assert.equal(result.state, null, "state is dropped with the position");
  }
});

/* ──────────────────────── the alert this exists for ─────────────────────── */

test("unlisted, in the money, window closing — red, and says nothing will do it for them", () => {
  const { alerts } = scanOption(opt({ expiryDate: inDays(12), under: 0.8 }), TODAY, null);
  const window_ = alerts.find((a) => a.kind === "window");
  assert.ok(window_, "no window alert");
  assert.equal(window_.severity, "red");
  assert.match(window_.subtitle, /not exercised automatically/);
  // 100,000 × (0.80 − 0.50). Separated, because a client reads this figure and
  // `$30000.00` is not how anyone writes thirty thousand dollars.
  assert.match(window_.subtitle, /exercise value \$30,000\.00/);
});

test("a LISTED series in the same position is not the red case", () => {
  // It is quoted and can be sold on its own market, so a holder who does
  // nothing still owns something tradeable. Only the deadline is reported.
  const { alerts } = scanOption(
    opt({ listed: true, expiryDate: inDays(12), under: 0.8 }),
    TODAY,
    null,
  );
  assert.deepEqual(alerts.map((a) => a.kind), ["expiry", "itm"]);
  assert.equal(alerts.find((a) => a.kind === "expiry")?.severity, "amber");
});

test("an out-of-the-money unlisted grant near expiry gets the deadline, not the red", () => {
  const { alerts } = scanOption(opt({ expiryDate: inDays(5), under: 0.2 }), TODAY, null);
  assert.deepEqual(alerts.map((a) => a.kind), ["expiry"]);
  assert.equal(alerts[0].severity, "amber");
});

test("ATM counts as exercisable, matching what the registers already colour", () => {
  const { alerts } = scanOption(
    opt({ expiryDate: inDays(9), under: 0.5, strike: 0.5 }),
    TODAY,
    null,
  );
  assert.ok(alerts.some((a) => a.kind === "window"));
});

/* ─────────────────────────────── the dedupe ─────────────────────────────── */

test("the same day scanned twice produces identical keys", () => {
  // The whole idempotence claim. Same input, same keys, so the unique index
  // swallows the second run.
  const o = opt({ expiryDate: inDays(12), under: 0.8 });
  const first = scanOption(o, TODAY, null);
  const second = scanOption(o, TODAY, first.state);
  assert.deepEqual(
    second.alerts.map((a) => a.key),
    first.alerts.filter((a) => a.kind !== "itm").map((a) => a.key),
    "only the ITM crossing should not repeat",
  );
});

test("sitting in the same rung for a second day repeats the key", () => {
  // 6 days and 5 days are both the 7-day rung, so it is one event, not two.
  const state = { moneyness: "OTM" as const, spell: 0, inSpell: false };
  assert.deepEqual(
    keys(opt({ expiryDate: inDays(6), under: 0.2 }), state),
    keys(opt({ expiryDate: inDays(5), under: 0.2 }), state),
  );
});

test("dropping to the next rung is a new event", () => {
  const state = { moneyness: "OTM" as const, spell: 0, inSpell: false };
  assert.notDeepEqual(
    keys(opt({ expiryDate: inDays(8), under: 0.2 }), state),
    keys(opt({ expiryDate: inDays(3), under: 0.2 }), state),
  );
});

test("the window alert escalates down the ladder on purpose", () => {
  // A client who ignored 14 days is told again at 7, 3 and 1. This is the one
  // place repetition is the point rather than noise.
  const state = { moneyness: "ITM" as const, spell: 1, inSpell: true };
  const at = (d: number) =>
    scanOption(opt({ expiryDate: inDays(d), under: 0.8 }), TODAY, state).alerts.find(
      (a) => a.kind === "window",
    )?.key;
  assert.deepEqual([at(14), at(7), at(3), at(1)], [
    "window:opt-1:14",
    "window:opt-1:7",
    "window:opt-1:3",
    "window:opt-1:1",
  ]);
});

/* ───────────────────────── moneyness crossings ──────────────────────────── */

test("in the money for a second day is not a second alert", () => {
  const far = opt({ expiryDate: inDays(25), under: 0.8 });
  const first = scanOption(far, TODAY, null);
  assert.ok(first.alerts.some((a) => a.kind === "itm"));
  const second = scanOption(far, TODAY, first.state);
  assert.equal(second.alerts.some((a) => a.kind === "itm"), false);
});

test("out and back in again is two events", () => {
  const far = (under: number) => opt({ expiryDate: inDays(25), under });
  const a = scanOption(far(0.8), TODAY, null);
  const b = scanOption(far(0.2), TODAY, a.state); // falls out
  const c = scanOption(far(0.9), TODAY, b.state); // crosses back in
  const first = a.alerts.find((x) => x.kind === "itm");
  const again = c.alerts.find((x) => x.kind === "itm");
  assert.ok(first && again);
  assert.notEqual(first.key, again.key, "the second crossing must not be swallowed");
  assert.equal(c.state?.spell, 2);
});

test("a missing price does not end the spell", () => {
  /**
   * The subtle one. If `unknown` were treated as "went out of the money", a
   * day with no quote would end the spell and the next quote would read as a
   * fresh crossing — firing a second alert about a grant that never moved.
   */
  const far = (under: number | null) => opt({ expiryDate: inDays(25), under });
  const a = scanOption(far(0.8), TODAY, null);
  const b = scanOption(far(null), TODAY, a.state);
  assert.equal(b.state?.moneyness, "ITM", "the last known verdict is kept");
  const c = scanOption(far(0.8), TODAY, b.state);
  assert.equal(c.alerts.some((x) => x.kind === "itm"), false, "no second alert");
});

test("one grant never produces two rows about the same thing on one morning", () => {
  // Unlisted, ITM, inside the window: the red alert says everything the green
  // one would, so the green is suppressed.
  assert.deepEqual(kinds(opt({ expiryDate: inDays(10), under: 0.8 })), ["expiry", "window"]);
});

/* ────────────────────────────── the whole book ──────────────────────────── */

test("scanBook carries state per option and returns it to be stored", () => {
  const book = [
    opt({ id: "a", expiryDate: inDays(25), under: 0.8 }),
    opt({ id: "b", expiryDate: inDays(3), under: 0.9 }),
    opt({ id: "c", expiryDate: inDays(90), under: 0.1 }),
  ];
  const { alerts, states } = scanBook(book, TODAY, new Map());
  assert.equal(states.size, 3, "every live option is remembered");
  assert.ok(alerts.some((a) => a.optionId === "a" && a.kind === "itm"));
  assert.ok(alerts.some((a) => a.optionId === "b" && a.kind === "window"));
  assert.equal(alerts.some((a) => a.optionId === "c"), false, "90 days away is not news");

  // Re-running with the returned state is silent for the crossing alerts.
  const again = scanBook(book, TODAY, states);
  assert.equal(again.alerts.some((a) => a.kind === "itm"), false);
});

test("alert keys are unique within a single run", () => {
  // Two rows with the same key in one insert batch would fail the unique index
  // and take the whole batch with them.
  const book = Array.from({ length: 5 }, (_, i) =>
    opt({ id: `o${i}`, expiryDate: inDays(5), under: 0.8 }),
  );
  const { alerts } = scanBook(book, TODAY, new Map());
  const seen = alerts.map((a) => `${a.clientId}|${a.key}`);
  assert.equal(new Set(seen).size, seen.length);
});

/* ─────────────────────────── what they may say ──────────────────────────── */

test("an alert states a fact and never recommends an action", () => {
  /**
   * The same gate `lib/commentary/prompt.ts` puts on generated text and
   * `lib/glossary.ts` is written to. An alert is the most action-shaped surface
   * in the product, so it is the easiest place to drift across the line — "MRD
   * is in the money, window closes in 12 days" is a fact; "exercise MRD" is
   * personal advice and not the portal's to give.
   */
  const ADVICE =
    /\b(you should|we recommend|exercise (it|now|this)|sell |buy |act now|don't miss|take (profit|action))\b/i;
  const book = [
    opt({ id: "a", expiryDate: inDays(10), under: 0.9 }),
    opt({ id: "b", expiryDate: inDays(1), under: 0.1 }),
    opt({ id: "c", listed: true, expiryDate: inDays(25), under: 0.9 }),
    opt({ id: "d", expiryDate: inDays(29), under: 0.5, strike: 0.5 }),
  ];
  const { alerts } = scanBook(book, TODAY, new Map());
  assert.ok(alerts.length > 0);
  for (const a of alerts) {
    const text = `${a.title} ${a.subtitle}`;
    assert.equal(ADVICE.test(text), false, `reads as advice: ${text}`);
  }
});

/* ────────────────────── the in-the-money band (hysteresis) ───────────────── */

test("edgePct answers in percent of strike, and refuses what it cannot", () => {
  assert.equal(edgePct(0.11, 0.1, "Call")?.toFixed(1), "10.0");
  assert.equal(edgePct(0.09, 0.1, "Call")?.toFixed(1), "-10.0");
  // A put is in the money on the other side.
  assert.equal(edgePct(0.09, 0.1, "Put")?.toFixed(1), "10.0");
  assert.equal(edgePct(null, 0.1, "Call"), null);
  assert.equal(edgePct(0.1, null, "Call"), null);
  // A zero strike makes the percentage meaningless rather than infinite.
  assert.equal(edgePct(0.1, 0, "Call"), null);
});

test("barely in the money does not alert", () => {
  // The case production raised: $0.101 against a $0.10 strike is 1%, which is
  // one tick on a stock whose ordinary day is one tick.
  const o = opt({ expiryDate: inDays(200), strike: 0.1, under: 0.101 });
  assert.equal(scanOption(o, TODAY, null).alerts.some((a) => a.kind === "itm"), false);
});

test("clearing the band alerts", () => {
  const o = opt({ expiryDate: inDays(200), strike: 0.1, under: 0.106 });
  const { alerts, state } = scanOption(o, TODAY, null);
  const itm = alerts.find((a) => a.kind === "itm");
  assert.ok(itm);
  assert.match(itm.subtitle, /\+6\.0% vs strike/);
  assert.equal(state?.inSpell, true);
});

test("oscillating around the strike is silent — this is the whole point", () => {
  /**
   * The failure the band exists to prevent. A grant that clears 5%, drifts back
   * to 1%, climbs to 6% and drifts again has done nothing a client needs
   * telling about four times. Only the first crossing reports.
   */
  const at = (under: number) => opt({ expiryDate: inDays(200), strike: 0.1, under });
  let state = scanOption(at(0.106), TODAY, null).state; // +6% — reports
  const fired: boolean[] = [];
  for (const price of [0.101, 0.107, 0.102, 0.108, 0.1005]) {
    const r = scanOption(at(price), TODAY, state);
    fired.push(r.alerts.some((a) => a.kind === "itm"));
    state = r.state;
  }
  assert.deepEqual(fired, [false, false, false, false, false]);
  assert.equal(state?.spell, 1, "one spell, not five");
});

test("falling below the strike re-arms it, and a real recovery reports again", () => {
  const at = (under: number) => opt({ expiryDate: inDays(200), strike: 0.1, under });
  const a = scanOption(at(0.106), TODAY, null); // +6% — reports
  assert.equal(a.state?.inSpell, true);

  const b = scanOption(at(0.098), TODAY, a.state); // below the strike — re-armed
  assert.equal(b.state?.inSpell, false);
  assert.equal(b.alerts.some((x) => x.kind === "itm"), false);

  const c = scanOption(at(0.12), TODAY, b.state); // +20% — a genuine new spell
  assert.equal(c.alerts.some((x) => x.kind === "itm"), true);
  assert.equal(c.state?.spell, 2);
});

test("dipping under the band but staying above the strike does NOT re-arm", () => {
  // The gap between +5% and 0% is the hysteresis. Without it, a grant at +4%
  // would re-arm and the next tick at +6% would fire again.
  const at = (under: number) => opt({ expiryDate: inDays(200), strike: 0.1, under });
  const a = scanOption(at(0.106), TODAY, null);
  const b = scanOption(at(0.104), TODAY, a.state); // +4% — inside the gap
  assert.equal(b.state?.inSpell, true, "still inside the reported spell");
  const c = scanOption(at(0.109), TODAY, b.state);
  assert.equal(c.alerts.some((x) => x.kind === "itm"), false);
});

test("a missing price neither arms nor re-arms", () => {
  const at = (under: number | null) => opt({ expiryDate: inDays(200), strike: 0.1, under });
  const a = scanOption(at(0.106), TODAY, null);
  const b = scanOption(at(null), TODAY, a.state);
  assert.equal(b.state?.inSpell, true, "a day without a quote is not a fall");
  const c = scanOption(at(0.107), TODAY, b.state);
  assert.equal(c.alerts.some((x) => x.kind === "itm"), false);
});
