import test from "node:test";
import assert from "node:assert/strict";

import { runWeeklyCommentary, type CommentaryApi, type BatchItem } from "./run.ts";
import { fakeDb } from "../test-support/fake-db.ts";

/**
 * The weekly job's phase logic.
 *
 * The generation itself is the model's problem and the validation is covered in
 * prompt.test.ts. What is worth covering here is the choreography, because both
 * of its failure modes are silent:
 *
 *   • submitting twice — the schedule fires every two hours all weekend, so a
 *     job that does not remember it has submitted bills for the whole book
 *     nine times over;
 *   • never collecting — a batch submitted and left in flight looks like a
 *     successful cron run from every angle except the client's screen, which
 *     stays empty.
 */

const FRIDAY_EVENING = new Date("2026-06-12T08:00:00Z"); // Fri 18:00 AEST
const SATURDAY = new Date("2026-06-13T02:00:00Z"); // Sat 12:00 AEST
const WEDNESDAY = new Date("2026-06-10T02:00:00Z"); // mid-week
const WEEK = "2026-06-12";

const GOOD = {
  loss_note:
    "The share price drifted lower through the week alongside a broader pullback in the sector. There was no company announcement, so the move looks sector-driven rather than specific to the business.",
  profit_note:
    "The stock held its recent gains through the week without any fresh news. Holders who are ahead are generally weighing whether the move reflects something durable in the order book.",
};

/** A book with two held securities and one that was sold out. */
function seeded() {
  return fakeDb({
    positions: [
      { account_id: "a1", client_id: "c1", security_code: "EOS", qty: 1000 },
      { account_id: "a2", client_id: "c2", security_code: "EOS", qty: 500 },
      { account_id: "a1", client_id: "c1", security_code: "LDX", qty: 2000 },
      // Sold out — a note about it would be a note nobody reads.
      { account_id: "a1", client_id: "c1", security_code: "GONE", qty: 0 },
    ],
    securities: [
      { code: "EOS", name: "Electro Optic", sector: "Industrials", last_price: 1.2 },
      { code: "LDX", name: "Lumos", sector: "Health Care", last_price: 0.27 },
      { code: "GONE", name: "Gone Ltd", sector: null, last_price: null },
    ],
    security_commentary: [],
    commentary_runs: [],
  });
}

/** A stub API that records what it was asked and answers as instructed. */
function stubApi(over: Partial<CommentaryApi> & { ended?: boolean } = {}) {
  const submitted: BatchItem[][] = [];
  const api: CommentaryApi = {
    async submit(items) {
      submitted.push(items);
      return { batchId: "batch_1" };
    },
    async status() {
      return { ended: over.ended ?? false };
    },
    async results() {
      return [
        { customId: "EOS", output: GOOD, sources: [{ title: "Wrap", url: "https://x/a" }] },
        { customId: "LDX", output: GOOD, sources: [] },
      ];
    },
    ...(over.submit ? { submit: over.submit } : {}),
    ...(over.status ? { status: over.status } : {}),
    ...(over.results ? { results: over.results } : {}),
  };
  return { api, submitted };
}

test("job: mid-week does nothing at all", () => {
  // The note is written against a market that has closed for the week. Checked
  // in the job, not just in the schedule: a manual catch-up and a mis-set cron
  // entry arrive as the same request.
  const { db, tables } = seeded();
  const { api, submitted } = stubApi();
  return runWeeklyCommentary({ db, api, now: WEDNESDAY }).then((r) => {
    assert.equal(r.phase, "outside-window");
    assert.equal(submitted.length, 0);
    assert.equal(tables.commentary_runs.length, 0);
  });
});

test("job: --force runs mid-week for the desk", async () => {
  const { db } = seeded();
  const { api, submitted } = stubApi();
  const r = await runWeeklyCommentary({ db, api, now: WEDNESDAY, force: true });
  assert.equal(r.phase, "submitted");
  assert.equal(submitted.length, 1);
});

