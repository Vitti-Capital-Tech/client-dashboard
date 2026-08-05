import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parsePnlFileBuffer,
  buildPnlExportCsvString,
  buildPnlExportXlsxBuffer,
  mergePlacementTrackerIntoSummary,
  mergeDbHoldingsIntoSummary,
  collectPlacementClientNames,
  parsePlacementTrackerBuffer,
  combinePlacementMaps,
  resolvePlacementClientHints,
  buildPnlExportFilename,
  isClientMatch,
  parseAddOnSpec,
  parseAddOnSpecs,
  buildUnlistedOptionRows,
  collectUnlistedOptionTickers,
  exportStatus,
  type PlacementTickerInfo,
} from "./pnl-calculator.ts";
import { blackScholesCall, UNLISTED_OPTION_ASSUMPTIONS } from "./black-scholes.ts";

test("PNL Calculator - parse CSV buffer and aggregate by ticker", async () => {
  const sampleCsv = `CNote,Account,Type,Security,Company,Description,Contract Date,Adviser,Units,Avg Price,Consideration,Brokerage,Other Charges,GST,Value,Brokerage%,Status
2462073,114716,SELL,EOS,ELECTRO C FPO,,21-05-2026,VIZ,407,8.11,3300.77,100,0,10,3300.77,3.0296,SETTLED
2458396,114716,BUY,EOS,ELECTRO C FPO,,19-05-2026,VIZ,407,8.00,3256.00,0,0,0,3256.00,0,SETTLED
2306306,114716,SELL,LDX,LUMOS DIA FPO,,04-02-2026,VIZ,1000,0.50,500.00,0,0,0,500.00,0,SETTLED
2303464,114716,BUY,LDX,LUMOS DIA FPO,,03-02-2026,VIZ,1000,0.30,300.00,0,0,0,300.00,0,SETTLED`;

  const result = await parsePnlFileBuffer(Buffer.from(sampleCsv), "sample.csv");

  assert.equal(result.errors.length, 0);
  assert.equal(result.totalTrades, 4);
  assert.equal(result.uniqueTickers, 2);

  const eos = result.summary.find((s) => s.ticker === "EOS");
  assert.ok(eos);
  assert.equal(eos.buyQty, 407);
  assert.equal(eos.sellQty, 407);
  assert.equal(eos.buyPrice, 3256.00);
  assert.equal(eos.sellPrice, 3300.77);
  assert.equal(eos.totalBuyValue, 3256.00);
  assert.equal(eos.totalSellValue, 3300.77);
  assert.equal(eos.pnlCalculated, 44.77);

  const ldx = result.summary.find((s) => s.ticker === "LDX");
  assert.ok(ldx);
  assert.equal(ldx.buyQty, 1000);
  assert.equal(ldx.sellQty, 1000);
  assert.equal(ldx.pnlCalculated, 200.00);

  // Total PNL = 44.77 + 200.00 = 244.77
  assert.equal(result.totalPnl, 244.77);
});

test("PNL Calculator - ignore non-SETTLED trades (CANCELLED, PENDING, REVERSED)", async () => {
  const csvWithNonSettled = `CNote,Account,Type,Security,Company,Description,Contract Date,Adviser,Units,Avg Price,Consideration,Brokerage,Other Charges,GST,Value,Brokerage%,Status
101,114716,BUY,ABC,ABC CORP,,01-01-2026,VIZ,100,10.00,1000.00,0,0,0,1000.00,0,SETTLED
102,114716,SELL,ABC,ABC CORP,,02-01-2026,VIZ,100,15.00,1500.00,0,0,0,1500.00,0,SETTLED
103,114716,BUY,ABC,ABC CORP,,03-01-2026,VIZ,50,12.00,600.00,0,0,0,600.00,0,CANCELLED
104,114716,SELL,ABC,ABC CORP,,04-01-2026,VIZ,50,14.00,700.00,0,0,0,700.00,0,PENDING`;

  const result = await parsePnlFileBuffer(Buffer.from(csvWithNonSettled), "test.csv");

  assert.equal(result.totalTrades, 2);
  assert.equal(result.summary.length, 1);
  const abc = result.summary[0];
  assert.equal(abc.buyQty, 100);
  assert.equal(abc.sellQty, 100);
  assert.equal(abc.buyPrice, 1000.00);
  assert.equal(abc.sellPrice, 1500.00);
  assert.equal(abc.pnlCalculated, 500.00);
});

test("PNL Calculator - map 5-letter derivative tickers (EOSXX, ACWXX) to 3-letter parent ticker", async () => {
  const sampleCsv = `CNote,Account,Type,Security,Company,Description,Contract Date,Adviser,Units,Avg Price,Consideration,Brokerage,Other Charges,GST,Value,Brokerage%,Status
2462073,114716,SELL,EOS,ELECTRO C FPO,,21-05-2026,VIZ,407,8.11,3300.77,100,0,10,3300.77,3.0296,SETTLED
2458396,114716,BUY,EOSXX,ELECTRO C INSTPLACE,,19-05-2026,VIZ,407,8.00,3256.00,0,0,0,3256.00,0,SETTLED
2303464,114716,BUY,ACWXX,ACTINOGE INSTOPLACE,,03-02-2026,VIZ,71429,0.042,3000.02,0,0,0,3000.02,0,SETTLED`;

  const result = await parsePnlFileBuffer(Buffer.from(sampleCsv), "derivative.csv");

  assert.equal(result.totalTrades, 3);
  assert.equal(result.uniqueTickers, 2);

  const eos = result.summary.find((s) => s.ticker === "EOS");
  assert.ok(eos);
  assert.equal(eos.buyQty, 407); // aggregated from EOSXX
  assert.equal(eos.sellQty, 407); // aggregated from EOS
  assert.equal(eos.buyPrice, 3256.00);
  assert.equal(eos.sellPrice, 3300.77);
  assert.equal(eos.isMatched, true);
  assert.equal(eos.isOption, false);
  assert.equal(eos.pnlCalculated, 44.77);

  const acw = result.summary.find((s) => s.ticker === "ACW");
  assert.ok(acw);
  assert.equal(acw.buyQty, 71429); // aggregated from ACWXX
  assert.equal(acw.sellQty, 0);
  assert.equal(acw.buyPrice, 3000.02);
  assert.equal(acw.isMatched, false);
  assert.equal(acw.isOption, false);
  assert.equal(acw.pnlCalculated, -3000.02);

  // Total PNL sums all positions (EOS: 44.77, ACW: -3000.02 => -2955.25)
  assert.equal(result.totalPnl, -2955.25);
});

test("PNL Calculator - categorize 4-5 character tickers containing 'O' (e.g. EOSO, ACWO) as Options", async () => {
  const optionCsv = `CNote,Account,Type,Security,Company,Description,Contract Date,Adviser,Units,Avg Price,Consideration,Brokerage,Other Charges,GST,Value,Brokerage%,Status
2462073,114716,BUY,EOSO,ELECTRO OPTIONS,,21-05-2026,VIZ,500,0.10,50.00,0,0,0,50.00,0,SETTLED
2458396,114716,SELL,EOSO,ELECTRO OPTIONS,,25-05-2026,VIZ,500,0.25,125.00,0,0,0,125.00,0,SETTLED`;

  const result = await parsePnlFileBuffer(Buffer.from(optionCsv), "option_test.csv");
  // The option keeps its own code — it is not folded into an EOS equity row.
  assert.equal(result.summary.find((s) => s.ticker === "EOS"), undefined);

  const eoso = result.summary.find((s) => s.ticker === "EOSO");
  assert.ok(eoso);
  assert.equal(eoso.buyQty, 500);
  assert.equal(eoso.sellQty, 500);
  assert.equal(eoso.instrument, "OPTION");
  assert.equal(eoso.parentTicker, "EOS");
  assert.equal(eoso.isOption, true);
  assert.equal(result.optionTickers, 1);
});

test("PNL Calculator - equity and option lines on one underlying stay separate rows", async () => {
  // GED (ordinary) and GEDO (option) are two different securities: their P&L
  // must never be netted into a single row.
  const gedCsv = `CNote,Account,Type,Security,Company,Description,Contract Date,Adviser,Units,Avg Price,Consideration,Brokerage,Other Charges,GST,Value,Brokerage%,Status
101,114716,BUY,GED,GOLDEN DEEPS,,01-05-2026,VIZ,10000,0.10,1000.00,0,0,0,1000.00,0,SETTLED
102,114716,SELL,GED,GOLDEN DEEPS,,10-05-2026,VIZ,10000,0.15,1500.00,0,0,0,1500.00,0,SETTLED
103,114716,BUY,GEDO,GOLDEN DEEPS OPTION,,01-05-2026,VIZ,5000,0.02,100.00,0,0,0,100.00,0,SETTLED
104,114716,SELL,GEDO,GOLDEN DEEPS OPTION,,12-05-2026,VIZ,5000,0.01,50.00,0,0,0,50.00,0,SETTLED`;

  const result = await parsePnlFileBuffer(Buffer.from(gedCsv), "ged.csv");

  assert.equal(result.uniqueTickers, 2);
  // Equity line sorts ahead of its option line.
  assert.deepEqual(result.summary.map((s) => s.ticker), ["GED", "GEDO"]);

  const ged = result.summary[0];
  assert.equal(ged.instrument, "EQUITY");
  assert.equal(ged.buyQty, 10000);
  assert.equal(ged.pnlCalculated, 500.00);
  assert.equal(ged.isOption, false);
  assert.equal(ged.hasOptionCode, false);

  const gedo = result.summary[1];
  assert.equal(gedo.instrument, "OPTION");
  assert.equal(gedo.parentTicker, "GED");
  assert.equal(gedo.buyQty, 5000);
  assert.equal(gedo.pnlCalculated, -50.00);
  assert.equal(gedo.isOption, true);

  assert.equal(result.totalPnl, 450.00); // 500 equity - 50 option
  assert.equal(result.optionTickers, 1);
});

test("PNL Calculator - options like ENVO, NVOO report on their own rows, not the parent's", async () => {
  const envCsv = `CNote,Account,Type,Security,Company,Description,Contract Date,Adviser,Units,Avg Price,Consideration,Brokerage,Other Charges,GST,Value,Brokerage%,Status
2462073,114716,BUY,ENVO,ENV OPTIONS,,21-05-2026,VIZ,1000,0.10,100.00,0,0,0,100.00,0,SETTLED
2458396,114716,BUY,ENV,ENV ORDINARY,,25-05-2026,VIZ,2000,0.50,1000.00,0,0,0,1000.00,0,SETTLED
2458397,114716,BUY,NVOO,NVO OPTIONS,,26-05-2026,VIZ,500,0.20,100.00,0,0,0,100.00,0,SETTLED`;

  const result = await parsePnlFileBuffer(Buffer.from(envCsv), "env_nvo_test.csv");

  assert.equal(result.uniqueTickers, 3);

  const env = result.summary.find((s) => s.ticker === "ENV");
  assert.ok(env);
  assert.equal(env.buyQty, 2000); // ENV ordinary only — ENVO is its own row now
  assert.equal(env.buyPrice, 1000.00);
  assert.equal(env.hasOptionCode, false);

  const envo = result.summary.find((s) => s.ticker === "ENVO");
  assert.ok(envo);
  assert.equal(envo.buyQty, 1000);
  assert.equal(envo.buyPrice, 100.00);
  assert.equal(envo.hasOptionCode, true);

  const nvoo = result.summary.find((s) => s.ticker === "NVOO");
  assert.ok(nvoo);
  assert.equal(nvoo.buyQty, 500);
  assert.equal(nvoo.parentTicker, "NVO");
  assert.equal(nvoo.hasOptionCode, true);
});

