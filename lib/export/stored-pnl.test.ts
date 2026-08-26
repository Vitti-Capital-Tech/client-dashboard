import test from "node:test";
import assert from "node:assert/strict";

import { storedToSummaryRows } from "./stored-pnl.ts";
import { grandTotal, positionStatus, type PnlOverride } from "./order-history.ts";
import type { StoredPnlRow } from "../data/pnl.ts";

/**
 * The stored rows feed the on-screen table, the CSV and the .xlsx from ONE
 * array. These tests cover the part of that mapping which changes money: which
 * rows the Grand Total is allowed to include, and how a desk override lands on
 * top of a stored figure.
 */

function row(over: Partial<StoredPnlRow> = {}): StoredPnlRow {
  return {
    accountId: "a1",
    clientId: "c1",
    ticker: "EOS",
    parentTicker: "EOS",
    company: "ELECTRO OPTIC",
    instrument: "FPO",
    buyQty: 1000,
    sellQty: 1000,
    heldQty: 0,
    openQty: 0,
    buyPrice: 5000,
    sellPrice: 8000,
    pnl: 3000,
    tradeCount: 2,
    isMatched: true,
    isOption: false,
    isEnriched: false,
    isDbMarketValued: false,
    isDbOpenValued: false,
    isDbOnly: false,
    isPartialExit: false,
    isPartialBuy: false,
    notInHoldings: false,
    isUnlistedOption: false,
    placementYearUnresolved: false,
    placementYearNote: null,
    buySideUnknown: false,
    unlistedOption: null,
    comment: null,
    computedAt: "2026-08-07T00:00:00Z",
    ...over,
  };
}

test("stored: a plain round trip maps straight through", () => {
  const [r] = storedToSummaryRows([row()]);
  assert.equal(r.ticker, "EOS");
  assert.equal(r.name, "ELECTRO OPTIC");
  assert.equal(r.buyPrice, 5000);
  assert.equal(r.sellOrCurrent, 8000);
  assert.equal(r.pnl, 3000);
  assert.equal(r.type, "Matched");
  assert.equal(r.openPosition, false);
});

test("stored: an unknown buy side is kept off the Grand Total", () => {
  // The row's cost is blank, not zero. Summing its proceeds would report the
  // whole sale as profit — the exact error the blank exists to prevent.
  const rows = storedToSummaryRows([
    row(),
    row({
      ticker: "EUR",
      buySideUnknown: true,
      placementYearUnresolved: true,
      buyQty: 0,
      buyPrice: 0,
      sellQty: 115385,
      sellPrice: 40000,
      pnl: 40000,
      isMatched: false,
    }),
  ]);

  const unknown = rows.find((r) => r.ticker === "EUR")!;
  assert.equal(unknown.type, "Buy Side Unknown");
  assert.equal(unknown.excludedFromTotal, true);
  assert.equal(unknown.flagged, true);

  const total = grandTotal(rows);
  assert.equal(total.pnl, 3000, "the $40,000 with no cost behind it is excluded");
  assert.equal(total.sellOrCurrent, 8000, "not even its proceeds are counted");
});

test("stored: correcting the buy side by hand puts the row back in the total", () => {
  // This is the whole point of the override: a blank row is not permanently
  // exiled, it rejoins as soon as someone supplies what the sources could not.
  const overrides = new Map<string, PnlOverride>([
    [
      "EUR",
      {
        parent: "EUR",
        buyQty: 115385,
        sellQty: null,
        buyPrice: 25000,
        sellOrCurrent: null,
        note: "Cost from the June statement",
        updatedBy: "desk",
        updatedAt: "2026-08-07T00:00:00Z",
      },
    ],
  ]);

  const rows = storedToSummaryRows(
    [
      row({
        ticker: "EUR",
        buySideUnknown: true,
        buyQty: 0,
        buyPrice: 0,
        sellQty: 115385,
        sellPrice: 40000,
        pnl: 40000,
        isMatched: false,
      }),
    ],
    overrides,
  );

  const r = rows[0];
  assert.equal(r.edited, true);
  assert.equal(r.buyPrice, 25000);
  assert.equal(r.pnl, 15000, "recomputed as sell − buy, never taken from the override");
  assert.equal(r.excludedFromTotal, false);
  assert.equal(grandTotal(rows).pnl, 15000);
});

