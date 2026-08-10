import { create } from "zustand";
import type { ParseResult, PlacementTickerInfo } from "@/lib/pnl-calculator";

/**
 * Working state for the P&L Calculator, held OUTSIDE the route component.
 *
 * The calculator is a long session: several trade files, a placement tracker, an
 * account filter, manual row edits. Navigating to another portal tab unmounts the
 * route, and with it every `useState` — so coming back meant re-uploading and
 * re-merging everything from scratch. A module-scope store survives client-side
 * navigation because the module is not re-evaluated.
 *
 * DELIBERATELY IN-MEMORY ONLY. The calculator's contract is that a client's trade
 * data is parsed and discarded without ever being stored (`parsePnlFileAction`:
 * "Zero database calls or storage"), so this state must not reach localStorage or
 * sessionStorage either. A full reload, a new tab, or closing the browser clears
 * it — which is the intended lifetime, not a limitation to work around.
 *
 * Because the store outlives the route, it also outlives a client-side sign-out.
 * `reset()` exists for that: call it if a logout is ever handled without a full
 * document navigation, so one staff member's parsed client data cannot be sitting
 * in memory for the next.
 */

export interface UploadedPlacementFile {
  id: string;
  name: string;
  map: Map<string, PlacementTickerInfo>;
  tickerCount: number;
  /**
   * Came from `PLACEMENT_TRACKER_URL` rather than from a person.
   *
   * Resetting the calculator keeps these: they are configuration, not the user's work,
   * and re-fetching means another ~12s parse of a 12 MB workbook.
   */
  configured?: boolean;
}

export interface UploadedTradeFile {
  id: string;
  name: string;
  rawTrades: any[];
  tradeCount: number;
  accounts: string[];
}

export type PnlFilterType =
  | "all"
  | "equity"
  | "options"
  | "unlisted"
  | "open"
  | "matched"
  | "profit"
  | "loss"
  | "unmatched";

/** Sentinel for "derive the account holder from the trade-file names". */
export const AUTO_CLIENT = "__auto__";

/** Mirrors React's `Dispatch<SetStateAction<T>>` so call sites need no rewrite. */
type Setter<T> = (value: T | ((prev: T) => T)) => void;

const next = <T,>(value: T | ((prev: T) => T), prev: T): T =>
  typeof value === "function" ? (value as (p: T) => T)(prev) : value;

interface PnlCalculatorState {
  tradeFiles: UploadedTradeFile[];
  result: ParseResult | null;
  placementFiles: UploadedPlacementFile[];
  parsedPlacementMap: Map<string, PlacementTickerInfo> | null;
  selectedAccount: string;
  /**
   * Inclusive `YYYY-MM-DD` window on the ledger's Contract Date, `""` for open-ended.
   *
   * Held here rather than in component state for the same reason the account filter
   * is: the route remounts on every portal-tab navigation, and a reporting period the
   * desk just set must not silently widen back to "everything" behind their back.
   */
  dateFrom: string;
  dateTo: string;
  placementClient: string;
  placementUrl: string;
  filterType: PnlFilterType;
  searchQuery: string;
  /**
   * Broker account number → account holder's name, resolved from the database.
   *
   * The trade file's `Account` column identifies the client far more reliably than
   * its filename does, so this is what the Placement Tracker merge matches on.
   */
  accountHolders: Record<string, string>;
  /**
   * Broker account number → the OTHER names the Placement Tracker calls that
   * holder (`clients.placement_aliases`).
   *
   * Kept beside `accountHolders` rather than folded into it because the UI labels
   * an account with one name while the merge may match on any of them.
   */
  accountAliases: Record<string, string[]>;
  /**
   * Whether the standing `PLACEMENT_TRACKER_URL` load has already been attempted.
   *
   * Lives in the store, not in component state, precisely because the route remounts
   * on every tab navigation — a component-level flag would re-trigger a ~12s fetch
   * and parse each time. Set before the await so React's double-invoke in development
   * cannot fire it twice either.
   */
  configuredTrackersAttempted: boolean;

  setTradeFiles: Setter<UploadedTradeFile[]>;
  setResult: Setter<ParseResult | null>;
  setPlacementFiles: Setter<UploadedPlacementFile[]>;
  setParsedPlacementMap: Setter<Map<string, PlacementTickerInfo> | null>;
  setSelectedAccount: Setter<string>;
  setDateFrom: Setter<string>;
  setDateTo: Setter<string>;
  setPlacementClient: Setter<string>;
  setPlacementUrl: Setter<string>;
  setFilterType: Setter<PnlFilterType>;
  setSearchQuery: Setter<string>;
  setAccountHolders: Setter<Record<string, string>>;
  setAccountAliases: Setter<Record<string, string[]>>;
  setConfiguredTrackersAttempted: Setter<boolean>;

  /** Drop everything back to a fresh calculator. */
  reset: () => void;
}

/**
 * A factory, not a shared object: every `reset()` must hand back fresh collections
 * rather than re-seating the same `[]` instance that a previous session was using.
 */
const initialState = () => ({
  tradeFiles: [] as UploadedTradeFile[],
  result: null as ParseResult | null,
  placementFiles: [] as UploadedPlacementFile[],
  parsedPlacementMap: null as Map<string, PlacementTickerInfo> | null,
  selectedAccount: "all",
  dateFrom: "",
  dateTo: "",
  placementClient: AUTO_CLIENT,
  placementUrl: "",
  filterType: "all" as PnlFilterType,
  searchQuery: "",
  accountHolders: {} as Record<string, string>,
  accountAliases: {} as Record<string, string[]>,
  configuredTrackersAttempted: false,
});

export const usePnlCalculatorStore = create<PnlCalculatorState>()((set) => ({
  ...initialState(),

  setTradeFiles: (v) => set((s) => ({ tradeFiles: next(v, s.tradeFiles) })),
  setResult: (v) => set((s) => ({ result: next(v, s.result) })),
  setPlacementFiles: (v) => set((s) => ({ placementFiles: next(v, s.placementFiles) })),
  setParsedPlacementMap: (v) => set((s) => ({ parsedPlacementMap: next(v, s.parsedPlacementMap) })),
  setSelectedAccount: (v) => set((s) => ({ selectedAccount: next(v, s.selectedAccount) })),
  setDateFrom: (v) => set((s) => ({ dateFrom: next(v, s.dateFrom) })),
  setDateTo: (v) => set((s) => ({ dateTo: next(v, s.dateTo) })),
  setPlacementClient: (v) => set((s) => ({ placementClient: next(v, s.placementClient) })),
  setPlacementUrl: (v) => set((s) => ({ placementUrl: next(v, s.placementUrl) })),
  setFilterType: (v) => set((s) => ({ filterType: next(v, s.filterType) })),
  setSearchQuery: (v) => set((s) => ({ searchQuery: next(v, s.searchQuery) })),
  setAccountHolders: (v) => set((s) => ({ accountHolders: next(v, s.accountHolders) })),
  setAccountAliases: (v) => set((s) => ({ accountAliases: next(v, s.accountAliases) })),
  setConfiguredTrackersAttempted: (v) =>
    set((s) => ({ configuredTrackersAttempted: next(v, s.configuredTrackersAttempted) })),

  reset: () => set(initialState()),
}));
