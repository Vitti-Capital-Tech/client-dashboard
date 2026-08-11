import test from "node:test";
import assert from "node:assert/strict";

import { parseSummaryTerms } from "./summary-terms.ts";

/**
 * Every fixture below is a real summary from `placement_candidates`, header block
 * verbatim. That matters: the header is written by an upstream LLM, so the only
 * useful test data is text it actually produced. Bullets are trimmed to one or
 * two lines, except where the bullet itself is the thing under test.
 *
 * What is worth covering is the difference between reading and guessing — a
 * range, a "$0.002" price that a naive float parse mangles, a price line with an
 * option strike on it, a deal type the feed disagrees with, and prose that
 * should yield nothing at all.
 */

const PGF = `Company: PM Capital Global Opportunities Fund (PGF:ASX)
Deal Type: Placement
Raise: $175M
Price: $3.07/share (10.8% disc)
Last Close: $3.44/share
3 Month High: $3.46/share
Bids Close: 12pm AEST 12 August 2026
Settlement: 19 August 2026

- ASX-listed investment company providing exposure to PM Capital's benchmark-unaware strategy.
- Offer price of $3.07 equals estimated pre-tax NTA per share as at 7 August 2026.`;

const AXR = `Company: Axiant Resources (AXR:ASX)
Deal Type: IPO
Raise: $8.0M–$10.0M
Price: $0.20/share
Bids Close: 5pm AWST 14 Aug 2026
Settlement: 20 Aug 2026

- Early-stage gold explorer spun out of Core Lithium (ASX: CXO).
- Key risks include early-stage exploration with no resource defined, native title and land access requirements in NT, reliance on key personnel, and gold price/FX exposure.`;

const KNI = `Company: Kuniko Limited (KNI:ASX)
Deal Type: Placement
Raise: A$1M (with ability to accept oversubscriptions)
Price: A$0.02/share (23% disc) + 1:2 free listed KNIOA options (strike A$0.07, exp May 2029)
Last Close: A$0.02/share
3 Month High: A$0.04/share
Bids Close: 1pm AEST 3 Aug 2026
Settlement: 10 Aug 2026

- Australian mineral exploration company advancing the Commonwealth-Silica Hill Gold-Silver Project.`;

const MRQ = `Company: MRG Metals (MRQ:ASX)
Deal Type: Placement
Raise: Up to $1M
Price: $0.002/share (33% disc)
Bids Close: 4pm AEST 7 August 2026
Settlement: 12 August 2026

- ASX-listed diversified resource developer focused on rare earths in South Africa and Mozambique.`;

const ICL = `Company: Iceni Gold (ICL:ASX)
Deal Type: Placement
Raise: A$0.5M (minimum)
Price: A$0.02/share (4.8% disc)
Bids Close: 2pm AEST 3 Aug 2026
Settlement: 11 Aug 2026

- 1-for-2 free attaching options exercisable at 4c with 2-year expiry, subject to shareholder approval.`;

const GLL = `Company: Galilee Energy (GLL:ASX)
Deal Type: Placement
Raise: A$3.5M
Price: A$0.0045/share (25% disc)
Last Close: A$0.01/share
Bids Close: 5pm WST 3 Aug 2026
Settlement: 17 Aug 2026

- Each new share comes with one free attaching listed option (ASX: GLLOD), exercisable at A$0.011 and expiring 20 Feb 2029.`;

const NTI = `Company: Neurotech International (NTI:ASX)
Deal Type: Placement
Raise: A$4M
Price: A$0.014/share (12.5% disc)
Bids Close: 5pm 31 Jul 2026
Settlement: 13 Aug 2026

- Clinical-stage biopharmaceutical company developing NTI164.`;

test("summary terms: the labelled header of a real placement is read whole", () => {
  assert.deepEqual(parseSummaryTerms(PGF), {
    name: "PM Capital Global Opportunities Fund",
    type: "Placement",
    raiseMillions: 175,
    price: 3.07,
    closeDate: "2026-08-12",
    settleDate: "2026-08-19",
  });
});

test("summary terms: an IPO becomes Pre-IPO, since placement_type has no plain IPO", () => {
  assert.equal(parseSummaryTerms(AXR).type, "Pre-IPO");
});

test("summary terms: a raise RANGE reads as its low end", () => {
  // `$8.0M–$10.0M`. The figure becomes the cap pro-rata scaling divides by, so
  // the low end scales bids back further and over-allocates nobody. The high end
  // would hand out stock the deal may not have.
  assert.equal(parseSummaryTerms(AXR).raiseMillions, 8);
});

test("summary terms: 'Up to $1M' and 'A$0.5M (minimum)' are the figure, not the words", () => {
  assert.equal(parseSummaryTerms(MRQ).raiseMillions, 1);
  assert.equal(parseSummaryTerms(ICL).raiseMillions, 0.5);
});