test("PNL Calculator - non-option derivatives (EOSXX) still roll into the equity row", async () => {
  const csv = `CNote,Account,Type,Security,Company,Description,Contract Date,Adviser,Units,Avg Price,Consideration,Brokerage,Other Charges,GST,Value,Brokerage%,Status
1,114716,BUY,EOSXX,ELECTRO C INSTPLACE,,19-05-2026,VIZ,407,8.00,3256.00,0,0,0,3256.00,0,SETTLED
2,114716,SELL,EOS,ELECTRO C FPO,,21-05-2026,VIZ,407,8.11,3300.77,0,0,0,3300.77,0,SETTLED
3,114716,BUY,EOSO,ELECTRO C OPTION,,19-05-2026,VIZ,100,0.05,5.00,0,0,0,5.00,0,SETTLED`;

  const result = await parsePnlFileBuffer(Buffer.from(csv), "mixed.csv");

  assert.deepEqual(result.summary.map((s) => s.ticker), ["EOS", "EOSO"]);
  const eos = result.summary[0];
  assert.equal(eos.buyQty, 407); // EOSXX merged in — it is not an option code
  assert.equal(eos.sellQty, 407);
  assert.equal(eos.isMatched, true);
  assert.equal(eos.isOption, false);
  assert.equal(result.summary[1].buyQty, 100);
});

test("PNL Calculator - CSV export string contains required columns and numbers", async () => {
  const summary = [
    {
      ticker: "EOS",
      company: "ELECTRO C FPO",
      buyQty: 407,
      sellQty: 407,
      buyPrice: 3256.00,
      sellPrice: 3300.77,
      totalBuyValue: 3256.00,
      totalSellValue: 3300.77,
      pnlCalculated: 44.77,
      isMatched: true,
      isOption: false,
      openQty: 0,
      tradeCount: 2,
    },
  ];

  const csv = buildPnlExportCsvString(summary);
  assert.ok(
    csv.includes(
      "Ticker,Company,Instrument,Underlying,Buy Qty (Sum),Sell Qty (Sum),Buy Price,Sell Price,PnL Calculated,Status,Comments"
    )
  );
  assert.equal(csv.includes("Open Qty"), false, "the Open Qty column was removed");
  assert.ok(csv.includes("EOS,ELECTRO C FPO,Equity,EOS,407,407,3256.00,3300.77,44.77,Matched,"));
  assert.ok(csv.includes("Grand Total"));

  // Every row, header and Grand Total included, must have the same column count.
  const lines = csv.split("\r\n");
  const width = lines[0].split(",").length;
  for (const line of lines) {
    assert.equal(line.split(",").length, width, `ragged row: ${line}`);
  }
});

test("PNL Calculator - CSV export labels the option line and its underlying", async () => {
  const csv = buildPnlExportCsvString([
    {
      ticker: "GEDO",
      parentTicker: "GED",
      instrument: "OPTION",
      company: "GOLDEN DEEPS OPTION",
      buyQty: 5000,
      sellQty: 5000,
      buyPrice: 100.0,
      sellPrice: 50.0,
      totalBuyValue: 100.0,
      totalSellValue: 50.0,
      pnlCalculated: -50.0,
      isMatched: true,
      isOption: true,
      hasOptionCode: true,
      openQty: 0,
      tradeCount: 2,
    },
  ]);

  // Trailing empty field is Comments — the last column now that Open Qty is gone.
  assert.ok(csv.includes("GEDO,GOLDEN DEEPS OPTION,Option,GED,5000,5000,100.00,50.00,-50.00,Matched,"));
});

test("PNL Calculator - XLSX export buffer builds cleanly", async () => {
  const summary = [
    {
      ticker: "EOS",
      company: "ELECTRO C FPO",
      buyQty: 407,
      sellQty: 407,
      buyPrice: 8.00,
      sellPrice: 8.11,
      totalBuyValue: 3256.00,
      totalSellValue: 3300.77,
      pnlCalculated: 44.77,
      isMatched: true,
      isOption: false,
      openQty: 0,
      tradeCount: 2,
    },
  ];

  const buffer = await buildPnlExportXlsxBuffer(summary);
  assert.ok(buffer instanceof Buffer);
  assert.ok(buffer.length > 0);
});

test("PNL Calculator - mergePlacementTrackerIntoSummary populates Buy Qty (Round Shares) and Buy Price (ACTUAL $)", async () => {
  const initialSummary = [
    {
      ticker: "ZEU",
      company: "ZEUS RESOURCES",
      buyQty: 0,
      sellQty: 3333333,
      buyPrice: 0,
      sellPrice: 24000.00,
      totalBuyValue: 0,
      totalSellValue: 24000.00,
      pnlCalculated: 24000.00,
      isMatched: false,
      isOption: true,
      openQty: -3333333,
      tradeCount: 1,
    },
  ];

  const placementMap = new Map();
  placementMap.set("ZEU", {
    ticker: "ZEU",
    totalShares: 3333333,
    totalActualDollar: 20000.00,
    clientAllocations: [
      { clientName: "Ikigai Consortium Pty Ltd", advisor: "VTC", askingBid: 9000, allocationDollar: 7200, roundShares: 1200000, actualDollar: 7200 },
      { clientName: "Zidiplus Pty Ltd", advisor: "VTC", askingBid: 5000, allocationDollar: 4000, roundShares: 666667, actualDollar: 4000 },
      { clientName: "Mr Akshit Verma", advisor: "VTC", askingBid: 4000, allocationDollar: 3200, roundShares: 533333, actualDollar: 3200 },
      { clientName: "PSG Capital", advisor: "VTC", askingBid: 7000, allocationDollar: 5600, roundShares: 933333, actualDollar: 5600 },
    ],
  });

  placementMap.set("UNKNOWN_TICKER", {
    ticker: "UNKNOWN_TICKER",
    totalShares: 100000,
    totalActualDollar: 5000,
    clientAllocations: [],
  });

  // Naming the account holder merges ONLY that holder's allocation row.
  const merged = mergePlacementTrackerIntoSummary(
    initialSummary,
    placementMap,
    "Ikigai Consortium Pty Ltd"
  );
  const zeu = merged.summary.find((s) => s.ticker === "ZEU");
  const unknown = merged.summary.find((s) => s.ticker === "UNKNOWN_TICKER");

  assert.ok(zeu);
  assert.equal(unknown, undefined); // Should NOT add tickers not in the current table!
  assert.equal(merged.summary.length, 1);
  assert.equal(zeu.buyQty, 1200000); // Ikigai's Round Shares only — not all 4 clients
  assert.equal(zeu.buyPrice, 7200.00); // Ikigai's ACTUAL $ only
  assert.equal(zeu.sellPrice, 24000.00);
  assert.equal(zeu.pnlCalculated, 16800.00); // 24000 - 7200
  assert.equal(zeu.isEnriched, true);
  assert.equal(zeu.clientAllocations?.length, 1);
  assert.equal(merged.ambiguousTickers.length, 0);
  assert.equal(merged.totalPnl, 16800.00);
});

test("PNL Calculator - a multi-client placement sheet is NOT summed into one client's row", async () => {
  // Regression: with four participants and no way to tell which one the trades
  // belong to, the merge used to sum every allocation — inflating Buy Qty 4x.
  const initialSummary = [
    {
      ticker: "ABE",
      company: "AUSBONDEXCHANGE",
      buyQty: 0,
      sellQty: 166667,
      buyPrice: 0,
      sellPrice: 5390.01,
      totalBuyValue: 0,
      totalSellValue: 5390.01,
      pnlCalculated: 5390.01,
      isMatched: false,
      isOption: true,
      openQty: -166667,
      tradeCount: 1,
    },
  ];

  const placementMap = new Map();
  placementMap.set("ABE", {
    ticker: "ABE",
    totalShares: 666668,
    totalActualDollar: 20000.04,
    clientAllocations: [
      { clientName: "Zidiplus Pty Ltd", advisor: "VTC", askingBid: 5000, allocationDollar: 5000, roundShares: 166667, actualDollar: 5000.01 },
      { clientName: "Ikigai Consortium Pty Ltd", advisor: "VTC", askingBid: 5000, allocationDollar: 5000, roundShares: 166667, actualDollar: 5000.01 },
      { clientName: "Mr Akshit Verma", advisor: "VTC", askingBid: 5000, allocationDollar: 5000, roundShares: 166667, actualDollar: 5000.01 },
      { clientName: "PSG Capital", advisor: "VTC", askingBid: 5000, allocationDollar: 5000, roundShares: 166667, actualDollar: 5000.01 },
    ],
  });

  // No hint at all: leave the row alone and report it rather than guess.
  const blind = mergePlacementTrackerIntoSummary(initialSummary, placementMap);
  const blindAbe = blind.summary.find((s) => s.ticker === "ABE");
  assert.ok(blindAbe);
  assert.equal(blindAbe.buyQty, 0, "must not fill Buy Qty when the holder is unknown");
  assert.equal(blindAbe.buyPrice, 0);
  assert.equal(blind.mergedCount, 0);
  assert.deepEqual(blind.ambiguousTickers, ["ABE"]);

  // With the holder identified, exactly that row's values land in the table.
  const named = mergePlacementTrackerIntoSummary(
    initialSummary,
    placementMap,
    "Zidiplus Pty Ltd"
  );
  const namedAbe = named.summary.find((s) => s.ticker === "ABE");
  assert.ok(namedAbe);
  assert.equal(namedAbe.buyQty, 166667); // NOT 666668
  assert.equal(namedAbe.buyPrice, 5000.01); // NOT 20000.04
  assert.equal(namedAbe.isMatched, true); // 166667 bought === 166667 sold
  assert.equal(namedAbe.openQty, 0);
  assert.equal(named.mergedCount, 1);
  assert.equal(named.ambiguousTickers.length, 0);
});

test("PNL Calculator - trade-file name identifies the account holder", async () => {
  const initialSummary = [
    {
      ticker: "ABE",
      company: "AUSBONDEXCHANGE",
      buyQty: 0,
      sellQty: 166667,
      buyPrice: 0,
      sellPrice: 5390.01,
      totalBuyValue: 0,
      totalSellValue: 5390.01,
      pnlCalculated: 5390.01,
      isMatched: false,
      isOption: true,
      openQty: -166667,
      tradeCount: 1,
    },
  ];

  const placementMap = new Map();
  placementMap.set("ABE", {
    ticker: "ABE",
    totalShares: 333334,
    totalActualDollar: 10000.02,
    clientAllocations: [
      { clientName: "Zidiplus Pty Ltd", advisor: "VTC", askingBid: 5000, allocationDollar: 5000, roundShares: 166667, actualDollar: 5000.01 },
      { clientName: "PSG Capital", advisor: "VTC", askingBid: 5000, allocationDollar: 5000, roundShares: 166667, actualDollar: 5000.01 },
    ],
  });

  // Hints arrive as the list of loaded trade-file stems.
  const merged = mergePlacementTrackerIntoSummary(initialSummary, placementMap, [
    "Zidiplus Pty Ltd trade ledger",
  ]);
  const abe = merged.summary.find((s) => s.ticker === "ABE");

  assert.ok(abe);
  assert.equal(abe.buyQty, 166667);
  assert.equal(abe.buyPrice, 5000.01);
  assert.equal(merged.ambiguousTickers.length, 0);
});

