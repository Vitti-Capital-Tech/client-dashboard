import test from "node:test";
import assert from "node:assert/strict";

import {
  aliasUpdateSql,
  suggestPlacementAliases,
  type ClientLedger,
} from "./alias-suggest.ts";
import type { PlacementTickerInfo } from "../pnl-calculator.ts";

/**
 * Tests for the alias SUGGESTER.
 *
 * The thing being pinned down is not "does it find matches" — it is where it
 * refuses to. An alias moves a placement parcel onto a client's stored P&L, so a
 * wrong suggestion that looks confident is worse than no suggestion at all.
 */

const alloc = (clientName: string, roundShares: number) => ({
  clientName,
  advisor: "VTC",
  askingBid: 0,
  allocationDollar: roundShares / 10,
  roundShares,
  actualDollar: roundShares / 10,
});

const sheet = (
  ticker: string,
  participants: ReturnType<typeof alloc>[],
): [string, PlacementTickerInfo] => [
  ticker,
  {
    ticker,
    totalShares: participants.reduce((s, p) => s + p.roundShares, 0),
    totalActualDollar: participants.reduce((s, p) => s + p.actualDollar, 0),
    clientAllocations: participants,
  },
];

const client = (over: Partial<ClientLedger> = {}): ClientLedger => ({
  clientId: "c1",
  displayName: "R Chawla & G Vijan PTY LTD",
  aliases: [],
  rows: [{ ticker: "RMI", buyQty: 0, sellQty: 238095 }],
  ...over,
});

test("suggest: the ledger's own shortfall names the participant", () => {
  // The real case. Eight names in the sheet; the quantity cuts it to two, and a
  // shared word picks one. That is a proposal a person can check in seconds.
  const placements = new Map([
    sheet("RMI", [
      alloc("Akhil Sobti", 238095),
      alloc("RG Vijan Super Fund", 238095),
      alloc("PSG Super Fund", 119048),
      alloc("Saturn Fund", 595238),
    ]),
  ]);

  const out = suggestPlacementAliases([client()], placements);

  // Both quantity matches are surfaced — hiding one would hide the ambiguity —
  // but only the one that also shares a name is offered with confidence.
  const high = out.filter((s) => s.confidence === "high");
  assert.equal(high.length, 1);
  assert.equal(high[0].alias, "RG Vijan Super Fund");
  assert.equal(high[0].evidence[0].ticker, "RMI");
  assert.equal(high[0].evidence[0].shortfall, 238095);
  assert.equal(high[0].evidence[0].quantityMatch, true);

  assert.deepEqual(
    out.filter((s) => s.confidence === "medium").map((s) => s.alias),
    ["Akhil Sobti"],
  );
  // Quantities that do not reconcile are not evidence of anything.
  assert.ok(!out.some((s) => s.alias === "Saturn Fund"));
});

test("suggest: a row the contract notes already explain proposes nothing", () => {
  // Bought on-market in a stock that was ALSO placed to other people. The sheet
  // will always list strangers and there is nothing to fill, so there is nothing
  // to suggest — which is what keeps this report short enough to read.
  const placements = new Map([
    sheet("GRV", [alloc("Technord Pty Ltd", 121212), alloc("Zidiplus Pty Ltd", 151515)]),
  ]);

  const out = suggestPlacementAliases(
    [client({ rows: [{ ticker: "GRV", buyQty: 121212, sellQty: 121212 }] })],
    placements,
  );
  assert.deepEqual(out, []);
});

test("suggest: a name that belongs to another client is never offered", () => {
  // `PSG Super Fund` resolves to the superannuation entity, which is a separate
  // client. Offering it to the investments company is exactly the mistake this
  // module exists to avoid making on someone's behalf.
  const placements = new Map([
    sheet("XST", [alloc("PSG Super Fund", 200000), alloc("Someone Unknown", 200000)]),
  ]);

  const clients: ClientLedger[] = [
    {
      clientId: "c-inv",
      displayName: "Psg Capital Investments PTY LTD",
      aliases: [],
      rows: [{ ticker: "XST", buyQty: 0, sellQty: 200000 }],
    },
    { clientId: "c-super", displayName: "Psg Super Fund PTY LTD", aliases: [], rows: [] },
  ];

  const out = suggestPlacementAliases(clients, placements);
  assert.ok(!out.some((s) => s.alias === "PSG Super Fund"));
  assert.deepEqual(out.map((s) => s.alias), ["Someone Unknown"]);
});

test("suggest: a name two clients both want is flagged, not chosen", () => {
  // Two clients, the same shortfall, one unclaimed participant. Picking either
  // would be a coin toss with a client's P&L, so it is reported and excluded
  // from the SQL.
  const placements = new Map([sheet("AKN", [alloc("Vijan Holdings", 833333)])]);

  const clients: ClientLedger[] = [
    {
      clientId: "c1",
      displayName: "R Chawla & G Vijan PTY LTD",
      aliases: [],
      rows: [{ ticker: "AKN", buyQty: 0, sellQty: 833333 }],
    },
    {
      clientId: "c2",
      displayName: "Rg Vijan PTY LTD",
      aliases: [],
      rows: [{ ticker: "AKN", buyQty: 0, sellQty: 833333 }],
    },
  ];

  const out = suggestPlacementAliases(clients, placements);
  assert.equal(out.length, 2);
  assert.ok(out.every((s) => s.conflict));
  assert.deepEqual(aliasUpdateSql(out), []);
});

