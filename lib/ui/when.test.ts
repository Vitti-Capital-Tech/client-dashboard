import assert from "node:assert/strict";
import { test } from "node:test";
import { relative, absolute, stamp } from "./when.ts";

/** 18 Sep 2026, 09:42 Sydney — the clock every case below is measured from. */
const NOW = new Date("2026-09-18T09:42:00+10:00").getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

/**
 * Dates are built from LOCAL parts, and month names are read back out of `Intl`
 * rather than written out here. Both for the same reason: these tests run on a
 * developer's laptop in Sydney and on CI in UTC, and neither the calendar day
 * of a fixed instant nor en-AU's abbreviation for September ("Sept", not "Sep")
 * is a thing this module decides. What it decides is which FORM to print, and
 * that is what is asserted.
 */
const localNoon = (y: number, m: number, d: number) =>
  new Date(y, m, d, 12, 0, 0).toISOString();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test("the first minute reads as just now", () => {
  assert.equal(relative(ago(0), NOW), "just now");
  assert.equal(relative(ago(59_000), NOW), "just now");
});

test("minutes, hours and days each floor rather than round", () => {
  // The whole point: an alert must never read as older than it is. Someone
  // deciding whether an expiry window still has time in it reads this number.
  assert.equal(relative(ago(MINUTE), NOW), "1m ago");
  assert.equal(relative(ago(59 * MINUTE + 59_000), NOW), "59m ago");
  assert.equal(relative(ago(HOUR), NOW), "1h ago");
  assert.equal(relative(ago(23 * HOUR + 59 * MINUTE), NOW), "23h ago");
  assert.equal(relative(ago(DAY), NOW), "1d ago");
  assert.equal(relative(ago(6 * DAY + 23 * HOUR), NOW), "6d ago");
});

test("a week old switches to a date", () => {
  // "7d ago" is no easier to read than the date it happened, and past that the
  // relative form stops helping at all.
  const week = ago(7 * DAY);
  const month = ago(30 * DAY);
  assert.equal(relative(week, NOW), absolute(week, NOW));
  assert.equal(relative(month, NOW), absolute(month, NOW));
  assert.doesNotMatch(relative(week, NOW), /ago/);
});

test("a clock a few seconds ahead does not print a negative age", () => {
  // The scanner's host and the browser disagree by seconds in practice, and
  // "-1m ago" on an alert is a bug report waiting to be filed.
  assert.equal(relative(new Date(NOW + 20_000).toISOString(), NOW), "just now");
});

test("the year appears only once it is not this one", () => {
  const thisYear = absolute(localNoon(2026, 0, 4), NOW);
  const lastYear = absolute(localNoon(2025, 8, 11), NOW);

  assert.match(thisYear, /^4 \w+$/);
  assert.doesNotMatch(thisYear, /2026/);
  assert.match(lastYear, /^11 \w+ 2025$/);
});

test("the hover stamp carries the day, the year and the minute", () => {
  const s = stamp(localNoon(2026, 8, 11));
  assert.match(s, /11/);
  assert.match(s, /2026/);
  assert.match(s, /12:00/);
});

test("an unparseable timestamp renders nothing rather than Invalid Date", () => {
  assert.equal(relative("not a date", NOW), "");
  assert.equal(absolute("not a date", NOW), "");
  assert.equal(stamp("not a date"), "");
});