test("PNL Calculator - a single-allocation ticker merges without a hint", async () => {
  // One participant means there is no ambiguity about whose allocation it is.
  const initialSummary = [
    {
      ticker: "LDX",
      company: "LUMOS DIAGNOSTICS",
      buyQty: 0,
      sellQty: 1000,
      buyPrice: 0,
      sellPrice: 500,
      totalBuyValue: 0,
      totalSellValue: 500,
      pnlCalculated: 500,
      isMatched: false,
      isOption: true,
      openQty: -1000,
      tradeCount: 1,
    },
  ];

  const placementMap = new Map();
  placementMap.set("LDX", {
    ticker: "LDX",
    totalShares: 1000,
    totalActualDollar: 300,
    clientAllocations: [
      { clientName: "Zidiplus Pty Ltd", advisor: "VTC", askingBid: 300, allocationDollar: 300, roundShares: 1000, actualDollar: 300 },
    ],
  });

  const merged = mergePlacementTrackerIntoSummary(initialSummary, placementMap);
  const ldx = merged.summary.find((s) => s.ticker === "LDX");

  assert.ok(ldx);
  assert.equal(ldx.buyQty, 1000);
  assert.equal(ldx.buyPrice, 300);
  assert.equal(merged.mergedCount, 1);
  assert.equal(merged.ambiguousTickers.length, 0);
});

test("PNL Calculator - a share placement fills the equity row, never the option row", async () => {
  const initialSummary = [
    {
      ticker: "GED",
      parentTicker: "GED",
      instrument: "EQUITY" as const,
      company: "GOLDEN DEEPS",
      buyQty: 0,
      sellQty: 10000,
      buyPrice: 0,
      sellPrice: 1500,
      totalBuyValue: 0,
      totalSellValue: 1500,
      pnlCalculated: 1500,
      isMatched: false,
      isOption: false,
      hasOptionCode: false,
      openQty: -10000,
      tradeCount: 1,
    },
    {
      ticker: "GEDO",
      parentTicker: "GED",
      instrument: "OPTION" as const,
      company: "GOLDEN DEEPS OPTION",
      buyQty: 0,
      sellQty: 5000,
      buyPrice: 0,
      sellPrice: 50,
      totalBuyValue: 0,
      totalSellValue: 50,
      pnlCalculated: 50,
      isMatched: false,
      isOption: true,
      hasOptionCode: true,
      openQty: -5000,
      tradeCount: 1,
    },
  ];

  const placementMap = new Map();
  placementMap.set("GED", {
    ticker: "GED",
    totalShares: 10000,
    totalActualDollar: 1000,
    clientAllocations: [
      { clientName: "Zidiplus Pty Ltd", advisor: "VTC", askingBid: 1000, allocationDollar: 1000, roundShares: 10000, actualDollar: 1000 },
    ],
  });

  const merged = mergePlacementTrackerIntoSummary(initialSummary, placementMap);

  const ged = merged.summary.find((s) => s.ticker === "GED");
  const gedo = merged.summary.find((s) => s.ticker === "GEDO");
  assert.ok(ged);
  assert.ok(gedo);
  assert.equal(ged.buyQty, 10000);
  assert.equal(ged.buyPrice, 1000);
  assert.equal(ged.isEnriched, true);
  // The option row is untouched: placement shares are not the option's cost base.
  assert.equal(gedo.buyQty, 0);
  assert.equal(gedo.buyPrice, 0);
  assert.equal(gedo.isEnriched, undefined);
  assert.equal(merged.mergedCount, 1);
});

test("PNL Calculator - DB market value never prices an option row off the underlying", async () => {
  const summary = [
    {
      ticker: "GED",
      parentTicker: "GED",
      instrument: "EQUITY" as const,
      company: "GOLDEN DEEPS",
      buyQty: 10000,
      sellQty: 0,
      buyPrice: 1000,
      sellPrice: 0,
      totalBuyValue: 1000,
      totalSellValue: 0,
      pnlCalculated: -1000,
      isMatched: false,
      isOption: false,
      hasOptionCode: false,
      openQty: 10000,
      tradeCount: 1,
    },
    {
      ticker: "GEDO",
      parentTicker: "GED",
      instrument: "OPTION" as const,
      company: "GOLDEN DEEPS OPTION",
      buyQty: 5000,
      sellQty: 0,
      buyPrice: 100,
      sellPrice: 0,
      totalBuyValue: 100,
      totalSellValue: 0,
      pnlCalculated: -100,
      isMatched: false,
      isOption: true,
      hasOptionCode: true,
      openQty: 5000,
      tradeCount: 1,
    },
  ];

  // Only the ordinary is held in the DB.
  const equityOnly = mergeDbHoldingsIntoSummary(summary, [
    { ticker: "GED", parentTicker: "GED", qty: 10000, marketValue: 1500 },
  ]);
  assert.equal(equityOnly.summary.find((s) => s.ticker === "GED")?.sellPrice, 1500);
  assert.equal(equityOnly.summary.find((s) => s.ticker === "GEDO")?.sellPrice, 0);
  assert.equal(equityOnly.mergedCount, 1);

  // With an option holding present, each row takes its own valuation.
  const both = mergeDbHoldingsIntoSummary(summary, [
    { ticker: "GED", parentTicker: "GED", qty: 10000, marketValue: 1500 },
    { ticker: "GEDO", parentTicker: "GED", qty: 5000, marketValue: 75 },
  ]);
  assert.equal(both.summary.find((s) => s.ticker === "GED")?.sellPrice, 1500);
  assert.equal(both.summary.find((s) => s.ticker === "GEDO")?.sellPrice, 75);
  assert.equal(both.mergedCount, 2);
});

/** A part-sold parcel: 121,213 bought, 50,000 sold, 71,213 still held. */
const partialExitRow = () => [
  {
    ticker: "GRV",
    parentTicker: "GRV",
    instrument: "EQUITY" as const,
    company: "GREENVALE ENERGY LTD",
    buyQty: 121213,
    sellQty: 50000,
    buyPrice: 4000.03,
    sellPrice: 1650.0,
    totalBuyValue: 4000.03,
    totalSellValue: 1650.0,
    pnlCalculated: -2350.03,
    isMatched: false,
    isOption: false,
    hasOptionCode: false,
    openQty: 71213,
    tradeCount: 2,
  },
];

test("PNL Calculator - partial exit ADDS the still-held parcel on top of the realised sale", async () => {
  const merged = mergeDbHoldingsIntoSummary(partialExitRow(), [
    { ticker: "GRV", parentTicker: "GRV", qty: 71213, marketValue: 2350.02 },
  ]);

  const grv = merged.summary.find((s) => s.ticker === "GRV");
  assert.ok(grv);
  // Added, not replaced: 50,000 realised + 71,213 still held.
  assert.equal(grv.sellQty, 121213);
  // Value sums add too: $1,650.00 proceeds + $2,350.02 market value.
  assert.equal(grv.sellPrice, 4000.02);
  assert.equal(grv.totalSellValue, 4000.02);
  assert.equal(grv.pnlCalculated, -0.01);
  assert.equal(grv.openQty, 0);
  assert.equal(grv.isMatched, true);
  assert.equal(grv.isPartialExit, true);
  assert.equal(grv.comment, "Partial Exit");
  assert.equal(merged.partialExitCount, 1);
  assert.equal(merged.mergedCount, 1);
});

test("PNL Calculator - partial exit keeps a DB/file discrepancy visible instead of balancing the row", async () => {
  // DB holds only 60,000 of the 71,213 units the file says are still open.
  const merged = mergeDbHoldingsIntoSummary(partialExitRow(), [
    { ticker: "GRV", parentTicker: "GRV", qty: 60000, marketValue: 1980.0 },
  ]);

  const grv = merged.summary.find((s) => s.ticker === "GRV");
  assert.ok(grv);
  // The held qty is taken verbatim — never back-solved from buyQty - sellQty.
  assert.equal(grv.sellQty, 110000);
  assert.equal(grv.openQty, 11213);
  assert.equal(grv.isMatched, false);
  assert.equal(grv.comment, "Partial Exit");
});

test("PNL Calculator - fully open rows still FILL rather than add, and matched rows are untouched", async () => {
  const rows = [
    // Fully open: nothing sold, so the blank sell side is filled.
    {
      ticker: "ABC",
      parentTicker: "ABC",
      instrument: "EQUITY" as const,
      company: "ABC CORP",
      buyQty: 1000,
      sellQty: 0,
      buyPrice: 500,
      sellPrice: 0,
      totalBuyValue: 500,
      totalSellValue: 0,
      pnlCalculated: -500,
      isMatched: false,
      isOption: false,
      hasOptionCode: false,
      openQty: 1000,
      tradeCount: 1,
    },
    // Fully closed: buy === sell, so the DB must not touch it.
    {
      ticker: "XYZ",
      parentTicker: "XYZ",
      instrument: "EQUITY" as const,
      company: "XYZ LTD",
      buyQty: 400,
      sellQty: 400,
      buyPrice: 300,
      sellPrice: 350,
      totalBuyValue: 300,
      totalSellValue: 350,
      pnlCalculated: 50,
      isMatched: true,
      isOption: false,
      hasOptionCode: false,
      openQty: 0,
      tradeCount: 2,
    },
  ];

  const merged = mergeDbHoldingsIntoSummary(rows, [
    { ticker: "ABC", parentTicker: "ABC", qty: 1000, marketValue: 700 },
    { ticker: "XYZ", parentTicker: "XYZ", qty: 999, marketValue: 9999 },
  ]);

  const abc = merged.summary.find((s) => s.ticker === "ABC");
  assert.equal(abc?.sellQty, 1000); // filled, not 0 + 1000 counted twice
  assert.equal(abc?.sellPrice, 700);
  assert.equal(abc?.isPartialExit, undefined);
  // Nothing was sold, so the row is flagged and noted as an open position.
  assert.equal(abc?.isDbOpenValued, true);
  assert.equal(abc?.comment, "Open");

  const xyz = merged.summary.find((s) => s.ticker === "XYZ");
  assert.equal(xyz?.sellQty, 400); // untouched
  assert.equal(xyz?.sellPrice, 350);
  assert.equal(xyz?.comment, undefined); // never touched, so never annotated
  assert.equal(xyz?.isDbOpenValued, undefined);

  assert.equal(merged.partialExitCount, 0);
  assert.equal(merged.mergedCount, 1);
});

