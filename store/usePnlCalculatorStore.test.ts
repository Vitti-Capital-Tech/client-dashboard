import test from "node:test";
import assert from "node:assert/strict";
import { usePnlCalculatorStore, AUTO_CLIENT } from "./usePnlCalculatorStore.ts";

const store = () => usePnlCalculatorStore.getState();

test("PNL store - starts empty and holds direct values", async () => {
  store().reset();

  assert.deepEqual(store().tradeFiles, []);
  assert.equal(store().result, null);
  assert.deepEqual(store().placementFiles, []);
  assert.equal(store().parsedPlacementMap, null);
  assert.equal(store().selectedAccount, "all");
  assert.equal(store().placementClient, AUTO_CLIENT);
  assert.equal(store().placementUrl, "");
  assert.equal(store().filterType, "all");
  assert.equal(store().searchQuery, "");

  store().setSelectedAccount("1103199");
  store().setFilterType("unlisted");
  store().setSearchQuery("GRV");
  store().setPlacementClient("Mr Akshit Verma");

  assert.equal(store().selectedAccount, "1103199");
  assert.equal(store().filterType, "unlisted");
  assert.equal(store().searchQuery, "GRV");
  assert.equal(store().placementClient, "Mr Akshit Verma");
});

test("PNL store - setters accept an updater function, like useState did", async () => {
  // The component was converted from useState, so `setX(prev => ...)` has to keep
  // working or a future call site silently stores the function itself.
  store().reset();

  store().setTradeFiles([{ id: "a", name: "a.csv", rawTrades: [], tradeCount: 1, accounts: ["1"] }]);
  store().setTradeFiles((prev) => [
    ...prev,
    { id: "b", name: "b.csv", rawTrades: [], tradeCount: 2, accounts: ["2"] },
  ]);

  assert.equal(store().tradeFiles.length, 2);
  assert.deepEqual(store().tradeFiles.map((f) => f.id), ["a", "b"]);

  store().setSearchQuery("abc");
  store().setSearchQuery((prev) => prev.toUpperCase());
  assert.equal(store().searchQuery, "ABC");

  // Removal by filter, the shape the file-remove buttons use.
  store().setTradeFiles((prev) => prev.filter((f) => f.id !== "a"));
  assert.deepEqual(store().tradeFiles.map((f) => f.id), ["b"]);
});

test("PNL store - nullable slices round-trip, including back to null", async () => {
  store().reset();

  const map = new Map([["GRV", { ticker: "GRV", totalShares: 1, totalActualDollar: 1, clientAllocations: [] }]]);
  store().setParsedPlacementMap(map);
  assert.equal(store().parsedPlacementMap?.get("GRV")?.ticker, "GRV");

  // Clearing the placement files clears the map — null must not be mistaken for
  // "no argument" by the updater-function check.
  store().setParsedPlacementMap(null);
  assert.equal(store().parsedPlacementMap, null);

  store().setResult({
    summary: [],
    rawTrades: [],
    totalPnl: 0,
    totalTrades: 0,
    uniqueTickers: 0,
    matchedTickers: 0,
    optionTickers: 0,
    errors: [],
  });
  assert.ok(store().result);
  store().setResult(null);
  assert.equal(store().result, null);
});

test("PNL store - the configured-tracker guard survives what it needs to", async () => {
  store().reset();
  assert.equal(store().configuredTrackersAttempted, false);

  store().setConfiguredTrackersAttempted(true);
  assert.equal(store().configuredTrackersAttempted, true);

  // The guard has to live here rather than in component state, because the route
  // remounts on every tab navigation and re-fetching costs a ~12s parse.
  assert.equal(usePnlCalculatorStore.getState().configuredTrackersAttempted, true);

  // A full reset clears it — the caller is responsible for restoring the standing
  // trackers and re-arming the flag so a reset does not trigger another 12s load.
  store().reset();
  assert.equal(store().configuredTrackersAttempted, false);
});

test("PNL store - a configured placement file is distinguishable from an uploaded one", async () => {
  store().reset();
  store().setPlacementFiles([
    { id: "cfg", name: "2026 Placements.xlsx", map: new Map(), tickerCount: 121, configured: true },
    { id: "up", name: "hand-upload.xlsx", map: new Map(), tickerCount: 3 },
  ]);

  // `handleReset` keeps only the configured ones; without the flag it could not tell
  // firm configuration apart from the user's own upload.
  const standing = store().placementFiles.filter((f) => f.configured);
  assert.equal(standing.length, 1);
  assert.equal(standing[0].name, "2026 Placements.xlsx");
});

test("PNL store - reset clears every slice with fresh collections", async () => {
  store().setTradeFiles([{ id: "a", name: "a.csv", rawTrades: [1], tradeCount: 1, accounts: ["1"] }]);
  store().setPlacementFiles([{ id: "p", name: "p.xlsx", map: new Map(), tickerCount: 3 }]);
  store().setParsedPlacementMap(new Map());
  store().setSelectedAccount("999");
  store().setPlacementClient("Someone");
  store().setPlacementUrl("https://example.com/sheet.xlsx");
  store().setFilterType("loss");
  store().setSearchQuery("zzz");

  const staleArray = store().tradeFiles;
  store().reset();

  assert.deepEqual(store().tradeFiles, []);
  assert.deepEqual(store().placementFiles, []);
  assert.equal(store().parsedPlacementMap, null);
  assert.equal(store().result, null);
  assert.equal(store().selectedAccount, "all");
  assert.equal(store().placementClient, AUTO_CLIENT);
  assert.equal(store().placementUrl, "");
  assert.equal(store().filterType, "all");
  assert.equal(store().searchQuery, "");

  // Fresh collection, not the previous session's array handed back.
  assert.notEqual(store().tradeFiles, staleArray);

  // Two resets must not share one array either.
  const first = store().tradeFiles;
  store().reset();
  assert.notEqual(store().tradeFiles, first);
});

test("PNL store - state survives across separate consumers, which is the whole point", async () => {
  store().reset();
  store().setSelectedAccount("1103199");
  store().setFilterType("open");

  // A second read of the module-scope store — what remounting the route after
  // navigating to another tab amounts to — sees the same values.
  const remounted = usePnlCalculatorStore.getState();
  assert.equal(remounted.selectedAccount, "1103199");
  assert.equal(remounted.filterType, "open");
});
