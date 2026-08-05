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

  setTradeFiles: Setter<UploadedTradeFile[]>;
  setResult: Setter<ParseResult | null>;
  setPlacementFiles: Setter<UploadedPlacementFile[]>;
  setParsedPlacementMap: Setter<Map<string, PlacementTickerInfo> | null>;
  setSelectedAccount: Setter<string>;
  setPlacementClient: Setter<string>;
  setPlacementUrl: Setter<string>;
  setFilterType: Setter<PnlFilterType>;
  setSearchQuery: Setter<string>;
  setAccountHolders: Setter<Record<string, string>>;

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
  placementClient: AUTO_CLIENT,
  placementUrl: "",
  filterType: "all" as PnlFilterType,
  searchQuery: "",
  accountHolders: {} as Record<string, string>,
});

export const usePnlCalculatorStore = create<PnlCalculatorState>()((set) => ({
  ...initialState(),

  setTradeFiles: (v) => set((s) => ({ tradeFiles: next(v, s.tradeFiles) })),
  setResult: (v) => set((s) => ({ result: next(v, s.result) })),
  setPlacementFiles: (v) => set((s) => ({ placementFiles: next(v, s.placementFiles) })),
  setParsedPlacementMap: (v) => set((s) => ({ parsedPlacementMap: next(v, s.parsedPlacementMap) })),
  setSelectedAccount: (v) => set((s) => ({ selectedAccount: next(v, s.selectedAccount) })),
  setPlacementClient: (v) => set((s) => ({ placementClient: next(v, s.placementClient) })),
  setPlacementUrl: (v) => set((s) => ({ placementUrl: next(v, s.placementUrl) })),
  setFilterType: (v) => set((s) => ({ filterType: next(v, s.filterType) })),
  setSearchQuery: (v) => set((s) => ({ searchQuery: next(v, s.searchQuery) })),
  setAccountHolders: (v) => set((s) => ({ accountHolders: next(v, s.accountHolders) })),

  reset: () => set(initialState()),
}));
