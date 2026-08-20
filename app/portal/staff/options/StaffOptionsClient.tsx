"use client";

import React, { useState, useMemo } from "react";
import type { ClientRow, AccountRow, OptionRow } from "@/lib/data/queries";
import type { StoredPnlRow } from "@/lib/data/pnl";
import type { PnlOverrideRow } from "@/lib/data/holdings";
import { TablePagination } from "@/app/components/TablePagination";
import { MoneynessBadge, StrikeSpot } from "@/app/components/MoneynessBadge";
import {
  moneynessOf,
  UNKNOWN_MONEYNESS,
  type OptionMoneyness,
} from "@/lib/options/moneyness";

export type OptionTableItem = {
  id: string;
  accountId: string;
  clientId: string;
  ticker: string;
  parentTicker: string | null;
  company: string;
  isUnlisted: boolean;
  isListed: boolean;
  quantity: number;
  costBasis: number;
  marketValue: number;
  pnl: number;
  strike: number | null;
  underlyingPrice: number | null;
  /** Where the strike sits against the underlying, and what exercising is worth. */
  money: OptionMoneyness;
  expiryDate: string | null;
  dte: number | null;
  pricingMethod: string | null;
  termsNote: string | null;
  source: string | null;
  status: "live" | "expired" | "exercised" | "pending";
};

type OptionFilterTab = "all" | "listed" | "unlisted" | "itm" | "gain" | "loss";

const money2 = (n: number) =>
  n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Strikes and spots are quoted in fractions of a cent, so a $0.0125 strike must
 * not round to $0.01 — the ITM arithmetic beside it would stop adding up.
 */
const money4 = (n: number) =>
  n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 4 });

const fmtQty = (n: number) =>
  Math.round(n).toLocaleString("en-AU");

/**
 * Parses expiry date and calculates days-to-expiry from date or security name.
 */
