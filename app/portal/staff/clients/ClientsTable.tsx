"use client";

import React, { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { setViewClient } from "@/app/actions/session";
import { TablePagination } from "@/app/components/TablePagination";

export type ClientRegistryRow = {
  id: string;
  initials: string;
  name: string;
  accountType: string;
  value: number;
  bidCount: number;
  s708: string;
  /**
   * Name, initials, email and every account's label / type / broker number,
   * lower-cased and joined — assembled by the page, which is where the accounts
   * are. See `searchKeyFor`.
   */
  searchKey: string;
};

export function ClientsTable({ rows }: { rows: ClientRegistryRow[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const filteredRows = useMemo(() => {
    // Every whitespace-separated term must match, in any order and in any
    // field: "smith smsf" finds the SMSF among four accounts a client holds,
    // which one contiguous substring could never do.
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return rows;
    return rows.filter((r) => terms.every((t) => r.searchKey.includes(t)));
  }, [rows, query]);

  const paginatedRows = useMemo(() => {
    if (pageSize >= filteredRows.length) return filteredRows;
    const start = (currentPage - 1) * pageSize;
    return filteredRows.slice(start, start + pageSize);
  }, [filteredRows, currentPage, pageSize]);

  const open = (id: string) => {
    void setViewClient(id); // keep the session's view-client in sync
    router.push(`/portal/staff/clients/${id}`);
  };

  // Typing changes which rows exist, so page 4 of the old list is not a place
  // that survives it — landing there shows an empty table over a full register.
  const search = (next: string) => {
    setQuery(next);
    setCurrentPage(1);
  };

  return (
    <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
      {/* Search */}
      <div className="flex flex-col sm:flex-row sm:items-center gap-2.5 px-4.5 py-3 border-b border-line">
        <div className="relative flex-1 max-w-md min-w-[200px]">
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
            // `text`, not `search`: WebKit draws its own clear button inside a
            // search input, which would sit beside the one below it. Escape is
            // wired by hand for the same reason — it comes free with `search`.
            type="text"
            value={query}
            onChange={(e) => search(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && search("")}
            placeholder="Search name, account number, structure, adviser…"
            className="w-full bg-paper-2/60 hover:bg-paper-2 focus:bg-white border border-line rounded-[8px] pl-8.5 pr-7 py-1.5 text-xs text-ink placeholder:text-mut focus:outline-none focus:border-navy transition-all font-medium"
          />
          {query && (
            <button
              type="button"
              onClick={() => search("")}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-mut hover:text-ink p-0.5 cursor-pointer"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* How much of the register is in view — the pagination footer states
            the same count, but it is hidden entirely on an empty result. */}
        {query && (
          <span className="text-[11px] text-mut font-medium whitespace-nowrap">
            <strong className="text-ink font-mono font-semibold">{filteredRows.length}</strong>
            {" of "}
            <strong className="text-ink font-mono font-semibold">{rows.length}</strong> clients
          </span>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-xs font-medium">
          <thead>
            <tr className="border-b border-line text-mut select-none">
              <th className="px-4.5 py-3 font-semibold uppercase tracking-wider text-[10.5px]">Client</th>
              <th className="px-4.5 py-3 font-semibold uppercase tracking-wider text-[10.5px]">Structure</th>
              <th className="px-4.5 py-3 font-semibold uppercase tracking-wider text-[10.5px] text-right">Portfolio value</th>
              <th className="px-4.5 py-3 font-semibold uppercase tracking-wider text-[10.5px] text-center">Active bids</th>
              <th className="px-4.5 py-3 font-semibold uppercase tracking-wider text-[10.5px] text-right">s708 expiry</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#f0ede5]">
            {paginatedRows.map((r) => (
              <tr
                key={r.id}
                onClick={() => open(r.id)}
                className="hover:bg-[#faf9f5] cursor-pointer transition-colors"
              >
                <td className="px-4.5 py-3.5 flex items-center gap-2">
                  <span className="w-6.5 h-6.5 rounded-full bg-paper-2 border border-line flex items-center justify-center font-bold text-[10.5px] text-ink uppercase">
                    {r.initials}
                  </span>
                  <span className="font-bold text-ink">{r.name}</span>
                </td>
                <td className="px-4.5 py-3.5 text-mut">{r.accountType}</td>
                <td className="px-4.5 py-3.5 text-right font-mono text-[13px]">${Math.round(r.value).toLocaleString("en-AU")}</td>
                <td className="px-4.5 py-3.5 text-center">
                  <span className={`pill text-[10.5px] font-bold rounded-full px-2 py-0.5 ${r.bidCount > 0 ? "bg-green-bg text-green-d" : "bg-paper-2 text-mut"}`}>
                    {r.bidCount} bids
                  </span>
                </td>
                <td className="px-4.5 py-3.5 text-right text-mut font-mono">{r.s708}</td>
              </tr>
            ))}

            {paginatedRows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4.5 py-10 text-center text-mut">
                  {query ? (
                    <>
                      No client matches <span className="font-semibold text-ink">“{query}”</span>.
                      <button
                        type="button"
                        onClick={() => search("")}
                        className="ml-2 font-semibold text-navy underline underline-offset-2 cursor-pointer"
                      >
                        Clear search
                      </button>
                    </>
                  ) : (
                    "No clients on the register yet."
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <TablePagination
        totalItems={filteredRows.length}
        currentPage={currentPage}
        pageSize={pageSize}
        onPageChange={setCurrentPage}
        onPageSizeChange={setPageSize}
        pageSizeOptions={[5, 10, 25, 50]}
        itemLabel="clients"
      />
    </div>
  );
}

