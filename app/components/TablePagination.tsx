"use client";

import React from "react";
import { ChevronLeft, ChevronRight, ChevronDown } from "lucide-react";

export interface TablePaginationProps {
  totalItems: number;
  currentPage: number;
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: number[];
  itemLabel?: string;
}

export function TablePagination({
  totalItems,
  currentPage,
  pageSize,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 25, 50, 100],
  itemLabel = "entries",
}: TablePaginationProps) {
  if (totalItems === 0) return null;

  const isAll = pageSize >= totalItems && pageSize > 100;
  const totalPages = isAll ? 1 : Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(Math.max(1, currentPage), totalPages);

  const startIdx = isAll ? 1 : (safePage - 1) * pageSize + 1;
  const endIdx = isAll ? totalItems : Math.min(safePage * pageSize, totalItems);

  // Generate page numbers with smart ellipsis
  const getPageNumbers = () => {
    if (totalPages <= 7) {
      return Array.from({ length: totalPages }, (_, i) => i + 1);
    }

    const pages: (number | string)[] = [];
    if (safePage <= 4) {
      pages.push(1, 2, 3, 4, 5, "...", totalPages);
    } else if (safePage >= totalPages - 3) {
      pages.push(1, "...", totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages);
    } else {
      pages.push(1, "...", safePage - 1, safePage, safePage + 1, "...", totalPages);
    }
    return pages;
  };

  return (
    <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3 px-4.5 py-3 border-t border-line bg-white text-xs text-mut select-none">
      {/* Left side: range count & segmented page size pills */}
      <div className="flex items-center gap-x-3 gap-y-2 flex-wrap">
        <span>
          Showing <strong className="text-ink font-mono font-semibold">{startIdx}</strong>–
          <strong className="text-ink font-mono font-semibold">{endIdx}</strong> of{" "}
          <strong className="text-ink font-mono font-semibold">{totalItems}</strong> {itemLabel}
        </span>

        {onPageSizeChange && totalItems > Math.min(...pageSizeOptions) && (
          <label className="flex items-center gap-1.5 sm:pl-2.5 sm:border-l sm:border-line">
            <span className="text-[11px] text-mut font-medium">Rows</span>
            {/*
              A dropdown rather than four pills. The segmented control spent a
              third of a phone's width on options nobody changes twice, and the
              chosen one was told apart from the rest by a slightly lighter
              background — which is a weak signal at 11px. A select shows the
              current value as text and hides the alternatives until they are
              wanted, which is the right ratio for a setting like this.

              Kept narrow deliberately: a `<select>` is as wide as its widest
              option, and that is how the account switcher pushed half the
              header off a phone. "All" is the widest thing in here.
            */}
            <span className="relative inline-flex items-center">
              <select
                value={isAll ? "all" : String(pageSize)}
                onChange={(e) => {
                  const v = e.target.value;
                  onPageSizeChange(v === "all" ? 999999 : Number(v));
                  onPageChange(1);
                }}
                aria-label="Rows per page"
                className="appearance-none cursor-pointer bg-paper-2 border border-line/60 rounded-[7px] pl-2.5 pr-6 py-1 text-[11px] font-mono font-semibold text-ink hover:border-line focus:outline-none focus:border-green"
              >
                {pageSizeOptions.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
                <option value="all">All</option>
              </select>
              <ChevronDown
                aria-hidden
                className="w-3 h-3 stroke-[2] text-mut absolute right-2 pointer-events-none"
              />
            </span>
          </label>
        )}
      </div>

      {/* Right side: segmented navigation controls */}
      {totalPages > 1 && (
        <div className="self-end sm:self-auto inline-flex items-center bg-paper-2 rounded-[8px] p-0.5 border border-line/60 gap-0.5">
          {/* Previous Button */}
          <button
            type="button"
            onClick={() => onPageChange(safePage - 1)}
            disabled={safePage <= 1}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-[6px] text-xs font-semibold text-ink hover:bg-white hover:shadow-xs disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:shadow-none disabled:cursor-not-allowed cursor-pointer transition-all"
            title="Previous page"
          >
            <ChevronLeft className="w-3.5 h-3.5" />
            Prev
          </button>

          {/* Page numbers */}
          <div className="hidden xs:flex items-center gap-0.5 px-0.5 border-x border-line/60">
            {getPageNumbers().map((p, idx) => {
              if (p === "...") {
                return (
                  <span key={`ellipsis-${idx}`} className="px-1.5 text-mut font-mono text-[11px]">
                    &hellip;
                  </span>
                );
              }
              const pageNum = Number(p);
              const isActive = pageNum === safePage;
              return (
                <button
                  key={pageNum}
                  type="button"
                  onClick={() => onPageChange(pageNum)}
                  className={`min-w-[26px] h-6.5 flex items-center justify-center rounded-[5px] text-xs font-mono font-semibold transition-all cursor-pointer ${
                    isActive
                      ? "bg-navy text-white shadow-xs font-bold"
                      : "text-ink hover:bg-white hover:shadow-xs"
                  }`}
                >
                  {pageNum}
                </button>
              );
            })}
          </div>

          {/* Next Button */}
          <button
            type="button"
            onClick={() => onPageChange(safePage + 1)}
            disabled={safePage >= totalPages}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-[6px] text-xs font-semibold text-ink hover:bg-white hover:shadow-xs disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:shadow-none disabled:cursor-not-allowed cursor-pointer transition-all"
            title="Next page"
          >
            Next
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