test("stored: P&L is recomputed from the values in force, never overridden directly", () => {
  const overrides = new Map<string, PnlOverride>([
    [
      "EOS",
      {
        parent: "EOS",
        buyQty: null,
        sellQty: null,
        buyPrice: 6000,
        sellOrCurrent: null,
        note: null,
        updatedBy: "desk",
        updatedAt: "2026-08-07T00:00:00Z",
      },
    ],
  ]);

  const [r] = storedToSummaryRows([row()], overrides);
  assert.equal(r.buyPrice, 6000);
  assert.equal(r.pnl, 2000, "8000 − 6000, not the stored 3000");
  assert.equal(r.computed.pnl, 3000, "what the sources said is kept");
  assert.match(r.type, /\(edited\)$/);
});

test("stored: an option line never inherits the underlying's override", () => {
  // The override was authored against the company row (EOS). Applying it to a
  // separate option position (EOSO) would change a figure nobody edited.
  const overrides = new Map<string, PnlOverride>([
    [
      "EOSO",
      {
        parent: "EOSO",
        buyQty: null,
        sellQty: null,
        buyPrice: 999,
        sellOrCurrent: null,
        note: null,
        updatedBy: "desk",
        updatedAt: "2026-08-07T00:00:00Z",
      },
    ],
  ]);

  const [r] = storedToSummaryRows(
    [row({ ticker: "EOSO", isOption: true, buyPrice: 0, isMatched: false })],
    overrides,
  );
  assert.equal(r.edited, false);
  assert.equal(r.buyPrice, 0);
  assert.equal(r.type, "Option");
});

test("stored: correcting the quantities leaves the row matched, not Unmatched", () => {
  // The bug this covers: the desk fixed a 900-vs-1000 mismatch by hand and the
  // row went on reading "Unmatched" — and went on being counted by the client
  // profile's Unmatched tab — because the status was still being read off the
  // stored flag the correction exists to overrule.
  const overrides = new Map<string, PnlOverride>([
    [
      "EOS",
      {
        parent: "EOS",
        buyQty: 1000,
        sellQty: null,
        buyPrice: null,
        sellOrCurrent: null,
        note: "Missing parcel from the May contract note",
        updatedBy: "desk",
        updatedAt: "2026-08-07T00:00:00Z",
      },
    ],
  ]);

  const [r] = storedToSummaryRows(
    [row({ buyQty: 900, sellQty: 1000, openQty: 0, isMatched: false })],
    overrides,
  );

  assert.equal(r.type, "Matched (edited)");
  assert.equal(r.isMatched, true, "the Unmatched tab reads this");
  assert.equal(r.openPosition, false);
  assert.equal(r.computed.buyQty, 900, "what the sources said is still kept");
});

test("stored: a quantity correction that does NOT balance stays a mismatch", () => {
  const overrides = new Map<string, PnlOverride>([
    [
      "EOS",
      {
        parent: "EOS",
        buyQty: 950,
        sellQty: null,
        buyPrice: null,
        sellOrCurrent: null,
        note: null,
        updatedBy: "desk",
        updatedAt: "2026-08-07T00:00:00Z",
      },
    ],
  ]);

  const [r] = storedToSummaryRows(
    [row({ buyQty: 900, sellQty: 1000, openQty: 0, isMatched: false })],
    overrides,
  );

  // 950 bought against 1,000 sold. The correction moved the row but did not
  // close the gap, and the gap is on the BUY side — 50 units were sold that no
  // contract note ever bought, which is what the status now says instead of the
  // catch-all "Unmatched".
  assert.equal(r.type, "Missing Buys (edited)");
  assert.equal(r.isMatched, false);
});