test("job: the first Friday tick submits the held securities and nothing else", async () => {
  const { db, tables } = seeded();
  const { api, submitted } = stubApi();

  const r = await runWeeklyCommentary({ db, api, now: FRIDAY_EVENING });

  assert.equal(r.phase, "submitted");
  assert.equal(r.requested, 2);
  assert.deepEqual(
    submitted[0].map((i) => i.customId).sort(),
    ["EOS", "LDX"],
    "a security nobody holds gets no note",
  );

  // The run row is what stops the next tick submitting again.
  assert.equal(tables.commentary_runs.length, 1);
  assert.equal(tables.commentary_runs[0].week_of, WEEK);
  assert.equal(tables.commentary_runs[0].status, "submitted");
});

test("job: the most-held security is first, so a truncated batch covers most clients", async () => {
  const { db } = seeded();
  const { api, submitted } = stubApi();
  await runWeeklyCommentary({ db, api, now: FRIDAY_EVENING });
  // EOS is held by two clients, LDX by one.
  assert.equal(submitted[0][0].customId, "EOS");
});

test("job: a second tick does NOT submit again — it polls", async () => {
  // The schedule fires every two hours all weekend. This is the test that
  // stands between that and nine batches.
  const { db, tables } = seeded();
  const { api, submitted } = stubApi({ ended: false });

  await runWeeklyCommentary({ db, api, now: FRIDAY_EVENING });
  const second = await runWeeklyCommentary({ db, api, now: SATURDAY });

  assert.equal(second.phase, "waiting");
  assert.equal(submitted.length, 1, "exactly one batch for the week");
  assert.equal(tables.commentary_runs.length, 1);
});

test("job: once the batch ends, a tick collects and stores the notes", async () => {
  const { db, tables } = seeded();

  await runWeeklyCommentary({ db, api: stubApi({ ended: false }).api, now: FRIDAY_EVENING });
  const done = await runWeeklyCommentary({
    db,
    api: stubApi({ ended: true }).api,
    now: SATURDAY,
  });

  assert.equal(done.phase, "collected");
  assert.equal(done.written, 2);
  assert.equal(tables.security_commentary.length, 2);

  const eos = tables.security_commentary.find((r) => r.security_code === "EOS")!;
  assert.equal(eos.week_of, WEEK);
  assert.equal(eos.loss_note, GOOD.loss_note);
  assert.deepEqual(eos.sources, [{ title: "Wrap", url: "https://x/a" }]);

  assert.equal(tables.commentary_runs[0].status, "collected");
  assert.equal(tables.commentary_runs[0].written, 2);
});

test("job: a collected week is left alone by later ticks", async () => {
  const { db, tables } = seeded();
  await runWeeklyCommentary({ db, api: stubApi({ ended: false }).api, now: FRIDAY_EVENING });
  await runWeeklyCommentary({ db, api: stubApi({ ended: true }).api, now: SATURDAY });

  const { api, submitted } = stubApi({ ended: true });
  const again = await runWeeklyCommentary({ db, api, now: SATURDAY });

  assert.equal(again.phase, "nothing-to-do");
  assert.equal(submitted.length, 0);
  assert.equal(tables.security_commentary.length, 2, "no duplicate rows");
});

test("job: one unusable note costs only that security", async () => {
  // 141 good notes must not be thrown away because the 142nd said "you should
  // sell". The reason is kept so the desk can see which and why.
  const { db, tables } = seeded();
  await runWeeklyCommentary({ db, api: stubApi({ ended: false }).api, now: FRIDAY_EVENING });

  const { api } = stubApi({
    ended: true,
    async results() {
      return [
        { customId: "EOS", output: GOOD, sources: [] },
        {
          customId: "LDX",
          output: { ...GOOD, profit_note: `${GOOD.profit_note} You should sell now.` },
          sources: [],
        },
      ];
    },
  });

  const r = await runWeeklyCommentary({ db, api, now: SATURDAY });

  assert.equal(r.phase, "collected");
  assert.equal(r.written, 1);
  assert.equal(r.errored, 1);
  assert.equal(tables.security_commentary.length, 1);
  assert.equal(tables.security_commentary[0].security_code, "EOS");
  assert.ok(
    r.notes.some((n) => n.includes("LDX") && /advice/.test(n)),
    "the run log names the security and the reason",
  );
});

