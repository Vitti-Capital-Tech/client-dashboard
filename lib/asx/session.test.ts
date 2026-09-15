import assert from "node:assert/strict";
import { test } from "node:test";
import {
  asxSession,
  closeCountdown,
  deskDate,
  holidayOn,
  isHalfDay,
  isTradingDay,
} from "./session.ts";

/**
 * An instant, written as Sydney wall-clock time.
 *
 * The tests are about a Sydney clock, so they have to be able to say "10:30 in
 * Sydney" without knowing whether that day is AEST or AEDT. Building the Date
 * from a UTC guess and correcting it by the offset `Intl` reports keeps the
 * daylight-saving question where it belongs — in the tz database.
 */
function sydney(date: string, time = "12:00:00"): Date {
  const iso = `${date}T${time}Z`;
  const guess = new Date(iso);
  const seen = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(guess)
    .reduce<Record<string, string>>((acc, p) => ((acc[p.type] = p.value), acc), {});
  const asUtc = Date.parse(
    `${seen.year}-${seen.month}-${seen.day}T${seen.hour}:${seen.minute}:${seen.second}Z`,
  );
  return new Date(guess.getTime() - (asUtc - guess.getTime()));
}

test("sydney() helper lands on the wall-clock time it was given", () => {
  // Sanity check on the fixture itself: everything below depends on it.
  assert.equal(deskDate(sydney("2026-06-12", "09:30:00")), "2026-06-12");
  assert.equal(deskDate(sydney("2026-01-01", "00:30:00")), "2026-01-01");
  assert.equal(deskDate(sydney("2026-06-12", "23:30:00")), "2026-06-12");
});

/**
 * ASX's published cash-market non-trading days, date for date. 2027 is here
 * because it is the year the Anzac Day and Christmas rules disagree with the
 * NSW public-holiday calendar, which is exactly where a plausible-looking
 * implementation goes wrong.
 */
test("2026 closures match the published ASX calendar", () => {
  assert.deepEqual(
    [
      "2026-01-01",
      "2026-01-26",
      "2026-04-03",
      "2026-04-06",
      "2026-04-25",
      "2026-06-08",
      "2026-12-25",
      "2026-12-28",
    ].map((d) => [d, holidayOn(d)]),
    [
      ["2026-01-01", "New Year's Day"],
      ["2026-01-26", "Australia Day"],
      ["2026-04-03", "Good Friday"],
      ["2026-04-06", "Easter Monday"],
      ["2026-04-25", "Anzac Day"],
      ["2026-06-08", "King's Birthday"],
      ["2026-12-25", "Christmas Day"],
      ["2026-12-28", "Boxing Day"],
    ],
  );
});

test("2027 closures match the published ASX calendar", () => {
  assert.deepEqual(
    [
      "2027-01-01",
      "2027-01-26",
      "2027-03-26",
      "2027-03-29",
      "2027-06-14",
      "2027-12-27",
      "2027-12-28",
    ].map((d) => [d, holidayOn(d)]),
    [
      ["2027-01-01", "New Year's Day"],
      ["2027-01-26", "Australia Day"],
      ["2027-03-26", "Good Friday"],
      ["2027-03-29", "Easter Monday"],
      ["2027-06-14", "King's Birthday"],
      ["2027-12-27", "Christmas Day"],
      ["2027-12-28", "Boxing Day"],
    ],
  );
});

test("Anzac Day is not moved off a weekend — 26 Apr 2027 trades", () => {
  // NSW takes the Monday; ASX does not. The published 2027 calendar lists no
  // April closure at all, and getting this wrong shuts the market for a day it
  // was open.
  assert.equal(holidayOn("2027-04-25"), "Anzac Day");
  assert.equal(holidayOn("2027-04-26"), null);
  assert.equal(isTradingDay("2027-04-26"), true);
});

test("New Year's Day and Australia Day move to the next Monday", () => {
  assert.equal(holidayOn("2028-01-03"), "New Year's Day"); // 1 Jan is a Saturday
  assert.equal(holidayOn("2028-01-01"), null);
  assert.equal(holidayOn("2025-01-27"), "Australia Day"); // 26 Jan is a Sunday
});

test("a Sunday Christmas pushes past the Monday Boxing Day", () => {
  // 25 Dec 2022 was a Sunday: Boxing Day stayed on its Monday and Christmas was
  // observed on the Tuesday. A naive "next Monday" rule collides them.
  assert.equal(holidayOn("2022-12-26"), "Boxing Day");
  assert.equal(holidayOn("2022-12-27"), "Christmas Day");
});