test("stored: correcting the sell side closes the open position", () => {
  const overrides = new Map<string, PnlOverride>([
    [
      "EOS",
      {
        parent: "EOS",
        buyQty: null,
        sellQty: 1000,
        buyPrice: null,
        sellOrCurrent: null,
        note: null,
        updatedBy: "desk",
        updatedAt: "2026-08-07T00:00:00Z",
      },
    ],
  ]);

  const [r] = storedToSummaryRows(
    [row({ buyQty: 1000, sellQty: 400, openQty: 600, isMatched: false })],
    overrides,
  );

  assert.equal(r.type, "Matched (edited)");
  assert.equal(r.openQty, 0, "the 600 held were the ones the ledger got wrong");
  assert.equal(r.openPosition, false);
});

test("stored: supplying the missing buy quantity retires the Buy Side Unknown flag", () => {
  const unknown = row({
    ticker: "EUR",
    buySideUnknown: true,
    buyQty: 0,
    buyPrice: 0,
    sellQty: 115385,
    sellPrice: 40000,
    pnl: 40000,
    openQty: 0,
    isMatched: false,
  });

  const withQty = (over: Partial<PnlOverride>) =>
    storedToSummaryRows(
      [unknown],
      new Map<string, PnlOverride>([
        [
          "EUR",
          {
            parent: "EUR",
            buyQty: null,
            sellQty: null,
            buyPrice: null,
            sellOrCurrent: null,
            note: null,
            updatedBy: "desk",
            updatedAt: "2026-08-07T00:00:00Z",
            ...over,
          },
        ],
      ]),
    )[0];

  assert.equal(withQty({ buyQty: 115385, buyPrice: 25000 }).type, "Matched (edited)");
  // Only the cost was answered. The label names the QUANTITY — still 0 buys
  // against 115,385 sold, which is exactly how the Mismatches page words it.
  assert.equal(withQty({ buyPrice: 25000 }).type, "Buy Side Unknown (edited)");
});

test("stored: status precedence matches the calculator's", () => {
  const status = (over: Partial<StoredPnlRow>) =>
    storedToSummaryRows([row(over)])[0].type;

  // Blank figures first — no status describing them can be true.
  assert.equal(status({ buySideUnknown: true, isDbOnly: true, isMatched: true }), "Buy Side Unknown");
  // A DB-only row trivially "matches" because both legs came from the same held
  // quantity, so where the figures came from is the useful fact.
  // Both wordings answer "why are there no trades behind this row?" rather than
  // naming the table it came from, and an OPTION only ever reaches the snapshot
  // with a code — so it is listed, which reads against the modelled rows beside it.
  assert.equal(status({ isDbOnly: true, isMatched: true }), "Open - no ledger history");
  assert.equal(status({ isDbOnly: true, isMatched: true, isOption: true }), "Listed Options");
  assert.equal(status({ isUnlistedOption: true, isMatched: true }), "Unlisted Option");
  assert.equal(status({ isMatched: false, isOption: true }), "Option");
  assert.equal(status({ isMatched: false, openQty: 500 }), "Open");
  assert.equal(status({ isMatched: false }), "Unmatched");
});

test("stored: a row the holdings snapshot does not carry is closed, not open", () => {
  // The bug this exists for: 10,000 bought, 4,000 sold, and the client holds
  // nothing. `openQty` said 6,000 and the profile read "Open" — a position the
  // client had already exited, with the missing sell trades hidden behind it.
  const unheld = {
    buyQty: 10_000,
    sellQty: 4_000,
    openQty: 6_000,
    isMatched: false,
    notInHoldings: true,
  };

  const [r] = storedToSummaryRows([row(unheld)]);
  assert.equal(r.type, "Missing Sells");
  assert.equal(positionStatus(r), "Closed");
  assert.equal(r.flagged, true, "the desk has to see this one");

  // Same figures, snapshot silent — nothing was verified, so nothing changes.
  const [unverified] = storedToSummaryRows([row({ ...unheld, notInHoldings: false })]);
  assert.equal(unverified.type, "Open");
  assert.equal(positionStatus(unverified), "Open");
  assert.equal(unverified.flagged, false);
});