test("job: a batch item that errored is reported, not stored", async () => {
  const { db, tables } = seeded();
  await runWeeklyCommentary({ db, api: stubApi({ ended: false }).api, now: FRIDAY_EVENING });

  const { api } = stubApi({
    ended: true,
    async results() {
      return [
        { customId: "EOS", output: GOOD, sources: [] },
        { customId: "LDX", output: null, sources: [], error: "batch item errored" },
      ];
    },
  });

  const r = await runWeeklyCommentary({ db, api, now: SATURDAY });
  assert.equal(r.written, 1);
  assert.equal(r.errored, 1);
  assert.equal(tables.security_commentary.length, 1);
});

test("job: a security that already has this week's note is not re-requested", async () => {
  // Covers the retry path: a week that was partly written — a failed collection,
  // a note the desk filled in by hand — must top up rather than start over.
  const { db, tables } = seeded();
  tables.security_commentary.push({
    security_code: "EOS",
    week_of: WEEK,
    loss_note: GOOD.loss_note,
    profit_note: GOOD.profit_note,
    sources: [],
  });

  const { api, submitted } = stubApi();
  await runWeeklyCommentary({ db, api, now: FRIDAY_EVENING });

  assert.deepEqual(
    submitted[0].map((i) => i.customId),
    ["LDX"],
    "only the security still missing a note",
  );
});

test("job: last week's note does not count as this week's", async () => {
  const { db, tables } = seeded();
  tables.security_commentary.push({
    security_code: "EOS",
    week_of: "2026-06-05", // the previous Friday
    loss_note: GOOD.loss_note,
    profit_note: GOOD.profit_note,
    sources: [],
  });

  const { api, submitted } = stubApi();
  await runWeeklyCommentary({ db, api, now: FRIDAY_EVENING });

  assert.deepEqual(
    submitted[0].map((i) => i.customId).sort(),
    ["EOS", "LDX"],
    "the whole point of the weekly job is that the note is rewritten",
  );
});

test("job: a book with nothing held submits nothing", async () => {
  const { db } = fakeDb({ positions: [], securities: [], security_commentary: [], commentary_runs: [] });
  const { api, submitted } = stubApi();
  const r = await runWeeklyCommentary({ db, api, now: FRIDAY_EVENING });
  assert.equal(r.phase, "nothing-to-do");
  assert.equal(submitted.length, 0);
});

test("job: a failed submit is reported as failed and writes no run row", async () => {
  // If it recorded a run, the week would be stuck polling a batch that does not
  // exist and would never be retried.
  const { db, tables } = seeded();
  const { api } = stubApi({
    async submit() {
      throw new Error("upstream is down");
    },
  });

  const r = await runWeeklyCommentary({ db, api, now: FRIDAY_EVENING });

  assert.equal(r.ok, false);
  assert.equal(r.phase, "failed");
  assert.equal(tables.commentary_runs.length, 0, "the week stays retryable");
  assert.ok(r.notes.some((n) => n.includes("upstream is down")));
});

test("job: the prompt never carries a price", async () => {
  // The no-figures rule in the system prompt is unenforceable if the per-item
  // prompt hands the model a number to quote back.
  const { db } = seeded();
  const { api, submitted } = stubApi();
  await runWeeklyCommentary({ db, api, now: FRIDAY_EVENING });
  for (const item of submitted[0]) {
    assert.ok(!/\d\.\d/.test(item.prompt), `${item.customId} prompt carries a price`);
  }
});
