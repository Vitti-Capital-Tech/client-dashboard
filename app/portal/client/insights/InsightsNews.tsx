"use client";

import { ArrowUpRight, Layers, Newspaper } from "lucide-react";
import { NewsViewToggle, useNewsView } from "@/app/components/NewsViewToggle";
import { WatchButton } from "@/app/components/WatchButton";
import type { AsxAnnouncement, AsxSentiment } from "@/lib/asx/news";

const SENTIMENT_PILL: Record<AsxSentiment, string> = {
  bullish: "bg-green-bg text-green-d",
  bearish: "bg-loss-bg text-loss-d",
  neutral: "bg-paper-2 text-mut",
};

/**
 * The two news sections of Insights, in whichever shape the reader asked for.
 *
 * Client components because the layout toggle is an interaction; the narrowing
 * of the feed to this client's book stays on the server and arrives as props.
 * Both sections carry their own toggle rather than sharing one at the top of
 * the page — a control that reaches past the card it sits in is a control
 * nobody trusts — and `useNewsView` keeps the two in step, so moving either one
 * moves both.
 */

/** The ticker, the read, and the company. Shared by both sections. */
function Meta({ a, muted = false }: { a: AsxAnnouncement; muted?: boolean }) {
  return (
    <div className="flex items-center gap-2 flex-wrap min-w-0 flex-1">
      <span
        className={`code font-mono text-[11px] px-1 rounded-sm font-bold ${muted ? "text-ink" : "text-green-d"}`}
      >
        {a.code}
      </span>
      <span
        className={`pill text-[10px] font-bold rounded-full px-2 py-0.5 ${SENTIMENT_PILL[a.sentiment]}`}
      >
        {a.sentiment}
      </span>
      <span className="font-mono text-[10px] text-mut uppercase tracking-wider truncate">
        {a.company}
      </span>
    </div>
  );
}

/**
 * One of the client's own filings.
 *
 * The upstream summary stays in full in both shapes: on Market it is one line
 * among 59 and a teaser is right, but here there are a handful and they are the
 * client's own. Cards in a row stretch to the tallest of them, which is the
 * cost of that and a cheap one at this count.
 */
