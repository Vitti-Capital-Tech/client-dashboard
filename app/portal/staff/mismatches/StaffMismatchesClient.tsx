"use client";

import React, { useState, useMemo } from "react";
import type { StoredPnlRow } from "@/lib/data/pnl";
import type { PnlOverrideRow } from "@/lib/data/holdings";
import type { ClientRow, AccountRow } from "@/lib/data/queries";
import { TablePagination } from "@/app/components/TablePagination";
import { MismatchRow, type MismatchItem } from "./MismatchRow";

type FilterTab = "all" | "pending" | "fixed" | "short_buy" | "buy_unknown";

const money2 = (n: number) =>
  n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Identify internal broker / suspense / house accounts that should be excluded from client mismatch monitoring:
 * e.g. "Placement - Vitti Capital Pty Ltd", "Errors - Vitt - Suspense", "ErrVitti".
 */
function isHouseOrSuspenseAccount(
  clientName?: string | null,
  accountExternalRef?: string | null,
  accountLabel?: string | null,
): boolean {
  const n = (clientName || "").toLowerCase();
  const ref = (accountExternalRef || "").toLowerCase();
  const label = (accountLabel || "").toLowerCase();

  // Match 'Placement - Vitti Capital Pty Ltd', 'Placement - Vitti', etc.
  if (
    n.includes("placement - vitti") ||
    n.includes("placement-vitti") ||
    (n.includes("vitti capital") && n.includes("placement"))
  ) {
    return true;
  }

  // Match 'ErrVitti', 'Errors - Vitt - Suspense', 'Suspense', 'Errors - Vitti', etc.
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

export function StaffMismatchesClient({
  storedPnl,
  overrides,
  clients,
  accounts,
}: {
  storedPnl: StoredPnlRow[];
  overrides: PnlOverrideRow[];
  clients: ClientRow[];
  accounts: AccountRow[];
}) {
  const [activeFilterTab, setActiveFilterTab] = useState<FilterTab>("all");
  const [selectedClientFilter, setSelectedClientFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [editingKey, setEditingKey] = useState<string | null>(null);

  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);

  // Map clients and accounts for fast lookup
  const clientMap = useMemo(
    () => new Map(clients.map((c) => [c.id, c])),
    [clients],
  );

  const accountMap = useMemo(
    () => new Map(accounts.map((a) => [a.id, a])),
    [accounts],
  );

  // Map overrides by accountId:parentCode
  const overridesMap = useMemo(() => {
    const map = new Map<string, PnlOverrideRow>();
    for (const o of overrides) {
      map.set(`${o.accountId}:${o.parent}`, o);
    }
    return map;
  }, [overrides]);

  // Build all mismatch items across all accounts: strictly rows where buyQty !== sellQty or flagged
  const allMismatches: MismatchItem[] = useMemo(() => {
    const items: MismatchItem[] = [];

    for (const r of storedPnl) {
      // 1. Skip all option rows (listed options and unlisted placement grants)
      const isOption = Boolean(
        r.isOption ||
        r.isUnlistedOption ||
        r.ticker.endsWith("-UO") ||
        (r.instrument && r.instrument.toLowerCase().includes("option"))
      );
      if (isOption) continue;

      const client = clientMap.get(r.clientId);
      const account = accountMap.get(r.accountId);
      const clientName = client?.name ?? "Unknown Client";
      const accountExternalRef = account?.externalRef ?? null;
      const accountLabel = account?.label ?? "Account";

      // 2. Exclude internal broker/house accounts (Placement - Vitti Capital Pty Ltd, ErrVitti / Suspense)
      if (isHouseOrSuspenseAccount(clientName, accountExternalRef, accountLabel)) {
        continue;
      }

      // Check if there is an existing override on this row
      const parentCode = r.parentTicker || r.ticker;
      const o = overridesMap.get(`${r.accountId}:${parentCode}`);

      const computed = {
        buyQty: r.buyQty,
        sellQty: r.sellQty,
        buyPrice: r.buyPrice,
        sellOrCurrent: r.sellPrice,
        pnl: r.pnl,
      };

      const overridden = {
        buyQty: o?.buyQty != null,
        sellQty: o?.sellQty != null,
        buyPrice: o?.buyPrice != null,
        sellOrCurrent: o?.sellOrCurrent != null,
      };

      const edited =
        overridden.buyQty ||
        overridden.sellQty ||
        overridden.buyPrice ||
        overridden.sellOrCurrent;

      const buyQty = o?.buyQty ?? computed.buyQty;
      const sellQty = o?.sellQty ?? computed.sellQty;
      const buyPrice = o?.buyPrice ?? computed.buyPrice;
      const sellOrCurrent = o?.sellOrCurrent ?? computed.sellOrCurrent;
      const pnl = sellOrCurrent - buyPrice;

      /**
       * What the SOURCES produced — why the row is on this page at all.
       *
       * `placementYearUnresolved` is deliberately not one of these. It says the
       * tracker placed a ticker in more than one year and the engine could not
       * pick one — a sourcing ambiguity, not a quantity discrepancy. Its rows
       * balance perfectly, so listing them here filled a page called "Mismatched
       * Qty" with rows that had nothing wrong with their quantities and buried
       * the ones that did. A year conflict with no buy side behind it is still
       * caught, because that is what `buySideUnknown` already means.
       */
      const hadDiscrepancy =
        computed.buyQty !== computed.sellQty ||
        Boolean(r.buySideUnknown) ||
        (computed.buyQty === 0 && computed.sellQty > 0);

      /**
       * What is TRUE NOW, with the desk's overrides applied.
       *
       * Everything below is judged on these rather than on `computed`. Reading
       * the stored figures is what had a row keep the badge "0 Buys vs 250,000
       * Sold" after someone had typed 250,000 into its Buy Qty — the fix was in
       * force everywhere else in the platform, and the one page whose job is to
       * track fixes was the last to notice.
       */
      const stillNoBuySide = buyQty === 0 && sellQty > 0;
      const stillOff = buyQty !== sellQty || stillNoBuySide;

      // Fixed: it WAS a discrepancy and the values in force reconcile. Only an
      // override can do that, so this is the audit view's population.
      const resolved = hadDiscrepancy && !stillOff;

      // Clean rows are strictly excluded. So is a row whose only edit was to a
      // price — nothing about its quantities was ever in question.
      if (!hadDiscrepancy && !stillOff) {
        continue;
      }

      // Discrepancy label & type — from the values in force, so a corrected row
      // never keeps describing the problem it no longer has.
      let discrepancyType: MismatchItem["discrepancyType"] = "unmatched";
      let discrepancyLabel = "Unmatched Qty";
      const discrepancyDiff = Math.abs(sellQty - buyQty);

      if (stillNoBuySide) {
        discrepancyType = "buy_unknown";
        discrepancyLabel = `0 Buys vs ${sellQty.toLocaleString("en-AU")} Sold`;
      } else if (buyQty < sellQty) {
        discrepancyType = "short_buy";
        discrepancyLabel = `Short Buy (${(sellQty - buyQty).toLocaleString("en-AU")})`;
      } else if (sellQty < buyQty) {
        discrepancyType = "short_sell";
        // "Excess Buy" is only true against something sold. With ZERO sells
        // there is nothing for the buy side to be in excess of — the parcel was
        // bought and never disposed of, which usually means it is still held and
        // the holdings snapshot has not caught up. Say what the ledger says and
        // let the desk decide; `Mark Open` is the one-click answer.
        discrepancyLabel =
          sellQty === 0
            ? `${buyQty.toLocaleString("en-AU")} Bought, 0 Sold`
            : `Excess Buy (${(buyQty - sellQty).toLocaleString("en-AU")})`;
      } else if (resolved) {
        discrepancyType = "unmatched";
        discrepancyLabel = "Fixed with Override";
      }

      items.push({
        ticker: r.ticker,
        name: r.company || r.ticker,
        buyQty,
        sellQty,
        buyPrice,
        sellOrCurrent,
        pnl,
        openPosition: r.openQty > 0,
        type: resolved ? "Matched (edited)" : edited ? "Unmatched (edited)" : "Unmatched",
        // Red means "the quantities do not add up", so a corrected row stops
        // being red. The year flag no longer colours anything here either — a
        // row is on this page for its quantities.
        flagged: stillNoBuySide,
        edited: !!edited,
        resolved,
        overridden,
        note: o?.note ?? r.comment ?? null,
        computed,
        excludedFromTotal: r.buySideUnknown && buyPrice === 0 && buyQty === 0,
        isMatched: !stillOff && buyQty > 0,
        isOption: r.isOption,
        isUnlistedOption: r.isUnlistedOption,
        isDbOpenValued: r.isDbOpenValued,
        isDbOnly: r.isDbOnly,
        openQty: r.openQty,

        accountId: r.accountId,
        clientId: r.clientId,
        clientName: client?.name ?? "Unknown Client",
        clientInitials: client?.initials ?? null,
        accountLabel: account?.label ?? "Account",
        accountExternalRef: account?.externalRef ?? null,
        discrepancyType,
        discrepancyLabel,
        discrepancyDiff,
      });
    }

    // Sort: unedited pending mismatches first, then by largest shortfall / discrepancy
    return items.sort((a, b) => {
      if (a.edited !== b.edited) return a.edited ? 1 : -1;
      return b.discrepancyDiff - a.discrepancyDiff || a.clientName.localeCompare(b.clientName);
    });
  }, [storedPnl, overridesMap, clientMap, accountMap]);

  /**
   * Counts for the KPI cards and the filter tabs.
   *
   * Everything except `fixed` counts OUTSTANDING rows only. A row whose
   * quantities now reconcile is not a discrepancy — counting it under "Total
   * Discrepancies" turned a number the desk works down into one that only ever
   * grows, and left "Affected Clients" naming clients with nothing left to fix.
   */
  const outstanding = useMemo(() => allMismatches.filter((m) => !m.resolved), [allMismatches]);

  const counts = useMemo(() => {
    const pending = outstanding.filter((m) => !m.edited).length;
    const fixed = allMismatches.filter((m) => m.resolved).length;
    const shortBuy = outstanding.filter((m) => m.discrepancyType === "short_buy").length;
    const buyUnknown = outstanding.filter((m) => m.discrepancyType === "buy_unknown").length;
    const affectedClients = new Set(outstanding.map((m) => m.clientId)).size;
    const affectedAccounts = new Set(outstanding.map((m) => m.accountId)).size;

    return {
      all: outstanding.length,
      pending,
      fixed,
      shortBuy,
      buyUnknown,
      affectedClients,
      affectedAccounts,
    };
  }, [allMismatches, outstanding]);

  // Filtered rows based on tab, client dropdown, and search query
  const filteredRows = useMemo(() => {
    return allMismatches.filter((row) => {
      // A reconciled row belongs in ONE place: the audit tab that exists to show
      // what was fixed. Everywhere else it is finished work, and leaving it in
      // the list is what made a corrected buy side look like it had not taken.
      if (activeFilterTab === "fixed") {
        if (!row.resolved) return false;
      } else if (row.resolved) {
        return false;
      }

      // Filter tab
      if (activeFilterTab === "pending" && row.edited) return false;
      if (activeFilterTab === "short_buy" && row.discrepancyType !== "short_buy") return false;
      if (activeFilterTab === "buy_unknown" && row.discrepancyType !== "buy_unknown") return false;

      // Client dropdown
      if (selectedClientFilter !== "all" && row.clientId !== selectedClientFilter) return false;

      // Search query
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const matches =
          row.ticker.toLowerCase().includes(q) ||
          row.name.toLowerCase().includes(q) ||
          row.clientName.toLowerCase().includes(q) ||
          (row.accountExternalRef && row.accountExternalRef.toLowerCase().includes(q)) ||
          (row.note && row.note.toLowerCase().includes(q));
        if (!matches) return false;
      }

      return true;
    });
  }, [allMismatches, activeFilterTab, selectedClientFilter, searchQuery]);

  // Paginated slice
  const paginatedRows = useMemo(() => {
    if (pageSize >= filteredRows.length) return filteredRows;
    const start = (currentPage - 1) * pageSize;
    return filteredRows.slice(start, start + pageSize);
  }, [filteredRows, currentPage, pageSize]);

  // Clients that have mismatches for the dropdown selector
  const mismatchClients = useMemo(() => {
    const clientIds = new Set(allMismatches.map((m) => m.clientId));
    return clients
      .filter((c) => clientIds.has(c.id))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [allMismatches, clients]);

  return (
    <div className="space-y-5">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Mismatched Qty in P&amp;L</h1>
          <p className="text-xs text-mut mt-0.5">
            Identify and fix quantity discrepancies, short buys, and missing trade legs across all client accounts.
          </p>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5 select-none">
        <div className="card bg-white border border-line rounded-[14px] p-4 shadow-shadow space-y-1">
          <div className="text-[11px] font-semibold text-mut uppercase tracking-wider">Total Discrepancies</div>
          <div className="text-2xl font-mono font-bold text-ink">{counts.all}</div>
          <div className="text-[11px] text-mut">Across {counts.affectedAccounts} accounts</div>
        </div>

        <div className="card bg-white border border-amber-200 bg-amber-50/20 rounded-[14px] p-4 shadow-shadow space-y-1">
          <div className="text-[11px] font-semibold text-amber-800 uppercase tracking-wider">Pending Fixes</div>
          <div className="text-2xl font-mono font-bold text-amber-700">{counts.pending}</div>
          <div className="text-[11px] text-amber-700/80">Need desk override</div>
        </div>

        <div className="card bg-white border border-blue-200 bg-blue-50/20 rounded-[14px] p-4 shadow-shadow space-y-1">
          <div className="text-[11px] font-semibold text-blue-800 uppercase tracking-wider">Fixed with Overrides</div>
          <div className="text-2xl font-mono font-bold text-blue-700">{counts.fixed}</div>
          <div className="text-[11px] text-blue-700/80">Active in reports</div>
        </div>

        <div className="card bg-white border border-line rounded-[14px] p-4 shadow-shadow space-y-1">
          <div className="text-[11px] font-semibold text-mut uppercase tracking-wider">Affected Clients</div>
          <div className="text-2xl font-mono font-bold text-ink">{counts.affectedClients}</div>
          <div className="text-[11px] text-mut">With reconciliation needs</div>
        </div>
      </div>

      {/* Main Table Card */}
      <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden space-y-0">
        {/* Controls Header */}
        <div className="px-4.5 py-3.5 border-b border-line bg-white select-none space-y-3">
          {/* Filter Tabs */}
          <div className="w-full bg-paper-2 rounded-[10px] p-1 flex items-center gap-1 overflow-x-auto flex-wrap sm:flex-nowrap border border-line/60">
            {(
              [
                { id: "all", label: "All Mismatches", count: counts.all },
                { id: "pending", label: "Pending Fix", count: counts.pending },
                { id: "fixed", label: "Fixed / Edited", count: counts.fixed },
                { id: "short_buy", label: "Short Buy", count: counts.shortBuy },
                { id: "buy_unknown", label: "0 Buys (Unknown)", count: counts.buyUnknown },
              ] as const
            ).map((t) => {
              const active = activeFilterTab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    setActiveFilterTab(t.id);
                    setCurrentPage(1);
                  }}
                  className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-1.75 rounded-[7px] text-xs cursor-pointer transition-all whitespace-nowrap ${
                    active
                      ? "bg-white text-ink font-semibold shadow-shadow border border-line/60"
                      : "text-mut hover:text-ink font-medium hover:bg-white/50"
                  }`}
                >
                  <span>{t.label}</span>
                  <span
                    className={`text-[10.5px] font-mono px-1.5 py-0.5 rounded-[4px] font-semibold transition-colors ${
                      active ? "bg-paper-2 text-ink" : "bg-line/40 text-mut"
                    }`}
                  >
                    {t.count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Search and Client Dropdown */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 pt-0.5">
            <div className="flex items-center gap-2.5 flex-1 max-w-xl flex-wrap sm:flex-nowrap">
              {/* Search Bar */}
              <div className="relative flex-1 min-w-[200px]">
                <svg
                  className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-mut pointer-events-none"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth="2"
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                  />
                </svg>
                <input
                  type="text"
                  placeholder="Search ticker, company, client, note..."
                  value={searchQuery}
                  onChange={(e) => {
                    setSearchQuery(e.target.value);
                    setCurrentPage(1);
                  }}
                  className="w-full bg-paper-2/60 hover:bg-paper-2 focus:bg-white border border-line rounded-[8px] pl-8.5 pr-7 py-1.5 text-xs text-ink placeholder:text-mut focus:outline-none focus:border-navy transition-all font-medium"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery("");
                      setCurrentPage(1);
                    }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-mut hover:text-ink p-0.5 cursor-pointer"
                  >
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>

              {/* Client Filter Dropdown */}
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <span className="text-[11px] text-mut font-medium">Client:</span>
                <select
                  value={selectedClientFilter}
                  onChange={(e) => {
                    setSelectedClientFilter(e.target.value);
                    setCurrentPage(1);
                  }}
                  className="bg-paper-2 border border-line rounded-[7px] px-2.5 py-1.5 text-xs font-semibold text-ink focus:outline-none focus:border-navy cursor-pointer max-w-[180px]"
                >
                  <option value="all">All Clients ({counts.affectedClients})</option>
                  {mismatchClients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Reset Button */}
            {(activeFilterTab !== "all" || selectedClientFilter !== "all" || searchQuery) && (
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-mut">
                  Showing <strong className="text-ink">{filteredRows.length}</strong> of {allMismatches.length}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setActiveFilterTab("all");
                    setSelectedClientFilter("all");
                    setSearchQuery("");
                    setCurrentPage(1);
                  }}
                  className="inline-flex items-center gap-1 border border-line bg-white hover:bg-paper-2 rounded-[7px] px-2.5 py-1 text-[11px] font-semibold text-mut hover:text-ink transition-colors cursor-pointer"
                >
                  <svg className="w-3 h-3 text-mut" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                  Reset
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Table Content */}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs font-medium">
            <thead>
              <tr className="border-b border-line text-mut select-none">
                <th className="px-4.5 py-2.5">Client &amp; Account</th>
                <th className="px-4.5 py-2.5 whitespace-nowrap">Ticker</th>
                <th className="px-4.5 py-2.5 whitespace-nowrap">Discrepancy</th>
                <th className="px-4.5 py-2.5 text-right whitespace-nowrap">Buy Qty</th>
                <th className="px-4.5 py-2.5 text-right whitespace-nowrap">Sell Qty</th>
                <th className="px-4.5 py-2.5 text-right whitespace-nowrap">Buy Cost ($)</th>
                <th className="px-4.5 py-2.5 text-right whitespace-nowrap">Sell / Current ($)</th>
                <th className="px-4.5 py-2.5 text-right whitespace-nowrap">P&amp;L ($)</th>
                <th className="px-4.5 py-2.5">Status &amp; Notes</th>
                <th className="px-4.5 py-2.5 text-right whitespace-nowrap">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#f0ede5]">
              {filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="text-center text-mut py-10">
                    {/* An emptied-out page is the GOAL, so it has to read as
                        one — counting rows the desk has already fixed would
                        report a finished job as "nothing matches your filter". */}
                    {outstanding.length === 0
                      ? "🎉 No quantity mismatches or shortfalls outstanding! All client accounts reconcile cleanly."
                      : "No mismatches match the active filters or search query."}
                  </td>
                </tr>
              ) : (
                paginatedRows.map((row) => {
                  const key = `${row.accountId}:${row.ticker}`;
                  const isEditing = editingKey === key;

                  return (
                    <MismatchRow
                      key={key}
                      row={row}
                      editing={isEditing}
                      onEdit={() => setEditingKey(key)}
                      onClose={() => setEditingKey(null)}
                      money2={money2}
                    />
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination Footer */}
        <TablePagination
          totalItems={filteredRows.length}
          currentPage={currentPage}
          pageSize={pageSize}
          onPageChange={setCurrentPage}
          onPageSizeChange={setPageSize}
          pageSizeOptions={[10, 15, 25, 50, 100]}
          itemLabel="mismatches"
        />
      </div>
    </div>
  );
}