test("summary terms: sub-cent prices survive", () => {
  // $0.002 and $0.0045 are real offer prices. A parser that rounded to cents
  // would price a raise at zero and every bid against it would be free.
  assert.equal(parseSummaryTerms(MRQ).price, 0.002);
  assert.equal(parseSummaryTerms(GLL).price, 0.0045);
});

test("summary terms: the share price is taken, not the option strike beside it", () => {
  // `A$0.02/share (23% disc) + 1:2 free listed KNIOA options (strike A$0.07 …)`
  // has two dollar figures on one line, and only one of them is the offer price.
  const kni = parseSummaryTerms(KNI);
  assert.equal(kni.price, 0.02);
  assert.equal(kni.opts, "1:2 free listed KNIOA options (strike A$0.07, exp May 2029)");
});

test("summary terms: attaching options are read from the header, never mined from bullets", () => {
  // GLL and ICL both describe attaching options in prose. `opts` is read back at
  // settlement to decide how many options to issue per share, so a value guessed
  // out of a sentence would issue the wrong register.
  assert.equal(parseSummaryTerms(GLL).opts, undefined);
  assert.equal(parseSummaryTerms(ICL).opts, undefined);
});

test("summary terms: close dates survive timezones, abbreviations and a missing zone", () => {
  // The line is `1pm AEST 3 Aug 2026`. Building the ISO string from the matched
  // parts — rather than letting `new Date()` interpret the zone abbreviation —
  // is what keeps the 3rd from becoming the 2nd in another browser.
  assert.equal(parseSummaryTerms(KNI).closeDate, "2026-08-03");
  assert.equal(parseSummaryTerms(AXR).closeDate, "2026-08-14");
  assert.equal(parseSummaryTerms(NTI).closeDate, "2026-07-31");
});

test("summary terms: close and settlement are told apart by label, not by shape", () => {
  // Both lines are dates and settlement is simply the later one, so a parser that
  // matched on pattern would swap them — and the swap is silent: bids would close
  // a week after the money was due.
  const pgf = parseSummaryTerms(PGF);
  assert.equal(pgf.closeDate, "2026-08-12");
  assert.equal(pgf.settleDate, "2026-08-19");

  // A settlement in a different month, so the two cannot pass for each other.
  const inn = parseSummaryTerms(`Company: Innovaero Technologies Limited (INN:ASX)
Deal Type: IPO
Raise: A$40M
Price: A$0.50/share
Bids Close: 12pm AEST 7 Aug 2026
Settlement: 10 Sep 2026`);
  assert.equal(inn.closeDate, "2026-08-07");
  assert.equal(inn.settleDate, "2026-09-10");
});

test("summary terms: a header with no settlement line leaves settlement absent", () => {
  const terms = parseSummaryTerms(`Company: Test Co (TST:ASX)
Deal Type: Placement
Price: $1.00/share
Bids Close: 1pm AEST 3 Aug 2026`);
  assert.equal(terms.settleDate, undefined);
  assert.equal(terms.closeDate, "2026-08-03");
});

test("summary terms: a bullet containing a colon does not become a field", () => {
  // "Key risks include … requirements in NT, reliance on key personnel, and gold
  // price/FX exposure." — reading the whole body as labelled lines invents terms
  // out of prose.
  const axr = parseSummaryTerms(AXR);
  assert.equal(axr.price, 0.2);
  assert.equal(axr.name, "Axiant Resources");
});

test("summary terms: prose with no header yields nothing at all", () => {
  // The upstream summary is LLM-generated; the day it stops writing a header, the
  // form must go back to being empty rather than filled with a reading of a
  // sentence.
  assert.deepEqual(parseSummaryTerms("Five lines of LLM prose about the raise."), {});
  assert.deepEqual(parseSummaryTerms(""), {});
});

test("summary terms: the MINIMUM BID is never produced, whatever the summary says", () => {
  // Not one real summary carries a minimum, and this is the figure a bid is
  // accepted or rejected against. The one field guaranteed to have been looked at
  // by a person is the one that is always empty.
  const withAMinimum = `Company: Test Co (TST:ASX)
Deal Type: Placement
Raise: $10M
Price: $1.00/share
Min Bid: $50,000
Bids Close: 1pm AEST 3 Aug 2026`;

  const terms = parseSummaryTerms(withAMinimum) as Record<string, unknown>;
  assert.equal("minBid" in terms, false);
  assert.equal(terms.price, 1);
});

test("summary terms: a zero raise is unreadable, not an answer", () => {
  const terms = parseSummaryTerms(`Company: Test Co (TST:ASX)
Raise: $0M
Price: $1.00/share`);
  assert.equal(terms.raiseMillions, undefined);
  assert.equal(terms.price, 1);
});