test("stored: a verified absence never overrides a better-sourced status", () => {
  // Every flag below means the snapshot DID carry the row, so `notInHoldings`
  // cannot be true beside them in real data — but precedence is what stops one
  // stale flag from closing a position, so it is pinned.
  const status = (over: Partial<StoredPnlRow>) =>
    positionStatus(storedToSummaryRows([row({ notInHoldings: true, ...over })])[0]);

  assert.equal(status({ isDbOnly: true }), "Open");
  assert.equal(status({ isDbOpenValued: true }), "Open");
  assert.equal(
    status({ ticker: "GRV-UO", isUnlistedOption: true, isOption: true, buyQty: 0, sellQty: 50_000 }),
    "Open",
  );
  assert.equal(status({ buySideUnknown: true, buyQty: 0, buyPrice: 0 }), "Unknown");
});

test("stored: a held parcel reads as Open, never as a completed round trip", () => {
  // 2,500 bought across two contract notes, nothing sold, 2,500 still held.
  const open = row({
    buyQty: 2500,
    sellQty: 0,
    heldQty: 2500,
    openQty: 0,
    isMatched: true,
    isDbOpenValued: true,
    buyPrice: 2900,
    sellPrice: 3250,
    pnl: 350,
    comment: "Open · 2,500 held",
  });

  const [r] = storedToSummaryRows([open]);
  assert.equal(r.sellQty, 0, "the table's Sell Qty must not claim a disposal");
  assert.equal(r.heldQty, 2500);
  // `isMatched` is TRUE here — every unit is accounted for — and the status
  // still must not say "Matched", which reads as bought-and-sold.
  assert.equal(r.isMatched, true);
  assert.equal(r.type, "Open");
  assert.equal(positionStatus(r), "Open");
  assert.equal(r.note, "Open · 2,500 held", "the count the sell side used to carry");
  assert.equal(r.pnl, 350, "no money moves");
});

test("stored: Mark Open's override reconciles without inventing a sale", () => {
  /**
   * The desk's sequence, and the half of it that used to be impossible.
   *
   * A row arrives with no buy side — 2,500 "sold" that no contract note bought.
   * The desk corrects the buy side, then declares the parcel open. Before the
   * held leg existed, `Mark Open` could only say so by setting both quantities
   * equal, which balanced the row by reporting the very sale that never
   * happened.
   */
  const overrides = new Map<string, PnlOverride>([
    [
      "EOS",
      {
        parent: "EOS",
        buyQty: 2500,
        sellQty: 0,
        heldQty: 2500,
        buyPrice: 2900,
        sellOrCurrent: 2900,
        note: "Open position — 2,500 units still held, carried at cost by the desk.",
        updatedBy: "desk",
        updatedAt: "2026-08-26T00:00:00Z",
      },
    ],
  ]);

  const [r] = storedToSummaryRows(
    [row({ buyQty: 0, sellQty: 2500, heldQty: 0, openQty: 0, isMatched: false })],
    overrides,
  );

  assert.equal(r.edited, true);
  assert.equal(r.buyQty, 2500);
  assert.equal(r.sellQty, 0, "declaring a parcel open must not report a sale");
  assert.equal(r.isMatched, true, "2,500 bought = 0 sold + 2,500 held — it reconciles");
  assert.equal(r.openQty, 0, "so nothing is left unaccounted for");
  assert.equal(r.pnl, 0, "carried at cost — no gain or loss is invented");
});

test("stored: correcting held units alone counts as an edit", () => {
  // Held has no cell of its own in the table, so it is not in `OverriddenFields`
  // — but a row whose held count was typed by hand is no longer a pure
  // derivation, and the reader is entitled to know that.
  const overrides = new Map<string, PnlOverride>([
    [
      "EOS",
      {
        parent: "EOS",
        buyQty: null,
        sellQty: null,
        heldQty: 1000,
        buyPrice: null,
        sellOrCurrent: null,
        note: null,
        updatedBy: "desk",
        updatedAt: "2026-08-26T00:00:00Z",
      },
    ],
  ]);

  const [r] = storedToSummaryRows(
    [row({ buyQty: 1000, sellQty: 0, heldQty: 0, openQty: 1000, isMatched: false })],
    overrides,
  );

  assert.equal(r.edited, true);
  assert.match(r.type, /\(edited\)$/);
  assert.equal(r.isMatched, true, "1,000 bought = 0 sold + 1,000 held");
  assert.equal(r.openQty, 0);
});

