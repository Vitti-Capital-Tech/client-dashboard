import assert from "node:assert/strict";
import { test } from "node:test";
import { moveBucket, movesForBook, type HeldPosition } from "./moves.ts";

const TODAY = "2026-09-15";

const pos = (over: Partial<HeldPosition> = {}): HeldPosition => ({
  clientId: "cl-1",
  code: "SGQ",
  qty: 40_000,
  last: 0.5,
  changePct: 12,
  ...over,
});

test("a move reports the largest band it clears, not every band", () => {
  assert.equal(moveBucket(22), 20);
  assert.equal(moveBucket(12), 10);
  assert.equal(moveBucket(5), 5);
  assert.equal(moveBucket(4.9), null);
  assert.equal(moveBucket(null), null);
  assert.equal(moveBucket(Number.NaN), null);
});

test("a fall is as much a move as a rise", () => {
  assert.equal(moveBucket(-12), 10);
  const [alert] = movesForBook([pos({ changePct: -12 })], TODAY);
  assert.equal(alert.severity, "amber");
  assert.match(alert.title, /-12\.0% today/);
});

test("ordinary daily drift says nothing", () => {
  assert.deepEqual(movesForBook([pos({ changePct: 3 })], TODAY), []);
});

test("a big move on a small holding is still reported", () => {
  // There is no materiality floor: magnitude is the only gate. A 30% move on
  // $100 of stock is told the same as a 30% move on $100,000 of it.
  const tiny = pos({ changePct: 30, qty: 100, last: 1 });
  const alerts = movesForBook([tiny], TODAY);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].subtitle, /\$100 at/);
});

test("a position with no quote is skipped rather than guessed at", () => {
  assert.deepEqual(movesForBook([pos({ last: null })], TODAY), []);
  assert.deepEqual(movesForBook([pos({ changePct: null })], TODAY), []);
});

test("drifting inside one band does not produce a second alert", () => {
  // The dedupe claim: 12.1% and 12.4% are the same event, so the same key.
  const a = movesForBook([pos({ changePct: 12.1 })], TODAY)[0];
  const b = movesForBook([pos({ changePct: 12.4 })], TODAY)[0];
  assert.equal(a.key, b.key);
});

test("reaching the next band IS a new event", () => {
  const a = movesForBook([pos({ changePct: 12 })], TODAY)[0];
  const b = movesForBook([pos({ changePct: 21 })], TODAY)[0];
  assert.notEqual(a.key, b.key);
});

test("the same band tomorrow is a new event", () => {
  // Yesterday's 12% and today's 12% are two days of news, not one.
  const a = movesForBook([pos()], TODAY)[0];
  const b = movesForBook([pos()], "2026-09-16")[0];
  assert.notEqual(a.key, b.key);
});

test("a selloff reports every holding that moved, biggest first", () => {
  /**
   * There is no daily cap. When everything moves at once the client hears about
   * all of it — ordered so the largest move is the first thing read.
   */
  const book = Array.from({ length: 30 }, (_, i) =>
    pos({ code: `T${i}`, changePct: -(6 + i) }),
  );
  const alerts = movesForBook(book, TODAY);
  assert.equal(alerts.length, 30);
  assert.deepEqual(alerts.slice(0, 4).map((a) => a.title.split(" ")[0]), [
    "T29",
    "T28",
    "T27",
    "T26",
  ]);
});

test("no client's alerts are capped by another client's", () => {
  const book = [
    ...Array.from({ length: 6 }, (_, i) => pos({ clientId: "a", code: `A${i}`, changePct: 9 + i })),
    ...Array.from({ length: 6 }, (_, i) => pos({ clientId: "b", code: `B${i}`, changePct: 9 + i })),
  ];
  const alerts = movesForBook(book, TODAY);
  assert.equal(alerts.filter((x) => x.clientId === "a").length, 6);
  assert.equal(alerts.filter((x) => x.clientId === "b").length, 6);
});

test("keys are unique within a run", () => {
  // Two rows with one key in a single upsert would fail the unique index and
  // take the whole batch with them.
  const book = Array.from({ length: 12 }, (_, i) => pos({ code: `T${i}`, changePct: 8 + i }));
  const alerts = movesForBook(book, TODAY);
  const seen = alerts.map((a) => `${a.clientId}|${a.key}`);
  assert.equal(new Set(seen).size, seen.length);
});

test("a move alert reports a fact and never suggests an action", () => {
  /**
   * The same gate `lib/alerts/scan.ts` and `lib/glossary.ts` carry. A move
   * alert is the easiest place in the whole product to drift into a tip — it is
   * literally "this thing you own is moving" — so the wording is tested rather
   * than trusted.
   */
  const ADVICE =
    /\b(you should|we recommend|worth a look|opportunity|buy |sell |take (profit|action)|act now|don't miss|running|surging|tanking)\b/i;
  const book = [
    pos({ code: "AAA", changePct: 24 }),
    pos({ code: "BBB", changePct: -31 }),
    pos({ code: "CCC", changePct: 6 }),
  ];
  const alerts = movesForBook(book, TODAY);
  assert.equal(alerts.length, 3);
  for (const a of alerts) {
    const text = `${a.title} ${a.subtitle}`;
    assert.equal(ADVICE.test(text), false, `reads as advice: ${text}`);
  }
});
