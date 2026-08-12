import test from "node:test";
import assert from "node:assert/strict";

import { fakeDb } from "../test-support/fake-db.ts";
import {
  candidateFingerprint,
  storeCandidates,
  syncPlacementCandidates,
  type CandidateFeedItem,
} from "./candidates.ts";

/**
 * Tests for the deal-mail sync.
 *
 * What is worth covering here is the seam, not the HTTP: does the same deal stay
 * one candidate across runs, does a re-summarised deal stay one candidate, and
 * does a run that cannot reach the feed fail loudly rather than quietly wiping
 * the queue. None of that needs a network or a database.
 */

const item = (over: Partial<CandidateFeedItem> = {}): CandidateFeedItem => ({
  ticker: "GRV",
  company: "GRV",
  deal_type: "Placement",
  subject: "GREENVALE ENERGY — $12m placement at $0.145",
  summary: "Five lines of LLM prose about the raise.",
  received_at: "2026-08-11T02:31:46Z",
  ...over,
});

/** A feed that answers the two endpoints from a literal map of date → deals. */
function fakeFeed(byDate: Record<string, CandidateFeedItem[]>) {
  const calls: string[] = [];
  const fetchJson = async (url: string) => {
    calls.push(url);
    if (url.endsWith("/api/placements")) {
      return { dates: Object.keys(byDate).sort().reverse() };
    }
    const date = url.split("/").pop()!;
    const placements = byDate[date] ?? [];
    return { date, total: placements.length, generated_at: "", placements };
  };
  return { fetchJson, calls };
}

test("candidates: the same deal is one row across runs", async () => {
  const { db, tables } = fakeDb({ placement_candidates: [] });
  const { fetchJson } = fakeFeed({ "2026-08-11": [item()] });

  await syncPlacementCandidates({ db, fetchJson, apiBase: "http://feed" });
  await syncPlacementCandidates({ db, fetchJson, apiBase: "http://feed" });

  assert.equal(tables.placement_candidates.length, 1);
});

test("candidates: a re-summarised deal does NOT become a second candidate", async () => {
  // The upstream summary is LLM-generated and its cache key includes the last
  // close price, so the same deal legitimately re-summarises when the market
  // moves. Folding `summary` into the fingerprint would put the same raise in
  // the desk's queue several times a week — which is exactly the failure this
  // is here to prevent.
  const { db, tables } = fakeDb({ placement_candidates: [] });

  await syncPlacementCandidates({
    db,
    fetchJson: fakeFeed({ "2026-08-11": [item()] }).fetchJson,
    apiBase: "http://feed",
  });
  const second = await syncPlacementCandidates({
    db,
    fetchJson: fakeFeed({
      "2026-08-11": [item({ summary: "Completely different prose, price moved." })],
    }).fetchJson,
    apiBase: "http://feed",
  });

  assert.equal(tables.placement_candidates.length, 1);
  assert.equal(second.fresh, 0, "not new — the deal is the same deal");
  // The newer text still lands: it is the better summary, just not a new deal.
  assert.match(tables.placement_candidates[0].summary, /price moved/);
});

test("candidates: a different subject IS a different deal", async () => {
  const { db, tables } = fakeDb({ placement_candidates: [] });
  const { fetchJson } = fakeFeed({
    "2026-08-11": [item(), item({ subject: "GREENVALE ENERGY — second tranche" })],
  });

  await syncPlacementCandidates({ db, fetchJson, apiBase: "http://feed" });
  assert.equal(tables.placement_candidates.length, 2);
});

test("candidates: a deal with no ticker is skipped, not stored", async () => {
  // Nothing downstream could match, promote or even list it.
  const { db, tables } = fakeDb({ placement_candidates: [] });
  const { fetchJson } = fakeFeed({ "2026-08-11": [item({ ticker: "  " }), item()] });

  await syncPlacementCandidates({ db, fetchJson, apiBase: "http://feed" });
  assert.equal(tables.placement_candidates.length, 1);
});

