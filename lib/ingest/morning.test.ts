import test from "node:test";
import assert from "node:assert/strict";

import { fakeDb } from "../test-support/fake-db.ts";
import { runMorningIngest } from "./morning.ts";
import type { BrokerAttachment, FetchResult } from "./graph-mail.ts";

/**
 * Tests for the unattended morning ingest.
 *
 * The importers themselves are covered in lib/import/runner.test.ts. What is at
 * stake here is everything the CRON adds: that a truncated snapshot cannot
 * silently empty the book, that holdings are applied before the trades that
 * depend on them, that an attachment is never processed twice, and that a bad
 * morning is recorded as a bad morning rather than a quiet success.
 */

const HOLDINGS_HEADER =
  "Account Number,Account Name,Security Code,Company Name,Holding Qty,Market Price," +
  "Average Cost,Market Value,Portfolio Value,Status,Advisor Code,Advisor Name";

const TRADES_HEADER =
  "CNote,Account,Type,Security,Company,Contract Date,Units,Value,Avg Price," +
  "Consideration,Brokerage,Other Charges,GST,Status";

/** A holdings snapshot naming exactly these accounts. */
const holdingsCsv = (accounts: string[]) =>
  [
    HOLDINGS_HEADER,
    ...accounts.map(
      (a) => `${a},HOLDER ${a},EOS,ELECTRO OPTIC,1000,8.00,5.00,8000,5000,ACTIVE,VIZ,Vitti`,
    ),
    "",
  ].join("\n");

const tradesCsv = (account: string) =>
  [
    TRADES_HEADER,
    `2001,${account},BUY,EOS,ELECTRO OPTIC,19/05/26,1000,5000,5.00,5000,0,0,0,SETTLED`,
    `2002,${account},SELL,EOS,ELECTRO OPTIC,21/05/26,1000,8000,8.00,8000,0,0,0,SETTLED`,
    "",
  ].join("\n");

function attachment(over: Partial<BrokerAttachment> = {}): BrokerAttachment {
  return {
    messageId: "msg-1",
    attachmentId: "att-1",
    receivedAt: "2026-08-07T23:05:00Z",
    sender: "reporting@morrisonsecurities.com",
    subject: "Daily Reports 07/08/2026",
    filename: "ClientHoldings.csv",
    sizeBytes: 1024,
    content: holdingsCsv(["114716"]),
    ...over,
  };
}

/** A mailbox that hands back exactly these attachments. */
const mailbox =
  (attachments: BrokerAttachment[]): ((since: Date | null) => Promise<FetchResult>) =>
  async () => ({ ok: true, attachments, messagesSeen: attachments.length });

/** A recompute that records what it was asked to do and does nothing else. */
function spyRecompute(opts: { deferAll?: boolean; skip?: string } = {}) {
  const calls: string[][] = [];
  const fn = async (accountIds: string[]) => {
    calls.push([...accountIds]);
    const deferred = opts.deferAll ? [...accountIds] : [];
    return {
      batchId: "batch-1",
      results: opts.deferAll
        ? []
        : accountIds.map((accountId) => ({
            accountId,
            runId: "run-1",
            rows: [],
            totalPnl: 0,
            warnings: [],
          })),
      failures: [],
      deferred,
      placementTickers: opts.skip ? null : 12,
      placementsParsedAt: opts.skip ? null : "2026-08-10T00:00:00Z",
      ...(opts.skip ? { skippedReason: opts.skip } : {}),
    };
  };
  return { calls, fn };
}

function run(
  tables: Parameters<typeof fakeDb>[0],
  attachments: BrokerAttachment[],
  recomputeOpts: Parameters<typeof spyRecompute>[0] = {},
) {
  const { db, tables: t } = fakeDb(tables);
  const recompute = spyRecompute(recomputeOpts);
  return {
    tables: t,
    recompute,
    go: () =>
      runMorningIngest({
        db,
        fetchAttachments: mailbox(attachments) as never,
        recompute: recompute.fn as never,
      }),
  };
}

// ---------------------------------------------------------------------------
// The guardrail
// ---------------------------------------------------------------------------

