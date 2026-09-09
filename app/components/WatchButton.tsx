"use client";

import { useState, useTransition } from "react";
import { Star } from "lucide-react";
import { addToWatchlist, removeFromWatchlist } from "@/app/actions/watchlist";

/**
 * Follow a company from wherever it is being read about.
 *
 * ── Optimistic, and honest when it fails ───────────────────────────────────
 * The star fills on click rather than after the round trip: this is a
 * preference, not a payment, and a control that waits half a second to
 * acknowledge a click gets clicked twice. If the write fails the star goes
 * back, and the title says why — silently keeping a filled star for something
 * that was never saved is the one outcome worth avoiding.
 *
 * ── Why it stops the event ─────────────────────────────────────────────────
 * On Market this sits inside a row that is itself a link to the ASX PDF.
 * Without `preventDefault` the click both watches the company and opens a
 * document in a new tab, which is two answers to one gesture.
 */
export function WatchButton({
  code,
  name,
  initiallyWatching,
  className = "",
}: {
  code: string;
  name: string;
  initiallyWatching: boolean;
  className?: string;
}) {
  const [watching, setWatching] = useState(initiallyWatching);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  const toggle = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (busy) return;

    const next = !watching;
    setWatching(next);
    setFailed(null);

    startTransition(async () => {
      const result = next
        ? await addToWatchlist(code, name)
        : await removeFromWatchlist(code);
      if (!result.ok) {
        setWatching(!next);
        setFailed(result.error);
      }
    });
  };

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      aria-pressed={watching}
      title={
        failed
          ? `Could not save: ${failed}`
          : watching
          ? `Stop watching ${code}`
          : `Watch ${code}`
      }
      className={`inline-flex items-center gap-1.5 text-[11px] font-semibold rounded-full border px-2.5 py-1 transition-colors cursor-pointer disabled:opacity-60 ${
        watching
          ? "border-green/40 bg-green-bg text-green-d"
          : "border-line text-mut hover:text-ink hover:border-mut/40"
      } ${className}`}
    >
      <Star
        className={`w-3.5 h-3.5 stroke-[1.8] ${watching ? "fill-current" : ""}`}
        aria-hidden
      />
      {watching ? "Watching" : "Watch"}
    </button>
  );
}
