"use client";

import { useSyncExternalStore } from "react";
import { LayoutGrid, List } from "lucide-react";

export type NewsView = "list" | "card";

/** What a reader who has never touched the toggle gets. */
const DEFAULT_VIEW: NewsView = "card";

const STORAGE_KEY = "vitti_news_view";

/**
 * How the reader wants their news laid out — one long column, or a grid.
 *
 * ── Why a module store rather than component state ─────────────────────────
 * The choice is one preference, not one per section: Insights shows two news
 * lists and Market shows a third, and a reader who asks for cards on one of
 * them means all of them. Keeping the value here lets every toggle on screen
 * move together, and lets the choice survive the walk from Insights to Market.
 *
 * ── Why useSyncExternalStore rather than an effect ─────────────────────────
 * `localStorage` does not exist on the server, so the saved value cannot be
 * read during the render that produces the HTML. Reading it in a mount effect
 * and calling setState is the obvious fix and the wrong one — it renders once,
 * throws that render away, and is what the lint rule about setState in effects
 * is for. `useSyncExternalStore` has a server snapshot for exactly this: the
 * server and the hydrating client both render the default, and the
 * subscription swaps in the saved value immediately afterwards, with no
 * mismatch.
 */
let current: NewsView | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): NewsView {
  // Cached in a module variable because getSnapshot must return a stable value
  // between renders — reading storage on every call would be a new read each
  // time React checked for a change.
  if (current) return current;
  try {
    // Only an explicit "list" opts out: cards are the default, so an absent or
    // unrecognised value has to land there too.
    current = window.localStorage.getItem(STORAGE_KEY) === "list" ? "list" : DEFAULT_VIEW;
  } catch {
    // Blocked or unreadable storage is not an error worth showing anybody.
    current = DEFAULT_VIEW;
  }
  return current;
}

function getServerSnapshot(): NewsView {
  return DEFAULT_VIEW;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function setNewsView(next: NewsView): void {
  if (current === next) return;
  current = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // The toggle still works for this visit; only the memory of it is lost.
  }
  for (const listener of listeners) listener();
}

/** The current layout, and a setter every mounted toggle hears. */
export function useNewsView(): [NewsView, (next: NewsView) => void] {
  const view = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return [view, setNewsView];
}

const OPTIONS = [
  { key: "card", label: "Cards", Icon: LayoutGrid },
  { key: "list", label: "List", Icon: List },
] satisfies { key: NewsView; label: string; Icon: typeof List }[];

/**
 * The segmented control itself, styled to match the filter tabs it sits beside.
 * Icon and word both: two abstract glyphs are a guess until you have clicked
 * one, and the pair costs about sixty pixels.
 */
export function NewsViewToggle({
  view,
  onChange,
  className = "",
}: {
  view: NewsView;
  onChange: (next: NewsView) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label="News layout"
      className={`inline-flex bg-paper-2 rounded-[9px] p-0.75 select-none ${className}`}
    >
      {OPTIONS.map(({ key, label, Icon }) => (
        <button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          aria-pressed={view === key}
          title={`${label} view`}
          className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-[7px] cursor-pointer transition-colors ${
            view === key ? "bg-white text-ink shadow-shadow" : "text-mut hover:text-ink"
          }`}
        >
          <Icon className="w-3.5 h-3.5" aria-hidden />
          {label}
        </button>
      ))}
    </div>
  );
}