test("PNL Calculator - a DB holding the trade file never mentioned gets its own row", async () => {
  // Real shape: the ordinary was traded, the free option GEDO never was (avg_cost 0,
  // so no contract note exists), and before this it was silently dropped entirely.
  const summary = [
    {
      ticker: "GED",
      parentTicker: "GED",
      instrument: "EQUITY" as const,
      company: "GOLDEN DEEPS",
      buyQty: 100000,
      sellQty: 0,
      buyPrice: 4300,
      sellPrice: 0,
      totalBuyValue: 4300,
      totalSellValue: 0,
      pnlCalculated: -4300,
      isMatched: false,
      isOption: false,
      hasOptionCode: false,
      openQty: 100000,
      tradeCount: 1,
    },
  ];

  const merged = mergeDbHoldingsIntoSummary(summary, [
    { ticker: "GED", parentTicker: "GED", companyName: "GOLDEN DEEPS", qty: 100000, marketValue: 4300, costBase: 4300 },
    { ticker: "GEDO", parentTicker: "GED", companyName: "GOLDEN DEEPS OPT", qty: 62500, marketValue: 562.5, costBase: 0 },
    { ticker: "LITOC", parentTicker: "LIT", companyName: "LITHIUM OPT", qty: 200000, marketValue: 200, costBase: 0 },
  ]);

  assert.equal(merged.createdCount, 2, "GEDO and LITOC each need a row of their own");

  const gedo = merged.summary.find((s) => s.ticker === "GEDO");
  assert.ok(gedo, "the free option must no longer be dropped");
  assert.equal(gedo.instrument, "OPTION");
  assert.equal(gedo.parentTicker, "GED");
  assert.equal(gedo.buyQty, 62500);
  assert.equal(gedo.sellQty, 62500);
  // Free: cost really is zero, so the whole market value is gain.
  assert.equal(gedo.buyPrice, 0);
  assert.equal(gedo.sellPrice, 562.5);
  assert.equal(gedo.pnlCalculated, 562.5);
  assert.equal(gedo.isDbOnly, true);
  assert.equal(gedo.comment, "DB Holding");
  assert.equal(gedo.tradeCount, 0);
  assert.equal(exportStatus(gedo), "DB Holding");

  // LITOC's parent is LIT, which is absent from the file entirely — still fine.
  const litoc = merged.summary.find((s) => s.ticker === "LITOC");
  assert.equal(litoc?.parentTicker, "LIT");
  assert.equal(litoc?.pnlCalculated, 200);

  // GED was already in the file, so it is FILLED, not duplicated.
  assert.equal(merged.summary.filter((s) => s.ticker === "GED").length, 1);
  assert.equal(merged.summary.find((s) => s.ticker === "GED")?.comment, "Open");

  // The dropped value now reaches the total: -4300 + 4300 (GED) + 562.50 + 200.
  assert.equal(merged.totalPnl, 762.5);
});

test("PNL Calculator - a created row keeps a real cost base rather than showing free profit", async () => {
  // 2 of 108 option positions in the DB DO have a cost. Zeroing them would report a
  // gain that never happened.
  const merged = mergeDbHoldingsIntoSummary([], [
    { ticker: "HLXO", parentTicker: "HLX", companyName: "HELIX OPT", qty: 71429, marketValue: 142.86, costBase: 2028.6 },
  ]);

  const row = merged.summary.find((s) => s.ticker === "HLXO");
  assert.equal(row?.buyPrice, 2028.6);
  assert.equal(row?.sellPrice, 142.86);
  assert.equal(row?.pnlCalculated, -1885.74, "a paid-for option that fell must show the loss");
  assert.equal(merged.createdCount, 1);
});

test("PNL Calculator - the create pass never duplicates a holding it already filled", async () => {
  const summary = [
    {
      ticker: "GEDO",
      parentTicker: "GED",
      instrument: "OPTION" as const,
      company: "GOLDEN DEEPS OPT",
      buyQty: 62500,
      sellQty: 0,
      buyPrice: 0,
      sellPrice: 0,
      totalBuyValue: 0,
      totalSellValue: 0,
      pnlCalculated: 0,
      isMatched: false,
      isOption: true,
      hasOptionCode: true,
      openQty: 62500,
      tradeCount: 1,
    },
  ];

  const merged = mergeDbHoldingsIntoSummary(summary, [
    { ticker: "GEDO", parentTicker: "GED", qty: 62500, marketValue: 562.5, costBase: 0 },
  ]);

  assert.equal(merged.summary.filter((s) => s.ticker === "GEDO").length, 1, "filled, not duplicated");
  assert.equal(merged.createdCount, 0);
  assert.equal(merged.mergedCount, 1);
  assert.equal(merged.summary[0].sellPrice, 562.5);
  assert.equal(merged.summary[0].isDbOnly, undefined);
});

test("PNL Calculator - an equity holding does not create a row off an option code", async () => {
  // The GED equity row must not be satisfied by the GEDO option holding, and GEDO
  // must still get its own row rather than being swallowed.
  const merged = mergeDbHoldingsIntoSummary(
    [
      {
        ticker: "GED",
        parentTicker: "GED",
        instrument: "EQUITY" as const,
        company: "GOLDEN DEEPS",
        buyQty: 1000,
        sellQty: 0,
        buyPrice: 43,
        sellPrice: 0,
        totalBuyValue: 43,
        totalSellValue: 0,
        pnlCalculated: -43,
        isMatched: false,
        isOption: false,
        hasOptionCode: false,
        openQty: 1000,
        tradeCount: 1,
      },
    ],
    [{ ticker: "GEDO", parentTicker: "GED", qty: 62500, marketValue: 562.5, costBase: 0 }]
  );

  // GED untouched — an option holding cannot price the ordinary.
  const ged = merged.summary.find((s) => s.ticker === "GED");
  assert.equal(ged?.sellPrice, 0);
  assert.equal(ged?.isDbMarketValued, undefined);
  // GEDO created on its own line.
  assert.equal(merged.createdCount, 1);
  assert.equal(merged.summary.find((s) => s.ticker === "GEDO")?.sellPrice, 562.5);
});

test("PNL Calculator - empty holdings create nothing", async () => {
  const merged = mergeDbHoldingsIntoSummary([], [
    { ticker: "ZERO", parentTicker: "ZER", qty: 0, marketValue: 0, costBase: 0 },
    { ticker: "", parentTicker: "", qty: 100, marketValue: 5, costBase: 0 },
  ]);
  assert.equal(merged.createdCount, 0);
  assert.equal(merged.summary.length, 0);
});

test("PNL Calculator - a sell-only row is never treated as a partial exit", async () => {
  const merged = mergeDbHoldingsIntoSummary(
    [
      {
        ticker: "OPT",
        parentTicker: "OPT",
        instrument: "EQUITY" as const,
        company: "SOLD WITHOUT A BUY",
        buyQty: 0,
        sellQty: 5000,
        buyPrice: 0,
        sellPrice: 900,
        totalBuyValue: 0,
        totalSellValue: 900,
        pnlCalculated: 900,
        isMatched: false,
        isOption: false,
        hasOptionCode: false,
        openQty: -5000,
        tradeCount: 1,
      },
    ],
    [{ ticker: "OPT", parentTicker: "OPT", qty: 1000, marketValue: 200 }]
  );

  const row = merged.summary.find((s) => s.ticker === "OPT");
  // buyQty 0 means there is no parcel to be partially out of — leave it alone.
  assert.equal(row?.sellQty, 5000);
  assert.equal(row?.sellPrice, 900);
  assert.equal(row?.comment, undefined);
  assert.equal(merged.partialExitCount, 0);
});

test("PNL Calculator - Comments column reaches both exports", async () => {
  const merged = mergeDbHoldingsIntoSummary(partialExitRow(), [
    { ticker: "GRV", parentTicker: "GRV", qty: 71213, marketValue: 2350.02 },
  ]);

  const csv = buildPnlExportCsvString(merged.summary);
  const [header, firstRow] = csv.split("\r\n");
  assert.ok(header.endsWith("Comments"), `header should end with Comments: ${header}`);
  assert.ok(firstRow.endsWith("Partial Exit"), `row should carry the note: ${firstRow}`);

  // Grand Total keeps the column count aligned with the header.
  const lines = csv.split("\r\n");
  const cols = (s: string) => s.split(",").length;
  assert.equal(cols(lines[lines.length - 1]), cols(header));

  const xlsx = await buildPnlExportXlsxBuffer(merged.summary);
  assert.ok(xlsx.length > 0);
});

test("resolvePlacementClientHints - the Account column beats the file name", async () => {
  const stem = (n: string) => n.replace(/\.[^.]+$/, "");
  const base = { override: "__auto__", autoSentinel: "__auto__", filenameStem: stem };

  // The real failing case: the file is named after nobody in the placement sheets,
  // but its Account column resolves to the actual holder.
  const resolved = resolvePlacementClientHints({
    ...base,
    files: [{ name: "PKevadiya-516908e3.csv", accounts: ["114716"] }],
    accountHolders: { "114716": "Sri Guru Nanak PTY LTD" },
  });
  assert.deepEqual(resolved.hints, ["Sri Guru Nanak PTY LTD"]);
  assert.equal(resolved.source, "account");
  // And that name does match a placement sheet, which the file name never would.
  assert.equal(isClientMatch("Sri Guru Nanak Pty Ltd", "Sri Guru Nanak PTY LTD"), true);
  assert.equal(isClientMatch("Sri Guru Nanak Pty Ltd", "PKevadiya-516908e3"), false);

  // An account the database does not know falls back to the file name.
  const fallback = resolvePlacementClientHints({
    ...base,
    files: [{ name: "Zidiplus.csv", accounts: ["9999999"] }],
    accountHolders: {},
  });
  assert.deepEqual(fallback.hints, ["Zidiplus"]);
  assert.equal(fallback.source, "filename");

  // A file with no Account column at all also falls back.
  const noAccounts = resolvePlacementClientHints({
    ...base,
    files: [{ name: "Vijan.xlsx" }],
    accountHolders: { "114794": "Rg Vijan PTY LTD" },
  });
  assert.deepEqual(noAccounts.hints, ["Vijan"]);
  assert.equal(noAccounts.source, "filename");
});

test("resolvePlacementClientHints - an explicit choice always wins, and multi-account files dedupe", async () => {
  const stem = (n: string) => n.replace(/\.[^.]+$/, "");
  const base = { autoSentinel: "__auto__", filenameStem: stem };

  // Staff picked someone: neither the account nor the file name may override it.
  const picked = resolvePlacementClientHints({
    ...base,
    override: "Mr Akshit Verma",
    files: [{ name: "Zidiplus.csv", accounts: ["1103199"] }],
    accountHolders: { "1103199": "Zidiplus PTY LTD" },
  });
  assert.deepEqual(picked.hints, ["Mr Akshit Verma"]);
  assert.equal(picked.source, "override");

  // Several files, several accounts, one repeated holder -> deduped.
  const many = resolvePlacementClientHints({
    ...base,
    override: "__auto__",
    files: [
      { name: "a.csv", accounts: ["114716", "1103199"] },
      { name: "b.csv", accounts: ["1103199"] },
    ],
    accountHolders: { "114716": "Sri Guru Nanak PTY LTD", "1103199": "Zidiplus PTY LTD" },
  });
  assert.deepEqual(many.hints, ["Sri Guru Nanak PTY LTD", "Zidiplus PTY LTD"]);

  // Partially resolved: known accounts win outright rather than being mixed with a
  // file name, which would risk pulling in a second client's allocation.
  const partial = resolvePlacementClientHints({
    ...base,
    override: "__auto__",
    files: [{ name: "SomeoneElse.csv", accounts: ["114716", "9999999"] }],
    accountHolders: { "114716": "Sri Guru Nanak PTY LTD" },
  });
  assert.deepEqual(partial.hints, ["Sri Guru Nanak PTY LTD"]);
  assert.equal(partial.source, "account");

  // Nothing to go on at all.
  assert.deepEqual(
    resolvePlacementClientHints({ ...base, override: "__auto__", files: [], accountHolders: {} }),
    { hints: [], source: "none" }
  );
});

