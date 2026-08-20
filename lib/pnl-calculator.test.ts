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
  splitTrackerUrls,
  combinePlacementMaps,
  resolvePlacementClientHints,
  buildPnlExportFilename,
  isClientMatch,
  parseAddOnSpec,
  parseAddOnSpecs,
  ASSUMED_UNLISTED_OPTION_TERM_YEARS,
  buildUnlistedOptionRows,
  collectUnlistedOptionTickers,
  exportStatus,
  isBuySideUnknown,
  aggregateTradesToSummary,
  filterTradesByDateRange,
  filterPlacementsByDateRange,
  tradedParentTickers,
  hasDateRange,
  type PlacementTickerInfo,
  type PnlSummaryItem,
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
  // An OPTION recovered from the snapshot is named for what it is. The snapshot
  // only carries coded instruments, so it is listed — and the note then reads
  // directly against the modelled `Unlisted Options` rows beside it.
  assert.equal(gedo.comment, "Listed Options");
  assert.equal(gedo.tradeCount, 0);
  assert.equal(exportStatus(gedo), "Listed Options");

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

test("isClientMatch - one entity spelled two ways matches; two entities never do", () => {
  // The real failing case. `clients.display_name` says PTY LTD, the hand-typed
  // tracker says something shorter, and the client matched NOTHING — which on the
  // stored-P&L path reported 24 tickers unfilled for one account.
  const hint = "Psg Capital Investments PTY LTD";
  for (const sheetName of [
    "PSG CAPITAL INVESTMENTS PTY LTD",
    "Psg Capital Investments Pty. Ltd.",
    "Psg Capital Investments P/L",
    "PSG Capital Investments Pty Limited",
    "PSG Capital Inv Pty Ltd",
    "Psg Capital Investment Pty Ltd",
    "Psg Capital Investments Pty Ltd ATF Psg Super Fund",
  ]) {
    assert.equal(isClientMatch(sheetName, hint), true, sheetName);
  }
  assert.equal(isClientMatch("Smith Superannuation Fund", "Smith Super Fund"), true);

  // A super fund written as one word in the register and two in the tracker —
  // a real client, and the case the earlier `super → superannuation` mapping
  // actively broke: it lengthened one side only, so the same entity matched
  // nothing and needed a hand-written alias to state its own spelling.
  assert.equal(isClientMatch("PSG Super Fund", "Psg Superfund PTY LTD"), true);
  assert.equal(isClientMatch("PSG Super", "Psg Superfund PTY LTD"), true);
  // …and it still does not reach the OTHER PSG entity, which is the whole point.
  assert.equal(isClientMatch("PSG Super Fund", "Psg Capital Investments PTY LTD"), false);

  // A joint account, whose connector the two sources write three different ways.
  // `&` used to survive as punctuation and vanish; once it was read as a word it
  // became a token the other spellings did not have, so it is dropped outright.
  const joint = "R Chawla & G Vijan PTY LTD";
  for (const sheetName of [
    "R Chawla & G Vijan Pty Ltd",
    "R Chawla and G Vijan Pty Ltd",
    "R Chawla G Vijan Pty Ltd",
    "R Chawla & G Vijan",
  ]) {
    assert.equal(isClientMatch(sheetName, joint), true, sheetName);
  }
  // …but the family's OTHER entities are not this one. Both are real rows in the
  // tracker and both are separate clients in the database.
  assert.equal(isClientMatch("RG Vijan Super Fund", joint), false);
  assert.equal(isClientMatch("RG Vijan Pty Ltd", joint), false);

  // The trap the canonicalisation must not fall into. DELETING `Pty Ltd` would be
  // the easy fix and would make "Smith Pty Ltd" a prefix of "Smith Super Fund",
  // filling one client's row from a related entity's parcel. Mapping the suffix to
  // a single token instead keeps it as evidence.
  assert.equal(isClientMatch("Smith Super Fund", "Smith Pty Ltd"), false);
  assert.equal(isClientMatch("Smith Family Trust", "Smith Pty Ltd"), false);
  assert.equal(isClientMatch("Psg Capital Superannuation Fund", hint), false);
  assert.equal(isClientMatch("Mr Paul Grant", hint), false);
  // A public company is not a proprietary one, so `Ltd` alone stays distinct.
  assert.equal(isClientMatch("Psg Capital Investments Ltd", hint), false);
});