test("suggest: a placement the client is already matched in is left alone", () => {
  // The merge will find them by name; an alias would add nothing and the other
  // participants are strangers, not candidates.
  const placements = new Map([
    sheet("TRU", [alloc("R Chawla & G Vijan", 250000), alloc("Zidiplus Pty Ltd", 250000)]),
  ]);

  const out = suggestPlacementAliases(
    [client({ rows: [{ ticker: "TRU", buyQty: 0, sellQty: 250000 }] })],
    placements,
  );
  assert.deepEqual(out, []);
});

test("suggest: a short buy side is a shortfall too", () => {
  // 30,000 arrived as a contract note and 100,000 was sold, so the missing
  // parcel is 70,000 — not 100,000. Matching on the sale would find nothing.
  const placements = new Map([
    sheet("KNI", [alloc("Kni Nominees", 70000), alloc("Other Fund", 100000)]),
  ]);

  const out = suggestPlacementAliases(
    [client({ rows: [{ ticker: "KNI", buyQty: 30000, sellQty: 100000 }] })],
    placements,
  );
  assert.deepEqual(out.map((s) => s.alias), ["Kni Nominees"]);
  assert.equal(out[0].evidence[0].shortfall, 70000);
});

test("sql: only the defensible suggestions become statements, and they append", () => {
  const suggestions = suggestPlacementAliases(
    [
      client({
        clientId: "c1",
        displayName: "Psg Capital Investments PTY LTD",
        rows: [
          { ticker: "AT1", buyQty: 0, sellQty: 363637 },
          { ticker: "CY5", buyQty: 0, sellQty: 31950 },
        ],
      }),
    ],
    new Map([
      sheet("AT1", [alloc("PSG Capital Ltd", 363637)]),
      // Name-only: the quantity disagrees, so it is reported but not offered.
      sheet("CY5", [alloc("PSG Investments", 999)]),
    ]),
  );

  assert.deepEqual(
    suggestions.map((s) => [s.alias, s.confidence]),
    [
      ["PSG Capital Ltd", "high"],
      ["PSG Investments", "low"],
    ],
  );

  const [sql, ...rest] = aliasUpdateSql(suggestions);
  assert.equal(rest.length, 0, "one statement per client");
  assert.match(sql, /'PSG Capital Ltd'/);
  assert.ok(!sql.includes("PSG Investments"), "a look-alike name is never emitted");
  // Appends: an alias entered by hand must survive a later run of this script.
  assert.match(sql, /placement_aliases \|\| ARRAY\[/);
  assert.match(sql, /WHERE display_name = 'Psg Capital Investments PTY LTD'/);
});

test("suggest: a sheet's own total is never proposed as a client", () => {
  // The parser drops these rows now, but a tracker cache parsed before that
  // change still carries them — and a total reconciles with a shortfall often
  // enough to look convincing. "Add `Total Confirmation` as a client alias" is
  // not a sentence this script may print.
  const placements = new Map([
    sheet("GRE", [alloc("Total Confirmation", 100000), alloc("Allowance", 100000)]),
  ]);

  const out = suggestPlacementAliases(
    [client({ rows: [{ ticker: "GRE", buyQty: 0, sellQty: 100000 }] })],
    placements,
  );
  assert.deepEqual(out, []);
});

test("sql: an exact quantity with no name signal is reported, not offered", () => {
  // From the real register: `Placement - Vitti Capital PTY LTD` reconciles
  // exactly with `PSG Capital Pty Ltd`'s CXO parcel and is plainly a different
  // company. Placement parcels are round numbers drawn from a short list, so
  // quantities collide by coincidence — a name signal has to agree before this
  // hands anyone a statement to run.
  const suggestions = suggestPlacementAliases(
    [
      client({
        displayName: "Placement - Vitti Capital PTY LTD",
        rows: [{ ticker: "CXO", buyQty: 0, sellQty: 35715 }],
      }),
    ],
    new Map([sheet("CXO", [alloc("PSG Capital Pty Ltd", 35715)])]),
  );

  assert.deepEqual(
    suggestions.map((s) => [s.alias, s.confidence]),
    [["PSG Capital Pty Ltd", "medium"]],
  );
  assert.deepEqual(aliasUpdateSql(suggestions), [], "reported above, never emitted");
});

test("sql: a quote in a client name cannot break out of the statement", () => {
  const suggestions = suggestPlacementAliases(
    [
      client({
        displayName: "O'Brien Holdings PTY LTD",
        rows: [{ ticker: "ABE", buyQty: 0, sellQty: 5000 }],
      }),
    ],
    new Map([sheet("ABE", [alloc("O'Brien Family Trust", 5000)])]),
  );

  const [sql] = aliasUpdateSql(suggestions);
  assert.match(sql, /'O''Brien Family Trust'/);
  assert.match(sql, /'O''Brien Holdings PTY LTD'/);
});
