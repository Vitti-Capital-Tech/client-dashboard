"use client";

import React, { useState, useTransition, useRef, useEffect } from "react";
import {
  parsePnlFileAction,
  exportPnlXlsxAction,
  exportPnlCsvAction,
  fetchPlacementTrackerUrlAction,
  fetchDatabaseHoldingsAction,
  fetchSpotPricesAction,
  resolveAccountHoldersAction,
  loadConfiguredPlacementTrackersAction,
} from "@/app/actions/pnl-calculator";
import {
  parsePnlFileBuffer,
  parsePlacementTrackerBuffer,
  mergePlacementTrackerIntoSummary,
  mergeDbHoldingsIntoSummary,
  buildUnlistedOptionRows,
  collectUnlistedOptionTickers,
  placementArrayToMap,
  collectPlacementClientNames,
  combinePlacementMaps,
  resolvePlacementClientHints,
  isClientMatch,
  aggregateTradesToSummary,
  normalizeAccountNo,
  isOptionRow,
  summaryParentTicker,
  LIVE_SPOT_SOURCES,
  type ParseResult,
  type PnlSummaryItem,
  type PlacementTickerInfo,
  type SpotSource,
} from "@/lib/pnl-calculator";
import {
  usePnlCalculatorStore,
  AUTO_CLIENT,
  type UploadedPlacementFile,
  type UploadedTradeFile,
} from "@/store/usePnlCalculatorStore";

export type { UploadedPlacementFile, UploadedTradeFile } from "@/store/usePnlCalculatorStore";

