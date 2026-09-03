import test from "node:test";
import assert from "node:assert/strict";

import {
  commentaryWeek,
  deskDate,
  deskWeekday,
  withinCommentaryWindow,
} from "./week.ts";

/**
 * The week anchor.
 *
 * Every case here is a real hazard rather than a formatting check: Sydney is
 * UTC+10 or UTC+11 depending on the season, so an instant's DATE and its
 * WEEKDAY both differ from UTC's for a good part of every day, and a note filed
 * under the wrong Friday is a note the client never sees.
 */

test("desk clock: an instant late in the UTC day is already tomorrow in Sydney", () => {
  // Friday 2026-06-12 22:00 UTC is Saturday 2026-06-13 08:00 AEST.
  const at = new Date("2026-06-12T22:00:00Z");
  assert.equal(deskDate(at), "2026-06-13");
  assert.equal(deskWeekday(at), 6, "Saturday in Sydney, still Friday in UTC");
});

test("desk clock: AEDT is a different offset, and is handled by the tz database", () => {
  // January is AEDT (UTC+11). 2026-01-15 14:00 UTC is 2026-01-16 01:00 AEDT.
  const at = new Date("2026-01-15T14:00:00Z");
  assert.equal(deskDate(at), "2026-01-16");
});

test("week: Friday evening files under that Friday", () => {
  // 2026-06-12 is a Friday. 08:00 UTC = 18:00 AEST.
  assert.equal(commentaryWeek(new Date("2026-06-12T08:00:00Z")), "2026-06-12");
});

test("week: the weekend catch-up run tops up the SAME Friday", () => {
  // This is the case a UTC-based rule gets wrong, and the reason the whole
  // module exists: three runs across one weekend must write one week's row.
  const friEvening = new Date("2026-06-12T08:00:00Z"); // Fri 18:00 AEST
  const saturday = new Date("2026-06-13T02:00:00Z"); // Sat 12:00 AEST
  const sunday = new Date("2026-06-14T04:00:00Z"); // Sun 14:00 AEST

  assert.equal(commentaryWeek(friEvening), "2026-06-12");
  assert.equal(commentaryWeek(saturday), "2026-06-12");
  assert.equal(commentaryWeek(sunday), "2026-06-12");
});

test("week: mid-week still reads last Friday's note", () => {
  // Monday–Thursday resolve backwards, so a client on Wednesday is served the
  // note that was written on Friday rather than nothing at all.
  assert.equal(commentaryWeek(new Date("2026-06-15T02:00:00Z")), "2026-06-12"); // Mon
  assert.equal(commentaryWeek(new Date("2026-06-18T02:00:00Z")), "2026-06-12"); // Thu
});

test("week: the next Friday opens the next week", () => {
  assert.equal(commentaryWeek(new Date("2026-06-19T08:00:00Z")), "2026-06-19");
});

test("week: the anchor walks back across a month and a year boundary", () => {
  // 2026-03-01 is a Sunday → the Friday before is 2026-02-27.
  assert.equal(commentaryWeek(new Date("2026-03-01T04:00:00Z")), "2026-02-27");
  // 2026-01-01 is a Thursday → back to 2025-12-26.
  assert.equal(commentaryWeek(new Date("2026-01-01T04:00:00Z")), "2025-12-26");
});

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

test("window: closed while the Friday session is still running", () => {
  // Fri 2026-06-12 02:00 UTC = 12:00 AEST — the market is open.
  assert.equal(withinCommentaryWindow(new Date("2026-06-12T02:00:00Z")), false);
});

test("window: open from Friday evening", () => {
  // Fri 07:00 UTC = 17:00 AEST, just after the close and the closing auction.
  assert.equal(withinCommentaryWindow(new Date("2026-06-12T07:00:00Z")), true);
});

test("window: open all weekend", () => {
  assert.equal(withinCommentaryWindow(new Date("2026-06-13T02:00:00Z")), true); // Sat
  assert.equal(withinCommentaryWindow(new Date("2026-06-14T12:00:00Z")), true); // Sun
});

test("window: closed Monday to Thursday", () => {
  assert.equal(withinCommentaryWindow(new Date("2026-06-15T02:00:00Z")), false);
  assert.equal(withinCommentaryWindow(new Date("2026-06-17T09:00:00Z")), false);
});

test("window: the Sunday-night boundary is read on the desk's clock", () => {
  // Sun 2026-06-14 23:00 UTC is already Monday 09:00 AEST — a run then is a
  // Monday run and must not write against the market about to open.
  assert.equal(withinCommentaryWindow(new Date("2026-06-14T23:00:00Z")), false);
});