test("guardrail: a truncated snapshot is quarantined, not applied", async () => {
  // Ten accounts hold positions today. Tomorrow's file mentions one of them.
  // Applying it would delete nine clients' holdings.
  const accountIds = Array.from({ length: 10 }, (_, i) => `a${i}`);
  const { tables, go, recompute } = run(
    {
      accounts: accountIds.map((id, i) => ({
        id,
        external_ref: `1000${i}`,
        client_id: `c${i}`,
      })),
      securities: [{ code: "EOS", parent_code: null }],
      positions: accountIds.map((id, i) => ({
        account_id: id,
        client_id: `c${i}`,
        security_code: "EOS",
        qty: 100,
      })),
    },
    [attachment({ content: holdingsCsv(["10000"]) })],
  );

  const report = await go();

  assert.equal(report.attachments[0].outcome, "quarantined");
  assert.match(report.attachments[0].error!, /would delete the positions of 9 account/);
  assert.equal(tables.positions.length, 10, "every position survived");
  assert.equal(recompute.calls.length, 0, "nothing to recompute — nothing changed");
  assert.equal(report.ok, false, "a quarantined file is not a clean morning");
});

test("guardrail: normal attrition still applies", async () => {
  // One account of ten has closed — 90% coverage, exactly at the floor.
  const accountIds = Array.from({ length: 10 }, (_, i) => `a${i}`);
  const stillOpen = Array.from({ length: 9 }, (_, i) => `1000${i}`);

  const { go } = run(
    {
      accounts: accountIds.map((id, i) => ({
        id,
        external_ref: `1000${i}`,
        client_id: `c${i}`,
      })),
      securities: [{ code: "EOS", parent_code: null }],
      positions: accountIds.map((id, i) => ({
        account_id: id,
        client_id: `c${i}`,
        security_code: "EOS",
        qty: 100,
      })),
    },
    [attachment({ content: holdingsCsv(stillOpen) })],
  );

  const report = await go();
  assert.equal(report.attachments[0].outcome, "imported");
});

test("guardrail: the very first snapshot has nothing to protect", async () => {
  const { go, tables } = run({}, [attachment({ content: holdingsCsv(["114716"]) })]);

  const report = await go();
  assert.equal(report.attachments[0].outcome, "imported");
  assert.equal(tables.positions.length, 1);
});

// ---------------------------------------------------------------------------
// Ordering, classification, dedupe
// ---------------------------------------------------------------------------

test("holdings are imported before the trades that depend on them", async () => {
  // The trade ledger references account 114716, which only exists once the
  // snapshot has created it. Mail order puts the trades first on purpose.
  const { go, tables } = run({}, [
    attachment({
      messageId: "m-trades",
      attachmentId: "a-trades",
      filename: "Confirmations.csv",
      receivedAt: "2026-08-07T23:01:00Z",
      content: tradesCsv("114716"),
    }),
    attachment({
      messageId: "m-holdings",
      attachmentId: "a-holdings",
      receivedAt: "2026-08-07T23:02:00Z",
      content: holdingsCsv(["114716"]),
    }),
  ]);

  const report = await go();

  for (const a of report.attachments) {
    assert.equal(a.outcome, "imported", `${a.filename}: ${a.error ?? ""}`);
  }
  assert.equal(tables.trades.length, 2);
  assert.equal(tables.realized_pnl.length, 1);
});

test("a file is classified by its headers, not its name", async () => {
  // Named like a holdings export, actually a trade ledger. The columns win.
  const { go } = run(
    {
      clients: [{ id: "c1", external_ref: "114716" }],
      accounts: [{ id: "a1", external_ref: "114716", client_id: "c1" }],
      securities: [{ code: "EOS", parent_code: null }],
    },
    [attachment({ filename: "ClientHoldings_FINAL.csv", content: tradesCsv("114716") })],
  );

  const report = await go();
  assert.equal(report.attachments[0].kind, "trades");
  assert.equal(report.attachments[0].outcome, "imported");
});

test("an unrecognised attachment is skipped, never guessed at", async () => {
  const { go, tables } = run({}, [
    attachment({ filename: "invoice.csv", content: "Invoice No,Amount\n1,2\n" }),
  ]);

  const report = await go();
  assert.equal(report.attachments[0].outcome, "unrecognised");
  assert.equal(tables.positions.length, 0);
  assert.equal(tables.trades.length, 0);
});