test("resolvePlacementClientHints - a client's tracker aliases are hints too", async () => {
  const stem = (n: string) => n.replace(/\.[^.]+$/, "");
  const base = { override: "__auto__", autoSentinel: "__auto__", filenameStem: stem };

  // The database calls this client one thing and the hand-typed tracker calls it
  // several others. The difference is not spelling — `PSG Capital Ltd` and `PSG
  // Super` are one word apart and are two SEPARATE clients — so the mapping is
  // stated in `clients.placement_aliases` rather than inferred by a looser matcher.
  const resolved = resolvePlacementClientHints({
    ...base,
    files: [{ name: "whatever.csv", accounts: ["114716"] }],
    accountHolders: { "114716": "Psg Capital Investments PTY LTD" },
    accountAliases: { "114716": ["PSG Capital Pty Ltd", "PSG Investments"] },
  });
  assert.deepEqual(resolved.hints, [
    "Psg Capital Investments PTY LTD",
    "PSG Capital Pty Ltd",
    "PSG Investments",
  ]);
  // Aliases only ADD candidates, so they can never change which source won.
  assert.equal(resolved.source, "account");
  // And each of them now matches its sheet, which the display name alone did not.
  assert.equal(isClientMatch("PSG Capital Pty Ltd", resolved.hints[1]), true);
  // The family's other entity is still not this client.
  assert.ok(!resolved.hints.some((h) => isClientMatch("PSG Superfund Pty Ltd", h)));

  // No aliases configured is the ordinary case and behaves exactly as before.
  const bare = resolvePlacementClientHints({
    ...base,
    files: [{ name: "whatever.csv", accounts: ["114716"] }],
    accountHolders: { "114716": "Psg Capital Investments PTY LTD" },
  });
  assert.deepEqual(bare.hints, ["Psg Capital Investments PTY LTD"]);
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

  // Two or three accounts: every one keeps its number AND its holder's name.
  assert.equal(
    buildPnlExportFilename({ ...base, accounts: ["a", "b"] }),
    "pnl-a-Alpha-Pty-Ltd-b-Beta-Pty-Ltd-2026-08-05.csv"
  );
  assert.equal(
    buildPnlExportFilename({ ...base, accounts: ["a", "b", "c"] }),
    "pnl-a-Alpha-Pty-Ltd-b-Beta-Pty-Ltd-c-Gamma-2026-08-05.csv"
  );

  // An account the database could not name still contributes its number.
  assert.equal(
    buildPnlExportFilename({ ...base, accounts: ["a", "zz"] }),
    "pnl-a-Alpha-Pty-Ltd-zz-2026-08-05.csv"
  );

  // With several accounts each name is trimmed harder — there are up to three of them.
  const longHolders = {
    a: "Mr Shaishav Kumar Patel + Mrs Vidushi Patel",
    b: "Sri Guru Nanak Investments Proprietary Limited",
    c: "Zidiplus Holdings And Investments Pty Ltd",
  };
  const trimmed = buildPnlExportFilename({
    ...base,
    accountHolders: longHolders,
    accounts: ["a", "b", "c"],
  });
  assert.equal(trimmed, "pnl-a-Mr-Shaishav-Kumar-Pa-b-Sri-Guru-Nanak-Inves-c-Zidiplus-Holdings-An-2026-08-05.csv");

  // Once even the trimmed form would run past what Windows accepts as a path, the
  // NAMES go and the numbers stay — a number still identifies the account, where a
  // truncated name identifies nothing.
  const refs = ["1102011-SUB-ACCOUNT-A", "1103199-SUB-ACCOUNT-B", "114716-SUB-ACCOUNT-C"];
  const capped = buildPnlExportFilename({
    ...base,
    accountHolders: { [refs[0]]: longHolders.a, [refs[1]]: longHolders.b, [refs[2]]: longHolders.c },
    accounts: refs,
    range: { from: "2026-01-01", to: "2026-06-30" },
  });
  assert.equal(
    capped,
    "pnl-1102011-SUB-ACCOUNT-A-1103199-SUB-ACCOUNT-B-114716-SUB-ACCOUNT-C-2026-01-01_to_2026-06-30.csv"
  );
  assert.ok(capped.length <= 120, capped);
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
  actualDollar: number,
  issueYear?: number
): { map: Map<string, PlacementTickerInfo> } => ({
  map: new Map<string, PlacementTickerInfo>([
    [
      ticker,
      {
        ticker,
        issueYear,
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

test("parsePlacementTrackerBuffer - a sheet's own arithmetic is not a participant", async () => {
  // From the real workbooks: every tab ends with `Total Confirmation`, and many
  // carry an `Allowance` bucket for what was not allocated to anybody. Both were
  // read as clients, which (a) counted the sheet's total a second time — AT1
  // reported 727,274 shares against one real allocation of 363,637 — and (b) made
  // every sheet look like it had one participant more than it does, silently
  // disabling the single-participant rule in the merge.
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();

  const ws = wb.addWorksheet("AT1");
  ws.addRow(["ASX CODE", "AT1"]);
  ws.addRow([]);
  ws.addRow(["CLIENT NAME", "ADVISOR/BROKER", "Asking Bid ($)", "Allocation ($)", "# of shares", "Round Shares", "ACTUAL $", "Seller Fee ($)"]);
  ws.addRow(["PSG Capital Ltd", "VTC", 12000, 12000.02, 363637, 363637, 12000.02, 360]);
  ws.addRow(["Allowance", "", 0, 3176.88, 264740, 264740, 3176.88, 0]);
  ws.addRow(["Total Confirmation", "", 12000, 12000.02, 363637, 363637, 12000.02, 360]);

  const map = await parsePlacementTrackerBuffer(Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer));
  const at1 = map.get("AT1");
  assert.ok(at1);

  assert.deepEqual(at1.clientAllocations.map((a) => a.clientName), ["PSG Capital Ltd"]);
  // The total is now the sum of the real allocations, not double it.
  assert.equal(at1.totalShares, 363637);
  assert.equal(at1.totalActualDollar, 12000.02);
});

test("PNL Calculator - the sole-participant rule is the calculator's, not the recompute's", () => {
  // One participant, and it is NOT the client being merged. On the calculator page
  // a human uploaded this client's ledger and is watching, so a lone name is taken
  // as a different spelling of them — long-standing, and what makes a merge work
  // before the holder is resolved.
  //
  // The unattended recompute cannot assume that: it runs every client against one
  // tracker, so filling here would store a stranger's parcel on this client's row
  // where nothing downstream could tell it from a real figure. It passes
  // `soleParticipantFallback: false` and takes a reported, unfilled row instead.
  const placements = new Map<string, PlacementTickerInfo>([
    [
      "AT1",
      {
        ticker: "AT1",
        totalShares: 363637,
        totalActualDollar: 12000.02,
        clientAllocations: [
          { clientName: "PSG Capital Ltd", advisor: "VTC", askingBid: 12000, allocationDollar: 12000.02, roundShares: 363637, actualDollar: 12000.02 },
        ],
      },
    ],
  ]);

  const row = (): PnlSummaryItem[] => [
    {
      ticker: "AT1",
      parentTicker: "AT1",
      instrument: "EQUITY",
      company: "ATOMO",
      buyQty: 0,
      sellQty: 363637,
      buyPrice: 0,
      sellPrice: 15000,
      totalBuyValue: 0,
      totalSellValue: 15000,
      pnlCalculated: 15000,
      isMatched: false,
      isOption: false,
      hasOptionCode: false,
      openQty: -363637,
      tradeCount: 1,
      buyYears: [],
      tradeYears: [2026],
    },
  ];

  const hint = "Some Other Client Pty Ltd";

  const calculator = mergePlacementTrackerIntoSummary(row(), placements, hint);
  assert.equal(calculator.summary[0].buyQty, 363637, "the calculator keeps the fallback");

  const recompute = mergePlacementTrackerIntoSummary(row(), placements, hint, {
    soleParticipantFallback: false,
  });
  assert.equal(recompute.summary[0].buyQty, 0, "nothing may be filled from a stranger");
  assert.equal(recompute.mergedCount, 0);
  // …and the row is reported, because its buy side is genuinely missing.
  assert.deepEqual(recompute.ambiguousTickers, ["AT1"]);
});

test("parsePlacementTrackerBuffer - the 2025 tracker's 'Options' column is read too", async () => {
  // The 2025 workbook heads the grant column "Options"; 2026 renamed it "Add-Ons".
  // Matching only "Add-Ons" made every 2025 unlisted option vanish from the P&L.
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();

  const ov = wb.addWorksheet("2025 Overview");
  ov.addRow([]);
  ov.addRow(["Counter", "Date Issued", "Options"]);
  ov.addRow(["ABE", "3 Mar 2025", "1:2 @$0.10 Unlisted Exp 31/12/29"]);
  ov.addRow(["ZEU", "4 Mar 2025", "Entitlement Offer"]);

  const ws = wb.addWorksheet("ABE");
  ws.addRow(["CLIENT NAME", "ADVISOR/BROKER", "Allocation ($)", "Round Shares", "ACTUAL $"]);
  ws.addRow(["Mr Akshit Verma", "VTC", 5000, 50000, 5000]);

  const map = await parsePlacementTrackerBuffer(
    Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer)
  );

  const abe = map.get("ABE");
  assert.ok(abe, "the ticker tab must still be parsed");
  assert.equal(abe.addOns?.length, 1);
  assert.equal(abe.addOns?.[0].strike, 0.1);
  assert.equal(abe.addOns?.[0].expiry, "2029-12-31");
  assert.equal(abe.addOns?.[0].listed, false);

  // "Entitlement Offer" is not a grant, so ZEU earns no entry at all.
  assert.equal(map.get("ZEU"), undefined);
});

test("parsePlacementTrackerBuffer - both Overview sheets in one workbook are read", async () => {
  // The two years live in one file often enough that reading only the first sheet
  // would drop a whole year of grants.
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();

  const ov25 = wb.addWorksheet("2025 Overview");
  ov25.addRow(["Counter", "Options"]);
  ov25.addRow(["ABE", "1:2 @$0.10 Unlisted Exp 31/12/29"]);

  const ov26 = wb.addWorksheet("2026 Overview");
  ov26.addRow(["Counter", "Add-Ons"]);
  ov26.addRow(["GRV", "1:3 @$0.14 Unlisted Expiry 31/12/27"]);

  const map = await parsePlacementTrackerBuffer(
    Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer)
  );

  // Neither has an allocation tab; both survive on the add-on-only path.
  assert.equal(map.get("ABE")?.addOns?.[0].strike, 0.1);
  assert.equal(map.get("GRV")?.addOns?.[0].strike, 0.14);
});

test("parseOverviewAddOns - a duplicated grant column does not double the entitlement", async () => {
  // A year in transition carries both spellings side by side, often copy-pasted.
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();

  const ov = wb.addWorksheet("Overview");
  ov.addRow(["Counter", "Options", "Add-Ons"]);
  ov.addRow([
    "ABE",
    "1:2 @$0.10 Unlisted Exp 31/12/29",
    "1:2 @$0.10 Unlisted Exp 31/12/29 + 1:4 @$0.20 Unlisted Piggyback Exp 31/12/30",
  ]);

  const map = await parsePlacementTrackerBuffer(
    Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer)
  );

  const addOns = map.get("ABE")?.addOns;
  assert.equal(addOns?.length, 2, "the repeated tranche collapses; the piggyback is kept");
  assert.deepEqual(
    addOns?.map((a) => a.tranche),
    [1, 2],
    "tranches are renumbered across the merged columns"
  );
  assert.equal(addOns?.[1].piggyback, true);
});

test("parseOverviewAddOns - an unrecognised column header is found by its contents", async () => {
  // Third rename insurance: no header matches, so the column is located by the cells.
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();

  const ov = wb.addWorksheet("2025 Overview");
  ov.addRow(["Counter", "Date Issued", "Extras"]);
  ov.addRow(["ABE", "3 Mar 2025", "1:2 @$0.10 Unlisted Exp 31/12/29"]);

  const map = await parsePlacementTrackerBuffer(
    Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer)
  );

  assert.equal(map.get("ABE")?.addOns?.[0].strike, 0.1);
});

test("parsePlacementTrackerBuffer - KNI (a) and KNI (b) are two placements, not one", async () => {
  // A stock placed twice in one year gets two tabs and two Overview rows. `set()`
  // used to overwrite here, so tab (b) was the only one that survived and tab (a)'s
  // parcel vanished from the merge entirely.
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();

  const ov = wb.addWorksheet("2026 Overview");
  ov.addRow(["Counter", "Settlement Date", "Add-Ons"]);
  ov.addRow(["KNI", "17 Jun 2026", "1:2 @$0.10 Unlisted Exp 31/12/29"]);
  ov.addRow(["KNI", "5 Nov 2026", ""]);

  const a = wb.addWorksheet("KNI (a)");
  a.addRow(["CLIENT NAME", "ADVISOR/BROKER", "Allocation ($)", "Round Shares", "ACTUAL $"]);
  a.addRow(["Mr Akshit Verma", "VTC", 6000, 60000, 6000]);

  const b = wb.addWorksheet("KNI (b)");
  b.addRow(["CLIENT NAME", "ADVISOR/BROKER", "Allocation ($)", "Round Shares", "ACTUAL $"]);
  b.addRow(["Zidiplus Pty Ltd", "VTC", 5000, 40000, 5000]);

  const map = await parsePlacementTrackerBuffer(
    Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer)
  );

  const kni = map.get("KNI")!;
  assert.equal(kni.candidates?.length, 2, "both tabs survive");
  assert.deepEqual(kni.candidates?.map((c) => c.sheetName), ["KNI (a)", "KNI (b)"]);
  assert.deepEqual(kni.candidates?.map((c) => c.totalShares), [60000, 40000]);

  // The nth tab takes the nth Overview row: its own date and its own grants.
  assert.deepEqual(kni.candidates?.map((c) => c.issueDate), ["2026-06-17", "2026-11-05"]);
  assert.equal(kni.candidates?.[0].addOns?.length, 1, "tab (a) grants options");
  assert.equal(kni.candidates?.[1].addOns, undefined, "tab (b) grants none");
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

test("splitTrackerUrls - a comma inside a SharePoint URL must not split it", async () => {
  // Shortened but structurally faithful: the real 2026 link ends in a query parameter
  // containing %2C, and something in the deploy pipeline decoded it to a real comma.
  const long =
    "https://x-my.sharepoint.com/:x:/r/personal/a/_layouts/15/doc2.aspx?sourcedoc=%7BGUID%7D&wdrldc=ExpiredWarningUnauthenticated,RefreshingExpiredWarning";
  const short = "https://x-my.sharepoint.com/:x:/g/personal/a/IQCabc?e=VbcU4x";

  // The failure that shipped: splitting on any comma tore the long link in two and left
  // a junk fragment, so it 404'd while the short one still worked.
  const naive = `${long},${short}`.split(/[\n,;]+/).filter(Boolean);
  assert.equal(naive.length, 3, "the old splitter produced a broken URL plus a fragment");

  const fixed = splitTrackerUrls(`${long},${short}`);
  assert.deepEqual(fixed.urls, [long, short]);
  assert.deepEqual(fixed.rejected, []);
});

test("splitTrackerUrls - accepts every sane separator and reports junk", async () => {
  const a = "https://example.com/a.xlsx";
  const b = "https://example.com/b.xlsx";

  for (const joiner of [",", ";", " ", "\n", "\r\n", ", ", " , ", "\n\n"]) {
    assert.deepEqual(
      splitTrackerUrls(`${a}${joiner}${b}`).urls,
      [a, b],
      `failed on ${JSON.stringify(joiner)}`
    );
  }

  // Duplicates collapse.
  assert.deepEqual(splitTrackerUrls(`${a}\n${a}`).urls, [a]);

  // Anything that is not an http(s) URL is surfaced, not silently attempted.
  const withJunk = splitTrackerUrls(`${a}\nnot-a-url\n/relative/path\n${b}`);
  assert.deepEqual(withJunk.urls, [a, b]);
  assert.deepEqual(withJunk.rejected, ["not-a-url", "/relative/path"]);

  // Empty and whitespace-only values yield nothing at all.
  assert.deepEqual(splitTrackerUrls("").urls, []);
  assert.deepEqual(splitTrackerUrls("   \n  ").urls, []);
});

test("splitTrackerUrls - quotes pasted into a hosting provider's env UI are stripped", async () => {
  const a = "https://example.com/a.xlsx";
  const b = "https://example.com/b.xlsx";

  // A `.env` file needs KEY="value" and dotenv strips the quotes; a hosting provider's
  // UI stores them verbatim, so they arrive as part of the URL. The deploy log showed
  // exactly this: one rejected entry, one character longer than the real link.
  assert.deepEqual(splitTrackerUrls(`"${a}"`).urls, [a]);
  assert.deepEqual(splitTrackerUrls(`'${a}'`).urls, [a]);

  // Quotes wrapping the whole value, with the links comma-separated inside.
  const wrapped = splitTrackerUrls(`"${a},${b}"`);
  assert.deepEqual(wrapped.urls, [a, b]);
  assert.deepEqual(wrapped.rejected, []);

  // Each link separately quoted.
  assert.deepEqual(splitTrackerUrls(`"${a}", "${b}"`).urls, [a, b]);
  assert.deepEqual(splitTrackerUrls(`"${a}"\n"${b}"`).urls, [a, b]);

  // A stray trailing quote must not survive into the URL — Graph would 404 on it.
  assert.deepEqual(splitTrackerUrls(`${a},${b}"`).urls, [a, b]);
  assert.equal(
    splitTrackerUrls(`${a},${b}"`).urls.every((u) => !u.includes('"')),
    true
  );
});

test("combinePlacementMaps - two years of the same ticker are never summed", async () => {
  // The 2025 and 2026 trackers both list ABE for the same client. Adding the two
  // parcels together gave the client a Buy Qty and a cost base they never had — the
  // reported wrong P&L. They are two placements (or one listed twice); either way
  // only the trade dates can say which belongs on the row.
  const a = placementFile("ABE", "Zidiplus Pty Ltd", 100000, 3000, 2025);
  const b = placementFile("ABE", "Zidiplus Pty Ltd", 66667, 2000, 2026);

  const first = combinePlacementMaps([a, b]);
  const abe = first.get("ABE")!;

  assert.equal(abe.candidates?.length, 2, "each year is kept as its own candidate");
  assert.deepEqual(abe.candidates?.map((c) => c.issueYear), [2025, 2026]);
  assert.deepEqual(abe.candidates?.map((c) => c.totalShares), [100000, 66667]);
  assert.notEqual(abe.totalShares, 166667, "the years must never be added together");
  assert.equal(abe.totalShares, 100000, "top-level describes the first candidate only");

  // The inputs must be untouched. Copying only the ARRAY left the allocation OBJECTS
  // shared, so a merge mutated the stored workbook — and this runs on every re-merge,
  // so the numbers grew on every upload.
  assert.equal(a.map.get("ABE")?.clientAllocations[0].roundShares, 100000);
  assert.equal(a.map.get("ABE")?.clientAllocations[0].actualDollar, 3000);
  assert.equal(b.map.get("ABE")?.clientAllocations[0].roundShares, 66667);

  // Re-merging the same inputs must give the same answer, however many times it runs.
  for (let i = 0; i < 4; i++) {
    const again = combinePlacementMaps([a, b]);
    assert.equal(again.get("ABE")?.totalShares, 100000, `run ${i + 2} drifted`);
    assert.deepEqual(again.get("ABE")?.candidates?.map((c) => c.totalShares), [100000, 66667]);
  }
});

test("combinePlacementMaps - two undated workbooks are kept apart, not collapsed", async () => {
  // Neither file's year could be read. They cannot be compared, so they must not be
  // treated as the same placement — that would silently drop one of them.
  const a = placementFile("ABE", "Zidiplus Pty Ltd", 100000, 3000);
  const b = placementFile("ABE", "Zidiplus Pty Ltd", 66667, 2000);

  const abe = combinePlacementMaps([a, b]).get("ABE")!;
  assert.equal(abe.candidates?.length, 2);
  assert.deepEqual(abe.candidates?.map((c) => c.issueYear), [undefined, undefined]);
});

test("combinePlacementMaps - each placement row survives, and repeats do not", async () => {
  // Two workbooks describing the same year's ABE, each naming a different
  // participant. They stay separate placements — the client is matched against a
  // ROW, and only the row they appear in should ever fill their figures.
  const a = placementFile("ABE", "Zidiplus Pty Ltd", 100000, 3000, 2025);
  const b = placementFile("ABE", "Saturn Fund", 50000, 1500, 2025);
  b.map.get("ABE")!.addOns = parseAddOnSpecs("1:2 @$0.10 Unlisted Exp 31/12/29");

  const combined = combinePlacementMaps([a, b]);
  const abe = combined.get("ABE")!;

  assert.equal(abe.candidates?.length, 2);
  assert.deepEqual(
    abe.candidates?.flatMap((c) => c.clientAllocations.map((x) => x.clientName)).sort(),
    ["Saturn Fund", "Zidiplus Pty Ltd"]
  );
  // Grants stay on the row that carries them, so a client in the other row earns none.
  assert.equal(abe.candidates?.[0].addOns, undefined);
  assert.equal(abe.candidates?.[1].addOns?.length, 1);
  // Both names still reach the account-holder picker.
  assert.deepEqual(collectPlacementClientNames(combined), ["Saturn Fund", "Zidiplus Pty Ltd"]);

  // The SAME placement carried into a second workbook is a repeat, not a parcel.
  const repeated = combinePlacementMaps([a, { map: new Map(a.map) }]);
  assert.equal(repeated.get("ABE")?.candidates, undefined, "identical rows collapse to one");
  assert.equal(repeated.get("ABE")?.totalShares, 100000);

  // Add-on objects are copies, so a later mutation cannot reach the source.
  abe.candidates![1].addOns![0].strike = 999;
  assert.equal(b.map.get("ABE")!.addOns![0].strike, 0.1);
});

test("mergePlacementTrackerIntoSummary - the client's own row fills the summary", async () => {
  // Two placements of ABE in one year — `ABE (a)` and `ABE (b)` — with a different
  // participant in each. Filling from the ticker rather than from the row the client
  // is actually in would hand them a stranger's parcel.
  const combined = combinePlacementMaps([
    placementFile("ABE", "Zidiplus Pty Ltd", 100000, 3000, 2025),
    placementFile("ABE", "Saturn Fund", 50000, 1500, 2025),
  ]);

  const row = () => [
    {
      ticker: "ABE",
      parentTicker: "ABE",
      instrument: "EQUITY" as const,
      company: "ABERDEEN",
      buyQty: 0,
      sellQty: 50000,
      buyPrice: 0,
      sellPrice: 2000,
      totalBuyValue: 0,
      totalSellValue: 2000,
      pnlCalculated: 2000,
      isMatched: false,
      isOption: false,
      hasOptionCode: false,
      openQty: -50000,
      tradeCount: 1,
      tradeYears: [2025],
      buyYears: [],
    },
  ];

  const saturn = mergePlacementTrackerIntoSummary(row(), combined, "Saturn Fund").summary[0];
  assert.equal(saturn.buyQty, 50000, "Saturn's own parcel, not Zidiplus's 100,000");
  assert.equal(saturn.buyPrice, 1500);

  const zidi = mergePlacementTrackerIntoSummary(row(), combined, "Zidiplus Pty Ltd").summary[0];
  assert.equal(zidi.buyQty, 100000);
  assert.equal(zidi.buyPrice, 3000);
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

/**
 * An ABE row with no recorded buys — the classic placement row — traded in `years`.
 * Pass `undefined` for a ledger that carries no Contract Date at all.
 */
const abeSoldRow = (years: number[] | undefined, buyYears: number[] = []) => [
  {
    ticker: "ABE",
    parentTicker: "ABE",
    instrument: "EQUITY" as const,
    company: "ABERDEEN",
    buyQty: 0,
    sellQty: 40000,
    buyPrice: 0,
    sellPrice: 12500,
    totalBuyValue: 0,
    totalSellValue: 12500,
    pnlCalculated: 12500,
    isMatched: false,
    isOption: false,
    hasOptionCode: false,
    openQty: -40000,
    tradeCount: 1,
    tradeYears: years,
    buyYears,
  },
];

/** ABE placed in BOTH trackers: 40,000 shares in 2025 and 10,000 in 2026. */
const abeTwoYearMap = () =>
  combinePlacementMaps([
    placementFile("ABE", "Mr Akshit Verma", 40000, 8000, 2025),
    placementFile("ABE", "Mr Akshit Verma", 10000, 2500, 2026),
  ]);

test("PNL Calculator - a ticker in two trackers is filled from the year the client traded", async () => {
  // The bug: both parcels were added, giving 50,000 shares for $10,500 — a Buy Qty
  // and a cost base the client never had. The trade's Contract Date year decides.
  const merged = mergePlacementTrackerIntoSummary(
    abeSoldRow([2025]),
    abeTwoYearMap(),
    "Mr Akshit Verma"
  );

  const abe = merged.summary.find((s) => s.ticker === "ABE")!;
  assert.equal(abe.buyQty, 40000, "the 2025 parcel, not both years");
  assert.equal(abe.buyPrice, 8000);
  assert.equal(abe.pnlCalculated, 4500);
  assert.equal(abe.placementYearUnresolved, undefined);
  assert.deepEqual(merged.unresolvedYearTickers, []);

  // The other year picks the other parcel, from the same combined map.
  const other = mergePlacementTrackerIntoSummary(
    abeSoldRow([2026]),
    abeTwoYearMap(),
    "Mr Akshit Verma"
  ).summary.find((s) => s.ticker === "ABE")!;
  assert.equal(other.buyQty, 10000);
  assert.equal(other.buyPrice, 2500);
});

test("PNL Calculator - BUY dates outrank sell dates when both are on the row", async () => {
  // Bought in 2025, sold in 2026. A placement is a purchase, so 2025 is the year.
  const abe = mergePlacementTrackerIntoSummary(
    abeSoldRow([2025, 2026], [2025]),
    abeTwoYearMap(),
    "Mr Akshit Verma"
  ).summary.find((s) => s.ticker === "ABE")!;

  assert.equal(abe.buyQty, 40000);
});

test("PNL Calculator - quantities settle a year the Contract Dates cannot", async () => {
  // Trades dated 2024 — neither tracker year matches. But 40,000 units were sold and
  // only the 2025 parcel is 40,000, so the numbers identify the placement where the
  // dates could not. That is harder evidence than any date heuristic.
  const abe = mergePlacementTrackerIntoSummary(
    abeSoldRow([2024]),
    abeTwoYearMap(),
    "Mr Akshit Verma"
  ).summary.find((s) => s.ticker === "ABE")!;

  assert.equal(abe.buyQty, 40000);
  assert.equal(abe.buyPrice, 8000);
  assert.equal(abe.placementYearUnresolved, undefined);
});

test("PNL Calculator - an unmatched placement year is left blank and flagged red", async () => {
  // Trades dated 2024, and 25,000 units sold — which is neither the 2025 parcel
  // (40,000), the 2026 one (10,000), nor both together. Neither the dates nor the
  // quantities identify a placement, so nothing is filled.
  const rows = abeSoldRow([2024]);
  rows[0].sellQty = 25000;
  rows[0].openQty = -25000;

  const merged = mergePlacementTrackerIntoSummary(rows, abeTwoYearMap(), "Mr Akshit Verma");

  const abe = merged.summary.find((s) => s.ticker === "ABE")!;
  assert.equal(abe.placementYearUnresolved, true);
  assert.equal(abe.buyQty, 0, "nothing was filled");
  assert.equal(abe.buyPrice, 0);
  assert.equal(abe.isEnriched, undefined);
  assert.equal(abe.comment, "Check Placement Year");
  assert.match(abe.placementYearNote ?? "", /2025 and 2026/);
  assert.match(abe.placementYearNote ?? "", /2024/);
  assert.deepEqual(merged.unresolvedYearTickers, ["ABE"]);

  // The row's buy side is UNKNOWN, not zero — so its cells blank out, and the total
  // skips it rather than booking the whole sale as profit.
  assert.equal(isBuySideUnknown(abe), true);
  assert.equal(merged.totalPnl, 0, "a row that shows blanks cannot be summed");
  assert.equal(exportStatus(abe), "Buy Side Unknown");

  // Both exports blank the buy side and the P&L rather than printing 0.
  const csv = buildPnlExportCsvString(merged.summary);
  const row = csv.split("\n").find((l) => l.startsWith("ABE,"))!;
  const cells = row.split(",");
  assert.equal(cells[4], "", "Buy Qty blank");
  assert.equal(cells[6], "", "Buy Price blank");
  assert.equal(cells[8], "", "PnL blank");
  assert.equal(cells[5], "25000", "the sale really happened and is still shown");
});

test("PNL Calculator - no trade dates at all cannot resolve a two-year ticker", async () => {
  // An older ledger with no Contract Date column AND quantities that fit no parcel:
  // nothing can answer the question, so the row is flagged rather than filled from
  // whichever year came first.
  const rows = abeSoldRow(undefined);
  rows[0].sellQty = 25000;
  rows[0].openQty = -25000;

  const merged = mergePlacementTrackerIntoSummary(rows, abeTwoYearMap(), "Mr Akshit Verma");
  const abe = merged.summary.find((s) => s.ticker === "ABE")!;

  assert.equal(abe.placementYearUnresolved, true);
  assert.match(abe.placementYearNote ?? "", /none in the file/);
});

test("PNL Calculator - two same-year parcels: the ledger's own buy is not counted twice", async () => {
  // `KNI (a)` (60,000) and `KNI (b)` (40,000) in one tracker year, the client in both.
  // The ledger already records 60,000 bought — tab (a) arriving as a contract note —
  // and 100,000 sold. Adding both parcels on top would count tab (a) twice; only the
  // 40,000 shortfall is missing, so only tab (b) is applied.
  const placement = combinePlacementMaps([
    {
      map: new Map<string, PlacementTickerInfo>([
        [
          "KNI",
          {
            ticker: "KNI",
            issueYear: 2026,
            totalShares: 60000,
            totalActualDollar: 6000,
            clientAllocations: [
              { clientName: "Mr Akshit Verma", advisor: "VTC", askingBid: 0, allocationDollar: 6000, roundShares: 60000, actualDollar: 6000 },
            ],
            candidates: [
              {
                sheetName: "KNI (a)",
                issueYear: 2026,
                totalShares: 60000,
                totalActualDollar: 6000,
                clientAllocations: [
                  { clientName: "Mr Akshit Verma", advisor: "VTC", askingBid: 0, allocationDollar: 6000, roundShares: 60000, actualDollar: 6000 },
                ],
              },
              {
                sheetName: "KNI (b)",
                issueYear: 2026,
                totalShares: 40000,
                totalActualDollar: 5000,
                clientAllocations: [
                  { clientName: "Mr Akshit Verma", advisor: "VTC", askingBid: 0, allocationDollar: 5000, roundShares: 40000, actualDollar: 5000 },
                ],
              },
            ],
          },
        ],
      ]),
    },
  ]);

  const kni = mergePlacementTrackerIntoSummary(
    [
      {
        ticker: "KNI",
        parentTicker: "KNI",
        instrument: "EQUITY",
        company: "KOONENBERRY",
        buyQty: 60000,
        sellQty: 100000,
        buyPrice: 6000,
        sellPrice: 15000,
        totalBuyValue: 6000,
        totalSellValue: 15000,
        pnlCalculated: 9000,
        isMatched: false,
        isOption: false,
        hasOptionCode: false,
        openQty: -40000,
        tradeCount: 3,
        buyYears: [2026],
        tradeYears: [2026],
      },
    ],
    placement,
    "Mr Akshit Verma"
  ).summary[0];

  assert.equal(kni.buyQty, 100000, "60,000 recorded + the 40,000 tab (b) parcel");
  assert.equal(kni.buyPrice, 11000, "$6,000 recorded + tab (b)'s $5,000");
  assert.equal(kni.isPartialBuy, true);
  assert.equal(kni.isMatched, true);
  assert.equal(kni.pnlCalculated, 4000);
  // The audit trail names the parcel actually applied, not both.
  assert.deepEqual(kni.clientAllocations?.map((a) => a.roundShares), [40000]);
});

test("PNL Calculator - a blank buy side takes BOTH same-year parcels", async () => {
  // Same two tabs, but the ledger records no buy at all: both parcels are missing,
  // so both are added. This is the case the shortfall matching must not narrow.
  const placement = new Map<string, PlacementTickerInfo>([
    [
      "KNI",
      {
        ticker: "KNI",
        issueYear: 2026,
        totalShares: 60000,
        totalActualDollar: 6000,
        clientAllocations: [],
        candidates: [
          {
            sheetName: "KNI (a)",
            issueYear: 2026,
            totalShares: 60000,
            totalActualDollar: 6000,
            clientAllocations: [
              { clientName: "Mr Akshit Verma", advisor: "VTC", askingBid: 0, allocationDollar: 6000, roundShares: 60000, actualDollar: 6000 },
            ],
          },
          {
            sheetName: "KNI (b)",
            issueYear: 2026,
            totalShares: 40000,
            totalActualDollar: 5000,
            clientAllocations: [
              { clientName: "Mr Akshit Verma", advisor: "VTC", askingBid: 0, allocationDollar: 5000, roundShares: 40000, actualDollar: 5000 },
            ],
          },
        ],
      },
    ],
  ]);

  const kni = mergePlacementTrackerIntoSummary(
    [
      {
        ticker: "KNI",
        parentTicker: "KNI",
        instrument: "EQUITY",
        company: "KOONENBERRY",
        buyQty: 0,
        sellQty: 100000,
        buyPrice: 0,
        sellPrice: 15000,
        totalBuyValue: 0,
        totalSellValue: 15000,
        pnlCalculated: 15000,
        isMatched: false,
        isOption: false,
        hasOptionCode: false,
        openQty: -100000,
        tradeCount: 1,
        buyYears: [],
        tradeYears: [2026],
      },
    ],
    placement,
    "Mr Akshit Verma"
  ).summary[0];

  assert.equal(kni.buyQty, 100000, "both parcels");
  assert.equal(kni.buyPrice, 11000);
  assert.equal(kni.pnlCalculated, 4000);
});

test("PNL Calculator - a ticker in ONE tracker fills without any year check", async () => {
  // The year comparison exists only to separate two placements. A single one must
  // keep working even when the ledger has no dates at all.
  const abe = mergePlacementTrackerIntoSummary(
    abeSoldRow(undefined),
    abePlacementMap(),
    "Mr Akshit Verma"
  ).summary.find((s) => s.ticker === "ABE")!;

  assert.equal(abe.buyQty, 40000);
  assert.equal(abe.placementYearUnresolved, undefined);
});

test("buildUnlistedOptionRows - grants come from the year the client was actually in", async () => {
  // Verbatim from the real trackers: ACM was placed in June 2025 with
  // "1:2@0.1 Unlisted" attached, and again in January 2026 with an EMPTY Add-Ons
  // cell. The client took the 2026 parcel (ACMXX bought 04-02-2026). Reading the
  // grants off whichever year happened to have some minted 23,333 options out of a
  // placement they were never in.
  const y2025 = placementFile("ACM", "Mr Akshit Verma", 40000, 3000, 2025);
  y2025.map.get("ACM")!.addOns = parseAddOnSpecs("1:2@0.1 Unlisted", new Date(Date.UTC(2025, 5, 17)));
  const y2026 = placementFile("ACM", "Mr Akshit Verma", 46667, 3500, 2026);

  const placement = combinePlacementMaps([y2025, y2026]);
  assert.equal(placement.get("ACM")?.candidates?.length, 2);
  assert.equal(placement.get("ACM")?.candidates?.[0].addOns?.length, 1, "2025 carries the grant");
  assert.equal(placement.get("ACM")?.candidates?.[1].addOns, undefined, "2026 carries none");

  const acmRow = (buyYears: number[]): PnlSummaryItem[] => [
    {
      ticker: "ACM",
      parentTicker: "ACM",
      instrument: "EQUITY",
      company: "AUS CRITICAL MINERAL",
      buyQty: 46667,
      sellQty: 46667,
      buyPrice: 3500,
      sellPrice: 3733,
      totalBuyValue: 3500,
      totalSellValue: 3733,
      pnlCalculated: 233,
      isMatched: true,
      isOption: false,
      hasOptionCode: false,
      openQty: 0,
      tradeCount: 2,
      buyYears,
      tradeYears: buyYears,
    },
  ];

  const spots = new Map([["ACM", { price: 0.08, source: "yahoo" as const }]]);
  const asOf = new Date("2026-08-06T00:00:00Z");

  // 2026 trades -> the 2026 placement -> no grant, so no row and no spot to fetch.
  const built2026 = buildUnlistedOptionRows(acmRow([2026]), placement, spots, asOf);
  assert.equal(built2026.addedCount, 0, "the 2026 placement grants nothing");
  assert.equal(built2026.summary.some((s) => s.isUnlistedOption), false);
  assert.deepEqual(collectUnlistedOptionTickers(acmRow([2026]), placement), []);

  // The same combined map DOES grant options to a client who took the 2025 parcel.
  const built2025 = buildUnlistedOptionRows(acmRow([2025]), placement, spots, asOf);
  assert.equal(built2025.addedCount, 1);
  assert.equal(built2025.summary.find((s) => s.isUnlistedOption)?.sellQty, 23333);
  assert.deepEqual(collectUnlistedOptionTickers(acmRow([2025]), placement), ["ACM"]);

  // Unresolvable year -> no grant either; the equity row is already blank and red.
  assert.equal(buildUnlistedOptionRows(acmRow([2024]), placement, spots, asOf).addedCount, 0);
});

test("buildUnlistedOptionRows - options come from the row the client was found in", async () => {
  // Same year, two placements: `ABE (a)` grants 1:2 unlisted options, `ABE (b)` grants
  // none. The client is only in (b). The year cannot separate these — they share one —
  // so the ROW the client was matched in has to, exactly as a person reading the sheet
  // would. Reading grants off the ticker hands them options they never earned.
  const withGrant = placementFile("ABE", "Saturn Fund", 100000, 3000, 2026);
  withGrant.map.get("ABE")!.addOns = parseAddOnSpecs("1:2 @$0.10 Unlisted Exp 31/12/29");
  const withoutGrant = placementFile("ABE", "Mr Akshit Verma", 40000, 1500, 2026);

  const placement = combinePlacementMaps([withGrant, withoutGrant]);

  const row = (): PnlSummaryItem[] => [
    {
      ticker: "ABE",
      parentTicker: "ABE",
      instrument: "EQUITY",
      company: "ABERDEEN",
      buyQty: 0,
      sellQty: 40000,
      buyPrice: 0,
      sellPrice: 2000,
      totalBuyValue: 0,
      totalSellValue: 2000,
      pnlCalculated: 2000,
      isMatched: false,
      isOption: false,
      hasOptionCode: false,
      openQty: -40000,
      tradeCount: 1,
      buyYears: [],
      tradeYears: [2026],
    },
  ];

  const spots = new Map([["ABE", { price: 0.2, source: "yahoo" as const }]]);
  const asOf = new Date("2026-08-06T00:00:00Z");

  const mine = mergePlacementTrackerIntoSummary(row(), placement, "Mr Akshit Verma").summary;
  assert.equal(mine[0].buyQty, 40000, "filled from the client's own row");
  assert.deepEqual(mine[0].placementAddOns, [], "and that row grants nothing");
  assert.equal(buildUnlistedOptionRows(mine, placement, spots, asOf).addedCount, 0);
  assert.deepEqual(collectUnlistedOptionTickers(mine, placement), []);

  // The client who IS in the granting row still gets their options.
  const theirs = mergePlacementTrackerIntoSummary(row(), placement, "Saturn Fund").summary;
  assert.equal(theirs[0].placementAddOns?.length, 1);
  const built = buildUnlistedOptionRows(theirs, placement, spots, asOf);
  assert.equal(built.addedCount, 1);
  assert.equal(built.summary.find((s) => s.isUnlistedOption)?.sellQty, 50000);
});

test("PNL Calculator - two placements in one period: name, buy qty and sell qty decide", async () => {
  // SKK placed twice inside the same reporting window, the client in both sheets, so
  // no date can separate them. The ledger does: whichever parcel reconciles with its
  // buy and sell quantities is the one this row is about.
  const skk = (label: string, shares: number, dollars: number, client: string) => ({
    sheetName: label,
    issueYear: 2026,
    issueDate: label === "SKK (a)" ? "2026-02-10" : "2026-05-18",
    totalShares: shares,
    totalActualDollar: dollars,
    clientAllocations: [
      { clientName: client, advisor: "VTC", askingBid: 0, allocationDollar: dollars, roundShares: shares, actualDollar: dollars },
    ],
  });

  const placement = new Map<string, PlacementTickerInfo>([
    [
      "SKK",
      {
        ticker: "SKK",
        issueYear: 2026,
        totalShares: 30000,
        totalActualDollar: 3000,
        clientAllocations: skk("SKK (a)", 30000, 3000, "Mr Akshit Verma").clientAllocations,
        candidates: [
          skk("SKK (a)", 30000, 3000, "Mr Akshit Verma"),
          skk("SKK (b)", 70000, 8000, "Mr Akshit Verma"),
        ],
      },
    ],
  ]);

  const row = (buyQty: number, buyPrice: number, sellQty: number): PnlSummaryItem[] => [
    {
      ticker: "SKK",
      parentTicker: "SKK",
      instrument: "EQUITY",
      company: "STIKA",
      buyQty,
      sellQty,
      buyPrice,
      sellPrice: 20000,
      totalBuyValue: buyPrice,
      totalSellValue: 20000,
      pnlCalculated: 20000 - buyPrice,
      isMatched: false,
      isOption: false,
      hasOptionCode: false,
      openQty: buyQty - sellQty,
      tradeCount: 2,
      buyYears: buyQty > 0 ? [2026] : [],
      tradeYears: [2026],
    },
  ];

  // Nothing bought per the ledger, 70,000 sold — that is the (b) parcel exactly.
  const onlyB = mergePlacementTrackerIntoSummary(row(0, 0, 70000), placement, "Mr Akshit Verma")
    .summary[0];
  assert.equal(onlyB.buyQty, 70000);
  assert.equal(onlyB.buyPrice, 8000);

  // 100,000 sold and nothing bought: both parcels together, which is the case the
  // matching must not narrow away.
  const both = mergePlacementTrackerIntoSummary(row(0, 0, 100000), placement, "Mr Akshit Verma")
    .summary[0];
  assert.equal(both.buyQty, 100000);
  assert.equal(both.buyPrice, 11000);

  // (a) already came through as a contract note: 30,000 bought, 100,000 sold. Only the
  // 70,000 shortfall is missing, so adding both would count (a) twice.
  const topUp = mergePlacementTrackerIntoSummary(row(30000, 3000, 100000), placement, "Mr Akshit Verma")
    .summary[0];
  assert.equal(topUp.buyQty, 100000);
  assert.equal(topUp.buyPrice, 11000);
  assert.equal(topUp.isPartialBuy, true);

  // A name matching NEITHER sheet falls back to the long-standing sole-participant
  // rule — each sheet lists exactly one client, so there is no one else the parcel
  // could belong to — and the quantities then pick between them exactly as above.
  const unmatchedName = mergePlacementTrackerIntoSummary(row(0, 0, 70000), placement, "Saturn Fund")
    .summary[0];
  assert.equal(unmatchedName.buyQty, 70000);

  // But a sheet with SEVERAL participants and no name match is never filled from:
  // that would sum strangers' allocations into this row.
  const shared = new Map(placement);
  shared.set("SKK", {
    ...placement.get("SKK")!,
    candidates: placement.get("SKK")!.candidates!.map((c) => ({
      ...c,
      clientAllocations: [
        ...c.clientAllocations,
        { clientName: "Zidiplus Pty Ltd", advisor: "VTC", askingBid: 0, allocationDollar: 1, roundShares: 1, actualDollar: 1 },
      ],
    })),
  });

  const ambiguous = mergePlacementTrackerIntoSummary(row(0, 0, 70000), shared, "Saturn Fund");
  assert.equal(ambiguous.summary[0].buyQty, 0);
  assert.deepEqual(ambiguous.ambiguousTickers, ["SKK"]);
});

test("PNL Calculator - only rows a placement could have filled are reported unfilled", () => {
  // Three stocks, the same story in the sheet each time: several participants and
  // none of them this client. What differs is the LEDGER.
  //
  //   GRV — bought and sold on-market, both sides recorded. A placement would have
  //         changed nothing, so naming it is a false alarm. This is the bug: one
  //         real account reported 24 such tickers and the genuine gaps were lost
  //         among them.
  //   ABE — sold with no recorded buy: a parcel really is missing.
  //   CCM — sold more than the ledger saw bought: short buy side, also missing.
  const strangers = [
    { clientName: "Zidiplus Pty Ltd", advisor: "VTC", askingBid: 0, allocationDollar: 5000, roundShares: 10000, actualDollar: 5000 },
    { clientName: "Ikigai Consortium Pty Ltd", advisor: "VTC", askingBid: 0, allocationDollar: 5000, roundShares: 10000, actualDollar: 5000 },
  ];
  const sheet = (ticker: string): PlacementTickerInfo => ({
    ticker,
    totalShares: 20000,
    totalActualDollar: 10000,
    clientAllocations: strangers,
  });
  const placements = new Map<string, PlacementTickerInfo>([
    ["GRV", sheet("GRV")],
    ["ABE", sheet("ABE")],
    ["CCM", sheet("CCM")],
  ]);

  const row = (
    ticker: string,
    buyQty: number,
    buyPrice: number,
    sellQty: number
  ): PnlSummaryItem => ({
    ticker,
    parentTicker: ticker,
    instrument: "EQUITY",
    company: ticker,
    buyQty,
    sellQty,
    buyPrice,
    sellPrice: 9000,
    totalBuyValue: buyPrice,
    totalSellValue: 9000,
    pnlCalculated: 9000 - buyPrice,
    isMatched: buyQty === sellQty && buyQty > 0,
    isOption: false,
    hasOptionCode: false,
    openQty: buyQty - sellQty,
    tradeCount: 2,
    buyYears: buyQty > 0 ? [2026] : [],
    tradeYears: [2026],
  });

  const merged = mergePlacementTrackerIntoSummary(
    [row("GRV", 5000, 2500, 5000), row("ABE", 0, 0, 10000), row("CCM", 3000, 1500, 10000)],
    placements,
    "Psg Capital Investments Pty Ltd"
  );

  assert.deepEqual(merged.ambiguousTickers, ["ABE", "CCM"]);

  // What changed is the REPORT, not the figures: an unidentified client still
  // fills nothing, on every row.
  assert.equal(merged.mergedCount, 0);
  assert.equal(merged.summary.find((s) => s.ticker === "GRV")?.buyQty, 5000);
  assert.equal(merged.summary.find((s) => s.ticker === "ABE")?.buyQty, 0);
  assert.equal(merged.summary.find((s) => s.ticker === "CCM")?.buyQty, 3000);
});

test("parsePnlFileBuffer - a real .xlsx date cell survives as a readable date", async () => {
  // The bug: an .xlsx Contract Date is a real `Date`, and stringifying it produced
  // "Sun Jun 21 2026 10:00:00 GMT+0530 (India Standard Time)". Nothing could read that
  // back, so a 36-trade ledger reported 36 trades with "no readable Contract Date" and
  // every reporting period came out empty while the lifetime view looked fine.
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["CNote", "Account", "Type", "Security", "Company", "Contract Date", "Units", "Avg Price", "Value", "Status"]);
  ws.addRow([2506814, 1102282, "BUY", "NHU", "NEUHORIZON", new Date(Date.UTC(2026, 5, 22)), 21111, 0.2, 4222.2, "SETTLED"]);
  ws.addRow([2306398, 1102282, "SELL", "WWI", "WEST WITS", new Date(Date.UTC(2026, 1, 4)), 49020, 0.0828, 3946.41, "SETTLED"]);
  ws.addRow([2242792, 1102282, "SELL", "GED", "GOLDEN DEEPS", new Date(Date.UTC(2025, 11, 17)), 37500, 0.06, 2140, "SETTLED"]);

  const res = await parsePnlFileBuffer(
    Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer),
    "Book3.xlsx"
  );

  assert.equal(res.rawTrades.length, 3);
  assert.deepEqual(
    res.rawTrades.map((t) => t.contractDate),
    ["2026-06-22", "2026-02-04", "2025-12-17"],
    "date cells become ISO, not a locale string"
  );

  // Which is the whole point: the reporting period can now place them.
  const fy = filterTradesByDateRange(res.rawTrades, { from: "2025-07-01", to: "2026-06-30" });
  assert.equal(fy.trades.length, 3);
  assert.equal(fy.undated, 0, "not one of them is 'undated' any more");

  const feb = filterTradesByDateRange(res.rawTrades, { from: "2026-02-01", to: "2026-02-28" });
  assert.deepEqual(feb.trades.map((t) => t.ticker), ["WWI"]);
});

test("Reporting period - a grant from a year outside the window cannot leak in", async () => {
  // SKK is in BOTH trackers: the 2025 placement grants nothing, the 2026 one grants
  // 1:3 unlisted options. A period of 1 Jul → 31 Oct 2025 was still showing the option,
  // because the merge (which runs on the full map, since allocations must not be date
  // filtered) had stamped the 2026 grant onto the row and the option builder trusted
  // that stamp over the date-filtered map.
  const y2025 = placementFile("SKK", "Mr Akshit Verma", 44780, 4000, 2025);
  y2025.map.get("SKK")!.issueDate = "2025-09-19";
  const y2026 = placementFile("SKK", "Mr Akshit Verma", 44780, 4000, 2026);
  y2026.map.get("SKK")!.issueDate = "2026-02-11";
  y2026.map.get("SKK")!.addOns = parseAddOnSpecs("1:3 @$0.10 Unlisted Exp 31/12/29");

  const full = combinePlacementMaps([y2025, y2026]);

  const rowTradedIn = (year: number): PnlSummaryItem[] => [
    {
      ticker: "SKK",
      parentTicker: "SKK",
      instrument: "EQUITY",
      company: "STAKK LIMITED",
      buyQty: 44780,
      sellQty: 0,
      buyPrice: 4000,
      sellPrice: 0,
      totalBuyValue: 4000,
      totalSellValue: 0,
      pnlCalculated: -4000,
      isMatched: false,
      isOption: false,
      hasOptionCode: false,
      openQty: 44780,
      tradeCount: 1,
      buyYears: [year],
      tradeYears: [year],
    },
  ];

  const spots = new Map([["SKK", { price: 0.2, source: "yahoo" as const }]]);
  const asOf = new Date("2026-08-06T00:00:00Z");
  const julToOct2025 = { from: "2025-07-01", to: "2025-10-31" };

  // The merge sees every placement — allocations must not be date filtered — so a row
  // whose trades are dated 2026 gets stamped with the 2026 placement's grant.
  const stamped2026 = mergePlacementTrackerIntoSummary(rowTradedIn(2026), full, "Mr Akshit Verma").summary;
  assert.equal(stamped2026[0].placementAddOns?.length, 1, "the row carries the 2026 grant");

  // THE LEAK: that stamp used to outrank the period's own placement list.
  const windowed = filterPlacementsByDateRange(full, julToOct2025);
  assert.equal(windowed.get("SKK")?.candidates, undefined, "only the 2025 placement is in range");
  assert.equal(windowed.get("SKK")?.addOns, undefined, "and it grants nothing");

  assert.equal(
    buildUnlistedOptionRows(stamped2026, windowed, spots, asOf).addedCount,
    0,
    "the 2026 grant must not reach a period ending in Oct 2025"
  );
  assert.deepEqual(collectUnlistedOptionTickers(stamped2026, windowed), []);

  // Lifetime, and a window that does contain the 2026 placement, still grant it.
  assert.equal(buildUnlistedOptionRows(stamped2026, full, spots, asOf).addedCount, 1);
  const h1of2026 = filterPlacementsByDateRange(full, { from: "2026-01-01", to: "2026-06-30" });
  assert.equal(buildUnlistedOptionRows(stamped2026, h1of2026, spots, asOf).addedCount, 1);

  // And a client whose parcel came from the 2025 placement earns nothing even lifetime,
  // because that placement is the one they were in and it granted nothing.
  const stamped2025 = mergePlacementTrackerIntoSummary(rowTradedIn(2025), full, "Mr Akshit Verma").summary;
  assert.deepEqual(stamped2025[0].placementAddOns, []);
  assert.equal(buildUnlistedOptionRows(stamped2025, full, spots, asOf).addedCount, 0);
});

test("filterPlacementsByDateRange - a period's options are its own placements'", async () => {
  // SKK issued 3 July cannot have granted anything to a period ending 30 June — the
  // grant did not exist yet — but it was still producing an unlisted option row.
  const placement = combinePlacementMaps([
    placementFile("SKK", "Mr Akshit Verma", 40000, 8000, 2026),
    placementFile("GRV", "Mr Akshit Verma", 10000, 2500, 2026),
    placementFile("ABE", "Mr Akshit Verma", 5000, 1000, 2025),
  ]);
  placement.get("SKK")!.issueDate = "2026-07-03";
  placement.get("GRV")!.issueDate = "2026-02-04";
  // ABE carries no usable date cell — only the year its Overview sheet is named for.
  placement.get("ABE")!.issueDate = undefined;

  const fy = filterPlacementsByDateRange(placement, { from: "2025-07-01", to: "2026-06-30" });
  assert.equal(fy.get("SKK"), undefined, "issued after the period ends");
  assert.equal(fy.get("GRV")?.totalShares, 10000, "issued inside it");
  assert.equal(fy.get("ABE")?.totalShares, 5000, "a year that overlaps cannot be ruled out");

  // Inclusive at both ends.
  assert.ok(filterPlacementsByDateRange(placement, { from: "2026-02-04", to: "2026-02-04" }).get("GRV"));
  assert.ok(filterPlacementsByDateRange(placement, { from: "2026-07-03", to: "2026-07-31" }).get("SKK"));

  // The cost of the desk's rule, stated so it is not mistaken for a bug: a placement
  // settles before its shares are traded, so a February-only window earns nothing from
  // a placement dated 4 Feb… but one dated 28 Jan is out. Widen `from` to include it.
  placement.get("GRV")!.issueDate = "2026-01-28";
  assert.equal(
    filterPlacementsByDateRange(placement, { from: "2026-02-01", to: "2026-02-28" }).get("GRV"),
    undefined
  );
  assert.ok(
    filterPlacementsByDateRange(placement, { from: "2026-01-01", to: "2026-02-28" }).get("GRV")
  );

  // No window at all leaves the map untouched — the lifetime view.
  assert.equal(filterPlacementsByDateRange(placement, {}), placement);
});

test("filterTradesByDateRange - an OPTIONAL window, inclusive at both ends", async () => {
  const trade = (contractDate: string) => ({
    ticker: "ABE",
    company: "ABERDEEN",
    type: "BUY" as const,
    units: 1000,
    avgPrice: 0.2,
    value: 200,
    contractDate,
  });

  // Day-first from the ledger, ISO from the date inputs — both must land on the day.
  const trades = [trade("31-12-2025"), trade("01-01-2026"), trade("2026-06-30"), trade("01-07-2026")];

  // No window at all is the lifetime view, which is the default and must stay free.
  assert.equal(filterTradesByDateRange(trades, {}).trades.length, 4);
  assert.equal(filterTradesByDateRange(trades, null).trades.length, 4);
  assert.equal(hasDateRange({}), false);
  assert.equal(hasDateRange({ from: "2026-01-01" }), true);

  const window = filterTradesByDateRange(trades, { from: "2026-01-01", to: "2026-06-30" });
  assert.deepEqual(window.trades.map((t) => t.contractDate), ["01-01-2026", "2026-06-30"]);
  assert.equal(window.excluded, 2);

  // One end open bounds only that side.
  assert.equal(filterTradesByDateRange(trades, { from: "2026-01-01" }).trades.length, 3);
  assert.equal(filterTradesByDateRange(trades, { to: "2025-12-31" }).trades.length, 1);

  // A trade whose date cannot be read cannot be placed in a period. It is dropped and
  // COUNTED — silently keeping it would put outside money in the period's P&L, and
  // silently dropping it would look like the file simply had less in it.
  const undated = filterTradesByDateRange([...trades, trade("")], { from: "2026-01-01" });
  assert.equal(undated.undated, 1);
  assert.equal(undated.trades.length, 3);
});

test("Reporting period - options follow the TRADES, not the placement's own date", async () => {
  // The bug: placements were filtered by their settlement date on top of the trades.
  // A placement settles days before its shares are traded, so a window holding the
  // trade missed the placement and the options vanished from a period that had them.
  //
  // GRV placed (and settled) 28 Jan 2026 with 1:2 unlisted options attached; the
  // client's buy is dated 4 Feb 2026. A February window must still show the options.
  const placement = new Map<string, PlacementTickerInfo>([
    [
      "GRV",
      {
        ticker: "GRV",
        issueYear: 2026,
        issueDate: "2026-01-28",
        totalShares: 40000,
        totalActualDollar: 4000,
        clientAllocations: [],
        addOns: parseAddOnSpecs("1:2 @$0.10 Unlisted Exp 31/12/29"),
      },
    ],
  ]);

  const febTrades = [
    { ticker: "GRV", company: "GRV LTD", type: "BUY" as const, units: 40000, avgPrice: 0.1, value: 4000, contractDate: "04-02-2026" },
    { ticker: "GRV", company: "GRV LTD", type: "SELL" as const, units: 40000, avgPrice: 0.12, value: 4800, contractDate: "20-02-2026" },
  ];

  const feb = { from: "2026-02-01", to: "2026-02-28" };
  const inWindow = filterTradesByDateRange(febTrades, feb);
  assert.equal(inWindow.trades.length, 2, "both trades are inside the window");

  const { summary } = aggregateTradesToSummary(inWindow.trades);
  const built = buildUnlistedOptionRows(
    summary,
    placement,
    new Map([["GRV", { price: 0.2, source: "yahoo" as const }]]),
    new Date("2026-08-06T00:00:00Z")
  );

  assert.equal(built.addedCount, 1, "the January placement still grants February's options");
  assert.equal(built.summary.find((s) => s.isUnlistedOption)?.sellQty, 20000);

  // And a window the trades fall OUTSIDE earns nothing, because the entitlement runs
  // off a Buy Qty aggregated from in-window trades only.
  const march = filterTradesByDateRange(febTrades, { from: "2026-03-01", to: "2026-03-31" });
  assert.equal(march.trades.length, 0);
  const nothing = buildUnlistedOptionRows(
    aggregateTradesToSummary(march.trades).summary,
    placement,
    new Map([["GRV", { price: 0.2, source: "yahoo" as const }]]),
    new Date("2026-08-06T00:00:00Z")
  );
  assert.equal(nothing.addedCount, 0);
});

test("mergeDbHoldingsIntoSummary - a period does not import holdings the ledger never traded", async () => {
  // The bug: PLS showed up inside a reporting period whose ledger has no PLS trade at
  // all. The row came from the holdings snapshot, which is "as of today" and carries
  // no date to test against a window.
  const summary = aggregateTradesToSummary([
    { ticker: "GRV", company: "GRV LTD", type: "BUY", units: 1000, avgPrice: 0.1, value: 100, contractDate: "04-02-2026" },
  ]).summary;

  const holdings = [
    { ticker: "PLS", parentTicker: "PLS", companyName: "PILBARA MIN", qty: 5000, marketValue: 12000, costBase: 9000 },
  ];

  // Lifetime view: the orphan row is exactly what recovers a position the ledger
  // never mentioned, so it is still created.
  const lifetime = mergeDbHoldingsIntoSummary(summary, holdings);
  assert.equal(lifetime.createdCount, 1);
  assert.ok(lifetime.summary.some((s) => s.ticker === "PLS"));

  // With a period set, it must not appear — the period's trades never touched PLS.
  const windowed = mergeDbHoldingsIntoSummary(summary, holdings, {
    createMissingRowsFor: new Set(["GRV"]),
  });
  assert.equal(windowed.createdCount, 0);
  assert.equal(windowed.summary.some((s) => s.ticker === "PLS"), false);

  // Rows that DO come from in-window trades are still valued off the snapshot.
  const open = aggregateTradesToSummary([
    { ticker: "GRV", company: "GRV LTD", type: "BUY", units: 1000, avgPrice: 0.1, value: 100, contractDate: "04-02-2026" },
  ]).summary;
  const valued = mergeDbHoldingsIntoSummary(
    open,
    [{ ticker: "GRV", parentTicker: "GRV", qty: 1000, marketValue: 150, costBase: 100 }],
    { createMissingRowsFor: new Set(["GRV"]) }
  );
  assert.equal(valued.mergedCount, 1);
  assert.equal(valued.summary.find((s) => s.ticker === "GRV")?.sellPrice, 150);
});

test("mergeDbHoldingsIntoSummary - a period keeps the options its own trades vouch for", async () => {
  // The regression the anchor set fixes: GEDO and LITOC exist ONLY in the holdings
  // snapshot — free attaching options are never bought, so no contract note creates a
  // row — and refusing every snapshot-only row deleted them from every windowed view.
  const trades = [
    { ticker: "GED", company: "GENESIS", type: "BUY" as const, units: 10000, avgPrice: 0.2, value: 2000, contractDate: "04-02-2026" },
    { ticker: "LIT", company: "LITHIUM", type: "BUY" as const, units: 5000, avgPrice: 0.5, value: 2500, contractDate: "20-01-2026" },
  ];
  const holdings = [
    // Free attaching options: cost base 0, no trade of their own anywhere.
    { ticker: "GEDO", parentTicker: "GED", companyName: "GENESIS OPT", qty: 5000, marketValue: 400, costBase: 0 },
    { ticker: "LITOC", parentTicker: "LIT", companyName: "LITHIUM OPT", qty: 2500, marketValue: 300, costBase: 0 },
    // Held today, but the period's ledger never touched PLS.
    { ticker: "PLS", parentTicker: "PLS", companyName: "PILBARA MIN", qty: 5000, marketValue: 12000, costBase: 9000 },
  ];

  // A window holding both parent trades: their options come back, PLS stays out.
  const january = filterTradesByDateRange(trades, { from: "2026-01-01", to: "2026-02-28" });
  const both = mergeDbHoldingsIntoSummary(
    aggregateTradesToSummary(january.trades).summary,
    holdings,
    { createMissingRowsFor: tradedParentTickers(january.trades) }
  );
  assert.equal(both.createdCount, 2);
  assert.ok(both.summary.some((s) => s.ticker === "GEDO"));
  assert.ok(both.summary.some((s) => s.ticker === "LITOC"));
  assert.equal(both.summary.some((s) => s.ticker === "PLS"), false);

  // The whole option value is gain — nothing was ever paid for it.
  assert.equal(both.summary.find((s) => s.ticker === "GEDO")?.pnlCalculated, 400);

  // Narrow the window to February: LIT was not traded in it, so LITOC has nothing in
  // the period vouching for it and drops out while GEDO stays.
  const february = filterTradesByDateRange(trades, { from: "2026-02-01", to: "2026-02-28" });
  const feb = mergeDbHoldingsIntoSummary(
    aggregateTradesToSummary(february.trades).summary,
    holdings,
    { createMissingRowsFor: tradedParentTickers(february.trades) }
  );
  assert.ok(feb.summary.some((s) => s.ticker === "GEDO"));
  assert.equal(feb.summary.some((s) => s.ticker === "LITOC"), false);

  // Lifetime view is unchanged — every snapshot-only position is still recovered.
  const lifetime = mergeDbHoldingsIntoSummary(aggregateTradesToSummary(trades).summary, holdings);
  assert.equal(lifetime.createdCount, 3);
});

test("buildPnlExportFilename - a period-scoped export says so in its name", async () => {
  const base = { accounts: ["114716"], accountHolders: {}, isoDate: "2026-08-05" };

  assert.equal(
    buildPnlExportFilename({ ...base, extension: "xlsx" }),
    "pnl-114716-2026-08-05.xlsx",
    "no period keeps today's stamp"
  );

  // Stamped with today's date alone, a six-month P&L is indistinguishable from a
  // lifetime one — and that difference is the whole figure.
  assert.equal(
    buildPnlExportFilename({
      ...base,
      extension: "xlsx",
      range: { from: "2026-01-01", to: "2026-06-30" },
    }),
    "pnl-114716-2026-01-01_to_2026-06-30.xlsx"
  );

  // An open end is named, not left blank.
  assert.equal(
    buildPnlExportFilename({ ...base, extension: "csv", range: { from: "2026-01-01" } }),
    "pnl-114716-2026-01-01_to_2026-08-05.csv"
  );
});

test("aggregateTradesToSummary - Contract Date years are carried onto the row", async () => {
  const trade = (type: "BUY" | "SELL", value: number, contractDate: string) => ({
    ticker: "ABE",
    company: "ABERDEEN",
    type,
    units: 1000,
    avgPrice: value / 1000,
    value,
    contractDate,
  });

  const { summary } = aggregateTradesToSummary([
    trade("BUY", 200, "03-03-2025"),
    trade("SELL", 300, "2026-01-20"),
    // An undated row must not invent a year.
    trade("SELL", 0, ""),
  ]);

  const abe = summary.find((s) => s.ticker === "ABE")!;
  assert.deepEqual(abe.buyYears, [2025], "day-first 03-03-2025");
  assert.deepEqual(abe.tradeYears, [2025, 2026], "sorted, unique, both legs");
});

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

test("buildUnlistedOptionRows - entitlement, in-the-money price and P&L", async () => {
  const asOf = new Date("2026-08-04T00:00:00Z");
  // 0.20 against a 0.14 strike — in the money, so this exercises the intrinsic
  // branch rather than the model.
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
  // Free options: buyQty is equal to sellQty (3,333), buyPrice is 0.
  assert.equal(row.buyQty, 3333);
  assert.equal(row.buyPrice, 0);
  assert.equal(row.totalBuyValue, 0);

  // Written as a literal rather than recomputed from the implementation, so the
  // test states the rule instead of mirroring it: (0.20 - 0.14) × 3,333.
  assert.equal(row.unlistedOption!.pricingMethod, "intrinsic");
  assert.equal(row.sellPrice, 199.98);
  assert.equal(row.totalSellValue, 199.98);
  assert.equal(row.pnlCalculated, 199.98);

  // And it is deliberately BELOW the model, which for a call is intrinsic value
  // plus time value. That gap is the whole reason the rule exists: an unlisted
  // option has no market in which the time value could be realised.
  const modelPer = blackScholesCall({
    spot,
    strike: 0.14,
    timeToExpiryYears: row.unlistedOption!.timeToExpiryYears,
    ...UNLISTED_OPTION_ASSUMPTIONS,
  });
  assert.ok(
    Math.round(modelPer * 3333 * 100) / 100 > 199.98,
    "Black-Scholes should carry time value on top of intrinsic",
  );

  // The valuation inputs are retained for audit — including the assumptions that
  // did NOT set this price, so the model figure stays reconstructable.
  const v = row.unlistedOption!;
  assert.equal(v.spot, spot);
  assert.equal(v.spotSource, "yahoo");
  assert.equal(v.sharesHeld, 10000);
  assert.equal(v.volatility, 0.5);
  assert.equal(v.riskFreeRate, 0.05);
  assert.equal(v.dividendYield, 0);
  assert.equal(v.addOn.strike, 0.14);
});

test("buildUnlistedOptionRows - out of the money still prices off Black-Scholes", async () => {
  // Below the 0.14 strike: exercising is worthless, so there is no intrinsic
  // value to fall back on and the model is the only defensible answer. The row
  // must NOT collapse to zero — a grant 1.4 years out still has real value.
  const asOf = new Date("2026-08-04T00:00:00Z");
  const spot = 0.1;
  const spots = new Map([["GRV", { price: spot, source: "yahoo" as const }]]);

  const built = buildUnlistedOptionRows(grvEquityRow(10000), unlistedPlacementMap(), spots, asOf);
  const row = built.summary.find((s) => s.isUnlistedOption);
  assert.ok(row);

  assert.equal(row.unlistedOption!.pricingMethod, "black-scholes");

  const expectedPer = blackScholesCall({
    spot,
    strike: 0.14,
    timeToExpiryYears: row.unlistedOption!.timeToExpiryYears,
    ...UNLISTED_OPTION_ASSUMPTIONS,
  });
  assert.equal(row.pnlCalculated, Math.round(expectedPer * 3333 * 100) / 100);
  assert.ok(row.pnlCalculated > 0, "an OTM option 1.4 years out is not worthless");
});

test("buildUnlistedOptionRows - spot exactly AT the strike is not intrinsic", async () => {
  // The rule is `spot > strike`, strictly. At the money there is nothing to gain
  // by exercising, so intrinsic would be exactly $0 and would wipe out a grant
  // that still has 1.4 years to run.
  const asOf = new Date("2026-08-04T00:00:00Z");
  const spots = new Map([["GRV", { price: 0.14, source: "yahoo" as const }]]);

  const built = buildUnlistedOptionRows(grvEquityRow(10000), unlistedPlacementMap(), spots, asOf);
  const row = built.summary.find((s) => s.isUnlistedOption);

  assert.equal(row!.unlistedOption!.pricingMethod, "black-scholes");
  assert.ok(row!.pnlCalculated > 0);
});

test("buildUnlistedOptionRows - a zero strike never takes the intrinsic branch", async () => {
  // A missing strike is a tracker data error. `spot - 0` would report the entire
  // share price as option value, which is how a typo becomes a five-figure gain;
  // Black-Scholes already refuses a non-positive strike, and that refusal stands.
  const asOf = new Date("2026-08-04T00:00:00Z");
  const spots = new Map([["GRV", { price: 0.2, source: "yahoo" as const }]]);

  const built = buildUnlistedOptionRows(
    grvEquityRow(10000),
    unlistedPlacementMap({ strike: 0 }),
    spots,
    asOf,
  );
  const row = built.summary.find((s) => s.isUnlistedOption);

  assert.equal(row!.unlistedOption!.pricingMethod, "black-scholes");
  assert.equal(row!.pnlCalculated, 0);
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

test("parseAddOnSpec - a cell with no expiry is dated 2 years off settlement", async () => {
  // Most of the 2025 Options column looks exactly like this. Rejecting it (the old
  // behaviour) reported a real entitlement as nothing at all.
  const settlement = new Date(Date.UTC(2025, 2, 3)); // 3 Mar 2025

  const spec = parseAddOnSpec("1:2@0.1 Unlisted", 1, settlement);
  assert.ok(spec, "a grant with no expiry must still parse when settlement is known");
  assert.equal(spec.strike, 0.1);
  assert.equal(spec.listed, false);
  assert.equal(spec.expiry, "2027-03-03");
  assert.equal(spec.expiryAssumed, true);
  assert.equal(ASSUMED_UNLISTED_OPTION_TERM_YEARS, 2);

  // A stated expiry always wins and is never flagged.
  const stated = parseAddOnSpec("1:2@0.03 UnlistedExp 31/12/27", 1, settlement);
  assert.equal(stated?.expiry, "2027-12-31");
  assert.equal(stated?.expiryAssumed, undefined);

  // No settlement date to count from -> nothing to derive, so no grant.
  assert.equal(parseAddOnSpec("1:2@0.1 Unlisted"), null);

  // An expiry that WAS typed but is not a real date is a data error, not a blank:
  // silently substituting the assumed term would bury it.
  assert.equal(parseAddOnSpec("1:2@0.1 Unlisted Exp 31/02/27", 1, settlement), null);
});

test("parseAddOnSpec - 'Unisted' is a typo for unlisted, not a listed grant", async () => {
  // Verbatim from the 2025 column. Reading it as LISTED dropped the grant entirely,
  // because listed add-ons are filtered out downstream.
  const settlement = new Date(Date.UTC(2025, 0, 20));

  for (const text of ["1:2@0.008 Unisted", "1:2@0.008 Unlisted", "1:2@0.008 un-listed"]) {
    assert.equal(parseAddOnSpec(text, 1, settlement)?.listed, false, text);
  }

  // A genuinely listed grant is still listed.
  assert.equal(parseAddOnSpec("1:2@0.1 Listed", 1, settlement)?.listed, true);
});

test("parsePlacementTrackerBuffer - settlement dates drive the assumed expiries", async () => {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();

  // "Settlement Date" outranks "Date Issued" on a sheet carrying both.
  const ov = wb.addWorksheet("2025 Overview");
  ov.addRow(["Counter", "Date Issued", "Settlement Date", "Options"]);
  ov.addRow(["ABE", "1 Jan 2025", "3/03/2025", "1:2@0.1 Unlisted"]);
  ov.addRow(["GRV", "1 Jan 2025", "3 Mar 2025", "1:2@0.1 Unlisted"]);
  // No settlement date at all: nothing to count from, so no grant is invented.
  ov.addRow(["ZEU", "1 Jan 2025", "", "1:2@0.1 Unlisted"]);

  const map = await parsePlacementTrackerBuffer(
    Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer)
  );

  // Day-first "3/03/2025" and the written "3 Mar 2025" must land on the same day.
  assert.equal(map.get("ABE")?.addOns?.[0].expiry, "2027-03-03");
  assert.equal(map.get("ABE")?.addOns?.[0].expiryAssumed, true);
  assert.equal(map.get("GRV")?.addOns?.[0].expiry, "2027-03-03");
  assert.equal(map.get("ZEU"), undefined);
});

test("buildUnlistedOptionRows - an assumed expiry is labelled in the row itself", async () => {
  const settlement = new Date(Date.UTC(2025, 2, 3));
  const placement = new Map<string, PlacementTickerInfo>([
    [
      "GRV",
      {
        ticker: "GRV",
        totalShares: 0,
        totalActualDollar: 0,
        clientAllocations: [],
        addOns: parseAddOnSpecs("1:2@0.1 Unlisted", settlement),
      },
    ],
  ]);

  const { summary } = buildUnlistedOptionRows(
    grvEquityRow(10000),
    placement,
    new Map([["GRV", { price: 0.2, source: "yahoo" as const }]]),
    new Date("2026-08-06T00:00:00Z")
  );

  const row = summary.find((s) => s.isUnlistedOption)!;
  assert.equal(row.sellQty, 5000);
  assert.ok(row.company.includes("(assumed)"), row.company);
  assert.equal(row.unlistedOption?.addOn.expiryAssumed, true);
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

test("xlsx export - P&L is green above zero and red below, total included", async () => {
  const row = (ticker: string, pnl: number, isMatched: boolean): PnlSummaryItem => ({
    ticker,
    parentTicker: ticker,
    instrument: "EQUITY",
    company: `${ticker} LTD`,
    buyQty: 1000,
    sellQty: isMatched ? 1000 : 400,
    buyPrice: 1000,
    sellPrice: 1000 + pnl,
    totalBuyValue: 1000,
    totalSellValue: 1000 + pnl,
    pnlCalculated: pnl,
    isMatched,
    isOption: false,
    hasOptionCode: false,
    openQty: isMatched ? 0 : 600,
    tradeCount: 2,
  });

  // A LOSS overall, so the Grand Total must be red too.
  const summary = [row("AAA", 500, true), row("BBB", -900, false), row("CCC", 0, true)];

  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load((await buildPnlExportXlsxBuffer(summary)) as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const ws = wb.worksheets[0];

  const GREEN = "FF166534";
  const RED = "FF991B1B";
  const pnlCol = 9;
  const colourOf = (rowNo: number) => ws.getRow(rowNo).getCell(pnlCol).font?.color?.argb;

  // Rows are sorted by ticker: 2 = AAA, 3 = BBB, 4 = CCC, 5 = Grand Total.
  assert.equal(ws.getRow(2).getCell(pnlCol).value, 500);
  assert.equal(colourOf(2), GREEN, "a gain is green");
  assert.equal(colourOf(3), RED, "a loss is red — even though the row is unmatched");
  assert.notEqual(colourOf(4), GREEN, "zero is neither");
  assert.notEqual(colourOf(4), RED);

  const total = ws.getRow(5);
  assert.equal(total.getCell(1).value, "Grand Total");
  assert.equal(total.getCell(pnlCol).value, -400);
  assert.equal(colourOf(5), RED, "the total follows the same rule");
  assert.equal(total.getCell(pnlCol).font?.bold, true, "and stays bold");

  // A loss reads -$900.00, not the accounting brackets the other money columns use.
  const fmt = String(ws.getRow(3).getCell(pnlCol).numFmt);
  assert.ok(fmt.includes("-$#,##0.00"), fmt);
  assert.equal(fmt.includes("("), false, fmt);
});

test("Exports carry no Open Qty column, and a granted option leaks no negative", async () => {
  const built = buildUnlistedOptionRows(
    grvEquityRow(10000),
    unlistedPlacementMap(),
    new Map([["GRV", { price: 0.2, source: "yahoo" as const }]]),
    new Date("2026-08-04T00:00:00Z")
  );

  // The field itself records openQty (0 for matched option legs)
  const uo = built.summary.find((s) => s.isUnlistedOption);
  assert.equal(uo?.openQty, 0);

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