test("candidates: the same deal on two dates upserts once, not twice in one statement", async () => {
  // A timezone boundary upstream can put one deal on two dates. Upserting the
  // same conflict key twice in a single statement is an error, not a no-op.
  const { db, tables } = fakeDb({ placement_candidates: [] });
  const { fetchJson } = fakeFeed({
    "2026-08-11": [item()],
    "2026-08-10": [item()],
  });

  const report = await syncPlacementCandidates({ db, fetchJson, apiBase: "http://feed", days: 2 });

  assert.equal(tables.placement_candidates.length, 1);
  assert.equal(report.seen, 2, "seen counts what the feed offered");
  assert.equal(report.fresh, 1, "fresh counts distinct deals");
});

test("candidates: only the most recent dates are pulled", async () => {
  // Each date costs the upstream a market-data lookup per ticker and possibly an
  // LLM call, so the window is bounded rather than walking all history.
  const { db } = fakeDb({ placement_candidates: [] });
  const { fetchJson, calls } = fakeFeed({
    "2026-08-11": [item()],
    "2026-08-10": [item({ subject: "b" })],
    "2026-08-09": [item({ subject: "c" })],
    "2026-08-08": [item({ subject: "d" })],
  });

  const report = await syncPlacementCandidates({ db, fetchJson, apiBase: "http://feed", days: 2 });

  assert.deepEqual(report.dates, ["2026-08-11", "2026-08-10"]);
  assert.equal(calls.filter((c) => c.includes("/api/placements/")).length, 2);
});

test("candidates: an unreachable feed fails loudly and stores nothing", async () => {
  // The queue is the desk's work list. A sync that cannot read the feed must not
  // report success — the absence of new deals would read as "none arrived".
  const { db, tables } = fakeDb({ placement_candidates: [] });

  const report = await syncPlacementCandidates({
    db,
    apiBase: "http://feed",
    fetchJson: async () => {
      throw new Error("connect ECONNREFUSED");
    },
  });

  assert.equal(report.ok, false);
  assert.match(report.error ?? "", /ECONNREFUSED/);
  assert.equal(tables.placement_candidates.length, 0);
});

test("candidates: a PUSHED deal is not new again when the schedule catches up", async () => {
  // The two ways in must agree about what "new" means. If they did not, the
  // hourly backstop would rediscover a deal the push already stored, call it
  // fresh, and the tracker would grow a second tab for one placement.
  const { db, tables } = fakeDb({ placement_candidates: [] });

  const pushed = await storeCandidates([item()], { db });
  assert.equal(pushed.fresh, 1, "the push saw it first");

  const later = await syncPlacementCandidates({
    db,
    fetchJson: fakeFeed({ "2026-08-11": [item()] }).fetchJson,
    apiBase: "http://feed",
  });

  assert.equal(later.fresh, 0, "the schedule finds it already stored");
  assert.deepEqual(later.freshItems, [], "so nothing is handed to the tracker twice");
  assert.equal(tables.placement_candidates.length, 1);
});

test("candidates: a push carrying two deals at once stores both", async () => {
  const { db, tables } = fakeDb({ placement_candidates: [] });
  const res = await storeCandidates([item(), item({ ticker: "KNI", subject: "KNI raise" })], { db });

  assert.equal(res.fresh, 2);
  assert.equal(tables.placement_candidates.length, 2);
});

test("candidates: a pushed deal with no ticker is dropped, not stored", async () => {
  const { db, tables } = fakeDb({ placement_candidates: [] });
  const res = await storeCandidates([item({ ticker: "   " }), item()], { db });

  assert.equal(res.seen, 1, "the empty one is not even counted as seen");
  assert.equal(tables.placement_candidates.length, 1);
});

test("candidates: the fingerprint ignores the summary but not the deal", async () => {
  const base = item();
  assert.equal(
    candidateFingerprint(base),
    candidateFingerprint({ ...base, summary: "rewritten" }),
  );
  assert.notEqual(
    candidateFingerprint(base),
    candidateFingerprint({ ...base, received_at: "2026-08-12T02:31:46Z" }),
  );
});