test("an attachment already processed is not processed again", async () => {
  const att = attachment();
  const { go, tables } = run(
    {
      ingest_attachments: [
        { message_id: att.messageId, attachment_id: att.attachmentId, outcome: "imported" },
      ],
    },
    [att],
  );

  const report = await go();
  assert.equal(report.attachments.length, 0);
  assert.match(report.notes.join(" "), /already imported/);
  assert.equal(tables.positions.length, 0, "nothing was re-applied");
});

// ---------------------------------------------------------------------------
// Recompute and provenance
// ---------------------------------------------------------------------------

test("the P&L is recomputed once, for exactly the accounts touched", async () => {
  const { go, recompute } = run({}, [
    attachment({ content: holdingsCsv(["114716", "220001"]) }),
  ]);

  const report = await go();

  assert.equal(recompute.calls.length, 1, "one batch, not one per file or per account");
  assert.equal(recompute.calls[0].length, 2);
  assert.equal(report.accountsRecomputed, 2);
  assert.match(report.notes.join(" "), /Recomputed 2 of 2 owed account/);
});

test("every run and every attachment is written down", async () => {
  const { go, tables } = run({}, [attachment()]);
  await go();

  assert.equal(tables.ingest_runs.length, 1);
  assert.equal(tables.ingest_runs[0].status, "ok");
  assert.equal(tables.ingest_runs[0].imported, 1);

  assert.equal(tables.ingest_attachments.length, 1);
  const row = tables.ingest_attachments[0];
  assert.equal(row.outcome, "imported");
  assert.equal(row.kind, "holdings");
  assert.equal(row.sender, "reporting@morrisonsecurities.com");
  assert.equal(row.sha256.length, 64, "content hash kept for the audit trail");
});

test("the watermark does not advance past a file that was refused", async () => {
  // Otherwise a quarantined snapshot is skipped tomorrow and never seen again.
  const accountIds = Array.from({ length: 10 }, (_, i) => `a${i}`);
  const { go, tables } = run(
    {
      accounts: accountIds.map((id, i) => ({
        id,
        external_ref: `1000${i}`,
        client_id: `c${i}`,
      })),
      securities: [{ code: "EOS", parent_code: null }],
      positions: accountIds.map((id, i) => ({
        account_id: id,
        client_id: `c${i}`,
        security_code: "EOS",
        qty: 100,
      })),
    },
    [attachment({ content: holdingsCsv(["10000"]) })],
  );

  await go();

  assert.equal(tables.ingest_runs[0].status, "partial");
  assert.equal(tables.ingest_runs[0].watermark, null, "still where it was");
  assert.equal(tables.ingest_runs[0].quarantined, 1);
});

test("a mailbox that cannot be read fails loudly and records why", async () => {
  const { db, tables } = fakeDb({});
  const report = await runMorningIngest({
    db,
    fetchAttachments: (async () => ({
      ok: false,
      attachments: [],
      messagesSeen: 0,
      error: "Graph message list failed (404) — may be a distribution list.",
    })) as never,
    recompute: spyRecompute().fn as never,
  });

  assert.equal(report.ok, false);
  assert.match(report.error!, /distribution list/);
  assert.equal(tables.ingest_runs[0].status, "failed");
});

// ---------------------------------------------------------------------------
// The recompute queue
// ---------------------------------------------------------------------------

test("touched accounts are queued BEFORE the recompute is attempted", async () => {
  // The queue is what makes an interrupted run still owe the work. Enqueueing
  // after a successful recompute would lose exactly the case it exists for —
  // which is the case that actually happened on the first real scheduled run.
  const { go, tables } = run({}, [attachment({ content: holdingsCsv(["114716"]) })], {
    deferAll: true,
  });

  const report = await go();

  assert.equal(tables.pnl_recompute_queue.length, 1, "still owed");
  assert.match(report.notes.join(" "), /left queued/);
  assert.equal(report.ok, false, "work still owed is not a clean morning");
  assert.equal(tables.ingest_runs[0].watermark, null, "and the watermark waits");
});

