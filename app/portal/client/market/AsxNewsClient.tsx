"use client";

import { useMemo, useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { TablePagination } from "@/app/components/TablePagination";
import { NewsViewToggle, useNewsView } from "@/app/components/NewsViewToggle";
import { WatchButton } from "@/app/components/WatchButton";
import type { AsxAnnouncement, AsxSentiment } from "@/lib/asx/news";

const SENTIMENT_PILL: Record<AsxSentiment, string> = {
  bullish: "bg-green-bg text-green-d",
  bearish: "bg-loss-bg text-loss-d",
  neutral: "bg-paper-2 text-mut",
};

type Filter = "all" | AsxSentiment | "held";

function annTime(iso: string): string {
  if (!iso) return "";
  return new Date(iso)
    .toLocaleTimeString("en-AU", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "Australia/Sydney",
    })
    .replace(/\s/g, "")
    .toLowerCase();
}

/**
 * What the price was doing going into a filing.
 *
 * Measured upstream from bars that closed before the announcement and passed
 * through untouched, so this page and the ASX dashboard state the same figures
 * for the same filing. Nothing here is generated — these are the part of a row
 * a reader can check against a chart, which is why they sit above the AI
 * summary rather than under it.
 *
 * A thinly traded stock's ratios are shown in the muted tone with its turnover
 * named, rather than coloured like a signal: a volume spike on A$4,000 a day is
 * two people, and presenting it as interest would be the lie.
 */
function ContextChips({ ctx }: { ctx: NonNullable<AsxAnnouncement["context"]> }) {
  const tone = !ctx.liquid
    ? "bg-paper-2 text-mut"
    : ctx.brokeOut || ctx.atHigh
      ? "bg-green-bg text-green-d"
      : ctx.atLow
        ? "bg-loss-bg text-loss-d"
        : "bg-paper-2 text-mut";

  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-2">
      {ctx.notes.slice(0, 2).map((n) => (
        <span key={n} className={`text-[10px] font-medium rounded-full px-2 py-0.5 ${tone}`}>
          {n}
        </span>
      ))}
      {/* Not decoration: these are pre-announcement figures, and a reader who
          takes them as live would draw the wrong conclusion. */}
      <span className="font-mono text-[9.5px] text-mut-d">to {ctx.asOf}</span>
      {/* A footnote, not a chip. As a chip this was a full sentence wrapping
          over two lines, and it displaced the observations it qualifies. */}
      {ctx.caveat && (
        <span className="w-full text-[10px] text-mut-d first-letter:uppercase">
          {ctx.caveat}
        </span>
      )}
    </div>
  );
}

interface Props {
  /** Already sorted upstream: holdings first, newest within each group. */
  items: AsxAnnouncement[];
  /** Tickers in the client's book, for the marker and the "in my book" filter. */
  heldCodes: string[];
  /** Tickers already on the client's watchlist, so the star starts filled. */
  watchedCodes: string[];
  /** Filings that day, which can exceed `items.length` if the fetch was capped. */
  total: number;
  asAt: string | null;
}

/**
 * The day's price-sensitive filings, filterable and paged.
 *
 * A client component because filtering and paging are interactions; the fetch
 * and the day's figures stay in the server component and arrive as props. Fifty
 * to sixty filings on an ordinary day — 294 on 27 Aug — is more than anyone
 * reads in one column, but the answer is not to show fewer and hide the rest:
 * it is to let someone say which ones they want.
 */
