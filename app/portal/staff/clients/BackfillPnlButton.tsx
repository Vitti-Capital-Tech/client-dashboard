"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { recalculateAllPnl } from "@/app/actions/pnl";

/**
 * Rebuild every account's stored P&L in one go.
 *
 * Needed because the client profile RENDERS what the recompute stored rather
 * than deriving it per request — so an account that has never been recomputed
 * has no rows to show, and says so. After the tables are first created, and
 * after any change to the engine, this is what fills them.
 *
 * Not a routine button: the morning ingest already recomputes whatever it
 * touched, and a single client can be refreshed from their own page. This is
 * for the whole book at once, which is why it asks first — one Placement
 * Tracker parse plus every account is minutes of work, not seconds.
 */
export function BackfillPnlButton() {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  const run = async () => {
    if (
      !window.confirm(
        "Rebuild the stored P&L for every account?\n\n" +
          "This re-reads the ledger and the holdings snapshot, re-merges the " +
          "Placement Trackers and re-prices unlisted options at today's spot. " +
          "It can take a few minutes.",
      )
    ) {
      return;
    }

    setRunning(true);
    setNote(null);
    try {
      const res = await recalculateAllPnl();
      if (!res.ok) {
        setNote({ tone: "bad", text: res.error });
        return;
      }
      setNote({
        tone: res.failed > 0 ? "bad" : "ok",
        text:
          `Rebuilt ${res.accounts} account${res.accounts === 1 ? "" : "s"}.` +
          (res.failed > 0 ? ` ${res.failed} failed — see the server log.` : ""),
      });
      router.refresh();
    } catch (err) {
      setNote({
        tone: "bad",
        text: err instanceof Error ? err.message : "Backfill failed.",
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={run}
        disabled={running}
        title="Rebuild stored P&L for every account — needed once after the P&L tables are created"
        className="border border-line bg-white rounded-[8px] px-2.5 py-1 text-[11px] font-semibold text-mut hover:text-ink hover:border-line-2 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
      >
        {running ? "Rebuilding…" : "Rebuild all P&L"}
      </button>
      {note && (
        <span className={`text-[11px] ${note.tone === "ok" ? "text-mut" : "text-loss-d"}`}>
          {note.text}
        </span>
      )}
    </div>
  );
}
