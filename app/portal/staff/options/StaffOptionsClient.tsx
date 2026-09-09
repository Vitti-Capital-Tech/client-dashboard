"use client";

import React, { useState, useMemo, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Download, Search, Trash2, X } from "lucide-react";
import type { ClientRow, AccountRow, OptionRow } from "@/lib/data/queries";
import type { StoredPnlRow } from "@/lib/data/pnl";
import type { PnlOverrideRow } from "@/lib/data/holdings";
import { TablePagination } from "@/app/components/TablePagination";
import { MoneynessBadge, StrikeSpot } from "@/app/components/MoneynessBadge";
import { optionsFromSources, type OptionTableItem } from "@/lib/options/from-stored-pnl";
import { deleteUnlistedOption } from "@/app/actions/options";

// `OptionTableItem` and the derivation now live in lib/options/from-stored-pnl.ts,
// so the client portal's Options tab reads the same register off the same rules.
// Re-exported because this module was where it lived.
export type { OptionTableItem };

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

  // One register, derived by the same rules the client portal uses — see
  // lib/options/from-stored-pnl.ts for why that had to stop being two.
  const allOptionItems: OptionTableItem[] = useMemo(
    () => optionsFromSources(storedPnl, optionHoldings),
    [storedPnl, optionHoldings],
  );

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

  // ── Deleting an unlisted grant ─────────────────────────────────────────────
  // The row being confirmed IS the state: holding the item rather than its id
  // means the modal can describe what is about to go — ticker, terms, whose
  // account — without looking anything back up, and closing it is one setState.
  const router = useRouter();
  const [isDeleting, startDelete] = useTransition();
  const [pendingDelete, setPendingDelete] = useState<OptionTableItem | null>(null);
  const [deleteReason, setDeleteReason] = useState<string>("");
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const openDeleteModal = (item: OptionTableItem) => {
    setDeleteError(null);
    setDeleteReason("");
    setPendingDelete(item);
  };

  const closeDeleteModal = () => {
    if (isDeleting) return; // Mid-write: closing would hide the outcome.
    setPendingDelete(null);
    setDeleteError(null);
    setDeleteReason("");
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    const item = pendingDelete;
    setDeleteError(null);

    startDelete(async () => {
      try {
        const res = await deleteUnlistedOption(item.id, deleteReason);
        if (!res.ok) {
          // The action's refusals are written to be read — "no longer on the
          // register", "only unlisted grants" — so they are shown as they are.
          setDeleteError(res.error);
          return;
        }
        setPendingDelete(null);
        setDeleteReason("");
        // The register is server-derived, so the row leaves the table when the
        // page's data does. Nothing is spliced out of local state: doing both
        // would briefly show a count that disagrees with the rows under it.
        router.refresh();
      } catch (e) {
        setDeleteError(e instanceof Error ? e.message : "Something went wrong.");
      }
    });
  };

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

      // Summed over the rows that are AT or in the money. An OTM option's
      // intrinsic is zero, so including it would not change the figure — but
      // the count beside it would then say something different from the tab.
      //
      // ATM is in this set deliberately: a grant sitting on its strike is one
      // tick from being worth something, and it adds ~nothing to the money
      // (its intrinsic is under a twentieth of a cent) while making the COUNT
      // honest. See `isExercisable`.
      if (it.money.isExercisable) {
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
      if (filterTab === "itm" && !it.money.isExercisable) return false;
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
            <Download className="w-3.5 h-3.5 text-mut" />
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
          title="Underlying at or above the strike — click to filter"
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
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-mut pointer-events-none" />
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
                  <X className="w-3 h-3" />
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
                  title="Qty × (Spot − Strike), floored at zero — so a grant at its strike reads $0.00. Unlisted grants only."
                >
                  Exercise Value
                </th>
                <th className="px-4 py-2.5 text-right whitespace-nowrap">Current Value</th>
                <th className="px-4 py-2.5 text-right whitespace-nowrap">Unreal. P&amp;L</th>
                <th className="px-4 py-2.5 whitespace-nowrap">Terms / Valuation Notes</th>
                <th
                  className="px-4 py-2.5 text-right whitespace-nowrap"
                  title="Unlisted grants only — a listed series is a fact about the broker feed, not a desk judgement"
                >
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/60">
              {filteredItems.length === 0 ? (
                <tr>
                  <td colSpan={selectedAccount === "all" ? 11 : 10} className="text-center text-mut py-12">
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
                          o.money.isExercisable
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
                                  : o.money.moneyness === "ATM"
                                    ? "Sitting on its strike — exercising today is worth nothing yet"
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
                            o.money.isExercisable ? "text-gain font-semibold" : "text-mut"
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

                        {/* Delete — unlisted grants only.
                            A listed series is quoted on its own market and sits
                            here because the broker feed says the client holds
                            it; there is nothing for the desk to decide, so
                            there is no button. */}
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          {o.isUnlisted ? (
                            <button
                              type="button"
                              onClick={() => openDeleteModal(o)}
                              disabled={isDeleting}
                              title={`Delete ${o.ticker} from the options register`}
                              aria-label={`Delete ${o.ticker} from the options register`}
                              className="inline-flex items-center justify-center w-7 h-7 rounded-lg border border-line text-mut bg-white hover:text-loss-d hover:border-loss-d/50 hover:bg-loss-bg/40 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          ) : (
                            <span className="text-mut/50">—</span>
                          )}
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

      {/* ── Delete confirmation ──────────────────────────────────────
          Worth a modal rather than a `window.confirm`, because the question is
          not "are you sure" — it is "is THIS the grant you meant". The tranche
          codes on one underlying differ by a single digit (`GRV-UO`, `GRV-UO2`)
          and their terms differ by a strike, so the row is restated in full and
          whose account it belongs to is stated with it. */}
      {pendingDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink/40 backdrop-blur-xs animate-in fade-in duration-150 overflow-y-auto"
          onClick={closeDeleteModal}
        >
          <div
            className="relative w-full max-w-md bg-white border border-line rounded-[16px] shadow-2xl overflow-hidden animate-in zoom-in-95 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="px-6 py-4.5 bg-paper border-b border-line flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-loss-bg border border-loss/30 text-loss-d flex items-center justify-center shadow-2xs">
                  <Trash2 className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-ink">Delete Unlisted Option</h3>
                  <p className="text-xs text-mut">Removes the grant from the register</p>
                </div>
              </div>

              <button
                type="button"
                onClick={closeDeleteModal}
                disabled={isDeleting}
                className="w-7 h-7 rounded-full border border-line flex items-center justify-center text-mut hover:text-ink hover:bg-paper-2 transition-colors cursor-pointer text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                title="Close"
              >
                &times;
              </button>
            </div>

            {/* Body */}
            <div className="p-6 space-y-4 text-xs text-ink">
              {/* The row, restated. */}
              <div className="rounded-[10px] border border-line/70 bg-paper-2/60 p-3.5 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono px-1.5 py-0.5 rounded bg-white border border-line/60 font-bold text-ink text-[11.5px]">
                    {pendingDelete.ticker}
                  </span>
                  <MoneynessBadge money={pendingDelete.money} />
                </div>

                <div className="text-[11.5px] font-medium text-ink leading-snug">
                  {pendingDelete.company}
                </div>

                <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px] pt-1 border-t border-line/60">
                  <div>
                    <dt className="text-mut">Client</dt>
                    <dd className="font-semibold text-ink truncate">
                      {clientMap.get(pendingDelete.clientId)?.name || "Client"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-mut">Account</dt>
                    <dd className="font-semibold text-ink truncate">
                      {accountMap.get(pendingDelete.accountId)?.label || "Account"}
                      {accountMap.get(pendingDelete.accountId)?.externalRef
                        ? ` · #${accountMap.get(pendingDelete.accountId)?.externalRef}`
                        : ""}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-mut">Options held</dt>
                    <dd className="font-mono font-semibold text-ink">
                      {pendingDelete.quantity > 0 ? fmtQty(pendingDelete.quantity) : "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-mut">Strike</dt>
                    <dd className="font-mono font-semibold text-ink">
                      {pendingDelete.strike == null
                        ? "—"
                        : `$${money4(pendingDelete.strike)}`}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-mut">Current value</dt>
                    <dd className="font-mono font-semibold text-ink">
                      ${money2(pendingDelete.marketValue)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-mut">Unrealized P&amp;L</dt>
                    <dd
                      className={`font-mono font-semibold ${
                        pendingDelete.pnl >= 0 ? "text-gain" : "text-loss-d"
                      }`}
                    >
                      {pendingDelete.pnl < 0 ? "-" : "+"}$
                      {money2(Math.abs(pendingDelete.pnl))}
                    </dd>
                  </div>
                </dl>
              </div>

              {/* What the operator is actually agreeing to. The modelled value
                  is P&L in full — these grants cost nothing — so deleting one
                  moves the client's stored total by exactly that figure, and it
                  moves on their screen too. Saying so here is cheaper than
                  explaining it afterwards. */}
              <div className="rounded-[8px] bg-loss-bg/60 border border-loss/25 p-3 text-[11.5px] text-ink/90 space-y-1.5">
                <div className="font-semibold text-loss-d">
                  This grant stops being reported.
                </div>
                <ul className="space-y-1 text-mut">
                  <li>It leaves this register and the client&apos;s own Options tab.</li>
                  <li>
                    Its ${money2(pendingDelete.marketValue)} comes out of their stored
                    P&amp;L — an unlisted grant is free, so the whole modelled value is
                    gain.
                  </li>
                  <li>
                    The deletion is recorded, so the next recompute will not bring it
                    back from the Placement Tracker.
                  </li>
                </ul>
              </div>

              {/* Optional, and left optional on purpose: the usual reasons are
                  legible from the description above, and a required field would
                  collect "n/a" rather than anything worth auditing. */}
              <div className="space-y-1.5">
                <label
                  htmlFor="delete-option-reason"
                  className="text-[11px] font-semibold text-mut uppercase tracking-wider"
                >
                  Reason{" "}
                  <span className="font-medium normal-case tracking-normal">(optional)</span>
                </label>
                <input
                  id="delete-option-reason"
                  type="text"
                  value={deleteReason}
                  onChange={(e) => setDeleteReason(e.target.value)}
                  disabled={isDeleting}
                  placeholder="e.g. duplicate tranche in the tracker, lapsed unexercised"
                  className="w-full bg-paper/60 hover:bg-paper focus:bg-white border border-line rounded-lg px-3 py-2 text-xs text-ink placeholder:text-mut focus:outline-none focus:border-navy transition-all font-medium disabled:opacity-50"
                />
                <p className="text-[10.5px] text-mut">
                  Kept with the audit entry, alongside who deleted it and when.
                </p>
              </div>

              {deleteError && (
                <div className="rounded-[8px] bg-loss-bg border border-loss/40 p-3 text-[11.5px] font-medium text-loss-d">
                  {deleteError}
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="px-6 py-4 bg-paper border-t border-line flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={closeDeleteModal}
                disabled={isDeleting}
                className="border border-line bg-white rounded-lg px-3.5 py-1.5 text-xs font-semibold text-mut hover:text-ink hover:border-line-2 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                disabled={isDeleting}
                className="inline-flex items-center gap-1.5 border border-loss-d bg-loss-d rounded-lg px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-loss transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isDeleting ? (
                  <>
                    <span className="inline-block w-3 h-3 border-2 border-white/70 border-t-transparent rounded-full animate-spin" />
                    Deleting…
                  </>
                ) : (
                  <>
                    <Trash2 className="w-3.5 h-3.5" />
                    Delete option
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
