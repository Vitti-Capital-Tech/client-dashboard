"use client";

import React from "react";

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
    <div className="flex flex-col sm:flex-row items-center justify-between gap-3 px-4.5 py-3 border-t border-line bg-white text-xs text-mut select-none">
      {/* Left side: range count & segmented page size pills */}
      <div className="flex items-center gap-3 flex-wrap">
        <span>
          Showing <strong className="text-ink font-mono font-semibold">{startIdx}</strong>–
          <strong className="text-ink font-mono font-semibold">{endIdx}</strong> of{" "}
          <strong className="text-ink font-mono font-semibold">{totalItems}</strong> {itemLabel}
        </span>

        {onPageSizeChange && totalItems > Math.min(...pageSizeOptions) && (
          <div className="flex items-center gap-1.5 pl-2.5 border-l border-line">
            <span className="text-[11px] text-mut font-medium">Rows:</span>
            <div className="inline-flex items-center bg-paper-2 rounded-[7px] p-0.5 border border-line/60">
              {pageSizeOptions.map((opt) => {
                const isSelected = !isAll && pageSize === opt;
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => {
                      onPageSizeChange(opt);
                      onPageChange(1);
                    }}
                    className={`px-2 py-0.5 rounded-[5px] text-[11px] font-mono font-semibold transition-all cursor-pointer ${
                      isSelected
                        ? "bg-white text-ink shadow-shadow"
                        : "text-mut hover:text-ink hover:bg-white/40"
                    }`}
                  >
                    {opt}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => {
                  onPageSizeChange(999999);
                  onPageChange(1);
                }}
                className={`px-2 py-0.5 rounded-[5px] text-[11px] font-medium transition-all cursor-pointer ${
                  isAll
                    ? "bg-white text-ink shadow-shadow font-semibold"
                    : "text-mut hover:text-ink hover:bg-white/40"
                }`}
              >
                All
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Right side: segmented navigation controls */}
      {totalPages > 1 && (
        <div className="inline-flex items-center bg-paper-2 rounded-[8px] p-0.5 border border-line/60 gap-0.5">
          {/* Previous Button */}
          <button
            type="button"
            onClick={() => onPageChange(safePage - 1)}
            disabled={safePage <= 1}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-[6px] text-xs font-semibold text-ink hover:bg-white hover:shadow-xs disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:shadow-none disabled:cursor-not-allowed cursor-pointer transition-all"
            title="Previous page"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
            </svg>
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
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
