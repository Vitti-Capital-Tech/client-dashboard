import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parsePnlFileBuffer,
  buildPnlExportCsvString,
  buildPnlExportXlsxBuffer,
  mergePlacementTrackerIntoSummary,
  mergeDbHoldingsIntoSummary,
  collectPlacementClientNames,
} from "./pnl-calculator.ts";

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
      "Ticker,Company,Instrument,Underlying,Buy Qty (Sum),Sell Qty (Sum),Buy Price,Sell Price,PnL Calculated,Status,Open Qty"
    )
  );
  assert.ok(csv.includes("EOS,ELECTRO C FPO,Equity,EOS,407,407,3256.00,3300.77,44.77,Matched,0"));
  assert.ok(csv.includes("Grand Total"));
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

  assert.ok(csv.includes("GEDO,GOLDEN DEEPS OPTION,Option,GED,5000,5000,100.00,50.00,-50.00,Matched,0"));
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
  assert.equal(abc?.comment, undefined); // not a partial exit
  assert.equal(abc?.isPartialExit, undefined);

  const xyz = merged.summary.find((s) => s.ticker === "XYZ");
  assert.equal(xyz?.sellQty, 400); // untouched
  assert.equal(xyz?.sellPrice, 350);
  assert.equal(xyz?.comment, undefined);

  assert.equal(merged.partialExitCount, 0);
  assert.equal(merged.mergedCount, 1);
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