test("stored: selling more than was bought names the missing buy trades", () => {
  const status = (over: Partial<StoredPnlRow>) => storedToSummaryRows([row(over)])[0].type;

  // Judged on the ledger's own figures — no holding can explain a sale of units
  // that were never bought — so the verification plays no part either way.
  assert.equal(status({ buyQty: 4_000, sellQty: 10_000, openQty: 0, isMatched: false }), "Missing Buys");
  assert.equal(
    status({ buyQty: 4_000, sellQty: 10_000, openQty: 0, isMatched: false, notInHoldings: true }),
    "Missing Buys",
  );
  // A blank buy side is a different statement — the tracker could not be
  // resolved — and keeps its own wording.
  assert.equal(
    status({ buyQty: 0, buyPrice: 0, sellQty: 10_000, openQty: 0, isMatched: false, buySideUnknown: true }),
    "Buy Side Unknown",
  );
});

test("stored: the flags the Position column reads survive the mapping", () => {
  // `positionStatus` cannot tell a still-held parcel from an exited one on the
  // quantities alone — valuing an open parcel sets both legs from the same held
  // count. It reads these flags instead, so they have to arrive.
  const status = (over: Partial<StoredPnlRow>) =>
    positionStatus(storedToSummaryRows([row(over)])[0]);

  assert.equal(status({ isDbOpenValued: true }), "Open", "nothing was sold");
  assert.equal(status({ isPartialExit: true, isMatched: false }), "Partly open");
  assert.equal(status({ isDbOnly: true }), "Open", "held, with no ledger behind it");
  assert.equal(status({}), "Closed", "1,000 bought, 1,000 sold, no parcel left");
});

test("stored: an option says whether the position is still open", () => {
  // The point of naming the state: a free grant is never bought, so the old
  // Yes/No flag reported it as a disposal that never happened.
  const status = (over: Partial<StoredPnlRow>) =>
    positionStatus(storedToSummaryRows([row(over)])[0]);

  assert.equal(
    status({ ticker: "GRV-UO", isUnlistedOption: true, isOption: true, buyQty: 0, sellQty: 50_000 }),
    "Open",
    "a modelled grant is outstanding for as long as the row exists",
  );
  assert.equal(
    status({ ticker: "EOSO", isOption: true, isDbOnly: true }),
    "Open",
    "a listed series carried by the holdings snapshot is held",
  );
  assert.equal(
    status({ ticker: "EOSO", isOption: true, buyQty: 10_000, sellQty: 10_000, openQty: 0 }),
    "Closed",
    "a listed series traded all the way out",
  );
  assert.equal(
    status({ ticker: "EOSO", isOption: true, buyQty: 10_000, sellQty: 4_000, openQty: 6_000, isMatched: false }),
    "Open",
    "6,000 contracts still held",
  );
});

test("stored: rows are ordered biggest result first", () => {
  const rows = storedToSummaryRows([
    row({ ticker: "AAA", pnl: 100, sellPrice: 100, buyPrice: 0 }),
    row({ ticker: "BBB", pnl: 900, sellPrice: 900, buyPrice: 0 }),
    row({ ticker: "CCC", pnl: -50, sellPrice: 0, buyPrice: 50 }),
  ]);
  assert.deepEqual(rows.map((r) => r.ticker), ["BBB", "AAA", "CCC"]);
});

test("stored: options (listed and unlisted) have buyQty equal to sellQty and non-empty", () => {
  const unlisted = storedToSummaryRows([
    row({ ticker: "GRV-UO", isUnlistedOption: true, isOption: true, buyQty: 0, sellQty: 50_000 }),
  ])[0];
  assert.equal(unlisted.buyQty, 50_000);
  assert.equal(unlisted.sellQty, 50_000);
  assert.equal(unlisted.computed.buyQty, 50_000);
  assert.equal(unlisted.computed.sellQty, 50_000);

  const listed = storedToSummaryRows([
    row({ ticker: "EOSO", isOption: true, buyQty: 0, sellQty: 25_000 }),
  ])[0];
  assert.equal(listed.buyQty, 25_000);
  assert.equal(listed.sellQty, 25_000);
  assert.equal(listed.computed.buyQty, 25_000);
  assert.equal(listed.computed.sellQty, 25_000);
});