function parseExpiry(
  dateStr?: string | null,
  companyName?: string | null,
): { date: string | null; dte: number | null } {
  if (dateStr) {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
      const now = new Date();
      const diffDays = Math.round((d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      return { date: dateStr, dte: diffDays };
    }
  }

  if (companyName) {
    const match = companyName.match(/OPTION\s+(\d{1,2})-([A-Za-z]{3})-(\d{2,4})/i);
    if (match) {
      const day = parseInt(match[1], 10);
      const monStr = match[2].toUpperCase();
      let year = parseInt(match[3], 10);
      if (year < 100) year += 2000;
      const months: Record<string, number> = {
        JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
        JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
      };
      if (monStr in months) {
        const d = new Date(year, months[monStr], day);
        const now = new Date();
        const diffDays = Math.round((d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
        const formatted = `${year}-${String(months[monStr] + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        return { date: formatted, dte: diffDays };
      }
    }
  }

  return { date: null, dte: null };
}

/**
 * Identify internal broker / suspense / house accounts
 */
function isHouseOrSuspenseAccount(
  clientName?: string | null,
  accountExternalRef?: string | null,
  accountLabel?: string | null,
): boolean {
  const n = (clientName || "").toLowerCase();
  const ref = (accountExternalRef || "").toLowerCase();
  const label = (accountLabel || "").toLowerCase();

  if (
    n.includes("placement - vitti") ||
    n.includes("placement-vitti") ||
    (n.includes("vitti capital") && n.includes("placement"))
  ) {
    return true;
  }

  if (
    n.includes("errvitti") ||
    n.includes("err vitti") ||
    n.includes("errors - vitt") ||
    n.includes("errors - vitti") ||
    n.includes("suspense") ||
    ref.includes("errvitti") ||
    ref.includes("suspense") ||
    label.includes("errvitti") ||
    label.includes("suspense")
  ) {
    return true;
  }

  return false;
}

export function StaffOptionsClient({
  storedPnl,
  optionHoldings = [],
  clients,
  accounts,
}: {
  storedPnl: StoredPnlRow[];
  optionHoldings?: OptionRow[];
  clients: ClientRow[];
  accounts: AccountRow[];
  overrides?: PnlOverrideRow[];
}) {
  // Client and Account lookup maps
  const clientMap = useMemo(() => new Map(clients.map((c) => [c.id, c])), [clients]);
  const accountMap = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  // Build unified options list across all accounts
  const allOptionItems: OptionTableItem[] = useMemo(() => {
    const items: OptionTableItem[] = [];
    const seenKeys = new Set<string>();

    // 1. Options from stored P&L (both listed & unlisted option models)
    for (const r of storedPnl) {
      const isOption = Boolean(
        r.isOption ||
        r.isUnlistedOption ||
        r.ticker.endsWith("-UO") ||
        (r.instrument && r.instrument.toLowerCase().includes("option"))
      );
      if (!isOption) continue;

      const isUnlisted = Boolean(r.isUnlistedOption || r.ticker.endsWith("-UO"));
      const key = `${r.accountId}:${r.ticker}`;
      seenKeys.add(key);

      const quantity =
        r.buyQty > 0
          ? r.buyQty
          : r.sellQty > 0
          ? r.sellQty
          : r.openQty !== 0
          ? Math.abs(r.openQty)
          : 0;

      // Terms are carried only by the MODELLED grants — they were the inputs to
      // that row's price. A listed series is quoted and traded on its own
      // market, so its Current Value is already the answer; a strike and an
      // intrinsic figure struck off the underlying would be a second, unrelated
      // number sitting beside it claiming to describe the same row.
      const uo = r.unlistedOption;
      const strike = uo?.strike ?? null;
      const underlyingPrice = uo?.spot ?? null;
      const { date: expiryDate, dte } = parseExpiry(uo?.expiry ?? null, r.company);
      const pricingMethod = uo?.pricingMethod
        ? uo.pricingMethod === "black-scholes"
          ? "Black-Scholes model"
          : "Intrinsic value"
        : isUnlisted
        ? "Modelled grant"
        : "Listed feed";

      const termsNote =
        uo?.raw ||
        r.comment ||
        (isUnlisted
          ? "Free unlisted placement options"
          : r.company || "Exchange traded listed options");

      items.push({
        id: `pnl-${key}`,
        accountId: r.accountId,
        clientId: r.clientId,
        ticker: r.ticker,
        parentTicker: r.parentTicker,
        company: r.company || r.ticker,
        isUnlisted,
        isListed: !isUnlisted,
        quantity,
        costBasis: r.buyPrice,
        marketValue: r.sellPrice,
        pnl: r.pnl,
        strike,
        underlyingPrice,
        // Placement grants are calls by construction.
        money: isUnlisted
          ? moneynessOf({ spot: underlyingPrice, strike, qty: quantity, kind: "Call" })
          : UNKNOWN_MONEYNESS,
        expiryDate,
        dte,
        pricingMethod,
        termsNote,
        source: isUnlisted ? "Placement grant" : "Broker feed",
        status: "live",
      });
    }

    // 2. Options from option_holdings table
    for (const o of optionHoldings) {
      const acctId = o.accountId || "";
      const key = `${acctId}:${o.code}`;
      if (seenKeys.has(key)) continue;

      const isUnlisted = !o.listed;
      const { date: expiryDate, dte } = parseExpiry(o.expiryDate, o.name);

      const statusMap: Record<string, "live" | "expired" | "exercised" | "pending"> = {
        open: "live",
        expired: "expired",
        exercised: "exercised",
        pending: "pending",
      };

      // These rows have no stored valuation behind them — the register is all
      // there is — so exercise value IS the value reported, for listed and
      // unlisted alike. Taken from the shared helper rather than open-coded,
      // which is what had a registered PUT reading as worthless whenever it was
      // in the money.
      const money = moneynessOf({
        spot: o.under,
        strike: o.strike,
        qty: o.qty,
        kind: o.type,
      });

      items.push({
        id: `opt-${o.id}`,
        accountId: acctId,
        clientId: o.clientId,
        ticker: o.code,
        parentTicker: o.code.replace(/O[A-Z]?$/, ""),
        company: o.name || o.code,
        isUnlisted,
        isListed: o.listed,
        quantity: o.qty,
        costBasis: 0,
        marketValue: money.intrinsicValue,
        pnl: money.intrinsicValue,
        // Reported only for the unlisted grants, matching the stored-P&L rows
        // above — one rule for the whole table, so a listed series never shows
        // a strike on one screen and a dash on the other.
        strike: isUnlisted ? o.strike : null,
        underlyingPrice: isUnlisted ? o.under : null,
        money: isUnlisted ? money : UNKNOWN_MONEYNESS,
        expiryDate,
        dte,
        pricingMethod: o.listed ? "Listed feed" : "Manual registry",
        termsNote: o.source || (o.listed ? "Listed option series" : "Unlisted placement option"),
        source: o.source || (o.listed ? "Broker feed" : "Manual register"),
        status: statusMap[o.status] || "live",
      });
    }

    return items;
  }, [storedPnl, optionHoldings]);

  // Count options per account
  const optionsCountByAccount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of allOptionItems) {
      counts.set(it.accountId, (counts.get(it.accountId) || 0) + 1);
    }
    return counts;
  }, [allOptionItems]);

  // Build sorted accounts for dropdown: accounts with options first, then alphabetical
  const sortedAccounts = useMemo(() => {
    return [...accounts].sort((a, b) => {
      const countA = optionsCountByAccount.get(a.id) || 0;
      const countB = optionsCountByAccount.get(b.id) || 0;
      if (countA > 0 && countB === 0) return -1;
      if (countA === 0 && countB > 0) return 1;

      const cA = clientMap.get(a.clientId)?.name || "";
      const cB = clientMap.get(b.clientId)?.name || "";
      const comp = cA.localeCompare(cB);
      if (comp !== 0) return comp;
      return (a.label || "").localeCompare(b.label || "");
    });
  }, [accounts, optionsCountByAccount, clientMap]);

  // Filter states (defaulting to "all")
  const [filterTab, setFilterTab] = useState<OptionFilterTab>("all");
  const [selectedAccount, setSelectedAccount] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const hideSuspense = true;

  // Pagination state
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(15);

  // Options scoped to currently selected account
  const scopedAccountItems = useMemo(() => {
    return allOptionItems.filter((it) => {
      const client = clientMap.get(it.clientId);
      const acct = accountMap.get(it.accountId);
      const clientName = client?.name ?? "";
      const acctRef = acct?.externalRef ?? acct?.ref ?? "";
      const acctLabel = acct?.label ?? "";

      if (hideSuspense && isHouseOrSuspenseAccount(clientName, acctRef, acctLabel)) {
        return false;
      }

      if (selectedAccount !== "all" && it.accountId !== selectedAccount) {
        return false;
      }

      return true;
    });
  }, [allOptionItems, selectedAccount, hideSuspense, clientMap, accountMap]);

  // Dynamic KPI Metrics for current account scope
  const metrics = useMemo(() => {
    let totalListedVal = 0;
    let totalUnlistedVal = 0;
    let totalPnl = 0;
    let totalUnits = 0;
    let listedCount = 0;
    let unlistedCount = 0;
    let gainCount = 0;
    let lossCount = 0;
    let itmCount = 0;
    let itmUnits = 0;
    let itmIntrinsic = 0;
    const accountsSet = new Set<string>();

    for (const it of scopedAccountItems) {
      accountsSet.add(it.accountId);
      totalUnits += it.quantity;
      totalPnl += it.pnl;

      if (it.isUnlisted) {
        unlistedCount++;
        totalUnlistedVal += it.marketValue;
      } else {
        listedCount++;
        totalListedVal += it.marketValue;
      }

      if (it.pnl > 0) gainCount++;
      else if (it.pnl < 0) lossCount++;

      // Exercise value is summed over the ITM rows ONLY. An OTM option's
      // intrinsic is zero, so including it would not change the figure — but
      // the count beside it would then say something different from the tab.
      if (it.money.isItm) {
        itmCount++;
        itmUnits += it.quantity;
        itmIntrinsic += it.money.intrinsicValue;
      }
    }

    return {
      totalCount: scopedAccountItems.length,
      listedCount,
      unlistedCount,
      gainCount,
      lossCount,
      itmCount,
      itmUnits,
      itmIntrinsic,
      totalListedVal,
      totalUnlistedVal,
      totalMarketVal: totalListedVal + totalUnlistedVal,
      totalPnl,
      totalUnits,
      accountsCount: accountsSet.size,
    };
  }, [scopedAccountItems]);

  // Filtered items based on active tab and search query
  const filteredItems = useMemo(() => {
    const items = scopedAccountItems.filter((it: OptionTableItem) => {
      // 1. Category tab filter
      if (filterTab === "listed" && !it.isListed) return false;
      if (filterTab === "unlisted" && !it.isUnlisted) return false;
      if (filterTab === "itm" && !it.money.isItm) return false;
      if (filterTab === "gain" && it.pnl <= 0) return false;
      if (filterTab === "loss" && it.pnl >= 0) return false;

      // 2. Search query
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const client = clientMap.get(it.clientId);
        const acct = accountMap.get(it.accountId);
        const clientName = client?.name ?? "";
        const acctLabel = acct?.label ?? "";
        const acctRef = acct?.externalRef ?? acct?.ref ?? "";

        const matches =
          it.ticker.toLowerCase().includes(q) ||
          (it.parentTicker && it.parentTicker.toLowerCase().includes(q)) ||
          it.company.toLowerCase().includes(q) ||
          clientName.toLowerCase().includes(q) ||
          acctLabel.toLowerCase().includes(q) ||
          acctRef.toLowerCase().includes(q) ||
          (it.termsNote && it.termsNote.toLowerCase().includes(q));

        if (!matches) return false;
      }

      return true;
    });

    // Grouping & Sorting:
    // When "All Accounts" is selected, group options by Client Name -> Account Label / Ref -> Series Ticker
    // When a single account is selected, sort options by Series Ticker
    return items.sort((a: OptionTableItem, b: OptionTableItem) => {
      if (selectedAccount === "all") {
        const clientA = clientMap.get(a.clientId)?.name || "";
        const clientB = clientMap.get(b.clientId)?.name || "";
        const clientComp = clientA.localeCompare(clientB);
        if (clientComp !== 0) return clientComp;

        const acctA = accountMap.get(a.accountId);
        const acctB = accountMap.get(b.accountId);
        const labelA = `${acctA?.label || ""}-${acctA?.externalRef || ""}`;
        const labelB = `${acctB?.label || ""}-${acctB?.externalRef || ""}`;
        const acctComp = labelA.localeCompare(labelB);
        if (acctComp !== 0) return acctComp;
      }

      return a.ticker.localeCompare(b.ticker);
    });
  }, [scopedAccountItems, selectedAccount, filterTab, searchQuery, clientMap, accountMap]);

  // Paginated items
  const paginatedItems = useMemo(() => {
    if (pageSize >= filteredItems.length) return filteredItems;
    const start = (currentPage - 1) * pageSize;
    return filteredItems.slice(start, start + pageSize);
  }, [filteredItems, currentPage, pageSize]);

  // Filtered Totals
  const filteredTotals = useMemo(() => {
    let val = 0;
    let pnl = 0;
    let qty = 0;
    let intrinsic = 0;

    for (const it of filteredItems) {
      val += it.marketValue;
      pnl += it.pnl;
      qty += it.quantity;
      intrinsic += it.money.intrinsicValue;
    }

    return { val, pnl, qty, intrinsic };
  }, [filteredItems]);

  // Reset filters
  const handleResetFilters = () => {
    setFilterTab("all");
    setSearchQuery("");
    setCurrentPage(1);
  };

  // Export CSV
  const handleExportCsv = () => {
    const headers = [
      "Series Ticker",
      "Parent Ordinary",
      "Company / Description",
      "Option Type",
      "Buy Qty",
      "Strike ($)",
      "Underlying Price ($)",
      "Moneyness",
      "Exercise Value ($)",
      "Current Value ($)",
      "Unrealized P&L ($)",
      "Terms / Valuation Notes",
      "Account Name",
      "Client Name",
    ];

    const rows = filteredItems.map((it) => {
      const client = clientMap.get(it.clientId)?.name ?? "";
      const acct = accountMap.get(it.accountId);
      const acctName = `${acct?.label || "Account"}${acct?.externalRef ? ` (#${acct.externalRef})` : ""}`;

      return [
        `"${it.ticker.replace(/"/g, '""')}"`,
        `"${(it.parentTicker || "").replace(/"/g, '""')}"`,
        `"${it.company.replace(/"/g, '""')}"`,
        `"${it.isUnlisted ? "Unlisted Option" : "Listed Option"}"`,
        it.quantity,
        // Blank, not 0 — an unparsed strike is not a free option, and a
        // spreadsheet cannot tell the difference once a zero is written.
        it.strike == null ? "" : it.strike,
        it.underlyingPrice == null ? "" : it.underlyingPrice,
        it.money.moneyness === "unknown" ? "" : it.money.moneyness,
        it.money.moneyness === "unknown" ? "" : it.money.intrinsicValue.toFixed(2),
        it.marketValue.toFixed(2),
        it.pnl.toFixed(2),
        `"${(it.termsNote || "").replace(/"/g, '""')}"`,
        `"${acctName.replace(/"/g, '""')}"`,
        `"${client.replace(/"/g, '""')}"`,
      ].join(",");
    });

    const csvContent = "\uFEFF" + [headers.join(","), ...rows].join("\r\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `Options_${selectedAccount === "all" ? "All_Accounts" : "Account"}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4 text-ink font-body select-none">
      {/* Top Header & Account Switcher Row (ABOVE KPI CARDS) */}
      <div className="flex justify-between items-center gap-4 flex-wrap pb-1 border-b border-line/60">
        <div>
          <h1 className="font-disp font-medium text-[24px] tracking-tight text-ink">
            Options
          </h1>
          <p className="text-xs text-mut mt-0.5">
            Overview of listed and unlisted options across accounts.
          </p>
        </div>

        {/* Account Selector & Export shifted to the TOP */}
        <div className="flex items-center gap-2.5 flex-wrap">
          <div className="flex items-center gap-2 bg-white border border-line rounded-lg px-3 py-1.5 shadow-2xs">
            <span className="text-mut text-xs font-semibold uppercase tracking-wider">Account:</span>
            <select
              value={selectedAccount}
              onChange={(e) => {
                setSelectedAccount(e.target.value);
                setCurrentPage(1);
              }}
              className="bg-transparent text-xs font-semibold text-ink focus:outline-none cursor-pointer max-w-[320px]"
            >
              <option value="all">All Accounts ({accounts.length})</option>
              {sortedAccounts.map((a) => {
                const client = clientMap.get(a.clientId);
                const clientName = client?.name || "Client";
                const ref = a.externalRef ? ` #${a.externalRef}` : "";
                const count = optionsCountByAccount.get(a.id) || 0;
                const label = `${clientName} — ${a.label || "Account"}${ref} (${count} ${count === 1 ? "option" : "options"})`;
                return (
                  <option key={a.id} value={a.id}>
                    {label}
                  </option>
                );
              })}
            </select>
          </div>

          <button
            type="button"
            onClick={handleExportCsv}
            className="inline-flex items-center gap-1.5 bg-white hover:bg-paper-2 border border-line text-ink font-semibold py-1.5 px-3 rounded-lg text-xs transition-colors shadow-2xs cursor-pointer"
          >
            <svg className="w-3.5 h-3.5 text-mut" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Export
          </button>
        </div>
      </div>

      {/* KPI Cards Row */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {/* Total Options */}
        <div className="bg-white border border-line rounded-xl p-3.5 shadow-2xs">
          <div className="text-[11px] font-medium text-mut uppercase tracking-wider">Total Options</div>
          <div className="font-disp font-semibold text-xl mt-1 text-ink flex items-baseline gap-2">
            {metrics.totalCount}
            <span className="font-body text-xs font-normal text-mut">
              {selectedAccount === "all" ? `(${metrics.accountsCount} accounts)` : "holdings"}
            </span>
          </div>
          <div className="text-[11px] text-mut mt-0.5 font-mono">{fmtQty(metrics.totalUnits)} units</div>
        </div>

        {/* Listed Options */}
        <div className="bg-white border border-line rounded-xl p-3.5 shadow-2xs">
          <div className="text-[11px] font-medium text-mut uppercase tracking-wider">Listed Options</div>
          <div className="font-disp font-semibold text-xl mt-1 text-ink">{metrics.listedCount}</div>
          <div className="text-[11px] text-mut mt-0.5 font-mono">${money2(metrics.totalListedVal)} value</div>
        </div>

        {/* Unlisted Options */}
        <div className="bg-white border border-line rounded-xl p-3.5 shadow-2xs">
          <div className="text-[11px] font-medium text-mut uppercase tracking-wider">Unlisted Options</div>
          <div className="font-disp font-semibold text-xl mt-1 text-ink">{metrics.unlistedCount}</div>
          <div className="text-[11px] text-mut mt-0.5 font-mono">${money2(metrics.totalUnlistedVal)} modelled</div>
        </div>

        {/* In the money — the desk's actionable set: options worth exercising
            today, and what exercising the whole lot would realise. */}
        <button
          type="button"
          onClick={() => {
            setFilterTab(filterTab === "itm" ? "all" : "itm");
            setCurrentPage(1);
          }}
          title="Underlying trading above the strike — click to filter"
          className={`text-left bg-white border rounded-xl p-3.5 shadow-2xs cursor-pointer transition-colors hover:border-green-d/40 ${
            filterTab === "itm" ? "border-green-d/60 ring-1 ring-green-d/20" : "border-line"
          }`}
        >
          <div className="text-[11px] font-medium text-mut uppercase tracking-wider">
            In the Money
          </div>
          <div className="font-disp font-semibold text-xl mt-1 text-gain flex items-baseline gap-2">
            {metrics.itmCount}
            <span className="font-body text-xs font-normal text-mut">
              of {metrics.totalCount}
            </span>
          </div>
          <div className="text-[11px] text-mut mt-0.5 font-mono">
            ${money2(metrics.itmIntrinsic)} on {fmtQty(metrics.itmUnits)} units
          </div>
        </button>

        {/* Unrealized P&L */}
        <div className="bg-white border border-line rounded-xl p-3.5 shadow-2xs">
          <div className="text-[11px] font-medium text-mut uppercase tracking-wider">Unrealized P&amp;L</div>
          <div className={`font-disp font-semibold text-xl mt-1 ${metrics.totalPnl >= 0 ? "text-gain" : "text-loss-d"}`}>
            {metrics.totalPnl >= 0 ? "+" : ""}${money2(metrics.totalPnl)}
          </div>
          <div className="text-[11px] text-mut mt-0.5">
            {metrics.gainCount} gain &middot; {metrics.lossCount} loss / unquoted
          </div>
        </div>
      </div>

      {/* Main Table Card */}
      <div className="bg-white border border-line rounded-xl shadow-2xs overflow-hidden">
        {/* Controls Bar: Tabs & Search */}
        <div className="p-3.5 border-b border-line bg-white space-y-3">
          {/* Segmented Filter Pills (All Options, Listed Options, Unlisted Options, Gain, Loss) */}
          <div className="bg-paper rounded-lg p-1 flex items-center gap-1 overflow-x-auto border border-line/60">
            {(
              [
                { id: "all", label: "All Options", count: metrics.totalCount },
                { id: "listed", label: "Listed Options", count: metrics.listedCount },
                { id: "unlisted", label: "Unlisted Options", count: metrics.unlistedCount },
                { id: "itm", label: "In the Money", count: metrics.itmCount },
                { id: "gain", label: "Gain", count: metrics.gainCount },
                { id: "loss", label: "Loss", count: metrics.lossCount },
              ] as const
            ).map((t) => {
              const active = filterTab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    setFilterTab(t.id);
                    setCurrentPage(1);
                  }}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs cursor-pointer transition-all whitespace-nowrap ${
                    active
                      ? "bg-white text-ink font-semibold shadow-xs border border-line/70"
                      : "text-mut hover:text-ink font-medium hover:bg-white/40"
                  }`}
                >
                  <span>{t.label}</span>
                  <span
                    className={`text-[10px] font-mono px-1.5 py-0.2 rounded font-semibold ${
                      active ? "bg-paper-2 text-ink" : "bg-line/40 text-mut"
                    }`}
                  >
                    {t.count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Search Bar & Reset */}
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <svg
                className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-mut pointer-events-none"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                placeholder="Search series, company, terms, client, account..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setCurrentPage(1);
                }}
                className="w-full bg-paper/60 hover:bg-paper focus:bg-white border border-line rounded-lg pl-8.5 pr-7 py-1.5 text-xs text-ink placeholder:text-mut focus:outline-none focus:border-navy transition-all font-medium"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery("");
                    setCurrentPage(1);
                  }}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-mut hover:text-ink cursor-pointer"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>

            {/* Clear Filter Button */}
            {(filterTab !== "all" || searchQuery) && (
              <button
                type="button"
                onClick={handleResetFilters}
                className="text-[11px] font-semibold text-mut hover:text-ink px-2.5 py-1.5 border border-line rounded-lg bg-paper hover:bg-white transition-colors cursor-pointer whitespace-nowrap"
              >
                Reset Filters
              </button>
            )}
          </div>
        </div>

        {/* Clean Options Table */}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-line text-mut select-none bg-paper/40 font-medium">
                {/* Conditionally show Account column when All Accounts is selected */}
                {selectedAccount === "all" && (
                  <th className="px-4 py-2.5 whitespace-nowrap">Account</th>
                )}
                <th className="px-4 py-2.5 whitespace-nowrap">Series</th>
                <th className="px-4 py-2.5">Company / Description</th>
                <th className="px-4 py-2.5 whitespace-nowrap">Type</th>
                <th
                  className="px-4 py-2.5 text-right whitespace-nowrap"
                  title="Options held — the count the exercise value is struck on"
                >
                  Buy Qty
                </th>
                <th
                  className="px-4 py-2.5 whitespace-nowrap"
                  title="Exercise price → underlying price. Unlisted grants only — a listed series trades on its own market."
                >
                  Strike &rarr; Spot
                </th>
                <th
                  className="px-4 py-2.5 text-right whitespace-nowrap"
                  title="Qty × (Spot − Strike), floored at zero. Unlisted grants only."
                >
                  Exercise Value
                </th>
                <th className="px-4 py-2.5 text-right whitespace-nowrap">Current Value</th>
                <th className="px-4 py-2.5 text-right whitespace-nowrap">Unreal. P&amp;L</th>
                <th className="px-4 py-2.5 whitespace-nowrap">Terms / Valuation Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/60">
              {filteredItems.length === 0 ? (
                <tr>
                  <td colSpan={selectedAccount === "all" ? 10 : 9} className="text-center text-mut py-12">
                    <p className="font-semibold text-ink">No options found</p>
                    <p className="text-xs text-mut mt-0.5">
                      {scopedAccountItems.length === 0
                        ? "There are no options on record for this selection."
                        : "No options match the active tab or search filter."}
                    </p>
                    {(filterTab !== "all" || searchQuery) && (
                      <button
                        type="button"
                        onClick={handleResetFilters}
                        className="mt-2 text-xs font-semibold text-navy hover:underline cursor-pointer"
                      >
                        Clear filters
                      </button>
                    )}
                  </td>
                </tr>
              ) : (
                <>
                  {paginatedItems.map((o) => {
                    const client = clientMap.get(o.clientId);
                    const acct = accountMap.get(o.accountId);
                    const isUp = o.pnl >= 0;

                    return (
                      <tr
                        key={o.id}
                        className={`transition-colors ${
                          o.money.isItm
                            ? "bg-green-bg/25 hover:bg-green-bg/40"
                            : "hover:bg-paper/50"
                        }`}
                      >
                        {/* Account column displayed only when All Accounts is selected */}
                        {selectedAccount === "all" && (
                          <td className="px-4 py-3 whitespace-nowrap">
                            <div className="font-semibold text-ink text-[11.5px]">
                              {client?.name || "Client"}
                            </div>
                            <div className="text-[10.5px] text-mut">
                              {acct?.label || "Account"}
                              {acct?.externalRef ? ` · #${acct.externalRef}` : ""}
                            </div>
                          </td>
                        )}

                        {/* Series / Ticker */}
                        <td className="px-4 py-3 whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono px-1.5 py-0.5 rounded bg-paper-2 border border-line/60 font-bold text-ink text-[11.5px]">
                              {o.ticker}
                            </span>
                            {o.parentTicker && o.parentTicker !== o.ticker && (
                              <span className="text-[10px] font-mono text-mut">
                                &rarr; {o.parentTicker}
                              </span>
                            )}
                          </div>
                        </td>

                        {/* Company / Description */}
                        <td className="px-4 py-3">
                          <div className="font-medium text-ink truncate max-w-xs" title={o.company}>
                            {o.company}
                          </div>
                        </td>

                        {/* Type + moneyness */}
                        <td className="px-4 py-3 whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`text-[10.5px] font-semibold rounded-full px-2.5 py-0.5 inline-block ${
                                o.isUnlisted
                                  ? "bg-[#ece9f3] text-[#5c5775] border border-[#d8d3e5]"
                                  : "bg-paper-2 text-ink border border-line/60"
                              }`}
                            >
                              {o.isUnlisted ? "Unlisted Option" : "Listed Option"}
                            </span>
                            <MoneynessBadge
                              money={o.money}
                              title={
                                o.money.isItm
                                  ? `In the money by $${money4(o.money.intrinsicPerOption)} per option`
                                  : undefined
                              }
                            />
                          </div>
                        </td>

                        {/* Quantity */}
                        <td className="px-4 py-3 text-right font-mono text-ink whitespace-nowrap font-medium">
                          {o.quantity > 0 ? fmtQty(o.quantity) : "—"}
                        </td>

                        {/* Strike against spot — what the badge is a verdict on */}
                        <td className="px-4 py-3 whitespace-nowrap">
                          <StrikeSpot strike={o.strike} spot={o.underlyingPrice} money4={money4} />
                        </td>

                        {/* Exercise value: qty × (spot − strike), floored at zero */}
                        <td
                          className={`px-4 py-3 text-right font-mono whitespace-nowrap ${
                            o.money.isItm ? "text-gain font-semibold" : "text-mut"
                          }`}
                          title={
                            o.money.moneyness === "unknown"
                              ? o.isUnlisted
                                ? "No strike on record for this grant"
                                : "Listed series — marked to its own market, see Current Value"
                              : `${fmtQty(o.quantity)} × $${money4(o.money.intrinsicPerOption)}`
                          }
                        >
                          {o.money.moneyness === "unknown"
                            ? "—"
                            : `$${money2(o.money.intrinsicValue)}`}
                        </td>

                        {/* Current Value */}
                        <td className="px-4 py-3 text-right font-mono font-semibold text-ink whitespace-nowrap">
                          ${money2(o.marketValue)}
                        </td>

                        {/* Unrealized P&L */}
                        <td
                          className={`px-4 py-3 text-right font-mono font-semibold whitespace-nowrap ${
                            isUp ? "text-gain" : "text-loss-d"
                          }`}
                        >
                          {o.pnl < 0 ? "-" : "+"}${money2(Math.abs(o.pnl))}
                        </td>

                        {/* Terms & Valuation Notes */}
                        <td className="px-4 py-3 text-mut text-[11px] font-mono max-w-sm truncate" title={o.termsNote || o.company}>
                          {o.termsNote || o.pricingMethod || "—"}
                        </td>
                      </tr>
                    );
                  })}

                  {/* Grand Total Row */}
                  <tr className="border-t-2 border-line bg-paper/60 font-semibold select-none">
                    <td className="px-4 py-3" colSpan={selectedAccount === "all" ? 2 : 1}>
                      Total ({filteredItems.length})
                    </td>
                    <td className="px-4 py-3" />
                    <td className="px-4 py-3" />
                    <td className="px-4 py-3 text-right font-mono">
                      {fmtQty(filteredTotals.qty)}
                    </td>
                    <td className="px-4 py-3" />
                    <td className="px-4 py-3 text-right font-mono text-gain">
                      ${money2(filteredTotals.intrinsic)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-ink">
                      ${money2(filteredTotals.val)}
                    </td>
                    <td
                      className={`px-4 py-3 text-right font-mono ${
                        filteredTotals.pnl >= 0 ? "text-gain" : "text-loss-d"
                      }`}
                    >
                      {filteredTotals.pnl < 0 ? "-" : "+"}${money2(Math.abs(filteredTotals.pnl))}
                    </td>
                    <td className="px-4 py-3" />
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Footer */}
        <TablePagination
          totalItems={filteredItems.length}
          currentPage={currentPage}
          pageSize={pageSize}
          onPageChange={setCurrentPage}
          onPageSizeChange={setPageSize}
          pageSizeOptions={[10, 15, 25, 50, 100]}
          itemLabel="options"
        />
      </div>
    </div>
  );
}