function HoldingItem({
  a,
  watching,
  card,
}: {
  a: AsxAnnouncement;
  watching: boolean;
  card: boolean;
}) {
  return (
    <div
      className={
        card
          ? "flex flex-col border border-line rounded-[12px] bg-white p-3.5 hover:border-line-2 transition-colors"
          : "px-4.5 py-3.5"
      }
    >
      <div className="flex items-start gap-2">
        <Meta a={a} />
        <div className="flex items-center gap-2 flex-none">
          <WatchButton
            code={a.code}
            name={a.company || a.code}
            initiallyWatching={watching}
          />
        </div>
      </div>

      <a
        href={a.url}
        target="_blank"
        rel="noopener noreferrer"
        className="group block mt-1.5"
      >
        <span className="font-semibold text-[13.5px] leading-snug group-hover:underline">
          {a.headline}
        </span>
        <ArrowUpRight
          aria-hidden
          className="inline w-3.5 h-3.5 ml-1 -mt-0.5 text-mut-d transition-transform group-hover:-translate-y-px group-hover:text-green-d"
        />
      </a>

      {a.summary.length > 0 && (
        <ul className="mt-1.5 space-y-1">
          {a.summary.map((line, i) => (
            <li
              key={i}
              className="text-xs text-mut leading-relaxed pl-3 relative before:content-[''] before:absolute before:left-0 before:top-[0.55em] before:w-1 before:h-1 before:rounded-full before:bg-mut-d"
            >
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function HoldingsNews({
  items,
  watchedCodes,
  feedTotal,
}: {
  /** Today's price-sensitive filings from companies the client holds. */
  items: AsxAnnouncement[];
  /** Tickers already followed, so each star starts in the right state. */
  watchedCodes: string[];
  /** Filings across the whole market today, for the "n of m" line. */
  feedTotal: number;
}) {
  const [view, setView] = useNewsView();
  const watched = new Set(watchedCodes);

  return (
    <section className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
      <div className="px-4.5 py-3.5 border-b border-line flex items-center gap-2 flex-wrap select-none">
        <Newspaper className="w-4 h-4 text-mut" aria-hidden />
        <b className="text-sm font-semibold text-ink">Your holdings in the news</b>
        {items.length > 0 && (
          <>
            <span className="ml-auto text-[11px] font-mono text-mut">
              {items.length} of {feedTotal} price-sensitive filings today
            </span>
            <NewsViewToggle view={view} onChange={setView} />
          </>
        )}
      </div>

      {items.length === 0 ? (
        <div className="px-4.5 py-10 text-center">
          <b className="text-sm font-semibold text-ink block">
            Nothing from your companies today
          </b>
          <p className="text-xs text-mut mt-1.5 max-w-90 mx-auto leading-relaxed">
            {feedTotal > 0
              ? `${feedTotal} price-sensitive filings were lodged with the ASX today, none of them by a company you hold. They are all under Market.`
              : "No price-sensitive filings have come through yet today."}
          </p>
        </div>
      ) : view === "list" ? (
        <div className="divide-y divide-line">
          {items.map((a) => (
            <HoldingItem key={a.id} a={a} watching={watched.has(a.code)} card={false} />
          ))}
        </div>
      ) : (
        <div className="p-4.5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {items.map((a) => (
            <HoldingItem key={a.id} a={a} watching={watched.has(a.code)} card />
          ))}
        </div>
      )}
    </section>
  );
}

/** One company the client does not hold, from a sector they do. */
function SectorItem({ a, card }: { a: AsxAnnouncement; card: boolean }) {
  return (
    <a
      href={a.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`group block ${
        card
          ? "border border-line rounded-[12px] bg-white p-3 hover:bg-paper hover:border-line-2 transition-colors"
          : ""
      }`}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Meta a={a} muted />
      </div>
      <div
        className={`text-[12.5px] font-semibold text-ink leading-snug mt-1 group-hover:underline ${
          card ? "line-clamp-3" : ""
        }`}
      >
        {a.headline}
        <ArrowUpRight
          aria-hidden
          className="inline w-3 h-3 ml-1 -mt-0.5 text-mut-d group-hover:text-green-d"
        />
      </div>
    </a>
  );
}

export function SectorNews({
  groups,
  sectorCount,
}: {
  /** `[sector, announcements]`, sorted by sector, two apiece. */
  groups: [string, AsxAnnouncement[]][];
  /** How many sectors the book is exposed to, which is more than are listed. */
  sectorCount: number;
}) {
  const [view, setView] = useNewsView();

  return (
    <section className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
      <div className="px-4.5 py-3.5 border-b border-line flex items-center gap-2 flex-wrap select-none">
        <Layers className="w-4 h-4 text-mut" aria-hidden />
        <b className="text-sm font-semibold text-ink">Elsewhere in your sectors</b>
        <span className="ml-auto text-[11px] font-mono text-mut">
          {sectorCount} sector{sectorCount === 1 ? "" : "s"} held
        </span>
        <NewsViewToggle view={view} onChange={setView} />
      </div>

      {/* The sector headings survive the switch. Losing them would turn a
          grouped read into an undifferentiated wall of companies the client
          does not own, which is the one thing this section must not become. */}
      <div className="divide-y divide-line">
        {groups.map(([sector, items]) => (
          <div key={sector} className="px-4.5 py-3.5">
            <div className="text-[10.5px] font-semibold uppercase tracking-wider text-mut mb-2">
              {sector}
            </div>
            <div className={view === "list" ? "space-y-2.5" : "grid gap-3 md:grid-cols-2"}>
              {items.map((a) => (
                <SectorItem key={a.id} a={a} card={view === "card"} />
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="px-4.5 py-3 border-t border-line bg-paper-2/40">
        <p className="text-[11px] text-mut leading-relaxed">
          Companies you do not hold, in the sectors you do. Shown for context —
          not a recommendation.
        </p>
      </div>
    </section>
  );
}
