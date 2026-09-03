import test from "node:test";
import assert from "node:assert/strict";

import { noteProblem, parseNote, userPrompt } from "./prompt.ts";

/**
 * The gate between a model response and a client's screen.
 *
 * The system prompt asks for general information with no figures in it. This
 * checks it, because a prompt is a request and text going out under the firm's
 * name needs more than a request behind it. Everything here is about refusing
 * a note rather than repairing one: a note is 2–4 sentences written to hang
 * together, and deleting the offending sentence leaves the rest leading into
 * something that is no longer there.
 */

const GOOD_LOSS =
  "The share price drifted lower through the week alongside a broader pullback in small-cap industrials. There was no company announcement, so the move looks sector-driven rather than specific to the business. Volumes stayed light, which often means selling without much conviction behind it.";

const GOOD_PROFIT =
  "The stock has run on the back of a supply agreement announced earlier in the quarter, and held those gains this week. Holders sitting on a gain are generally weighing whether the contract marks a lasting change in the order book or a single win. The next quarterly update is the usual place to look for that.";

test("note: an ordinary note passes", () => {
  assert.equal(noteProblem(GOOD_LOSS), null);
  assert.equal(noteProblem(GOOD_PROFIT), null);
});

test("note: 'nothing happened this week' is a valid note, not a failure", () => {
  // The normal case for a small-cap. A model asked for market colour will
  // invent some, so saying there was none has to be explicitly acceptable.
  const quiet =
    "There was no company news this week and no announcements to the market. The sector traded broadly flat, so the position has moved with it rather than on anything specific to the business.";
  assert.equal(noteProblem(quiet), null);
});

test("note: a stated figure is refused, in every shape it arrives in", () => {
  // The app shows the client's real numbers right next to this text. A
  // generated figure that disagrees with them is worse than no note.
  assert.ok(noteProblem(`${GOOD_LOSS} The price fell to $1.20.`));
  assert.ok(noteProblem(`${GOOD_LOSS} It is down 12% on the month.`));
  assert.ok(noteProblem(`${GOOD_LOSS} Revenue reached $40 million.`));
  assert.ok(noteProblem(`${GOOD_LOSS} It slipped about 8 per cent.`));
});

test("note: advice wording is refused", () => {
  assert.ok(noteProblem(`${GOOD_PROFIT} You should sell into this strength.`));
  assert.ok(noteProblem(`${GOOD_PROFIT} We recommend trimming the position.`));
  assert.ok(noteProblem(`${GOOD_PROFIT} Our price target is under review.`));
  assert.ok(noteProblem(`${GOOD_LOSS} This is a strong buy at these levels.`));
});

test("note: describing what holders weigh is NOT advice", () => {
  // The line this draws is the whole point: general information about the
  // market is allowed, an instruction to the reader is not.
  const general =
    "Holders who are ahead on the position are generally weighing whether the recent move reflects something durable in the business. The usual thing watched from here is whether the order book holds up in the next update. Nothing was announced this week either way.";
  assert.equal(noteProblem(general), null);
});

test("note: too short and too long are both refused", () => {
  assert.ok(noteProblem("Quiet week."), "a fragment is not a note");
  assert.ok(noteProblem(GOOD_LOSS.repeat(4)), "four notes' worth is not a note");
});

// ---------------------------------------------------------------------------
// parseNote
// ---------------------------------------------------------------------------

test("parse: a well-formed response becomes a storable note", () => {
  const out = parseNote(
    { loss_note: GOOD_LOSS, profit_note: GOOD_PROFIT },
    [{ title: "Sector wrap", url: "https://example.com/a" }],
  );
  assert.ok("note" in out);
  assert.equal(out.note.lossNote, GOOD_LOSS);
  assert.equal(out.note.sources.length, 1);
});

test("parse: a missing field is reported, not defaulted", () => {
  const out = parseNote({ loss_note: GOOD_LOSS });
  assert.ok("problem" in out);
  assert.match(out.problem, /profit_note/);
});

test("parse: a non-object response is reported", () => {
  assert.ok("problem" in parseNote("just some text"));
  assert.ok("problem" in parseNote(null));
  assert.ok("problem" in parseNote(42));
});

test("parse: the problem names WHICH note failed", () => {
  // One bad note out of 142 must cost only that security its note, so the run
  // log has to say which one and why.
  const out = parseNote({
    loss_note: GOOD_LOSS,
    profit_note: `${GOOD_PROFIT} You should sell.`,
  });
  assert.ok("problem" in out);
  assert.match(out.problem, /^profit_note/);
  assert.match(out.problem, /advice/);
});

test("parse: sources are deduplicated by URL", () => {
  const out = parseNote({ loss_note: GOOD_LOSS, profit_note: GOOD_PROFIT }, [
    { title: "Wrap", url: "https://example.com/a" },
    { title: "Wrap (again)", url: "https://example.com/a" },
    { title: "Other", url: "https://example.com/b" },
  ]);
  assert.ok("note" in out);
  assert.deepEqual(
    out.note.sources.map((s) => s.url),
    ["https://example.com/a", "https://example.com/b"],
  );
});

test("parse: a source with no URL is dropped rather than shown unlinked", () => {
  const out = parseNote({ loss_note: GOOD_LOSS, profit_note: GOOD_PROFIT }, [
    { title: "Nowhere", url: "" },
  ]);
  assert.ok("note" in out);
  assert.deepEqual(out.note.sources, []);
});

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

test("prompt: carries the security, its sector and the week", () => {
  const p = userPrompt(
    { code: "EOS", name: "Electro Optic Systems", sector: "Industrials", lastPrice: 1.2, holders: 3 },
    "2026-06-12",
  );
  assert.match(p, /EOS/);
  assert.match(p, /Electro Optic Systems/);
  assert.match(p, /Industrials/);
  assert.match(p, /2026-06-12/);
});

test("prompt: never carries a price, so the model cannot repeat one back", () => {
  // The no-figures rule is unenforceable if the prompt hands over a number to
  // quote. `lastPrice` is on the subject for the desk's own use, not for this.
  const p = userPrompt(
    { code: "EOS", name: "Electro Optic Systems", sector: null, lastPrice: 1.2345, holders: 3 },
    "2026-06-12",
  );
  assert.ok(!p.includes("1.23"), "the prompt must not contain the price");
  assert.match(p, /not classified/, "an unclassified sector is stated as such");
});

test("prompt: never carries how many clients hold it", () => {
  // Holder counts are the firm's book, not context for a market note.
  const p = userPrompt(
    { code: "EOS", name: "Electro Optic Systems", sector: "Industrials", lastPrice: null, holders: 17 },
    "2026-06-12",
  );
  assert.ok(!p.includes("17"), "holder count must not reach the model");
});