test("buildPnlExportFilename - carries the account number and the holder's name", async () => {
  const holders = {
    "114716": "Sri Guru Nanak PTY LTD",
    "1103199": "Zidiplus PTY LTD",
    "114660": "Mr Shaishav Kumar Patel + Mrs Vidushi Patel",
  };
  const base = { accountHolders: holders, isoDate: "2026-08-05" };

  assert.equal(
    buildPnlExportFilename({ ...base, accounts: ["114716"], extension: "xlsx" }),
    "pnl-114716-Sri-Guru-Nanak-PTY-LTD-2026-08-05.xlsx"
  );
  assert.equal(
    buildPnlExportFilename({ ...base, accounts: ["1103199"], extension: "csv" }),
    "pnl-1103199-Zidiplus-PTY-LTD-2026-08-05.csv"
  );

  // A name with characters Windows rejects still yields a usable filename.
  const messy = buildPnlExportFilename({ ...base, accounts: ["114660"], extension: "xlsx" });
  assert.match(messy, /^pnl-114660-Mr-Shaishav-Kumar-Patel-Mrs-Vidushi-Patel-2026-08-05\.xlsx$/);
  assert.equal(/[\\/:*?"<>|]/.test(messy), false, "must contain no reserved characters");

  // An account the database could not name still gets its number.
  assert.equal(
    buildPnlExportFilename({ ...base, accounts: ["9999999"], extension: "csv" }),
    "pnl-9999999-2026-08-05.csv"
  );
});

test("buildPnlExportFilename - multi-account and empty scopes stay sane", async () => {
  const holders = { a: "Alpha Pty Ltd", b: "Beta Pty Ltd", c: "Gamma", d: "Delta" };
  const base = { accountHolders: holders, isoDate: "2026-08-05", extension: "csv" as const };

  // Two or three accounts: numbers only — concatenating names would blow past path limits.
  assert.equal(buildPnlExportFilename({ ...base, accounts: ["a", "b"] }), "pnl-a-b-2026-08-05.csv");
  assert.equal(buildPnlExportFilename({ ...base, accounts: ["a", "b", "c"] }), "pnl-a-b-c-2026-08-05.csv");
  // Beyond three, even the numbers are summarised.
  assert.equal(
    buildPnlExportFilename({ ...base, accounts: ["a", "b", "c", "d"] }),
    "pnl-4-accounts-2026-08-05.csv"
  );

  // Duplicates and blanks do not inflate the count.
  assert.equal(
    buildPnlExportFilename({ ...base, accounts: ["a", "a", "", "  "] }),
    "pnl-a-Alpha-Pty-Ltd-2026-08-05.csv"
  );

  // No account information at all — keep the old shape rather than invent one.
  assert.equal(
    buildPnlExportFilename({ accounts: [], accountHolders: {}, isoDate: "2026-08-05", extension: "xlsx" }),
    "pnl-summary-calculated-2026-08-05.xlsx"
  );
});

test("buildPnlExportFilename - a very long holder name is capped, extension intact", async () => {
  const long = "A".repeat(200) + " Investments And Holdings Proprietary Limited";
  const name = buildPnlExportFilename({
    accounts: ["114716"],
    accountHolders: { "114716": long },
    isoDate: "2026-08-05",
    extension: "xlsx",
  });
  assert.ok(name.endsWith(".xlsx"), name);
  assert.ok(name.startsWith("pnl-114716-"), name);
  // Comfortably inside any filesystem's per-component limit (255 bytes).
  assert.ok(name.length < 120, `too long: ${name.length}`);
});

/** One workbook holding a single ticker with one client's allocation. */
const placementFile = (
  ticker: string,
  clientName: string,
  roundShares: number,
  actualDollar: number
): { map: Map<string, PlacementTickerInfo> } => ({
  map: new Map<string, PlacementTickerInfo>([
    [
      ticker,
      {
        ticker,
        totalShares: roundShares,
        totalActualDollar: actualDollar,
        clientAllocations: [
          { clientName, advisor: "VTC", askingBid: 0, allocationDollar: actualDollar, roundShares, actualDollar },
        ],
      },
    ],
  ]),
});

test("parsePlacementTrackerBuffer - reads a real workbook via SheetJS", async () => {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();

  // A sheet that must be ignored, to prove the skip list still applies.
  wb.addWorksheet("Template").addRow(["CLIENT NAME", "ADVISOR/BROKER"]);

  // The Overview carries the Add-Ons column; header is NOT row 1, as in the real file.
  const ov = wb.addWorksheet("2026 Overview");
  ov.addRow([]);
  ov.addRow([]);
  ov.addRow(["Counter", "Date Issued", "Add-Ons"]);
  ov.addRow(["GRV", "1 Jan 2026", "1:3 @$0.14 Unlisted Expiry 31/12/27"]);
  ov.addRow(["ABE", "2 Jan 2026", "IPO"]);

  // A ticker sheet: preamble rows, then the allocation table, then a Total row.
  const ws = wb.addWorksheet("GRV (b)");
  ws.addRow(["ONLY EDIT FIELDS HIGHLIGHTED"]);
  ws.addRow(["Add-Ons", "1:3 @$0.14 Unlisted Expiry 31/12/27", "ASX CODE", "GRV"]);
  ws.addRow(["Date", "", "Issue price ($)", 0.033]);
  ws.addRow([]);
  ws.addRow(["CLIENT NAME", "ADVISOR/BROKER", "Asking Bid ($)", "Allocation ($)", "# of shares", "Round Shares", "ACTUAL $", "Seller Fee ($)"]);
  ws.addRow(["Total", "", 9000, 9000.03, 272728, 272728, 9000.03, 270]);
  ws.addRow(["Zidiplus Pty Ltd", "VTC", 4000, 4000.0053, 121212.28, 121213, 4000.029, 120.0009]);
  ws.addRow(["Mr Akshit Verma", "VTC", 5000, 5000.0067, 151515.35, 151515, 4999.995, 149.9998]);
  // A row with no client name must be skipped, not counted.
  ws.addRow([null, "VTC", 0, 0, 0, 0, 0, 0]);

  const buffer = Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  const map = await parsePlacementTrackerBuffer(buffer);

  assert.equal(map.size, 1, "only the ticker sheet becomes an entry");
  const grv = map.get("GRV");
  assert.ok(grv, "sheet name 'GRV (b)' must resolve to ticker GRV");

  // "Total" and the nameless row are excluded; the two real clients are kept.
  assert.equal(grv.clientAllocations.length, 2);
  assert.deepEqual(
    grv.clientAllocations.map((a) => a.clientName).sort(),
    ["Mr Akshit Verma", "Zidiplus Pty Ltd"]
  );

  // Numbers keep full precision — raw cell values, not formatted text.
  const zidi = grv.clientAllocations.find((a) => a.clientName === "Zidiplus Pty Ltd")!;
  assert.equal(zidi.advisor, "VTC");
  assert.equal(zidi.roundShares, 121213);
  assert.equal(zidi.actualDollar, 4000.03);
  assert.equal(zidi.askingBid, 4000);

  assert.equal(grv.totalShares, 121213 + 151515);
  // Each allocation is rounded to cents before summing: 4000.029 -> 4000.03 and
  // 4999.995 -> 5000.00 (half-up), so the total is 9000.03, not 9000.02.
  assert.equal(grv.totalActualDollar, 9000.03);

  // The Add-Ons cell from the Overview is attached to the ticker.
  assert.equal(grv.addOns?.length, 1);
  assert.equal(grv.addOns?.[0].strike, 0.14);
  assert.equal(grv.addOns?.[0].listed, false);
});

test("parsePlacementTrackerBuffer - a non-xlsx buffer fails with an actionable message", async () => {
  await assert.rejects(
    () => parsePlacementTrackerBuffer(Buffer.from("not a spreadsheet at all")),
    (err: Error) => {
      assert.match(err.message, /not a valid \.xlsx Excel workbook|link requires login/i);
      return true;
    }
  );
});

test("combinePlacementMaps - repeated calls do not inflate the source workbooks", async () => {
  // The 2025 and 2026 trackers both list ABE for the same client.
  const a = placementFile("ABE", "Zidiplus Pty Ltd", 100000, 3000);
  const b = placementFile("ABE", "Zidiplus Pty Ltd", 66667, 2000);

  const first = combinePlacementMaps([a, b]);
  assert.equal(first.get("ABE")?.clientAllocations[0].roundShares, 166667);
  assert.equal(first.get("ABE")?.clientAllocations[0].actualDollar, 5000);

  // The inputs must be untouched. Copying only the ARRAY left the allocation OBJECTS
  // shared, so the `+=` above mutated the stored workbook — and this function runs on
  // every re-merge, so the numbers grew on every upload.
  assert.equal(a.map.get("ABE")?.clientAllocations[0].roundShares, 100000);
  assert.equal(a.map.get("ABE")?.clientAllocations[0].actualDollar, 3000);
  assert.equal(b.map.get("ABE")?.clientAllocations[0].roundShares, 66667);

  // Re-merging the same inputs must give the same answer, however many times it runs.
  for (let i = 0; i < 4; i++) {
    const again = combinePlacementMaps([a, b]);
    assert.equal(again.get("ABE")?.clientAllocations[0].roundShares, 166667, `run ${i + 2} drifted`);
    assert.equal(again.get("ABE")?.clientAllocations[0].actualDollar, 5000);
    assert.equal(again.get("ABE")?.totalShares, 166667);
  }
});

test("combinePlacementMaps - distinct clients and add-ons merge without doubling", async () => {
  const a = placementFile("ABE", "Zidiplus Pty Ltd", 100000, 3000);
  const b = placementFile("ABE", "Saturn Fund", 50000, 1500);
  // Only the second workbook carries the add-on spec.
  b.map.get("ABE")!.addOns = parseAddOnSpecs("1:2 @$0.10 Unlisted Exp 31/12/29");

  const combined = combinePlacementMaps([a, b]);
  const abe = combined.get("ABE")!;

  assert.equal(abe.clientAllocations.length, 2, "different clients stay separate rows");
  assert.deepEqual(
    abe.clientAllocations.map((x) => x.clientName).sort(),
    ["Saturn Fund", "Zidiplus Pty Ltd"]
  );
  assert.equal(abe.addOns?.length, 1);

  // Add-ons come from the first workbook that has them, never concatenated — two
  // workbooks listing the same placement would otherwise double every tranche.
  const bothHaveAddOns = combinePlacementMaps([
    { map: new Map([["ABE", { ...a.map.get("ABE")!, addOns: parseAddOnSpecs("1:2 @$0.10 Unlisted Exp 31/12/29") }]]) },
    b,
  ]);
  assert.equal(bothHaveAddOns.get("ABE")?.addOns?.length, 1);

  // And the add-on objects are copies, so a later mutation cannot reach the source.
  combined.get("ABE")!.addOns![0].strike = 999;
  assert.equal(b.map.get("ABE")!.addOns![0].strike, 0.1);
});

test("resolvePlacementClientHints - scoping two clients' files to one account", async () => {
  const stem = (n: string) => n.replace(/\.[^.]+$/, "");
  const holders = { "1103199": "Zidiplus PTY LTD", "114716": "Sri Guru Nanak PTY LTD" };
  const files = [
    { name: "Zidiplus.csv", accounts: ["1103199"] },
    { name: "Sri Guru Nanak.csv", accounts: ["114716"] },
  ];
  const base = { override: "__auto__", autoSentinel: "__auto__", filenameStem: stem };

  // Viewing everything: both holders are legitimate hints.
  assert.deepEqual(resolvePlacementClientHints({ ...base, files, accountHolders: holders }).hints, [
    "Zidiplus PTY LTD",
    "Sri Guru Nanak PTY LTD",
  ]);

  // This is what the component does when one account is selected. Keeping both names
  // would merge BOTH clients' allocations into that one account's row.
  const scopeTo = (account: string) =>
    files
      .map((f) => ({ ...f, accounts: f.accounts.filter((a) => a === account) }))
      .filter((f) => f.accounts.length > 0);

  assert.deepEqual(
    resolvePlacementClientHints({ ...base, files: scopeTo("1103199"), accountHolders: holders }).hints,
    ["Zidiplus PTY LTD"]
  );

  // And when the DB cannot name the selected account, the filename fallback must not
  // reach across to the other client's file — hence dropping files out of scope.
  const unnamed = resolvePlacementClientHints({
    ...base,
    files: scopeTo("114716"),
    accountHolders: {},
  });
  assert.deepEqual(unnamed.hints, ["Sri Guru Nanak"]);
  assert.equal(unnamed.source, "filename");
  assert.equal(unnamed.hints.includes("Zidiplus"), false);
});

test("PNL Calculator - collectPlacementClientNames dedupes across sheets", async () => {
  const placementMap = new Map();
  placementMap.set("ABE", {
    ticker: "ABE",
    totalShares: 0,
    totalActualDollar: 0,
    clientAllocations: [
      { clientName: "Zidiplus Pty Ltd", advisor: "VTC", askingBid: 0, allocationDollar: 0, roundShares: 1, actualDollar: 1 },
      { clientName: "PSG Capital", advisor: "VTC", askingBid: 0, allocationDollar: 0, roundShares: 1, actualDollar: 1 },
    ],
  });
  placementMap.set("ZEU", {
    ticker: "ZEU",
    totalShares: 0,
    totalActualDollar: 0,
    clientAllocations: [
      { clientName: "zidiplus pty ltd", advisor: "VTC", askingBid: 0, allocationDollar: 0, roundShares: 1, actualDollar: 1 },
      { clientName: "Mr Akshit Verma", advisor: "VTC", askingBid: 0, allocationDollar: 0, roundShares: 1, actualDollar: 1 },
    ],
  });

  assert.deepEqual(collectPlacementClientNames(placementMap), [
    "Mr Akshit Verma",
    "PSG Capital",
    "Zidiplus Pty Ltd",
  ]);
});

test("PNL Calculator - mergePlacementTrackerIntoSummary does NOT double buyQty/buyPrice if already present (non-zero)", async () => {
  const initialSummary = [
    {
      ticker: "ZEU",
      company: "ZEUS RESOURCES",
      buyQty: 3333333,
      sellQty: 3333333,
      buyPrice: 20000.00,
      sellPrice: 24000.00,
      totalBuyValue: 20000.00,
      totalSellValue: 24000.00,
      pnlCalculated: 4000.00,
      isMatched: true,
      isOption: false,
      openQty: 0,
      tradeCount: 2,
    },
  ];

  const placementMap = new Map();
  placementMap.set("ZEU", {
    ticker: "ZEU",
    totalShares: 3333333,
    totalActualDollar: 20000.00,
    clientAllocations: [
      { clientName: "Mr Akshit Verma", advisor: "VTC", askingBid: 4000, allocationDollar: 3200, roundShares: 3333333, actualDollar: 20000 },
    ],
  });

  const merged = mergePlacementTrackerIntoSummary(initialSummary, placementMap, "Mr Akshit Verma");
  const zeu = merged.summary.find((s) => s.ticker === "ZEU");

  assert.ok(zeu);
  assert.equal(zeu.buyQty, 3333333); // NOT doubled to 6666666!
  assert.equal(zeu.buyPrice, 20000.00); // NOT doubled to 40000!
  assert.equal(zeu.pnlCalculated, 4000.00);
  assert.equal(zeu.isPartialBuy, undefined); // matched row is not a short buy
  assert.equal(zeu.comment, undefined);
  assert.equal(merged.partialBuyCount, 0);
});

/** A placement sheet allocating 40,000 ABE shares for $8,000 to one client. */
const abePlacementMap = () => {
  const m = new Map();
  m.set("ABE", {
    ticker: "ABE",
    totalShares: 40000,
    totalActualDollar: 8000,
    clientAllocations: [
      {
        clientName: "Mr Akshit Verma",
        advisor: "VTC",
        askingBid: 8000,
        allocationDollar: 8000,
        roundShares: 40000,
        actualDollar: 8000,
      },
    ],
  });
  return m;
};

test("PNL Calculator - short buy side (0 < buyQty < sellQty) ADDS the placement allocation", async () => {
  // 10,000 units bought per the ledger but 50,000 sold — 40,000 were never
  // recorded as a buy, which is exactly the placement parcel.
  const merged = mergePlacementTrackerIntoSummary(
    [
      {
        ticker: "ABE",
        parentTicker: "ABE",
        instrument: "EQUITY" as const,
        company: "ABERDEEN",
        buyQty: 10000,
        sellQty: 50000,
        buyPrice: 2000,
        sellPrice: 12500,
        totalBuyValue: 2000,
        totalSellValue: 12500,
        pnlCalculated: 10500,
        isMatched: false,
        isOption: false,
        hasOptionCode: false,
        openQty: -40000,
        tradeCount: 3,
      },
    ],
    abePlacementMap(),
    "Mr Akshit Verma"
  );

  const abe = merged.summary.find((s) => s.ticker === "ABE");
  assert.ok(abe);
  assert.equal(abe.buyQty, 50000); // 10,000 recorded + 40,000 from the placement
  assert.equal(abe.buyPrice, 10000); // $2,000 recorded + $8,000 ACTUAL $
  assert.equal(abe.totalBuyValue, 10000);
  // P&L drops from an overstated 10,500 to the real 2,500 once the cost is known.
  assert.equal(abe.pnlCalculated, 2500);
  assert.equal(abe.openQty, 0);
  assert.equal(abe.isMatched, true);
  assert.equal(abe.isPartialBuy, true);
  assert.equal(abe.isEnriched, true);
  assert.equal(abe.comment, "Partial Buy");
  assert.equal(merged.partialBuyCount, 1);
});

test("PNL Calculator - a blank buy side still FILLS, and an over-bought row is left alone", async () => {
  const rows = [
    // buyQty 0 → fill (pre-existing behaviour).
    {
      ticker: "ABE",
      parentTicker: "ABE",
      instrument: "EQUITY" as const,
      company: "ABERDEEN",
      buyQty: 0,
      sellQty: 40000,
      buyPrice: 0,
      sellPrice: 9000,
      totalBuyValue: 0,
      totalSellValue: 9000,
      pnlCalculated: 9000,
      isMatched: false,
      isOption: false,
      hasOptionCode: false,
      openQty: -40000,
      tradeCount: 1,
    },
  ];

  const filled = mergePlacementTrackerIntoSummary(rows, abePlacementMap(), "Mr Akshit Verma");
  const abe = filled.summary.find((s) => s.ticker === "ABE");
  assert.equal(abe?.buyQty, 40000);
  assert.equal(abe?.buyPrice, 8000);
  assert.equal(abe?.isPartialBuy, undefined); // a fill is not a top-up
  assert.equal(abe?.comment, undefined);
  assert.equal(filled.partialBuyCount, 0);

  // buyQty > sellQty is an open position, not a short buy — adding cost would be wrong.
  const overBought = mergePlacementTrackerIntoSummary(
    [{ ...rows[0], buyQty: 60000, buyPrice: 12000, totalBuyValue: 12000, openQty: 20000 }],
    abePlacementMap(),
    "Mr Akshit Verma"
  );
  const held = overBought.summary.find((s) => s.ticker === "ABE");
  assert.equal(held?.buyQty, 60000);
  assert.equal(held?.buyPrice, 12000);
  assert.equal(overBought.partialBuyCount, 0);
});

test("PNL Calculator - a row short on both sides reads both notes, whichever merge runs last", async () => {
  const base = [
    {
      ticker: "ABE",
      parentTicker: "ABE",
      instrument: "EQUITY" as const,
      company: "ABERDEEN",
      buyQty: 10000,
      sellQty: 50000,
      buyPrice: 2000,
      sellPrice: 12500,
      totalBuyValue: 2000,
      totalSellValue: 12500,
      pnlCalculated: 10500,
      isMatched: false,
      isOption: false,
      hasOptionCode: false,
      openQty: -40000,
      tradeCount: 3,
    },
  ];

  // Placement first → buyQty becomes 50,000 (matched), so the DB merge finds
  // nothing partial. Bump the buy side further so a sell-side gap remains.
  const placed = mergePlacementTrackerIntoSummary(base, abePlacementMap(), "Mr Akshit Verma");
  const stretched = placed.summary.map((s) => ({ ...s, buyQty: 70000, openQty: 20000, isMatched: false }));

  const then = mergeDbHoldingsIntoSummary(stretched, [
    { ticker: "ABE", parentTicker: "ABE", qty: 20000, marketValue: 5000 },
  ]);
  const row = then.summary.find((s) => s.ticker === "ABE");
  assert.equal(row?.isPartialBuy, true);
  assert.equal(row?.isPartialExit, true);
  assert.equal(row?.comment, "Partial Buy · Partial Exit");
});

// ---------------------------------------------------------------------------
// Unlisted placement options
// ---------------------------------------------------------------------------

test("parseAddOnSpec - every shape the real Overview column contains", async () => {
  // Verbatim strings pulled from the 2026 Placements workbook.
  const listed = parseAddOnSpec("1:1 @$0.04 Listed Exp 30/11/28");
  assert.ok(listed);
  assert.equal(listed.listed, true);
  assert.equal(listed.ratioOptions, 1);
  assert.equal(listed.ratioPerShares, 1);
  assert.equal(listed.strike, 0.04);
  assert.equal(listed.expiry, "2028-11-30");

  const unlisted = parseAddOnSpec("1:2 @$1.20 Unlisted Exp 31/12/27");
  assert.ok(unlisted);
  assert.equal(unlisted.listed, false);
  assert.equal(unlisted.strike, 1.2);
  assert.equal(unlisted.expiry, "2027-12-31");

  // Spaces after @ and around $, seen on most 2026 rows.
  const spaced = parseAddOnSpec("1:4 @ $ 0.035 Unlisted Exp 03/07/28");
  assert.equal(spaced?.strike, 0.035);
  assert.equal(spaced?.expiry, "2028-07-03");
  assert.equal(spaced?.listed, false);

  // Two-digit ratio, no space before @.
  const wide = parseAddOnSpec("1:20 @$1.1 Unlisted Exp 31/01/29");
  assert.equal(wide?.ratioPerShares, 20);
  assert.equal(wide?.strike, 1.1);

  // "Expiry" spelled out, no $ sign.
  const spelled = parseAddOnSpec("1:3@0.14 Unlisted Expiry 31/12/27");
  assert.equal(spelled?.ratioPerShares, 3);
  assert.equal(spelled?.strike, 0.14);
  assert.equal(spelled?.expiry, "2027-12-31");
  assert.equal(spelled?.listed, false);

  // "Unlisted" contains "listed" — the negative must win.
  assert.equal(parseAddOnSpec("1:1 @$0.1 Unlisted Exp 01/01/29")?.listed, false);
});

test("parseAddOnSpec - rejects everything that is not an option grant", async () => {
  for (const junk of [
    "",
    "   ",
    "IPO",
    "Entitlement Offer",
    "Entitlement/Shortfall Offer",
    "0:00", // a blank time cell, not a 0-for-0 ratio
    "00:00",
    "1:2 Unlisted Exp 31/12/27", // no strike
    "1:2 @$0.10 Unlisted", // no expiry
    "@$0.10 Unlisted Exp 31/12/27", // no ratio
    "1:2 @$0.10 Unlisted Exp 31/02/27", // 31 February — never silently rolls to March
  ]) {
    assert.equal(parseAddOnSpec(junk), null, `should reject ${JSON.stringify(junk)}`);
  }
  assert.equal(parseAddOnSpec(null), null);
  assert.equal(parseAddOnSpec(undefined), null);
});

/** Placement map with one unlisted 1:3 @ $0.14 add-on on GRV, expiring 31/12/27. */
const unlistedPlacementMap = (overrides = {}) => {
  const m = new Map();
  m.set("GRV", {
    ticker: "GRV",
    totalShares: 0,
    totalActualDollar: 0,
    clientAllocations: [],
    addOns: [
      {
        raw: "1:3@0.14 Unlisted Expiry 31/12/27",
        tranche: 1,
        ratioOptions: 1,
        ratioPerShares: 3,
        strike: 0.14,
        expiry: "2027-12-31",
        listed: false,
        ...overrides,
      },
    ],
  });
  return m;
};

/** One equity row holding 10,000 GRV shares. */
const grvEquityRow = (buyQty = 10000) => [
  {
    ticker: "GRV",
    parentTicker: "GRV",
    instrument: "EQUITY" as const,
    company: "GREENVALE ENERGY LTD",
    buyQty,
    sellQty: 0,
    buyPrice: 2000,
    sellPrice: 0,
    totalBuyValue: 2000,
    totalSellValue: 0,
    pnlCalculated: -2000,
    isMatched: false,
    isOption: false,
    hasOptionCode: false,
    openQty: buyQty,
    tradeCount: 1,
  },
];

test("buildUnlistedOptionRows - entitlement, Black-Scholes price and P&L", async () => {
  const asOf = new Date("2026-08-04T00:00:00Z");
  const spot = 0.2;
  const spots = new Map([["GRV", { price: spot, source: "yahoo" as const }]]);

  const built = buildUnlistedOptionRows(grvEquityRow(10000), unlistedPlacementMap(), spots, asOf);

  assert.equal(built.addedCount, 1);
  assert.deepEqual(built.skipped, []);

  const row = built.summary.find((s) => s.isUnlistedOption);
  assert.ok(row);
  assert.equal(row.ticker, "GRV-UO");
  assert.equal(row.parentTicker, "GRV");
  assert.equal(row.instrument, "OPTION");
  assert.equal(row.comment, "Unlisted Options");

  // 1 option per 3 shares on 10,000 shares -> 3,333 (floored, no part options).
  assert.equal(row.sellQty, 3333);

  // Free options: nothing paid, so the whole modelled value is the gain.
  assert.equal(row.buyQty, 0);
  assert.equal(row.buyPrice, 0);
  assert.equal(row.totalBuyValue, 0);

  const expectedPer = blackScholesCall({
    spot,
    strike: 0.14,
    timeToExpiryYears: row.unlistedOption!.timeToExpiryYears,
    ...UNLISTED_OPTION_ASSUMPTIONS,
  });
  const expectedValue = Math.round(expectedPer * 3333 * 100) / 100;

  assert.equal(row.sellPrice, expectedValue);
  assert.equal(row.totalSellValue, expectedValue);
  assert.equal(row.pnlCalculated, expectedValue);
  assert.ok(expectedValue > 0, "an ITM option 1.4 years out must be worth something");

  // The valuation inputs are retained for audit.
  const v = row.unlistedOption!;
  assert.equal(v.spot, spot);
  assert.equal(v.spotSource, "yahoo");
  assert.equal(v.sharesHeld, 10000);
  assert.equal(v.volatility, 0.5);
  assert.equal(v.riskFreeRate, 0.05);
  assert.equal(v.dividendYield, 0);
  assert.equal(v.addOn.strike, 0.14);
});

test("buildUnlistedOptionRows - an ASX-sourced spot prices normally and is not 'skipped'", async () => {
  const asOf = new Date("2026-08-04T00:00:00Z");
  const spot = 0.2;

  const viaAsx = buildUnlistedOptionRows(
    grvEquityRow(10000),
    unlistedPlacementMap(),
    new Map([["GRV", { price: spot, source: "asx" as const }]]),
    asOf
  );
  const viaYahoo = buildUnlistedOptionRows(
    grvEquityRow(10000),
    unlistedPlacementMap(),
    new Map([["GRV", { price: spot, source: "yahoo" as const }]]),
    asOf
  );

  const asxRow = viaAsx.summary.find((s) => s.isUnlistedOption);
  const yahooRow = viaYahoo.summary.find((s) => s.isUnlistedOption);

  // Same spot, same source-agnostic maths — only the recorded provenance differs.
  assert.equal(asxRow?.unlistedOption?.spotSource, "asx");
  assert.equal(asxRow?.sellPrice, yahooRow?.sellPrice);
  assert.equal(asxRow?.pnlCalculated, yahooRow?.pnlCalculated);
  assert.ok(asxRow!.sellPrice > 0);

  // A real price means the name is NOT reported as unpriced.
  assert.deepEqual(viaAsx.skipped, []);
});

test("buildUnlistedOptionRows - listed add-ons never become rows", async () => {
  const built = buildUnlistedOptionRows(
    grvEquityRow(),
    unlistedPlacementMap({ listed: true }),
    new Map([["GRV", { price: 0.2, source: "yahoo" as const }]]),
    new Date("2026-08-04T00:00:00Z")
  );
  assert.equal(built.addedCount, 0);
  assert.equal(built.summary.filter((s) => s.isUnlistedOption).length, 0);
});

test("buildUnlistedOptionRows - no spot still books the entitlement, at zero and reported", async () => {
  const built = buildUnlistedOptionRows(
    grvEquityRow(10000),
    unlistedPlacementMap(),
    new Map(), // Yahoo and the DB both came back empty
    new Date("2026-08-04T00:00:00Z")
  );

  const row = built.summary.find((s) => s.isUnlistedOption);
  assert.ok(row, "the entitlement is real even without a price — hiding it understates the position");
  assert.equal(row.sellQty, 3333);
  assert.equal(row.sellPrice, 0);
  assert.equal(row.pnlCalculated, 0);
  assert.equal(row.unlistedOption?.spotSource, "unavailable");
  assert.deepEqual(built.skipped, ["GRV"], "the desk must be told which names are unpriced");
});

test("buildUnlistedOptionRows - skips names with no shares, and is idempotent", async () => {
  const asOf = new Date("2026-08-04T00:00:00Z");
  const spots = new Map([["GRV", { price: 0.2, source: "yahoo" as const }]]);

  // No shares bought -> no entitlement.
  const none = buildUnlistedOptionRows(grvEquityRow(0), unlistedPlacementMap(), spots, asOf);
  assert.equal(none.addedCount, 0);

  // Fewer shares than the ratio needs -> floor(2/3) = 0 options, so no row.
  const tooFew = buildUnlistedOptionRows(grvEquityRow(2), unlistedPlacementMap(), spots, asOf);
  assert.equal(tooFew.addedCount, 0);

  // Re-running over its own output replaces rather than stacks.
  const first = buildUnlistedOptionRows(grvEquityRow(10000), unlistedPlacementMap(), spots, asOf);
  const second = buildUnlistedOptionRows(first.summary, unlistedPlacementMap(), spots, asOf);
  assert.equal(second.summary.filter((s) => s.isUnlistedOption).length, 1);
  assert.equal(second.summary.length, first.summary.length);
  assert.equal(second.totalPnl, first.totalPnl);
});

test("buildUnlistedOptionRows - an expired add-on is worth its intrinsic value only", async () => {
  const built = buildUnlistedOptionRows(
    grvEquityRow(30000),
    unlistedPlacementMap({ expiry: "2020-01-01" }),
    new Map([["GRV", { price: 0.2, source: "yahoo" as const }]]),
    new Date("2026-08-04T00:00:00Z")
  );
  const row = built.summary.find((s) => s.isUnlistedOption);
  // 10,000 options, intrinsic 0.20 - 0.14 = 0.06 each.
  assert.equal(row?.sellQty, 10000);
  assert.equal(row?.unlistedOption?.timeToExpiryYears, 0);
  assert.equal(row?.sellPrice, 600);
});

test("collectUnlistedOptionTickers - only unlisted add-ons on names actually held", async () => {
  const spots = unlistedPlacementMap();
  assert.deepEqual(collectUnlistedOptionTickers(grvEquityRow(10000), spots), ["GRV"]);
  // Nothing held -> nothing to price.
  assert.deepEqual(collectUnlistedOptionTickers(grvEquityRow(0), spots), []);
  // Listed add-on -> not our problem.
  assert.deepEqual(collectUnlistedOptionTickers(grvEquityRow(10000), unlistedPlacementMap({ listed: true })), []);
});

test("parseAddOnSpecs - a multi-tranche cell yields one grant per tranche", async () => {
  // Verbatim from the 2026 workbook's RCE row.
  const specs = parseAddOnSpecs(
    "1:2 @ $ 0.60 Unlisted Exp 30/06/27 +  1:2  @ $ 1.00 Unlisted Piggyback Exp 30/06/28"
  );

  assert.equal(specs.length, 2, "the piggyback tranche must not be dropped");

  assert.equal(specs[0].tranche, 1);
  assert.equal(specs[0].strike, 0.6);
  assert.equal(specs[0].expiry, "2027-06-30");
  assert.equal(specs[0].listed, false);
  assert.equal(specs[0].note, undefined);

  assert.equal(specs[1].tranche, 2);
  assert.equal(specs[1].strike, 1);
  assert.equal(specs[1].expiry, "2028-06-30");
  assert.equal(specs[1].listed, false);
  assert.equal(specs[1].note, "Piggyback");
  assert.equal(specs[1].piggyback, true);
  assert.equal(specs[0].piggyback, false);
  // Each segment keeps only its own text, so the audit trail is per tranche.
  assert.ok(specs[1].raw.includes("1.00"));
  assert.ok(!specs[1].raw.includes("0.60"));
});

test("parseAddOnSpecs - separator-agnostic, and single grants still work", async () => {
  // The separator is whatever was typed, so segmentation keys off the ratio.
  for (const joiner of [" + ", " & ", " and ", "; ", "\n"]) {
    const specs = parseAddOnSpecs(
      `1:2 @ $0.60 Unlisted Exp 30/06/27${joiner}1:4 @ $1.00 Unlisted Exp 30/06/28`
    );
    assert.equal(specs.length, 2, `failed to split on ${JSON.stringify(joiner)}`);
    assert.equal(specs[0].ratioPerShares, 2);
    assert.equal(specs[1].ratioPerShares, 4);
  }

  // A single grant is a one-element list.
  const one = parseAddOnSpecs("1:2 @$1.20 Unlisted Exp 31/12/27");
  assert.equal(one.length, 1);
  assert.equal(one[0].tranche, 1);
  assert.equal(one[0].strike, 1.2);

  // Junk still yields nothing.
  for (const junk of ["", "IPO", "Entitlement Offer", "0:00", "00:00"]) {
    assert.deepEqual(parseAddOnSpecs(junk), [], `should reject ${JSON.stringify(junk)}`);
  }

  // A repeated tranche is not counted twice.
  const dupe = parseAddOnSpecs("1:2 @$0.60 Unlisted Exp 30/06/27 + 1:2 @$0.60 Unlisted Exp 30/06/27");
  assert.equal(dupe.length, 1);
});

test("parseAddOnSpecs - a mixed listed + unlisted cell keeps both, tagged", async () => {
  const specs = parseAddOnSpecs(
    "1:1 @$0.04 Listed Exp 30/11/28 + 1:2 @$0.10 Unlisted Exp 31/12/29"
  );
  assert.equal(specs.length, 2);
  assert.equal(specs[0].listed, true);
  assert.equal(specs[1].listed, false);
});

test("buildUnlistedOptionRows - every unlisted tranche becomes its own row", async () => {
  const asOf = new Date("2026-08-04T00:00:00Z");
  const spot = 0.8;
  const pmap = new Map();
  pmap.set("RCE", {
    ticker: "RCE",
    totalShares: 0,
    totalActualDollar: 0,
    clientAllocations: [],
    addOns: parseAddOnSpecs(
      "1:2 @ $ 0.60 Unlisted Exp 30/06/27 +  1:2  @ $ 1.00 Unlisted Piggyback Exp 30/06/28"
    ),
  });

  const summary = [
    {
      ticker: "RCE",
      parentTicker: "RCE",
      instrument: "EQUITY" as const,
      company: "RECCE PHARMA",
      buyQty: 10000,
      sellQty: 0,
      buyPrice: 5000,
      sellPrice: 0,
      totalBuyValue: 5000,
      totalSellValue: 0,
      pnlCalculated: -5000,
      isMatched: false,
      isOption: false,
      hasOptionCode: false,
      openQty: 10000,
      tradeCount: 1,
    },
  ];

  const built = buildUnlistedOptionRows(
    summary,
    pmap,
    new Map([["RCE", { price: spot, source: "yahoo" as const }]]),
    asOf
  );

  assert.equal(built.addedCount, 2);
  assert.deepEqual(built.unresolvedPiggybacks, []);

  const uo = built.summary.filter((s) => s.isUnlistedOption);
  assert.deepEqual(uo.map((r) => r.ticker), ["RCE-UO", "RCE-UO2"]);

  // Base tranche: 1:2 on the 10,000 SHARES held.
  assert.equal(uo[0].sellQty, 5000);
  assert.equal(uo[0].unlistedOption?.basisKind, "shares");
  assert.equal(uo[0].unlistedOption?.basisQty, 10000);
  assert.equal(uo[0].unlistedOption?.addOn.piggyback, false);

  // Piggyback: 1:2 on the BASE TRANCHE'S 5,000 options, earned by exercising it —
  // not another 5,000 off the share count.
  assert.equal(uo[1].sellQty, 2500);
  assert.equal(uo[1].unlistedOption?.basisKind, "base-options");
  assert.equal(uo[1].unlistedOption?.basisQty, 5000);
  assert.equal(uo[1].unlistedOption?.addOn.piggyback, true);

  // Shares held is still recorded on both for context.
  assert.equal(uo[0].unlistedOption?.sharesHeld, 10000);
  assert.equal(uo[1].unlistedOption?.sharesHeld, 10000);

  // Different strikes and expiries, so the $0.60 tranche is worth strictly more.
  assert.equal(uo[0].unlistedOption?.addOn.strike, 0.6);
  assert.equal(uo[1].unlistedOption?.addOn.strike, 1);
  assert.ok(
    uo[0].unlistedOption!.optionPrice > uo[1].unlistedOption!.optionPrice,
    "the lower strike must price higher"
  );

  // The piggyback label reaches the row description.
  assert.ok(uo[1].company.includes("Piggyback"), uo[1].company);

  // Both flow into the total, and a re-run replaces rather than stacks.
  assert.equal(built.totalPnl, Math.round((-5000 + uo[0].pnlCalculated + uo[1].pnlCalculated) * 100) / 100);
  const again = buildUnlistedOptionRows(
    built.summary,
    pmap,
    new Map([["RCE", { price: spot, source: "yahoo" as const }]]),
    asOf
  );
  assert.equal(again.summary.filter((s) => s.isUnlistedOption).length, 2);
  assert.equal(again.totalPnl, built.totalPnl);
});

test("buildUnlistedOptionRows - a listed tranche is skipped but numbering stays clean", async () => {
  const pmap = new Map();
  pmap.set("GRV", {
    ticker: "GRV",
    totalShares: 0,
    totalActualDollar: 0,
    clientAllocations: [],
    // Listed first, unlisted second.
    addOns: parseAddOnSpecs("1:1 @$0.04 Listed Exp 30/11/28 + 1:2 @$0.10 Unlisted Exp 31/12/29"),
  });

  const built = buildUnlistedOptionRows(
    grvEquityRow(10000),
    pmap,
    new Map([["GRV", { price: 0.2, source: "yahoo" as const }]]),
    new Date("2026-08-04T00:00:00Z")
  );

  assert.equal(built.addedCount, 1);
  const uo = built.summary.filter((s) => s.isUnlistedOption);
  // The only created row keeps the bare code — no gap left by the skipped tranche.
  assert.deepEqual(uo.map((r) => r.ticker), ["GRV-UO"]);
  assert.equal(uo[0].sellQty, 5000);
  assert.equal(uo[0].unlistedOption?.addOn.strike, 0.1);
});

test("buildUnlistedOptionRows - a piggyback with no base tranche is reported, never guessed", async () => {
  const pmap = new Map();
  pmap.set("GRV", {
    ticker: "GRV",
    totalShares: 0,
    totalActualDollar: 0,
    clientAllocations: [],
    // Piggyback only — there is nothing to piggyback on.
    addOns: parseAddOnSpecs("1:2 @$0.60 Unlisted Piggyback Exp 30/06/27"),
  });

  const built = buildUnlistedOptionRows(
    grvEquityRow(10000),
    pmap,
    new Map([["GRV", { price: 0.2, source: "yahoo" as const }]]),
    new Date("2026-08-04T00:00:00Z")
  );

  // Falling back to the share count would fabricate 5,000 options out of nothing.
  assert.equal(built.addedCount, 0);
  assert.equal(built.summary.filter((s) => s.isUnlistedOption).length, 0);
  assert.equal(built.unresolvedPiggybacks.length, 1);
  assert.ok(built.unresolvedPiggybacks[0].startsWith("GRV"), built.unresolvedPiggybacks[0]);
});

test("buildUnlistedOptionRows - a base too small to grant anything zeroes its piggyback", async () => {
  const pmap = new Map();
  pmap.set("GRV", {
    ticker: "GRV",
    totalShares: 0,
    totalActualDollar: 0,
    clientAllocations: [],
    addOns: parseAddOnSpecs("1:5 @$0.10 Unlisted Exp 30/06/27 + 1:2 @$0.20 Unlisted Piggyback Exp 30/06/28"),
  });

  // 3 shares -> floor(3/5) = 0 base options -> nothing for the piggyback either.
  const built = buildUnlistedOptionRows(
    grvEquityRow(3),
    pmap,
    new Map([["GRV", { price: 0.2, source: "yahoo" as const }]]),
    new Date("2026-08-04T00:00:00Z")
  );

  assert.equal(built.addedCount, 0);
  // A base that came to 0 is not the same as a MISSING base, so nothing is flagged.
  assert.deepEqual(built.unresolvedPiggybacks, []);
});

test("buildUnlistedOptionRows - an unpriced name is reported once, not per tranche", async () => {
  const pmap = new Map();
  pmap.set("RCE", {
    ticker: "RCE",
    totalShares: 0,
    totalActualDollar: 0,
    clientAllocations: [],
    addOns: parseAddOnSpecs("1:2 @$0.60 Unlisted Exp 30/06/27 + 1:2 @$1.00 Unlisted Exp 30/06/28"),
  });

  const built = buildUnlistedOptionRows(
    [{ ...grvEquityRow(10000)[0], ticker: "RCE", parentTicker: "RCE", company: "RECCE" }],
    pmap,
    new Map(), // no spot at all
    new Date("2026-08-04T00:00:00Z")
  );

  assert.equal(built.addedCount, 2);
  assert.deepEqual(built.skipped, ["RCE"], "one warning per name, not one per tranche");
  assert.equal(built.summary.filter((s) => s.isUnlistedOption).every((r) => r.sellPrice === 0), true);
});

test("Exports carry no Open Qty column, and a granted option leaks no negative", async () => {
  const built = buildUnlistedOptionRows(
    grvEquityRow(10000),
    unlistedPlacementMap(),
    new Map([["GRV", { price: 0.2, source: "yahoo" as const }]]),
    new Date("2026-08-04T00:00:00Z")
  );

  // The field itself still records buy minus sell — only the export dropped it.
  const uo = built.summary.find((s) => s.isUnlistedOption);
  assert.equal(uo?.openQty, -3333);

  const csv = buildPnlExportCsvString(built.summary);
  const lines = csv.split("\r\n");

  assert.equal(lines[0].includes("Open Qty"), false, "column removed from the header");
  // A granted option's negative open qty must not appear anywhere in the file.
  assert.equal(csv.includes("-3333"), false);
  // Comments is now the last column.
  assert.ok(lines[0].endsWith("Comments"), lines[0]);
  assert.ok(lines.find((l) => l.startsWith("GRV-UO"))!.endsWith("Unlisted Options"));

  // Header, every row and Grand Total stay the same width.
  const width = lines[0].split(",").length;
  for (const line of lines) {
    assert.equal(line.split(",").length, width, `ragged row: ${line}`);
  }

  const xlsx = await buildPnlExportXlsxBuffer(built.summary);
  assert.ok(xlsx.length > 0);
});

test("exportStatus - option lines are never reported as Unmatched", async () => {
  const base = { ticker: "ABC", company: "ABC", buyQty: 1, sellQty: 2, buyPrice: 1, sellPrice: 2, totalBuyValue: 1, totalSellValue: 2, pnlCalculated: 1, openQty: -1, tradeCount: 1, isOption: false };

  // An equity row with legs that do not balance IS a discrepancy.
  assert.equal(exportStatus({ ...base, isMatched: false, instrument: "EQUITY" }), "Unmatched");
  assert.equal(exportStatus({ ...base, isMatched: true, instrument: "EQUITY" }), "Matched");

  // An option's legs are not expected to balance, so "Unmatched" would be noise.
  assert.equal(exportStatus({ ...base, isMatched: false, instrument: "OPTION" }), "Option");
  assert.equal(
    exportStatus({ ...base, isMatched: false, instrument: "OPTION", isUnlistedOption: true }),
    "Unlisted Option"
  );
  // A matched option still reads Matched — that is real information.
  assert.equal(exportStatus({ ...base, isMatched: true, instrument: "OPTION" }), "Matched");
});

test("Unlisted option rows reach the Comments column in both exports", async () => {
  const built = buildUnlistedOptionRows(
    grvEquityRow(10000),
    unlistedPlacementMap(),
    new Map([["GRV", { price: 0.2, source: "yahoo" as const }]]),
    new Date("2026-08-04T00:00:00Z")
  );

  const csv = buildPnlExportCsvString(built.summary);
  const lines = csv.split("\r\n");
  const uoLine = lines.find((l) => l.startsWith("GRV-UO"));
  assert.ok(uoLine, "the option row must be exported");
  assert.ok(uoLine.endsWith("Unlisted Options"), `expected the note, got: ${uoLine}`);
  // Column count stays aligned with the header.
  assert.equal(uoLine.split(",").length, lines[0].split(",").length);

  const xlsx = await buildPnlExportXlsxBuffer(built.summary);
  assert.ok(xlsx.length > 0);
});