test("work owed from a previous run is picked up even if today touched nothing", async () => {
  // An account deferred yesterday must not wait behind the accident of which
  // accounts today's file happens to mention.
  const { go, recompute } = run(
    {
      accounts: [{ id: "a-old", external_ref: "999999", client_id: "c9" }],
      pnl_recompute_queue: [
        { account_id: "a-old", queued_at: "2026-08-09T00:00:00Z", attempts: 1 },
      ],
    },
    [],
  );

  await go();

  assert.equal(recompute.calls.length, 1);
  assert.deepEqual(recompute.calls[0], ["a-old"]);
});

test("an empty tracker cache stops the recompute but not the import", async () => {
  // Placement buy sides and unlisted option rows would be missing, and a stored
  // figure without them is indistinguishable from a correct one.
  const { go, tables } = run(
    {},
    [attachment({ content: holdingsCsv(["114716"]) })],
    { deferAll: true, skip: "The Placement Tracker cache is empty." },
  );

  const report = await go();

  assert.equal(tables.positions.length, 1, "the import still happened");
  assert.match(report.notes.join(" "), /Placement Tracker cache is empty/);
  assert.equal(tables.pnl_recompute_queue.length, 1, "the recompute is still owed");
});

test("a FAILED attachment is retried, not treated as done", async () => {
  // Only `imported` and `unrecognised` are final. A failure's cause is usually
  // something a later run fixes — a missing account a holdings snapshot then
  // creates — and marking it seen manufactures a permanent skip out of a
  // temporary problem. Three real trade files were lost to exactly this.
  const att = attachment();
  const { go, tables } = run(
    {
      ingest_attachments: [
        { message_id: att.messageId, attachment_id: att.attachmentId, outcome: "failed" },
      ],
    },
    [att],
  );

  const report = await go();

  assert.equal(report.attachments.length, 1, "retried");
  assert.equal(report.attachments[0].outcome, "imported");
  assert.equal(tables.positions.length, 1);
});

test("a QUARANTINED attachment is retried too", async () => {
  // The guardrail may refuse again, and that is fine — but the refusal must be
  // re-decided against today's book, not inherited from yesterday's.
  const att = attachment();
  const { go } = run(
    {
      ingest_attachments: [
        { message_id: att.messageId, attachment_id: att.attachmentId, outcome: "quarantined" },
      ],
    },
    [att],
  );

  const report = await go();
  assert.equal(report.attachments.length, 1, "re-examined rather than skipped");
});

test("a byte-identical file is imported once, not once per copy", async () => {
  // The broker re-sends the same full-history export daily, so three identical
  // 4,026-row files sat in one mailbox. Each costs ~10.8s to import and cannot
  // reach a state the first did not — thirty seconds of a sixty-second budget
  // spent arriving where the database already was.
  const content = tradesCsv("114716");
  const { go, tables } = run(
    {
      clients: [{ id: "c1", external_ref: "114716" }],
      accounts: [{ id: "a1", external_ref: "114716", client_id: "c1" }],
      securities: [{ code: "EOS", parent_code: null }],
    },
    [
      attachment({ messageId: "m1", attachmentId: "a1", filename: "day1.csv", content }),
      attachment({ messageId: "m2", attachmentId: "a2", filename: "day2.csv", content }),
      attachment({ messageId: "m3", attachmentId: "a3", filename: "day3.csv", content }),
    ],
  );

  const report = await go();

  assert.deepEqual(
    report.attachments.map((a) => a.outcome),
    ["imported", "duplicate", "duplicate"],
  );
  assert.equal(tables.trades.length, 2, "one import's worth of rows");
  // A duplicate is settled work, so it must not hold the watermark back.
  assert.equal(report.ok, true);
  assert.notEqual(tables.ingest_runs[0].watermark, null);
});

test("different content is never treated as a duplicate", async () => {
  const { go, tables } = run(
    {
      clients: [{ id: "c1", external_ref: "114716" }],
      accounts: [{ id: "a1", external_ref: "114716", client_id: "c1" }],
      securities: [{ code: "EOS", parent_code: null }],
    },
    [
      attachment({ messageId: "m1", attachmentId: "a1", content: tradesCsv("114716") }),
      attachment({
        messageId: "m2",
        attachmentId: "a2",
        content: tradesCsv("114716").replace("2001,", "3001,").replace("2002,", "3002,"),
      }),
    ],
  );

  const report = await go();
  assert.deepEqual(report.attachments.map((a) => a.outcome), ["imported", "imported"]);
  assert.equal(tables.trades.length, 4);
});