test("one-off closures are honoured", () => {
  assert.equal(holidayOn("2022-09-22"), "National Day of Mourning");
  assert.equal(isTradingDay("2022-09-22"), false);
});

test("weekends never trade", () => {
  assert.equal(isTradingDay("2026-06-13"), false); // Saturday
  assert.equal(isTradingDay("2026-06-14"), false); // Sunday
  assert.equal(isTradingDay("2026-06-12"), true); // Friday
});

test("the half days are the last trading day before Christmas and of the year", () => {
  assert.equal(isHalfDay("2026-12-24"), true);
  assert.equal(isHalfDay("2026-12-31"), true);
  assert.equal(isHalfDay("2026-12-23"), false);
  // 24 Dec 2027 is a Friday and 31 Dec 2027 is a Friday, both trading days.
  assert.equal(isHalfDay("2027-12-24"), true);
  assert.equal(isHalfDay("2027-12-31"), true);
  // 24 Dec 2022 was a Saturday, so the early close was the Friday before it.
  assert.equal(isHalfDay("2022-12-23"), true);
  assert.equal(isHalfDay("2022-12-24"), false);
});

test("the phases walk through an ordinary trading day", () => {
  const on = (time: string) => asxSession(sydney("2026-06-12", time));
  assert.equal(on("03:00:00").phase, "closed");
  assert.equal(on("07:30:00").phase, "pre-open");
  assert.equal(on("09:59:00").phase, "pre-open");
  assert.equal(on("10:00:00").phase, "open");
  assert.equal(on("15:59:59").phase, "open");
  assert.equal(on("16:00:00").phase, "closing-auction");
  assert.equal(on("16:10:59").phase, "closing-auction");
  assert.equal(on("16:11:00").phase, "closed");
  assert.equal(on("23:00:00").phase, "closed");
});

test("the label is what the header stamps", () => {
  assert.equal(asxSession(sydney("2026-06-12", "11:00:00")).label, "ASX open");
  assert.equal(asxSession(sydney("2026-06-13", "11:00:00")).label, "ASX closed");
  assert.equal(asxSession(sydney("2026-12-25", "11:00:00")).label, "ASX closed");
  assert.equal(asxSession(sydney("2026-12-25", "11:00:00")).holiday, "Christmas Day");
});

test("a holiday is never open, however ordinary the hour", () => {
  const xmas = asxSession(sydney("2026-12-25", "12:00:00"));
  assert.equal(xmas.phase, "closed");
  assert.equal(xmas.msToClose, null);
  assert.equal(xmas.msToOpen, null);
  assert.equal(xmas.halfDay, false);
});

test("a half day closes at 14:10", () => {
  const eve = (time: string) => asxSession(sydney("2026-12-24", time));
  assert.equal(eve("12:00:00").halfDay, true);
  assert.equal(eve("14:09:59").phase, "open");
  assert.equal(eve("14:10:00").phase, "closing-auction");
  assert.equal(eve("14:21:00").phase, "closed");
  assert.equal(closeCountdown(eve("13:10:00")), "closes 1:00:00");
});

test("the countdown counts to the close, not to 4pm somewhere else", () => {
  assert.equal(closeCountdown(asxSession(sydney("2026-06-12", "13:45:51"))), "closes 2:14:09");
  assert.equal(closeCountdown(asxSession(sydney("2026-06-12", "16:00:30"))), "closing auction");
  assert.equal(closeCountdown(asxSession(sydney("2026-06-12", "18:00:00"))), "closed");
  assert.equal(closeCountdown(asxSession(sydney("2026-06-13", "13:00:00"))), "closed");
  assert.equal(closeCountdown(asxSession(sydney("2026-06-12", "08:30:00"))), "opens in 1h 30m");
  assert.equal(closeCountdown(asxSession(sydney("2026-06-12", "06:00:00"))), "opens in 4h 00m");
});

test("daylight saving does not move the open or the close", () => {
  // AEDT in January, AEST in June. Both must count to 16:00 on the Sydney wall
  // clock; an implementation carrying a fixed +10 offset breaks one of them.
  for (const date of ["2026-01-15", "2026-06-15"]) {
    assert.equal(closeCountdown(asxSession(sydney(date, "15:00:00"))), "closes 1:00:00");
  }
});