export function AsxNewsClient({ items, heldCodes, watchedCodes, total, asAt }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  // Shared with Insights and remembered per browser, so the choice is made once.
  const [view, setView] = useNewsView();

  const held = useMemo(() => new Set(heldCodes), [heldCodes]);
  const watched = useMemo(() => new Set(watchedCodes), [watchedCodes]);

  const counts = useMemo(
    () => ({
      all: items.length,
      bullish: items.filter((a) => a.sentiment === "bullish").length,
      bearish: items.filter((a) => a.sentiment === "bearish").length,
      neutral: items.filter((a) => a.sentiment === "neutral").length,
      held: items.filter((a) => held.has(a.code)).length,
    }),
    [items, held],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((a) => {
      if (filter === "held" ? !held.has(a.code) : filter !== "all" && a.sentiment !== filter) {
        return false;
      }
      if (!q) return true;
      return (
        a.code.toLowerCase().includes(q) ||
        a.company.toLowerCase().includes(q) ||
        a.headline.toLowerCase().includes(q)
      );
    });
  }, [items, filter, search, held]);

  // Clamp rather than reset: a filter that shortens the list past the current
  // page should land on the last page of results, not silently on page 1 with
  // no explanation of where the rows went.
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const visible =
    pageSize >= filtered.length
      ? filtered
      : filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  // Only the tabs worth offering. A "Bearish 0" tab that yields an empty list
  // is a dead end dressed as a choice.
  const tabs = ([
    { key: "all", label: "All", count: counts.all },
    { key: "bullish", label: "Bullish", count: counts.bullish },
    { key: "bearish", label: "Bearish", count: counts.bearish },
    { key: "neutral", label: "Neutral", count: counts.neutral },
    { key: "held", label: "In my book", count: counts.held },
  ] satisfies { key: Filter; label: string; count: number }[]).filter(
    (t) => t.key === "all" || t.count > 0,
  );

  function pick(next: Filter) {
    setFilter(next);
    setPage(1);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <div className="font-mono text-[11px] tracking-wider uppercase text-mut">
          ASX market-sensitive announcements
        </div>
        {asAt && (
          <div className="font-mono text-[10.5px] text-mut-d shrink-0">as at {asAt}</div>
        )}
      </div>

      <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
        {/* Filters */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4.5 py-3.5 border-b border-line">
          <div className="inline-flex bg-paper-2 rounded-[9px] p-0.75 flex-wrap">
            {tabs.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => pick(t.key)}
                aria-pressed={filter === t.key}
                className={`text-xs font-semibold px-3 py-1.5 rounded-[7px] cursor-pointer transition-colors ${
                  filter === t.key ? "bg-white text-ink shadow-shadow" : "text-mut hover:text-ink"
                }`}
              >
                {t.label}{" "}
                <span className="font-mono text-[11px] text-mut-d">{t.count}</span>
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto">
            <input
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Search ticker, company or headline"
              aria-label="Search announcements"
              className="flex-1 min-w-0 sm:flex-none sm:w-60 border border-line-2 bg-white rounded-[9px] px-3 py-2 text-xs focus:border-green focus:outline-none transition-colors"
            />
            <NewsViewToggle view={view} onChange={setView} className="flex-none" />
          </div>
        </div>

        {/* Rows — the same filings either way; only the shape changes. The list
            is the density-first read, the grid is the scannable one, and which
            of those somebody wants depends on whether they are working through
            the day or looking for one name in it. */}
        {visible.length === 0 ? (
          <div className="px-4.5 py-10 text-center">
            <b className="text-sm font-semibold text-ink block">No filings match</b>
            <p className="text-xs text-mut mt-1">
              {search.trim()
                ? "Try a different ticker or company."
                : "Nothing in this category today."}
            </p>
          </div>
        ) : view === "list" ? (
          <div className="divide-y divide-line">
            {visible.map((a) => {
              const owned = held.has(a.code);
              return (
                <a
                  key={a.id}
                  href={a.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block px-4.5 py-3.5 hover:bg-paper transition-colors group"
                >
                  <div className="flex items-start gap-2">
                    <div className="flex items-center gap-2 flex-wrap min-w-0 flex-1">
                    <span
                      className={`code font-mono text-[11px] px-1 rounded-sm font-bold ${owned ? "text-green-d" : "text-ink"}`}
                    >
                      {a.code} {owned && "●"}
                    </span>
                    <span
                      className={`pill text-[10px] font-bold rounded-full px-2 py-0.5 ${SENTIMENT_PILL[a.sentiment]}`}
                    >
                      {a.sentiment}
                    </span>
                    <span className="font-mono text-[10px] text-mut uppercase tracking-wider">
                      {a.company} &middot; {annTime(a.released)}
                    </span>
                    </div>

                    {/* Reading a filing is where somebody decides to follow a
                        company, so the control belongs on the filing rather than
                        on a page they would have to go and find. */}
                    <span className="flex items-center gap-1.5 flex-none">
                      <WatchButton
                        code={a.code}
                        name={a.company || a.code}
                        initiallyWatching={watched.has(a.code)}
                      />
                      <ArrowUpRight
                        aria-hidden
                        className="w-3.5 h-3.5 text-mut-d transition-all
                                   group-hover:text-green-d group-hover:-translate-y-px"
                      />
                    </span>
                  </div>

                  <div className="font-semibold text-[13.5px] leading-snug mt-1.5 group-hover:underline">
                    {a.headline}
                  </div>

                  {a.context && <ContextChips ctx={a.context} />}

                  {a.summary[0] && (
                    <p className="text-xs text-mut leading-relaxed mt-1.5 line-clamp-2">
                      {a.summary[0]}
                    </p>
                  )}
                </a>
              );
            })}
          </div>
        ) : (
          <div className="p-4.5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {visible.map((a) => {
              const owned = held.has(a.code);
              return (
                <a
                  key={a.id}
                  href={a.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="group flex flex-col border border-line rounded-[12px] bg-white p-3.5
                             hover:bg-paper hover:border-line-2 transition-colors"
                >
                  <div className="flex items-start gap-2">
                    <div className="flex items-center gap-2 flex-wrap min-w-0 flex-1">
                      <span
                        className={`code font-mono text-[11px] px-1 rounded-sm font-bold ${owned ? "text-green-d" : "text-ink"}`}
                      >
                        {a.code} {owned && "●"}
                      </span>
                      <span
                        className={`pill text-[10px] font-bold rounded-full px-2 py-0.5 ${SENTIMENT_PILL[a.sentiment]}`}
                      >
                        {a.sentiment}
                      </span>
                    </div>

                    <span className="flex items-center gap-1.5 flex-none">
                      <WatchButton
                        code={a.code}
                        name={a.company || a.code}
                        initiallyWatching={watched.has(a.code)}
                      />
                      <ArrowUpRight
                        aria-hidden
                        className="w-3.5 h-3.5 text-mut-d transition-all
                                   group-hover:text-green-d group-hover:-translate-y-px"
                      />
                    </span>
                  </div>

                  <div className="font-mono text-[10px] text-mut uppercase tracking-wider truncate mt-1.5">
                    {a.company} &middot; {annTime(a.released)}
                  </div>

                  {/* Clamped rather than left to run: in a grid an unclamped
                      headline stretches its whole row, and a row of cards that
                      are tall because one of them is tall reads as broken. */}
                  <div className="font-semibold text-[13.5px] leading-snug mt-1 group-hover:underline line-clamp-3">
                    {a.headline}
                  </div>

                  {a.context && <ContextChips ctx={a.context} />}

                  {a.summary[0] && (
                    <p className="text-xs text-mut leading-relaxed mt-1.5 line-clamp-3">
                      {a.summary[0]}
                    </p>
                  )}
                </a>
              );
            })}
          </div>
        )}

        <TablePagination
          totalItems={filtered.length}
          currentPage={safePage}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
          pageSizeOptions={[10, 25, 50]}
          itemLabel="filings"
        />

        {/* Only when the fetch itself was capped, which the pagination above
            cannot know about — it pages what arrived, not what exists. */}
        {items.length < total && (
          <div className="px-4.5 py-2.5 border-t border-line text-[11px] text-mut-d text-center">
            Showing the {items.length} most recent of {total} filings today.
          </div>
        )}
      </div>
    </div>
  );
}