export function PnlCalculatorClient() {
  /**
   * Everything worth keeping when the user leaves the tab lives in a module-scope
   * store, because navigating away unmounts this route and would otherwise discard
   * the uploaded files, the merges and the filters. See the store for why it is
   * deliberately memory-only.
   *
   * Selected field-by-field so a change to one slice does not re-render on the
   * others' account.
   */
  const tradeFiles = usePnlCalculatorStore((s) => s.tradeFiles);
  const setTradeFiles = usePnlCalculatorStore((s) => s.setTradeFiles);
  const result = usePnlCalculatorStore((s) => s.result);
  const setResult = usePnlCalculatorStore((s) => s.setResult);
  const placementFiles = usePnlCalculatorStore((s) => s.placementFiles);
  const setPlacementFiles = usePnlCalculatorStore((s) => s.setPlacementFiles);
  const parsedPlacementMap = usePnlCalculatorStore((s) => s.parsedPlacementMap);
  const setParsedPlacementMap = usePnlCalculatorStore((s) => s.setParsedPlacementMap);
  const selectedAccount = usePnlCalculatorStore((s) => s.selectedAccount);
  const setSelectedAccount = usePnlCalculatorStore((s) => s.setSelectedAccount);
  const placementClient = usePnlCalculatorStore((s) => s.placementClient);
  const setPlacementClient = usePnlCalculatorStore((s) => s.setPlacementClient);
  const placementUrl = usePnlCalculatorStore((s) => s.placementUrl);
  const setPlacementUrl = usePnlCalculatorStore((s) => s.setPlacementUrl);
  const filterType = usePnlCalculatorStore((s) => s.filterType);
  const setFilterType = usePnlCalculatorStore((s) => s.setFilterType);
  const searchQuery = usePnlCalculatorStore((s) => s.searchQuery);
  const setSearchQuery = usePnlCalculatorStore((s) => s.setSearchQuery);
  const accountHolders = usePnlCalculatorStore((s) => s.accountHolders);
  const setAccountHolders = usePnlCalculatorStore((s) => s.setAccountHolders);
  const configuredTrackersAttempted = usePnlCalculatorStore((s) => s.configuredTrackersAttempted);
  const setConfiguredTrackersAttempted = usePnlCalculatorStore(
    (s) => s.setConfiguredTrackersAttempted
  );

  /**
   * The store's state RIGHT NOW, rather than as captured by this render.
   *
   * Every handler here is async — file reads, a 12s tracker fetch, DB round trips — so
   * a value closed over at render time is routinely out of date by the time the
   * callback resumes. Two real failures came from exactly that:
   *
   *  - the standing-tracker load captured `result === null` at mount, so a trade file
   *    uploaded during its 12s fetch was never merged with the tracker (and the upload,
   *    in turn, saw `placementFiles` still empty);
   *  - picking a second trade file before the first transition settled read a stale
   *    `tradeFiles` and dropped the earlier file.
   *
   * Reading through `getState()` removes the whole class of bug — which is the point of
   * keeping this state in a module store rather than in `useState`.
   */
  const live = () => usePnlCalculatorStore.getState();
  const resetStore = usePnlCalculatorStore((s) => s.reset);

  // Transient UI state stays local — a half-finished drag, an open tooltip or a
  // row mid-edit should NOT survive leaving the page.
  const [file, setFile] = useState<File | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isProcessing, startProcessing] = useTransition();
  const [isExportingXlsx, startExportingXlsx] = useTransition();
  const [isExportingCsv, startExportingCsv] = useTransition();
  const [isFetchingUrl, startFetchingUrl] = useTransition();
  const [isMergingPlacementFile, startMergingPlacementFile] = useTransition();
  const [isSyncingDb, startSyncingDb] = useTransition();
  /**
   * Hovered unlisted-option row and where to draw its card.
   *
   * Positioned `fixed` from the pointer rather than `absolute` inside the cell: the
   * results table sits in an `overflow-x-auto` wrapper, and a scroll container
   * clips on BOTH axes once either one is not `visible`, so an absolutely
   * positioned card would be cut off on the right and on the last rows.
   */
  const [unlistedTip, setUnlistedTip] = useState<{
    item: PnlSummaryItem;
    left: number;
    top: number;
  } | null>(null);
  const [placementMsg, setPlacementMsg] = useState<{
    type: "success" | "error";
    text: string;
    /** Secondary line: the fix for an error, or how a link was read on success. */
    hint?: string;
  } | null>(null);
  const [expandedTickers, setExpandedTickers] = useState<Set<string>>(new Set());

  const fileInputRef = useRef<HTMLInputElement>(null);
  const placementFileInputRef = useRef<HTMLInputElement>(null);

  const toggleExpandTicker = (ticker: string) => {
    setExpandedTickers((prev) => {
      const next = new Set(prev);
      if (next.has(ticker)) {
        next.delete(ticker);
      } else {
        next.add(ticker);
      }
      return next;
    });
  };

  const getFilenameStem = (filename?: string | null): string => {
    if (!filename) return "";
    const dotIdx = filename.lastIndexOf(".");
    const name = dotIdx > 0 ? filename.substring(0, dotIdx) : filename;
    return name.trim();
  };

  /**
   * The account holder whose allocation rows a Placement Tracker merge should
   * use. A placement sheet lists every client in the placement, so picking the
   * wrong rows — or all of them — inflates Buy Qty / Buy Price by the number of
   * participants. Trade files are normally named after the account holder, so
   * their names are the default hint; `placementClient` is the explicit override
   * for when they are not.
   */
  /**
   * Who the Placement Tracker merge should treat these trades as belonging to.
   *
   * Preference order matters. The trade file's `Account` column resolved against the
   * database is real data; a filename is a convention someone has to remember, and it
   * is often simply wrong — `PKevadiya-…csv` actually belongs to "Sri Guru Nanak Pty
   * Ltd", which matches nothing in the placement sheets. So account-derived names win,
   * and the filename stays only as a fallback for accounts the database does not know.
   *
   * `holders` may be passed explicitly because callers resolve it and re-merge in the
   * same tick, before the store state has flushed.
   */
  const getClientHints = (
    files: UploadedTradeFile[] = tradeFiles,
    override: string = placementClient,
    holders: Record<string, string> = accountHolders,
    activeAccount: string = live().selectedAccount
  ): string[] => {
    // Scope to the account being viewed. Uploading two clients' files and then
    // filtering to one of them must NOT keep the other's name as a hint: a ticker both
    // took part in would merge BOTH allocations into that single account's row and
    // overstate its Buy Qty.
    // Files with none of the selected account are dropped entirely, not just stripped
    // of their accounts — otherwise the filename fallback (used when the DB cannot name
    // an account) would pull the other client's name straight back in.
    const scoped =
      activeAccount === "all"
        ? files
        : files
            .map((f) => ({
              ...f,
              accounts: (f.accounts || []).filter(
                (a) => normalizeAccountNo(a) === normalizeAccountNo(activeAccount)
              ),
            }))
            .filter((f) => f.accounts.length > 0);

    return resolvePlacementClientHints({
      files: scoped,
      override,
      autoSentinel: AUTO_CLIENT,
      accountHolders: holders,
      filenameStem: getFilenameStem,
    }).hints;
  };

  /** Human-readable label for whichever account holder the merge resolved to. */
  const describeClientHints = (hints: string[]): string =>
    hints.length === 0 ? "client" : hints.join(", ");

  /**
   * Explains tickers the merge deliberately skipped: the sheet lists several
   * account holders and none matched, so filling Buy Qty would have summed
   * everyone's allocation instead of this client's.
   */
  const ambiguityHint = (ambiguousTickers?: string[]): string | undefined => {
    if (!ambiguousTickers || ambiguousTickers.length === 0) return undefined;
    const shown = ambiguousTickers.slice(0, 6).join(", ");
    const more = ambiguousTickers.length > 6 ? ` +${ambiguousTickers.length - 6} more` : "";
    return `Left ${ambiguousTickers.length} ticker(s) unfilled (${shown}${more}) — the sheet lists multiple account holders and none matched the trade file name. Pick the account holder above to fill them.`;
  };

  /**
   * Why a row carries the note it does — the Comments cell's tooltip.
   *
   * For an unlisted option this is the only place the valuation is shown, so it
   * spells out every input. A modelled number that cannot be traced back to its
   * assumptions is not auditable.
   */
  const commentHint = (item: PnlSummaryItem): string => {
    if (item.isUnlistedOption) {
      const v = item.unlistedOption;
      if (!v) return "Free unlisted placement options valued with Black-Scholes.";
      return (
        `MODEL PRICE, not a market quote.\n` +
        `Add-On: ${v.addOn.raw}\n` +
        `Entitlement: ${v.addOn.ratioOptions}:${v.addOn.ratioPerShares} on ${fmtQty(v.basisQty)} ${
          v.basisKind === "shares" ? "shares" : "base options"
        } = ${fmtQty(item.sellQty)} options\n` +
        `Spot ${fmtCurrency(v.spot)} (${v.spotSource}) · Strike ${fmtCurrency(v.addOn.strike)}\n` +
        `Expiry ${v.addOn.expiry} (${v.timeToExpiryYears.toFixed(2)} yrs)\n` +
        `Vol ${(v.volatility * 100).toFixed(0)}% · Rate ${(v.riskFreeRate * 100).toFixed(0)}% · Div ${(v.dividendYield * 100).toFixed(0)}%\n` +
        `Black-Scholes per option: ${fmtCurrency(v.optionPrice)}`
      );
    }
    const parts: string[] = [];
    if (item.isPartialBuy) {
      parts.push(
        "Buy side was short — more units were sold than the ledger recorded buying, so the Placement Tracker allocation was added on top."
      );
    }
    if (item.isPartialExit) {
      parts.push(
        "Part of this parcel was sold; the units still held were valued from the DB holdings snapshot and added to the sell side."
      );
    } else if (item.isDbOnly) {
      parts.push(
        "No trade in the uploaded ledger backs this row — it exists because the holdings snapshot has the position. Both the cost basis and the market value come from the database, not from a contract note. Free placement options land here, since nothing is ever bought."
      );
    } else if (item.isDbOpenValued) {
      parts.push(
        "Nothing was sold — the sell side is this open position marked to the latest DB holdings snapshot, not realised cash."
      );
    }
    return parts.join(" ");
  };

  /**
   * A short-buy top-up changes an already-populated Buy side, so it is called out
   * separately from a plain fill into a blank one.
   */
  const partialBuyNote = (partialBuyCount?: number): string =>
    partialBuyCount && partialBuyCount > 0
      ? ` ${partialBuyCount} had a short buy side — the placement allocation was added on top of the recorded buys (tagged "Partial Buy").`
      : "";

  /** Every account holder named across the active placement sheets. */
  const placementClientNames = parsedPlacementMap
    ? collectPlacementClientNames(parsedPlacementMap)
    : [];

  /** Which of those the trade-file names resolve to on their own. */
  const autoDetectedClients = placementClientNames.filter((name) =>
    getClientHints(tradeFiles, AUTO_CLIENT).some((hint) => isClientMatch(name, hint))
  );

  /**
   * Values open positions off the DB snapshot, then prices any unlisted placement
   * options. One async pass so the two only ever write `result` once between them.
   *
   * `placementOverride` exists because callers reach here immediately after
   * `setParsedPlacementMap(...)`, before React has flushed that state — reading the
   * state variable would use the previous upload's add-ons. Pass `null` to mean
   * "no placements", which drops any generated option rows.
   */
  const handleSyncDbHoldings = (
    currentResult?: ParseResult | null,
    targetAcc?: string,
    placementOverride?: Map<string, PlacementTickerInfo> | null
  ) => {
    const res = currentResult || live().result;
    if (!res) return;
    const accToUse = targetAcc !== undefined ? targetAcc : live().selectedAccount;
    const placements = placementOverride !== undefined ? placementOverride : live().parsedPlacementMap;

    const targetAccountsScope =
      accToUse !== "all"
        ? accToUse
        : res.accounts && res.accounts.length > 0
        ? res.accounts
        : "all";

    startSyncingDb(async () => {
      let working = res;
      const notes: string[] = [];

      const dbRes = await fetchDatabaseHoldingsAction(targetAccountsScope);
      if (dbRes.ok && dbRes.holdings.length > 0) {
        const merged = mergeDbHoldingsIntoSummary(working.summary, dbRes.holdings);
        working = { ...working, summary: merged.summary, totalPnl: merged.totalPnl };
        notes.push(
          `Auto-filled DB Portfolio Market Values for ${merged.mergedCount} open positions (Account ${
            Array.isArray(targetAccountsScope) ? targetAccountsScope.join(", ") : targetAccountsScope
          })!` +
            (merged.partialExitCount > 0
              ? ` ${merged.partialExitCount} of them were partial exits — the still-held parcel was added on top of the realised sale.`
              : "") +
            (merged.createdCount > 0
              ? ` Added ${merged.createdCount} row(s) for holdings the trade file never mentioned (mostly free placement options, which have no contract note) — their cost basis comes from the snapshot, so they are tagged "DB Holding".`
              : "")
        );
      }

      // Unlisted placement options: free options, so their whole modelled value is
      // P&L. Rebuilt every pass, which also refreshes the spot prices behind them.
      const unlistedTickers = placements ? collectUnlistedOptionTickers(working.summary, placements) : [];
      if (placements && unlistedTickers.length > 0) {
        const spotRes = await fetchSpotPricesAction(unlistedTickers);
        const spotMap = new Map<string, { price: number; source: SpotSource }>(
          spotRes.prices.map((p) => [p.ticker, { price: p.price, source: p.source }])
        );
        const built = buildUnlistedOptionRows(working.summary, placements, spotMap, new Date());
        working = { ...working, summary: built.summary, totalPnl: built.totalPnl };

        if (built.addedCount > 0) {
          const fromAsx = spotRes.prices.filter((p) => p.source === "asx").map((p) => p.ticker);
          const stale = spotRes.prices.filter((p) => p.source === "database").map((p) => p.ticker);
          notes.push(
            `Valued ${built.addedCount} unlisted option line(s) with Black-Scholes (vol 50%, rate 5%, div 0%).` +
              (fromAsx.length > 0
                ? ` ${fromAsx.join(", ")} priced from the ASX feed (Yahoo had no quote) — still a live price.`
                : "") +
              (stale.length > 0
                ? ` ${stale.join(", ")} used the last holdings-snapshot price — neither Yahoo nor the ASX had a quote, so it is as stale as the last import.`
                : "") +
              (built.skipped.length > 0
                ? ` No price at all for ${built.skipped.join(", ")} — those rows are valued at $0 until a quote is available.`
                : "") +
              (built.unresolvedPiggybacks.length > 0
                ? ` Skipped ${built.unresolvedPiggybacks.length} piggyback grant(s) with no base tranche to compute from: ${built.unresolvedPiggybacks.join("; ")}.`
                : "")
          );
        }
      } else if (placements) {
        // Placements are loaded but none earn an option row — drop any stale ones.
        const cleared = working.summary.filter((s) => !s.isUnlistedOption);
        if (cleared.length !== working.summary.length) {
          working = {
            ...working,
            summary: cleared,
            totalPnl: Math.round(cleared.reduce((a, c) => a + c.pnlCalculated, 0) * 100) / 100,
          };
        }
      }

      setResult({
        ...working,
        matchedTickers: working.summary.filter((s) => s.isMatched).length,
        optionTickers: working.summary.filter((s) => s.isOption).length,
      });

      if (notes.length > 0) {
        setPlacementMsg({ type: "success", text: notes.join(" ") });
      }
    });
  };

  const handleSelectAccount = (accNo: string) => {
    setSelectedAccount(accNo);
    if (!result) return;

    const tradesToUse =
      accNo === "all"
        ? result.rawTrades
        : result.rawTrades.filter((t) => normalizeAccountNo(t.account) === normalizeAccountNo(accNo));

    const { summary: newSummary } = aggregateTradesToSummary(tradesToUse);

    let finalSummary = newSummary;
    let finalTotalPnl = Math.round(newSummary.reduce((acc, curr) => acc + curr.pnlCalculated, 0) * 100) / 100;

    if (parsedPlacementMap && parsedPlacementMap.size > 0) {
      const merged = mergePlacementTrackerIntoSummary(
        newSummary,
        parsedPlacementMap,
        getClientHints()
      );
      finalSummary = merged.summary;
      finalTotalPnl = merged.totalPnl;
    }

    const updatedRes: ParseResult = {
      ...result,
      summary: finalSummary,
      totalPnl: finalTotalPnl,
      matchedTickers: finalSummary.filter((s) => s.isMatched).length,
      optionTickers: finalSummary.filter((s) => s.isOption).length,
    };

    setResult(updatedRes);
    handleSyncDbHoldings(updatedRes, accNo);
  };

  const handleMergeUrl = () => {
    if (!placementUrl || !result) return;
    setPlacementMsg(null);
    startFetchingUrl(async () => {
      const res = await fetchPlacementTrackerUrlAction(placementUrl);
      if (!res.ok || !res.placementItems.length) {
        setPlacementMsg({
          type: "error",
          text: res.error || "Failed to fetch/parse Placement Tracker URL.",
          hint: res.hint,
        });
        return;
      }

      // Register the linked tracker alongside uploaded ones so it survives a
      // later upload/removal (reapplyPlacementMerges rebuilds from this list)
      // and can be removed from the same chip row.
      const placementMap = placementArrayToMap(res.placementItems);
      const linkedFile: UploadedPlacementFile = {
        id: `link-${placementUrl}-${Date.now()}`,
        name: res.filename || "Linked Placement Tracker",
        map: placementMap,
        tickerCount: placementMap.size,
      };

      // Live read: the fetch above can take seconds, during which the standing-tracker
      // load may have registered its own files.
      const updatedFileList = [...live().placementFiles, linkedFile];
      setPlacementFiles(updatedFileList);
      const stats = reapplyPlacementMerges(updatedFileList);

      const readNote =
        res.source === "public-link"
          ? undefined
          : `Read privately via ${
              res.source === "google-service-account"
                ? "the Google service account"
                : "Microsoft Graph"
            }.`;

      setPlacementMsg({
        type: "success",
        text: `Enriched Placement Tracker data for ${describeClientHints(
          getClientHints()
        )}! Matched/merged ${stats?.mergedCount ?? 0} tickers.${partialBuyNote(stats?.partialBuyCount)}`,
        hint:
          [readNote, ambiguityHint(stats?.ambiguousTickers)]
            .filter(Boolean)
            .join(" ") || undefined,
      });
      setPlacementUrl("");
    });
  };

  /**
   * Rebuilds the summary from the raw trades and re-merges the active placement
   * files. Returns the merge stats so callers can report them without running
   * the merge a second time.
   */
  const reapplyPlacementMerges = (
    files: UploadedPlacementFile[],
    baseRes?: ParseResult | null,
    clientOverride?: string
  ): { mergedCount: number; partialBuyCount: number; ambiguousTickers: string[] } | null => {
    // Live reads throughout: the standing-tracker load takes ~12s, and a trade file
    // uploaded during it left this function looking at the mount-time `result` (null),
    // so the tracker silently never merged.
    const res = baseRes || live().result;
    if (!res) return null;

    const override = clientOverride ?? live().placementClient;
    const activeAccount = live().selectedAccount;

    const tradesToUse =
      activeAccount === "all"
        ? res.rawTrades
        : res.rawTrades.filter((t) => normalizeAccountNo(t.account) === normalizeAccountNo(activeAccount));

    const { summary: baseSummary } = aggregateTradesToSummary(tradesToUse);

    if (files.length === 0) {
      setParsedPlacementMap(null);
      const freshTotalPnl = Math.round(baseSummary.reduce((acc, curr) => acc + curr.pnlCalculated, 0) * 100) / 100;
      const resetRes: ParseResult = {
        ...res,
        summary: baseSummary,
        totalPnl: freshTotalPnl,
        matchedTickers: baseSummary.filter((s) => s.isMatched).length,
        optionTickers: baseSummary.filter((s) => s.isOption).length,
      };
      setResult(resetRes);
      handleSyncDbHoldings(resetRes, activeAccount, null);
      return { mergedCount: 0, partialBuyCount: 0, ambiguousTickers: [] };
    }

    const combinedMap = combinePlacementMaps(files);
    setParsedPlacementMap(combinedMap);

    const merged = mergePlacementTrackerIntoSummary(
      baseSummary,
      combinedMap,
      getClientHints(live().tradeFiles, override, live().accountHolders, activeAccount)
    );

    const updatedRes: ParseResult = {
      ...res,
      summary: merged.summary,
      totalPnl: merged.totalPnl,
      matchedTickers: merged.summary.filter((s) => s.isMatched).length,
      optionTickers: merged.summary.filter((s) => s.isOption).length,
    };
    setResult(updatedRes);
    handleSyncDbHoldings(updatedRes, activeAccount, combinedMap);

    return {
      mergedCount: merged.mergedCount,
      partialBuyCount: merged.partialBuyCount,
      ambiguousTickers: merged.ambiguousTickers,
    };
  };

  /**
   * Loads the standing `PLACEMENT_TRACKER_URL` link(s) once per session.
   *
   * Runs on mount but guards on a STORE flag, not component state: the route remounts
   * on every portal tab navigation, and a real tracker is a 12 MB workbook that takes
   * ~12s to parse — repeating that on each visit would be unusable. The flag is set
   * before the await so React's development double-invoke cannot fire it twice either.
   *
   * Declared AFTER `reapplyPlacementMerges` on purpose: the effect body only runs post
   * render so a forward reference would work, but reading in dependency order keeps it
   * honest (and keeps eslint's no-use-before-declare quiet).
   *
   * Deliberately independent of whether a trade file is loaded yet. The trackers just
   * join `placementFiles`; the merge is a no-op until there are trades, and every later
   * upload rebuilds from that list anyway.
   */
  useEffect(() => {
    if (configuredTrackersAttempted) return;
    setConfiguredTrackersAttempted(true);

    startFetchingUrl(async () => {
      const res = await loadConfiguredPlacementTrackersAction();
      if (!res.configured) return;

      const loaded = res.trackers.filter((t) => t.placementItems.length > 0);
      const failed = res.trackers.filter((t) => t.placementItems.length === 0);

      if (loaded.length > 0) {
        const newFiles: UploadedPlacementFile[] = loaded.map((t, i) => {
          const map = placementArrayToMap(t.placementItems);
          return {
            id: `configured-${i}-${t.name}`,
            name: t.name,
            map,
            tickerCount: map.size,
            configured: true,
          };
        });

        // Live reads: this resumes ~12s after mount, by which time a trade file may
        // have been uploaded and other placement files registered.
        const updatedFileList = [...live().placementFiles, ...newFiles];
        setPlacementFiles(updatedFileList);
        reapplyPlacementMerges(updatedFileList, live().result);
      }

      setPlacementMsg({
        type: failed.length > 0 && loaded.length === 0 ? "error" : "success",
        text:
          loaded.length > 0
            ? `Loaded ${loaded.length} standing Placement Tracker${
                loaded.length === 1 ? "" : "s"
              } from configuration: ${loaded.map((t) => t.name).join(", ")}.`
            : "Could not load the configured Placement Tracker link(s).",
        hint:
          failed.length > 0
            ? `${failed.length} configured link(s) failed: ${failed
                .map((t) => t.error)
                .filter(Boolean)
                .join(" ")} Check PLACEMENT_TRACKER_URL in .env.local.`
            : undefined,
      });
    });
    // Intentionally mount-only: the store flag is the real guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleMergePlacementFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files || e.target.files.length === 0 || !result) return;
    const fileList = Array.from(e.target.files);
    setPlacementMsg(null);

    startMergingPlacementFile(async () => {
      try {
        const newUploadedFiles: UploadedPlacementFile[] = [];

        for (const pFile of fileList) {
          const arrayBuffer = await pFile.arrayBuffer();
          const placementMap = await parsePlacementTrackerBuffer(Buffer.from(arrayBuffer as any));
          if (placementMap.size > 0) {
            newUploadedFiles.push({
              id: `${pFile.name}-${Date.now()}-${Math.random()}`,
              name: pFile.name,
              map: placementMap,
              tickerCount: placementMap.size,
            });
          }
        }

        if (newUploadedFiles.length === 0) {
          setPlacementMsg({
            type: "error",
            text: "No valid placement ticker sheets found in the selected file(s).",
          });
          return;
        }

        // Live read: parsing a placement workbook takes seconds, so another file (or the
        // standing tracker) may have landed while this one was being read.
        const updatedFileList = [...live().placementFiles, ...newUploadedFiles];
        setPlacementFiles(updatedFileList);
        const stats = reapplyPlacementMerges(updatedFileList);

        setPlacementMsg({
          type: stats?.ambiguousTickers.length ? "error" : "success",
          text: `Merged ${newUploadedFiles.length} placement file(s) for ${describeClientHints(
            getClientHints()
          )} — filled ${stats?.mergedCount ?? 0} ticker(s).${partialBuyNote(
            stats?.partialBuyCount
          )} Total active placement files: ${updatedFileList.length}.`,
          hint: ambiguityHint(stats?.ambiguousTickers),
        });

        if (placementFileInputRef.current) {
          placementFileInputRef.current.value = "";
        }
      } catch (err: any) {
        console.error("Error parsing placement files:", err);
        setPlacementMsg({
          type: "error",
          text: err.message || "Failed to parse placement file(s).",
        });
      }
    });
  };

  /** Re-runs the merge against a different account holder. */
  const handleSelectPlacementClient = (name: string) => {
    setPlacementClient(name);
    if (placementFiles.length === 0) return;

    const stats = reapplyPlacementMerges(placementFiles, null, name);
    setPlacementMsg({
      type: stats?.ambiguousTickers.length ? "error" : "success",
      text:
        name === AUTO_CLIENT
          ? `Account holder set to auto-detect from trade file names — filled ${
              stats?.mergedCount ?? 0
            } ticker(s).${partialBuyNote(stats?.partialBuyCount)}`
          : `Using ${name}'s placement allocations — filled ${
              stats?.mergedCount ?? 0
            } ticker(s).${partialBuyNote(stats?.partialBuyCount)}`,
      hint: ambiguityHint(stats?.ambiguousTickers),
    });
  };

  const handleRemovePlacementFile = (id: string) => {
    const fileToRemove = placementFiles.find((f) => f.id === id);
    const updated = placementFiles.filter((f) => f.id !== id);
    setPlacementFiles(updated);
    reapplyPlacementMerges(updated);
    setPlacementMsg({
      type: "success",
      text: `Removed placement file "${fileToRemove?.name || "file"}".`,
    });
  };

  const recalculateTradeFiles = (
    activeTradeFiles: UploadedTradeFile[],
    targetAcc?: string,
    holders?: Record<string, string>
  ) => {
    if (activeTradeFiles.length === 0) {
      setResult(null);
      return;
    }

    const accToUse = targetAcc !== undefined ? targetAcc : live().selectedAccount;
    const allRawTrades: any[] = [];
    const accountsSet = new Set<string>();

    for (const tf of activeTradeFiles) {
      for (const t of tf.rawTrades) {
        allRawTrades.push(t);
        if (t.account && t.account.trim()) {
          accountsSet.add(t.account.trim());
        }
      }
    }

    const allAccounts = Array.from(accountsSet).sort();
    const tradesToAggregate =
      accToUse === "all"
        ? allRawTrades
        : allRawTrades.filter((t) => normalizeAccountNo(t.account) === normalizeAccountNo(accToUse));

    const { summary: aggregatedSummary, totalPnl: aggregatedPnl } = aggregateTradesToSummary(tradesToAggregate);

    let finalSummary = aggregatedSummary;
    let finalTotalPnl = aggregatedPnl;

    // Hints come from `activeTradeFiles` and the passed-in `holders`, because this runs
    // in the same tick as setTradeFiles/setAccountHolders. Everything else reads live,
    // so a tracker that finished loading mid-upload is still picked up.
    const clientHints = getClientHints(
      activeTradeFiles,
      live().placementClient,
      holders ?? live().accountHolders,
      accToUse
    );

    const activePlacementFiles = live().placementFiles;
    const activePlacementMap = live().parsedPlacementMap;
    let combinedMap: Map<string, PlacementTickerInfo> | null = null;

    if (activePlacementFiles.length > 0) {
      combinedMap = combinePlacementMaps(activePlacementFiles);
    } else if (activePlacementMap && activePlacementMap.size > 0) {
      combinedMap = activePlacementMap;
    }

    if (combinedMap) {
      const merged = mergePlacementTrackerIntoSummary(aggregatedSummary, combinedMap, clientHints);
      finalSummary = merged.summary;
      finalTotalPnl = merged.totalPnl;
    }

    const newResult: ParseResult = {
      summary: finalSummary,
      rawTrades: allRawTrades,
      totalPnl: finalTotalPnl,
      totalTrades: allRawTrades.length,
      uniqueTickers: finalSummary.length,
      matchedTickers: finalSummary.filter((s) => s.isMatched).length,
      optionTickers: finalSummary.filter((s) => s.isOption).length,
      accounts: allAccounts,
      errors: [],
    };

    setResult(newResult);
    // Pass the map explicitly: without it the DB sync falls back to `parsedPlacementMap`,
    // which this path never sets, so unlisted-option rows were never built on upload.
    handleSyncDbHoldings(newResult, accToUse, combinedMap);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setFile(e.target.files[0]);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const droppedFiles = Array.from(e.dataTransfer.files).filter(
        (f) =>
          f.name.endsWith(".xlsx") ||
          f.name.endsWith(".xls") ||
          f.name.endsWith(".csv")
      );
      // One trade file at a time — extra drops are ignored rather than queued.
      if (droppedFiles.length > 0) {
        setFile(droppedFiles[0]);
      }
    }
  };

  /**
   * Parses ONE trade file and makes it the active one.
   *
   * Deliberately a replace, not an append. Accumulating several files meant the summary,
   * the placement hints and the account filter all had to agree about which client's
   * trades were in play, and they drifted apart — a second upload left the placement
   * merge showing the first file's enrichment. One file at a time removes that whole
   * class of confusion; re-upload to switch clients.
   */
  const processTradeFile = (fileToProcess: File) => {
    startProcessing(async () => {
      try {
        const arrayBuffer = await fileToProcess.arrayBuffer();
        const parsed = await parsePnlFileBuffer(
          Buffer.from(arrayBuffer as any),
          fileToProcess.name
        );

        if (parsed.rawTrades.length === 0) {
          setPlacementMsg({
            type: "error",
            text: `No valid trade records found in "${fileToProcess.name}".`,
          });
          return;
        }

        const updatedTradeFileList: UploadedTradeFile[] = [
          {
            id: `${fileToProcess.name}-${parsed.rawTrades.length}`,
            name: fileToProcess.name,
            rawTrades: parsed.rawTrades,
            tradeCount: parsed.rawTrades.length,
            accounts: parsed.accounts || [],
          },
        ];

        setTradeFiles(updatedTradeFileList);
        setFile(null);
        setSelectedAccount("all");
        if (fileInputRef.current) fileInputRef.current.value = "";

        // Resolve the file's Account numbers to account holders BEFORE merging, so the
        // placement merge matches on who the account belongs to rather than on what
        // the file happens to be called.
        const refs = [...new Set(updatedTradeFileList.flatMap((tf) => tf.accounts || []))];
        let holders = live().accountHolders;
        if (refs.length > 0) {
          const resolved = await resolveAccountHoldersAction(refs);
          if (resolved.ok && resolved.holders.length > 0) {
            holders = { ...live().accountHolders };
            for (const h of resolved.holders) holders[h.accountRef] = h.clientName;
            setAccountHolders(holders);
          }
          const unresolved = refs.filter((r) => !holders[r]);
          if (unresolved.length > 0) {
            setPlacementMsg({
              type: "success",
              text: `Identified account holder(s): ${
                [...new Set(refs.map((r) => holders[r]).filter(Boolean))].join(", ") || "none"
              }.`,
              hint: `Account ${unresolved.join(", ")} is not in the database, so the placement merge falls back to the file name for it. Import the holdings snapshot for that account, or pick the account holder manually.`,
            });
          }
        }

        recalculateTradeFiles(updatedTradeFileList, "all", holders);
      } catch (err) {
        console.error("Error processing trade file:", err);
        setPlacementMsg({
          type: "error",
          text: err instanceof Error ? err.message : "Failed to process the trade file.",
        });
      }
    });
  };

  const handleProcessFile = () => {
    if (!file) return;
    processTradeFile(file);
  };

  const handleRemoveTradeFile = (id: string) => {
    const updated = tradeFiles.filter((tf) => tf.id !== id);
    setTradeFiles(updated);
    recalculateTradeFiles(updated);
  };

  const handleReset = () => {
    // One call for every persisted slice. Listing them individually used to be good
    // enough because leaving the page cleared the rest anyway; now that the store
    // survives navigation, a partial reset would strand the old account filter,
    // filter tab and account holder on a freshly uploaded file.
    // Standing trackers come from configuration, not from the user, so a reset keeps
    // them — dropping them would cost another ~12s parse to get back to the same place.
    const standing = placementFiles.filter((f) => f.configured);

    resetStore();

    if (standing.length > 0) {
      setPlacementFiles(standing);
      setConfiguredTrackersAttempted(true);
    }

    setFile(null);
    setPlacementMsg(null);
    setEditingTicker(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (placementFileInputRef.current) placementFileInputRef.current.value = "";
  };

  /**
   * Which client the export covers, so the file is named after them.
   *
   * Scoped to the account filter in force: exporting one account must not label the
   * file with every account in the upload.
   */
  const exportScope = () => ({
    accounts:
      selectedAccount !== "all"
        ? [selectedAccount]
        : result?.accounts && result.accounts.length > 0
        ? result.accounts
        : [],
    accountHolders,
  });

  const handleDownloadXlsx = () => {
    if (!result || !result.summary.length) return;
    startExportingXlsx(async () => {
      const { base64, filename } = await exportPnlXlsxAction(result.summary, exportScope());
      const binary = atob(base64);
      const array = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        array[i] = binary.charCodeAt(i);
      }
      const blob = new Blob([array], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    });
  };

  const handleDownloadCsv = () => {
    if (!result || !result.summary.length) return;
    startExportingCsv(async () => {
      const { csv, filename } = await exportPnlCsvAction(result.summary, exportScope());
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    });
  };

  const handleDownloadSample = () => {
    const sampleCsv = `CNote,Account,Type,Security,Company,Description,Contract Date,Adviser,Units,Avg Price,Consideration,Brokerage,Other Charges,GST,Value,Brokerage%,Status
2462073,114716,SELL,EOS,ELECTRO C FPO,,21-05-2026,VIZ,407,8.11,3300.77,100,0,10,3300.77,3.0296,SETTLED
2458396,114716,BUY,EOS,ELECTRO C FPO,,19-05-2026,VIZ,407,8.00,3256.00,0,0,0,3256.00,0,SETTLED
2306306,114716,SELL,LDX,LUMOS DIA FPO,,04-02-2026,VIZ,16629,0.275,4572.98,100,0,10,4462.98,2.1868,SETTLED
2303464,114716,BUY,ACWXX,ACTINOGE INSTOPLACE,,03-02-2026,VIZ,71429,0.042,3000.02,0,0,0,3000.02,0,SETTLED
2288637,114716,BUY,LDX,LUMOS DIA FPO,,23-01-2026,VIZ,16629,0.235,3907.82,100,0,10,4017.82,2.559,SETTLED`;

    const blob = new Blob([sampleCsv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "trade-ledger-sample.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const fmtCurrency = (num: number) => {
    return new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: "AUD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(num);
  };

  const fmtPrice = (num: number) => {
    return new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: "AUD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }).format(num);
  };

  const fmtQty = (num: number) => {
    return num.toLocaleString("en-AU");
  };

  // Inline row edit state
  const [editingTicker, setEditingTicker] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<{
    buyQty: string;
    sellQty: string;
    buyPrice: string;
    sellPrice: string;
    marketPrice: string;
  }>({ buyQty: "", sellQty: "", buyPrice: "", sellPrice: "", marketPrice: "" });

  const handleStartEdit = (item: PnlSummaryItem) => {
    setEditingTicker(item.ticker);
    setEditForm({
      buyQty: String(item.buyQty),
      sellQty: String(item.sellQty),
      buyPrice: String(item.buyPrice),
      sellPrice: String(item.sellPrice),
      marketPrice: "",
    });
  };

  const handleCancelEdit = () => {
    setEditingTicker(null);
  };

  const handleSaveEdit = (ticker: string) => {
    if (!result) return;
    const bQty = parseFloat(editForm.buyQty) || 0;
    const sQty = parseFloat(editForm.sellQty) || 0;
    const bPrice = parseFloat(editForm.buyPrice) || 0;
    let sPrice = parseFloat(editForm.sellPrice) || 0;
    const mPrice = parseFloat(editForm.marketPrice) || 0;

    let finalSellQty = sQty;
    // Helper: If market price is entered for open position, calculate estimated sell value and set sell qty = buy qty
    if (mPrice > 0) {
      const openQty = bQty - sQty;
      if (openQty > 0) {
        sPrice = sPrice + openQty * mPrice;
        finalSellQty = bQty;
      }
    }

    const updatedSummary = result.summary.map((item) => {
      if (item.ticker === ticker) {
        const isMatched = bQty === finalSellQty && bQty > 0;
        const pnlCalculated = Math.round((sPrice - bPrice) * 100) / 100;
        return {
          ...item,
          buyQty: bQty,
          sellQty: finalSellQty,
          buyPrice: Math.round(bPrice * 100) / 100,
          sellPrice: Math.round(sPrice * 100) / 100,
          totalBuyValue: Math.round(bPrice * 100) / 100,
          totalSellValue: Math.round(sPrice * 100) / 100,
          pnlCalculated,
          isMatched,
          isEdited: true,
          openQty: bQty - finalSellQty,
        };
      }
      return item;
    });

    const newTotalPnl = updatedSummary.reduce((acc, curr) => acc + curr.pnlCalculated, 0);

    setResult({
      ...result,
      summary: updatedSummary,
      totalPnl: Math.round(newTotalPnl * 100) / 100,
      matchedTickers: updatedSummary.filter((s) => s.isMatched).length,
      optionTickers: updatedSummary.filter((s) => s.isOption).length,
    });

    setEditingTicker(null);
  };

  // Filtered rows
  const filteredSummary = (result?.summary || []).filter((item) => {
    const matchesSearch =
      item.ticker.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.company.toLowerCase().includes(searchQuery.toLowerCase());

    if (!matchesSearch) return false;

    if (filterType === "matched") return item.isMatched;
    if (filterType === "profit") return item.pnlCalculated > 0;
    if (filterType === "loss") return item.pnlCalculated < 0;
    // Options — listed and unlisted alike — are reported on their own lines and are
    // not expected to balance, so they are not "unmatched"; they are just options.
    if (filterType === "unmatched") return !item.isMatched && !isOptionRow(item);
    if (filterType === "options") return isOptionRow(item);
    if (filterType === "unlisted") return Boolean(item.isUnlistedOption);
    // Open = nothing sold; the sell side is this parcel marked to the DB snapshot.
    if (filterType === "open") return Boolean(item.isDbOpenValued);
    if (filterType === "equity") return !isOptionRow(item);
    return true;
  });

  const summaryList = result?.summary || [];
  const totalBuyVolume = summaryList.reduce((acc, curr) => acc + curr.totalBuyValue, 0);
  const totalSellVolume = summaryList.reduce((acc, curr) => acc + curr.totalSellValue, 0);

  const equityRows = summaryList.filter((i) => !isOptionRow(i));
  const optionRows = summaryList.filter((i) => isOptionRow(i));

  /** Equity and options are reported as separate books, then combined. */
  const subtotalFor = (rows: PnlSummaryItem[]) => ({
    count: rows.length,
    buyQty: rows.reduce((s, i) => s + i.buyQty, 0),
    sellQty: rows.reduce((s, i) => s + i.sellQty, 0),
    buyPrice: rows.reduce((s, i) => s + i.buyPrice, 0),
    sellPrice: rows.reduce((s, i) => s + i.sellPrice, 0),
    pnl: rows.reduce((s, i) => s + i.pnlCalculated, 0),
  });

  const equityTotals = subtotalFor(equityRows);
  const optionTotals = subtotalFor(optionRows);

  const tabCounts = {
    all: summaryList.length,
    equity: equityRows.length,
    options: optionRows.length,
    unlisted: summaryList.filter((i) => i.isUnlistedOption).length,
    open: summaryList.filter((i) => i.isDbOpenValued).length,
    matched: summaryList.filter((i) => i.isMatched).length,
    profit: summaryList.filter((i) => i.pnlCalculated > 0).length,
    loss: summaryList.filter((i) => i.pnlCalculated < 0).length,
    // Mirrors the filter above: option lines are counted under Options / Unlisted
    // Options, never under Unmatched.
    unmatched: summaryList.filter((i) => !i.isMatched && !isOptionRow(i)).length,
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      {/* Header Banner */}
      <div className="bg-paper-1 border border-paper-border rounded-2xl p-6 sm:p-8 relative overflow-hidden shadow-xs">
        <div className="absolute -top-12 -right-12 w-64 h-64 bg-green/5 rounded-full blur-3xl pointer-events-none" />
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 relative z-10">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-navy/5 text-navy text-xs font-semibold uppercase tracking-wider mb-2">
              <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 10h-4v4h-2v-4H7v-2h4V7h2v4h4v2z" />
              </svg>
              Admin Tool
            </div>
            <h1 className="text-2.5xl font-disp font-bold text-navy tracking-tight">
              In-Memory PNL Calculator
            </h1>
            <p className="text-mut text-sm max-w-2xl mt-1 leading-relaxed">
              Upload trade contract note Excel or CSV files to instantly parse, calculate, and download ticker-level P&L summaries without saving any data to the database.
            </p>
          </div>
          <button
            onClick={handleDownloadSample}
            className="inline-flex items-center gap-2 text-xs font-semibold text-navy bg-paper-2 hover:bg-paper-border border border-paper-border px-4 py-2.5 rounded-xl transition-all shadow-2xs"
          >
            <svg className="w-4 h-4 text-mut" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Download Sample Template
          </button>
        </div>
      </div>

      {/* File Upload Dropzone Section */}
      {!result && (
        <div className="bg-paper-1 border border-paper-border rounded-2xl p-6 sm:p-10 shadow-xs">
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`border-2 border-dashed rounded-2xl p-8 sm:p-12 text-center transition-all cursor-pointer ${
              isDragOver
                ? "border-green bg-green/5"
                : file
                ? "border-navy/40 bg-paper-2"
                : "border-paper-border hover:border-navy/30 bg-paper-2/50"
            }`}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleFileChange}
              accept=".xlsx,.xls,.csv"
              className="hidden"
            />

            <div className="w-14 h-14 rounded-2xl bg-paper-1 border border-paper-border flex items-center justify-center mx-auto mb-4 shadow-2xs text-navy">
              <svg className="w-7 h-7 stroke-[1.7]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M7 16a4 4 0 01-.88-7.903A5 5 0 0115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
            </div>

            {file ? (
              <div className="space-y-2">
                <p className="font-semibold text-navy text-base">{file.name}</p>
                <p className="text-xs text-mut">
                  {(file.size / 1024).toFixed(1)} KB · Ready for parsing
                </p>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setFile(null);
                  }}
                  className="text-xs font-semibold text-loss hover:underline pt-1 inline-block"
                >
                  Remove & pick another file
                </button>
              </div>
            ) : (
              <div className="space-y-1.5">
                <p className="font-semibold text-navy text-base">
                  Drag and drop your trade ledger file here
                </p>
                <p className="text-xs text-mut">
                  Supports <span className="font-medium text-navy">.xlsx</span>, <span className="font-medium text-navy">.xls</span>, or <span className="font-medium text-navy">.csv</span> contract note exports
                </p>
                <p className="text-2xs text-mut/80 pt-2">
                  (Columns expected: Security, Type, Units, Avg Price / Value, CNote, Status)
                </p>
              </div>
            )}
          </div>

          <div className="mt-6 flex justify-end gap-3">
            {file && (
              <button
                type="button"
                onClick={handleProcessFile}
                disabled={isProcessing}
                className="inline-flex items-center gap-2 font-semibold text-white bg-navy hover:bg-navy-h border border-transparent px-6 py-3 rounded-xl transition-all shadow-sm disabled:opacity-50 cursor-pointer"
              >
                {isProcessing ? (
                  <>
                    <svg className="animate-spin w-4 h-4 text-white" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Parsing File...
                  </>
                ) : (
                  <>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 7h6m-6 4h6m-6 4h4M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
                    </svg>
                    Calculate PNL Summary
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Parsing Errors Banner */}
      {result && result.errors.length > 0 && (
        <div className="bg-loss-bg/30 border border-loss/20 rounded-2xl p-5 text-sm text-loss flex items-start gap-3">
          <svg className="w-5 h-5 flex-none mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div>
            <p className="font-semibold">Processing Issue</p>
            <ul className="list-disc list-inside mt-1 space-y-1 text-xs">
              {result.errors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* KPI Cards & Results View */}
      {result && (
        <div className="space-y-6">
          {/* Metrics Overview */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Total PNL */}
            <div className="bg-paper-1 border border-paper-border rounded-2xl p-5 shadow-2xs space-y-1">
              <span className="text-2xs font-semibold uppercase tracking-wider text-mut">
                Total Net PNL
              </span>
              <p className={`text-2xl font-bold tracking-tight ${result.totalPnl >= 0 ? "text-green" : "text-loss"}`}>
                {fmtCurrency(result.totalPnl)}
              </p>
              <p className="text-xs text-mut">
                {result.matchedTickers} matched ({tabCounts.profit} profit, {tabCounts.loss} loss)
              </p>
              <p className="text-2xs text-mut">
                Equity{" "}
                <span className={equityTotals.pnl >= 0 ? "text-green font-semibold" : "text-loss font-semibold"}>
                  {fmtCurrency(equityTotals.pnl)}
                </span>{" "}
                · Options{" "}
                <span className={optionTotals.pnl >= 0 ? "text-green font-semibold" : "text-loss font-semibold"}>
                  {fmtCurrency(optionTotals.pnl)}
                </span>
              </p>
            </div>

            {/* Total Trades */}
            <div className="bg-paper-1 border border-paper-border rounded-2xl p-5 shadow-2xs space-y-1">
              <span className="text-2xs font-semibold uppercase tracking-wider text-mut">
                Parsed Trades
              </span>
              <p className="text-2xl font-bold tracking-tight text-navy">
                {result.totalTrades}
              </p>
              <p className="text-xs text-mut">Contract notes parsed</p>
            </div>

            {/* Total Buy Volume */}
            <div className="bg-paper-1 border border-paper-border rounded-2xl p-5 shadow-2xs space-y-1">
              <span className="text-2xs font-semibold uppercase tracking-wider text-mut">
                Total Buy Expenditure
              </span>
              <p className="text-2xl font-bold tracking-tight text-navy">
                {fmtCurrency(totalBuyVolume)}
              </p>
              <p className="text-xs text-mut">Sum of buy consideration</p>
            </div>

            {/* Total Sell Volume */}
            <div className="bg-paper-1 border border-paper-border rounded-2xl p-5 shadow-2xs space-y-1">
              <span className="text-2xs font-semibold uppercase tracking-wider text-mut">
                Total Sell Proceeds
              </span>
              <p className="text-2xl font-bold tracking-tight text-navy">
                {fmtCurrency(totalSellVolume)}
              </p>
              <p className="text-xs text-mut">Sum of sell proceeds</p>
            </div>
          </div>

          {/* Placement Tracker Integration Card */}
          <div className="bg-paper-1 border border-paper-border rounded-2xl p-5 shadow-2xs space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-paper-border pb-3">
              <div>
                <h3 className="text-sm font-bold text-navy flex items-center gap-2">
                  <span>Placement Tracker Integration (Direct Link & File Merge)</span>
                  <span className="text-3xs px-2 py-0.5 rounded-full bg-navy/10 text-navy font-semibold">
                    Auto-Enrichment
                  </span>
                </h3>
                <p className="text-2xs text-mut mt-0.5">
                  Paste a Google Sheets / SharePoint / Excel URL — private links included — or upload a Placement Tracker file to auto-fill missing Buy Qty (Round Shares), Buy Price (ACTUAL $), and client breakdowns.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="file"
                  multiple
                  ref={placementFileInputRef}
                  onChange={handleMergePlacementFile}
                  accept=".xlsx,.xls"
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => placementFileInputRef.current?.click()}
                  disabled={isMergingPlacementFile}
                  className="text-xs font-semibold text-navy bg-paper-2 hover:bg-paper-border border border-paper-border px-3.5 py-1.5 rounded-xl transition-all cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  <svg className="w-3.5 h-3.5 text-mut" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
                  </svg>
                  {isMergingPlacementFile ? "Merging Files..." : "Upload Placement (.xlsx)"}
                </button>
              </div>
            </div>

            {/* Active Uploaded Placement Files List */}
            {placementFiles.length > 0 && (
              <div className="flex items-center gap-2 flex-wrap pt-0.5 pb-1">
                <span className="text-3xs font-semibold text-mut uppercase tracking-wider">
                  Active Placement Files ({placementFiles.length}):
                </span>
                {placementFiles.map((pFile) => (
                  <div
                    key={pFile.id}
                    className="inline-flex items-center gap-1.5 bg-paper-2 border border-paper-border px-2.5 py-1 rounded-lg text-xs text-navy shadow-2xs"
                  >
                    <svg className="w-3.5 h-3.5 text-green-d flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0" />
                    </svg>
                    <span className="font-semibold text-2xs max-w-[170px] truncate" title={pFile.name}>
                      {pFile.name}
                    </span>
                    <span className="text-3xs text-mut font-medium">({pFile.tickerCount} tickers)</span>
                    <button
                      type="button"
                      onClick={() => handleRemovePlacementFile(pFile.id)}
                      className="text-mut hover:text-loss p-0.5 rounded transition-colors cursor-pointer ml-0.5"
                      title={`Remove ${pFile.name}`}
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                ))}
                {placementFiles.length > 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      setPlacementFiles([]);
                      reapplyPlacementMerges([]);
                      setPlacementMsg({ type: "success", text: "Cleared all placement files." });
                    }}
                    className="text-3xs font-semibold text-loss hover:underline cursor-pointer ml-1"
                  >
                    Clear All
                  </button>
                )}
              </div>
            )}

            {/* Account holder selector — a placement sheet lists every client in
                the placement, so this picks whose allocation rows to merge. */}
            {placementClientNames.length > 0 && (
              <div className="flex flex-col sm:flex-row sm:items-center gap-2.5 pt-0.5">
                <label
                  htmlFor="placement-client"
                  className="text-3xs font-semibold text-mut uppercase tracking-wider whitespace-nowrap"
                >
                  Account Holder
                </label>
                <select
                  id="placement-client"
                  value={placementClient}
                  onChange={(e) => handleSelectPlacementClient(e.target.value)}
                  className="w-full sm:w-auto sm:min-w-[260px] bg-paper-2/60 border border-paper-border rounded-xl px-3 py-1.5 text-xs font-semibold text-navy focus:outline-none focus:border-navy cursor-pointer"
                >
                  <option value={AUTO_CLIENT}>
                    Auto-detect from trade file name
                    {autoDetectedClients.length > 0 ? ` (${autoDetectedClients.join(", ")})` : ""}
                  </option>
                  {placementClientNames.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <span className="text-3xs text-mut leading-relaxed">
                  Whose Round Shares / ACTUAL $ to fill in. Only this holder&apos;s allocation is
                  used — never the placement total.
                </span>
              </div>
            )}

            <div className="flex flex-col sm:flex-row items-center gap-3">
              <div className="relative flex-1 w-full">
                <input
                  type="url"
                  value={placementUrl}
                  onChange={(e) => setPlacementUrl(e.target.value)}
                  placeholder="Paste Placement Tracker Link (Google Sheets, SharePoint/OneDrive, or direct .xlsx URL)..."
                  className="w-full bg-paper-2/60 border border-paper-border rounded-xl px-3.5 py-2 text-xs font-mono text-navy focus:outline-none focus:border-navy"
                />
              </div>
              <button
                type="button"
                onClick={handleMergeUrl}
                disabled={isFetchingUrl || !placementUrl.trim()}
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 text-xs font-semibold text-white bg-navy hover:bg-navy-h px-5 py-2 rounded-xl transition-all shadow-2xs disabled:opacity-50 cursor-pointer"
              >
                {isFetchingUrl ? (
                  <>
                    <svg className="animate-spin w-3.5 h-3.5 text-white" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Fetching & Merging...
                  </>
                ) : (
                  "Fetch & Auto-Merge Link"
                )}
              </button>
            </div>

            {placementMsg && (
              <div
                className={`text-2xs p-3 rounded-xl flex items-start justify-between gap-3 ${
                  placementMsg.type === "success"
                    ? "bg-green-bg text-green-d border border-green/20"
                    : "bg-loss-bg text-loss-d border border-loss/20"
                }`}
              >
                <div className="space-y-1">
                  <span>{placementMsg.text}</span>
                  {placementMsg.hint && (
                    <p className="text-3xs opacity-80 leading-relaxed">{placementMsg.hint}</p>
                  )}
                </div>
                <button
                  onClick={() => setPlacementMsg(null)}
                  className="text-3xs underline font-semibold cursor-pointer flex-shrink-0"
                >
                  Dismiss
                </button>
              </div>
            )}
          </div>

          {/* Action & Filter Toolbar */}
          <div className="bg-paper-1 border border-paper-border rounded-2xl p-4 sm:p-5 space-y-3.5 shadow-2xs">
            {/* Active Uploaded Trade Files Badges */}
            {tradeFiles.length > 0 && (
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-3 border-b border-paper-border/70">
                <div className="flex items-center gap-2 text-xs font-semibold text-navy">
                  <svg className="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                  <span>Active Trade File:</span>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  {tradeFiles.map((tf) => (
                    <span
                      key={tf.id}
                      className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium bg-emerald-50 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 rounded-xl"
                    >
                      <span className="truncate max-w-[180px] font-semibold">{tf.name}</span>
                      <span className="text-[10px] bg-emerald-200/60 dark:bg-emerald-800/60 px-1.5 py-0.5 rounded-md font-mono font-bold">
                        {tf.tradeCount} trades
                      </span>
                      <button
                        type="button"
                        onClick={() => handleRemoveTradeFile(tf.id)}
                        className="ml-0.5 text-emerald-500 hover:text-red-600 dark:hover:text-red-400 font-bold focus:outline-none cursor-pointer"
                        title="Remove file"
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                  {/* One trade file at a time — uploading another replaces this one, so
                      there is no "add more" control. */}
                  <span className="text-[10px] text-mut italic">
                    Upload another file to replace it
                  </span>
                </div>
              </div>
            )}

            {/* Account Filter Bar (external_ref / broker account) */}
            {result?.accounts && result.accounts.length > 0 && (
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-3 border-b border-paper-border/70">
                <div className="flex items-center gap-2 text-xs font-semibold text-navy">
                  <svg className="w-4 h-4 text-mut" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                  <span>Client Account (external_ref):</span>
                </div>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <button
                    onClick={() => handleSelectAccount("all")}
                    className={`px-3 py-1 rounded-xl text-xs font-semibold transition-all cursor-pointer ${
                      selectedAccount === "all"
                        ? "bg-navy text-white shadow-xs"
                        : "bg-paper-2 text-mut hover:text-navy border border-paper-border"
                    }`}
                  >
                    All Accounts ({result.accounts.length})
                  </button>
                  {result.accounts.map((accNo) => (
                    <button
                      key={accNo}
                      onClick={() => handleSelectAccount(accNo)}
                      className={`px-3 py-1 rounded-xl text-xs font-semibold transition-all cursor-pointer ${
                        selectedAccount === accNo
                          ? "bg-navy text-white shadow-xs"
                          : "bg-paper-2 text-mut hover:text-navy border border-paper-border hover:border-navy/30"
                      }`}
                    >
                      Account #{accNo}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Filter Pills Bar — Full width on Desktop so all tabs fit with ZERO scrolling */}
            <div className="flex items-center gap-1.5 bg-paper-2/90 p-1.5 rounded-2xl border border-paper-border text-xs font-medium overflow-x-auto lg:overflow-visible flex-wrap sm:flex-nowrap shadow-inner">
              {(
                [
                  "all",
                  "equity",
                  "options",
                  "unlisted",
                  "open",
                  "matched",
                  "profit",
                  "loss",
                  "unmatched",
                ] as const
              ).map((f) => {
                const active = filterType === f;
                const count = tabCounts[f];
                const labels: Record<string, string> = {
                  all: "All Tickers",
                  equity: "Equity",
                  options: "Options",
                  unlisted: "Unlisted Options",
                  open: "Open",
                  matched: "Matched P&L",
                  profit: "Profit Only",
                  loss: "Loss Only",
                  unmatched: "Unmatched",
                };
                return (
                  <button
                    key={f}
                    onClick={() => setFilterType(f)}
                    className={`flex-1 sm:flex-initial flex items-center justify-center gap-2 px-3.5 py-2 rounded-xl transition-all duration-150 text-xs font-semibold whitespace-nowrap cursor-pointer ${
                      active
                        ? "bg-navy text-white shadow-xs"
                        : "text-mut hover:text-navy hover:bg-paper-1/70"
                    }`}
                  >
                    <span>{labels[f]}</span>
                    <span
                      className={`px-1.5 py-0.5 rounded-md text-3xs font-bold transition-colors ${
                        active
                          ? "bg-white/20 text-white"
                          : "bg-paper-border/80 text-navy/80"
                      }`}
                    >
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            {/* Controls Row: Search Input on left, Export & Action Buttons on right */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
              {/* Search Bar */}
              <div className="relative flex-1 max-w-md">
                <svg className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 text-mut" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  type="text"
                  placeholder="Search ticker or company..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-paper-2 border border-paper-border rounded-xl pl-9 pr-8 py-2 text-xs text-navy focus:outline-none focus:border-navy focus:bg-paper-1 transition-all"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery("")}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-mut hover:text-navy p-0.5"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>

              {/* Download Export Buttons & Reset */}
              <div className="flex items-center gap-2 flex-wrap sm:flex-nowrap">
                <button
                  onClick={() => handleSyncDbHoldings()}
                  disabled={isSyncingDb}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 px-3.5 py-2 rounded-xl transition-all shadow-2xs cursor-pointer disabled:opacity-50"
                  title="Auto-fill Qty & Market Value from Database Portfolio Holdings for open positions"
                >
                  <svg className="w-4 h-4 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  {isSyncingDb ? "Syncing DB..." : "Sync DB Market Value"}
                </button>

                <button
                  onClick={handleDownloadXlsx}
                  disabled={isExportingXlsx}
                  className="inline-flex items-center gap-2 text-xs font-semibold text-white bg-green hover:bg-green-h px-4 py-2 rounded-xl transition-all shadow-2xs cursor-pointer disabled:opacity-50"
                  title="Export as Microsoft Excel (.xlsx)"
                >
                  {isExportingXlsx ? (
                    "Exporting..."
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                      Excel (.xlsx)
                    </>
                  )}
                </button>

                <button
                  onClick={handleDownloadCsv}
                  disabled={isExportingCsv}
                  className="inline-flex items-center gap-2 text-xs font-semibold text-navy bg-paper-2 hover:bg-paper-border border border-paper-border px-3.5 py-2 rounded-xl transition-all shadow-2xs cursor-pointer disabled:opacity-50"
                  title="Export as CSV (.csv)"
                >
                  {isExportingCsv ? (
                    "Exporting..."
                  ) : (
                    <>
                      <svg className="w-4 h-4 text-mut" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                      CSV (.csv)
                    </>
                  )}
                </button>

                <button
                  onClick={handleReset}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-mut hover:text-loss border border-paper-border hover:border-loss/30 px-3 py-2 rounded-xl transition-all cursor-pointer"
                  title="Reset & upload new trade ledger file"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  New
                </button>
              </div>
            </div>
          </div>

          {/* Results Summary Table */}
          <div className="bg-paper-1 border border-paper-border rounded-2xl overflow-hidden shadow-2xs">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-paper-2 text-navy border-b border-paper-border text-2xs font-semibold uppercase tracking-wider">
                    <th className="py-3.5 px-4">Ticker</th>
                    <th className="py-3.5 px-4">Company</th>
                    <th className="py-3.5 px-4 text-right">Buy Qty (Sum)</th>
                    <th className="py-3.5 px-4 text-right">Sell Qty (Sum)</th>
                    <th className="py-3.5 px-4 text-right">Buy Price (Sum)</th>
                    <th className="py-3.5 px-4 text-right">Sell Price (Sum)</th>
                    <th className="py-3.5 px-4 text-right">PnL Calculated</th>
                    <th className="py-3.5 px-4">Comments</th>
                    <th className="py-3.5 px-4 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-paper-border text-xs">
                  {filteredSummary.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="py-12 text-center text-mut">
                        No ticker records found matching your filters.
                      </td>
                    </tr>
                  ) : (
                    filteredSummary.map((item) => {
                      const isEditing = editingTicker === item.ticker;

                      if (isEditing) {
                        return (
                          <tr key={item.ticker} className="bg-paper-2/90 border-l-4 border-l-navy transition-colors">
                            <td className="py-3 px-4 font-bold text-navy">
                              <div className="flex items-center gap-1.5">
                                <span>{item.ticker}</span>
                                <span className="text-3xs px-1 py-0.5 rounded bg-navy text-white font-semibold">
                                  Editing
                                </span>
                              </div>
                            </td>
                            <td className="py-3 px-4 text-mut text-xs max-w-[180px] truncate" title={item.company}>
                              {item.company}
                            </td>
                            <td className="py-3 px-2 text-right">
                              <input
                                type="number"
                                value={editForm.buyQty}
                                onChange={(e) => setEditForm({ ...editForm, buyQty: e.target.value })}
                                className="w-24 bg-paper-1 border border-paper-border rounded-lg px-2 py-1 text-right text-xs font-mono focus:outline-none focus:border-navy"
                                placeholder="Buy Qty"
                              />
                            </td>
                            <td className="py-3 px-2 text-right">
                              <input
                                type="number"
                                value={editForm.sellQty}
                                onChange={(e) => setEditForm({ ...editForm, sellQty: e.target.value })}
                                className="w-24 bg-paper-1 border border-paper-border rounded-lg px-2 py-1 text-right text-xs font-mono focus:outline-none focus:border-navy"
                                placeholder="Sell Qty"
                              />
                            </td>
                            <td className="py-3 px-2 text-right">
                              <input
                                type="number"
                                step="0.01"
                                value={editForm.buyPrice}
                                onChange={(e) => setEditForm({ ...editForm, buyPrice: e.target.value })}
                                className="w-28 bg-paper-1 border border-paper-border rounded-lg px-2 py-1 text-right text-xs font-mono focus:outline-none focus:border-navy"
                                placeholder="Buy Price $"
                              />
                            </td>
                            <td className="py-3 px-2 text-right">
                              <div className="space-y-1">
                                <input
                                  type="number"
                                  step="0.01"
                                  value={editForm.sellPrice}
                                  onChange={(e) => setEditForm({ ...editForm, sellPrice: e.target.value })}
                                  className="w-28 bg-paper-1 border border-paper-border rounded-lg px-2 py-1 text-right text-xs font-mono focus:outline-none focus:border-navy"
                                  placeholder="Sell Price $"
                                />
                                {item.openQty > 0 && (
                                  <div className="text-3xs text-mut">
                                    <input
                                      type="number"
                                      step="0.01"
                                      value={editForm.marketPrice}
                                      onChange={(e) => setEditForm({ ...editForm, marketPrice: e.target.value })}
                                      className="w-28 bg-paper-1 border border-paper-border rounded-lg px-1.5 py-0.5 text-right text-3xs font-mono text-navy focus:outline-none focus:border-navy"
                                      placeholder="Mkt Price ($/u)"
                                      title="Enter current market price per unit to value open position"
                                    />
                                  </div>
                                )}
                              </div>
                            </td>
                            <td className="py-3 px-4 text-right text-2xs italic text-mut">
                              Auto-calculated on save
                            </td>
                            <td className="py-3 px-4 text-2xs text-mut">
                              {item.comment || ""}
                            </td>
                            <td className="py-3 px-4 text-center">
                              <div className="flex items-center justify-center gap-1.5">
                                <button
                                  onClick={() => handleSaveEdit(item.ticker)}
                                  className="p-1.5 rounded-lg bg-green text-white hover:bg-green-h transition-all cursor-pointer shadow-2xs"
                                  title="Save Changes"
                                >
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7" />
                                  </svg>
                                </button>
                                <button
                                  onClick={handleCancelEdit}
                                  className="p-1.5 rounded-lg bg-paper-2 text-mut hover:text-navy border border-paper-border transition-all cursor-pointer"
                                  title="Cancel Edit"
                                >
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                                  </svg>
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      }

                      return (
                        <tr key={item.ticker} className="hover:bg-paper-2/60 transition-colors">
                          <td className="py-3.5 px-4 font-bold text-navy">
                            <div className="flex items-center gap-2">
                              <span>{item.ticker}</span>
                              {item.isUnlistedOption && (
                                <button
                                  type="button"
                                  aria-label={`Black-Scholes valuation inputs for ${item.ticker}`}
                                  className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-amber-bg text-amber-d border border-amber-200 hover:bg-amber-d hover:text-white transition-colors cursor-help shrink-0"
                                  onMouseEnter={(e) =>
                                    // Clamped to the viewport: the card is w-[22rem]
                                    // (352px) and ~300px tall, and `fixed` coords are
                                    // viewport-relative, so both axes need a stop.
                                    setUnlistedTip({
                                      item,
                                      left: Math.max(8, Math.min(e.clientX + 14, window.innerWidth - 368)),
                                      top: Math.max(8, Math.min(e.clientY + 14, window.innerHeight - 310)),
                                    })
                                  }
                                  onMouseLeave={() => setUnlistedTip(null)}
                                  onFocus={(e) => {
                                    const r = e.currentTarget.getBoundingClientRect();
                                    setUnlistedTip({
                                      item,
                                      left: Math.max(8, Math.min(r.right + 10, window.innerWidth - 368)),
                                      top: Math.max(8, Math.min(r.bottom + 8, window.innerHeight - 310)),
                                    });
                                  }}
                                  onBlur={() => setUnlistedTip(null)}
                                >
                                  <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M12 16v-5m0-4h.01" />
                                  </svg>
                                </button>
                              )}
                              {item.isEnriched && (
                                <span className="text-3xs px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200 font-semibold" title="Buy Qty and Buy Price merged from Placement Tracker">
                                  Enriched
                                </span>
                              )}
                              {/* Merged and modelled rows carry their note in the
                                  Comments column, not as a badge here. Hover that
                                  cell for the full valuation breakdown. */}
                              {item.isEdited && (
                                <span className="text-3xs px-1.5 py-0.5 rounded bg-navy/10 text-navy font-semibold">
                                  Edited
                                </span>
                              )}
                              {isOptionRow(item) ? (
                                <span
                                  className="text-3xs px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-200 font-semibold"
                                  title={`Option line — reported separately from the ${summaryParentTicker(item)} equity line`}
                                >
                                  Option
                                </span>
                              ) : (
                                <span
                                  className="text-3xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200 font-semibold"
                                  title="Ordinary equity line (includes non-option derivatives)"
                                >
                                  Equity
                                </span>
                              )}
                              {item.isMatched ? (
                                <span className="text-3xs px-1.5 py-0.5 rounded bg-green-bg text-green-d font-semibold">
                                  Matched
                                </span>
                              ) : isOptionRow(item) ? null : (
                                // Options are deliberately exempt: an option line's
                                // buy and sell legs are not expected to balance, so
                                // an Unmatched flag on it is noise, not a finding.
                                <span
                                  className="text-3xs px-1.5 py-0.5 rounded bg-amber-bg text-amber-d font-semibold"
                                  title={`Unmatched buy/sell quantities — ${fmtQty(Math.abs(item.openQty))} ${
                                    item.openQty > 0 ? "unsold" : "sold without a recorded buy"
                                  }`}
                                >
                                  Unmatched
                                </span>
                              )}
                            </div>
                            {isOptionRow(item) && (
                              <span className="text-3xs font-normal text-mut">
                                Underlying {summaryParentTicker(item)}
                              </span>
                            )}
                          </td>
                          <td className="py-3.5 px-4 text-mut truncate max-w-[200px]" title={item.company}>
                            {item.company}
                          </td>
                          <td className="py-3.5 px-4 text-right font-mono text-navy">
                            {fmtQty(item.buyQty)}
                          </td>
                          <td className="py-3.5 px-4 text-right font-mono text-navy">
                            {fmtQty(item.sellQty)}
                          </td>
                          <td className="py-3.5 px-4 text-right font-mono text-navy">
                            {fmtCurrency(item.buyPrice)}
                          </td>
                          <td className="py-3.5 px-4 text-right font-mono text-navy">
                            {fmtCurrency(item.sellPrice)}
                          </td>
                          <td className="py-3.5 px-4 text-right font-mono font-bold">
                            <span
                              className={`inline-block px-2.5 py-1 rounded-lg ${
                                item.pnlCalculated > 0
                                  ? "bg-green-bg text-green-d"
                                  : item.pnlCalculated < 0
                                  ? "bg-loss-bg text-loss-d"
                                  : "bg-paper-2 text-mut"
                              }`}
                            >
                              {fmtCurrency(item.pnlCalculated)}
                            </span>
                          </td>
                          <td className="py-3.5 px-4">
                            {item.comment && (
                              <span
                                className={`text-3xs px-1.5 py-0.5 rounded border font-semibold whitespace-nowrap ${
                                  // "Open" is a statement of fact, not something to
                                  // look into — only the merges get the amber.
                                  item.comment === "Open"
                                    ? "bg-paper-2 text-mut border-paper-border"
                                    : "bg-amber-bg text-amber-d border-amber-200"
                                }`}
                                title={commentHint(item)}
                              >
                                {item.comment}
                              </span>
                            )}
                          </td>
                          <td className="py-3.5 px-4 text-center">
                            <button
                              onClick={() => handleStartEdit(item)}
                              className="inline-flex items-center gap-1 text-xs font-semibold text-mut hover:text-navy px-2.5 py-1 rounded-lg border border-paper-border hover:bg-paper-2 transition-all cursor-pointer"
                              title="Edit position values manually"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                              </svg>
                              Edit
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
                {filteredSummary.length > 0 && (
                  <tfoot>
                    {/* Equity and options are subtotalled separately — GED and
                        GEDO are different books, then combined below. */}
                    {([
                      { label: "Equity Subtotal", totals: equityTotals },
                      { label: "Options Subtotal", totals: optionTotals },
                    ] as const)
                      .filter(({ totals }) => totals.count > 0)
                      .map(({ label, totals }) => (
                        <tr
                          key={label}
                          className="bg-paper-2/50 font-semibold text-navy border-t border-paper-border text-xs"
                        >
                          <td className="py-3 px-4" colSpan={2}>
                            {label} ({totals.count} ticker{totals.count === 1 ? "" : "s"})
                          </td>
                          <td className="py-3 px-4 text-right font-mono">{fmtQty(totals.buyQty)}</td>
                          <td className="py-3 px-4 text-right font-mono">{fmtQty(totals.sellQty)}</td>
                          <td className="py-3 px-4 text-right font-mono">{fmtCurrency(totals.buyPrice)}</td>
                          <td className="py-3 px-4 text-right font-mono">{fmtCurrency(totals.sellPrice)}</td>
                          <td className="py-3 px-4 text-right font-mono" colSpan={3}>
                            <span
                              className={`inline-block px-2.5 py-1 rounded-lg ${
                                totals.pnl >= 0 ? "bg-green-bg text-green-d" : "bg-loss-bg text-loss-d"
                              }`}
                            >
                              {fmtCurrency(totals.pnl)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    <tr className="bg-paper-2 font-bold text-navy border-t border-paper-border text-xs">
                      <td className="py-4 px-4" colSpan={2}>
                        Grand Total ({summaryList.length} total tickers)
                      </td>
                      <td className="py-4 px-4 text-right font-mono">
                        {fmtQty(summaryList.reduce((s, i) => s + i.buyQty, 0))}
                      </td>
                      <td className="py-4 px-4 text-right font-mono">
                        {fmtQty(summaryList.reduce((s, i) => s + i.sellQty, 0))}
                      </td>
                      <td className="py-4 px-4 text-right font-mono">
                        {fmtCurrency(totalBuyVolume)}
                      </td>
                      <td className="py-4 px-4 text-right font-mono">
                        {fmtCurrency(totalSellVolume)}
                      </td>
                      <td className="py-4 px-4 text-right font-mono" colSpan={3}>
                        <span
                          className={`inline-block px-2.5 py-1 rounded-lg ${
                            result.totalPnl >= 0 ? "bg-green-bg text-green-d" : "bg-loss-bg text-loss-d"
                          }`}
                        >
                          {fmtCurrency(result.totalPnl)}
                        </span>
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Unlisted-option valuation card. Rendered at the component root with `fixed`
          positioning so the table's scroll container cannot clip it.

          Styled with real theme tokens only — `bg-card` / `border-line` / `text-[11px]`.
          `bg-paper-1`, `border-paper-border` and `text-2xs`/`text-3xs` are used widely
          in this file but are NOT defined in app/globals.css, so they resolve to
          nothing: inside the table that is invisible (rows inherit `text-xs` and sit on
          a painted parent), but out here it left the card transparent with 16px text
          piling on top of itself. */}
      {unlistedTip?.item.unlistedOption && (
        <div
          role="tooltip"
          className="fixed z-[100] w-[22rem] pointer-events-none rounded-xl border border-line bg-card shadow-shadow-lg overflow-hidden"
          style={{ left: unlistedTip.left, top: unlistedTip.top }}
        >
          <div className="flex items-center justify-between gap-2 px-3.5 py-2 bg-navy">
            <span className="text-[11px] font-bold tracking-wide text-white leading-tight">
              {unlistedTip.item.ticker} · Unlisted Option
            </span>
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-white/20 text-white whitespace-nowrap">
              MODEL PRICE
            </span>
          </div>

          <div className="px-3.5 py-2.5">
            <p className="text-[10px] text-mut italic leading-snug mb-2 break-words">
              {unlistedTip.item.unlistedOption.addOn.raw}
            </p>

            {/* Fixed label column + right-aligned value column, so a long value wraps
                inside its own cell instead of colliding with the label. */}
            <dl className="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-1 text-[11px] leading-snug">
              {(
                [
                  [
                    "Entitlement",
                    `${unlistedTip.item.unlistedOption.addOn.ratioOptions}:${unlistedTip.item.unlistedOption.addOn.ratioPerShares}`,
                  ],
                  [
                    // A piggyback is earned off the base grant, not off the stock,
                    // so the card has to name what the ratio was applied to.
                    unlistedTip.item.unlistedOption.basisKind === "shares"
                      ? "on shares held"
                      : "on base options",
                    fmtQty(unlistedTip.item.unlistedOption.basisQty),
                  ],
                  ["Options granted", fmtQty(unlistedTip.item.sellQty)],
                  ["Spot", `${fmtCurrency(unlistedTip.item.unlistedOption.spot)} · ${unlistedTip.item.unlistedOption.spotSource}`],
                  ["Strike", fmtCurrency(unlistedTip.item.unlistedOption.addOn.strike)],
                  ["Expiry", unlistedTip.item.unlistedOption.addOn.expiry],
                  ["Time to expiry", `${unlistedTip.item.unlistedOption.timeToExpiryYears.toFixed(2)} yrs`],
                  [
                    "Vol / Rate / Div",
                    `${(unlistedTip.item.unlistedOption.volatility * 100).toFixed(0)}% / ${(
                      unlistedTip.item.unlistedOption.riskFreeRate * 100
                    ).toFixed(0)}% / ${(unlistedTip.item.unlistedOption.dividendYield * 100).toFixed(0)}%`,
                  ],
                ] as const
              ).map(([label, value]) => (
                <React.Fragment key={label}>
                  <dt className="text-mut">{label}</dt>
                  <dd className="font-mono text-ink text-right break-words">{value}</dd>
                </React.Fragment>
              ))}
            </dl>

            <dl className="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-1 text-[11px] leading-snug mt-2 pt-2 border-t border-line">
              <dt className="text-mut">B-S / option</dt>
              <dd className="font-mono text-ink text-right">
                {fmtCurrency(unlistedTip.item.unlistedOption.optionPrice)}
              </dd>
              <dt className="font-bold text-ink">Row P&amp;L</dt>
              <dd
                className={`font-mono font-bold text-right ${
                  unlistedTip.item.pnlCalculated >= 0 ? "text-green-d" : "text-loss-d"
                }`}
              >
                {fmtCurrency(unlistedTip.item.pnlCalculated)}
              </dd>
            </dl>

            {/* `yahoo` and `asx` are both live quotes, so neither is warned about —
                only a stale snapshot or no price at all. */}
            {!LIVE_SPOT_SOURCES.includes(unlistedTip.item.unlistedOption.spotSource) && (
              <p className="mt-2 text-[10px] text-amber-d bg-amber-bg border border-amber rounded-lg px-2 py-1.5 leading-snug">
                {unlistedTip.item.unlistedOption.spotSource === "database"
                  ? "No live quote from Yahoo or the ASX — priced off the last holdings snapshot, so it is as stale as the last import."
                  : "No price from Yahoo, the ASX or the database, so this row is valued at $0."}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
