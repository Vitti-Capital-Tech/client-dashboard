"use client";

import React, { useState, useTransition } from "react";
import { X } from "lucide-react";
import type {
  WatchRow,
  PlacementRow,
  RecoRow,
} from "@/lib/data/queries";
import { addCustomAlert } from "@/app/actions/alerts";
import { addToWatchlist, removeFromWatchlist } from "@/app/actions/watchlist";
import { useToast } from "@/app/components/Toast";

// Local view shape for a watchlist row.
type WatchItem = {
  code: string | null;
  name: string;
  last: number | null;
  /** The day's move, from the live quote. Null for anything not quoted. */
  changePct: number | null;
  alert: number | null;
  dir: "above" | "below" | null;
  unlisted: boolean;
};

export function WatchlistClient({
  watchlist: initialWatchlist,
  placements,
  recos,
  clientId,
}: {
  watchlist: (WatchRow & { changePct: number | null })[];
  placements: PlacementRow[];
  recos: RecoRow[];
  clientId: string;
}) {
  // Local list state since watchlist can be mutated locally or from DB.
  // Seed from the prop (add/remove were never persisted).
  const [watchlist, setWatchlist] = useState<WatchItem[]>(() =>
    initialWatchlist.map((w) => ({
      code: w.code,
      name: w.name,
      last: w.last,
      changePct: w.changePct,
      alert: w.alert,
      dir: w.dir,
      unlisted: w.unlisted,
    })),
  );

  const toast = useToast();
  const [, startTransition] = useTransition();
  const [showAddModal, setShowAddModal] = useState(false);
  const [showAlertModal, setShowAlertModal] = useState<number | null>(null); // Index of watch item

  // Form inputs
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");

  const [alertDirection, setAlertDirection] = useState<"above" | "below">("above");
  const [alertTargetPrice, setAlertTargetPrice] = useState("");

  const livePlacements = placements.filter(p => p.stage === "open");

  // Check if any stock on the watchlist has an active placement raise
  const activePlacementMatches = () => {
    return watchlist.find(w => livePlacements.some(p => p.code === w.code));
  };

  const matchedWatchItem = activePlacementMatches();
  const matchedPlacement = matchedWatchItem
    ? livePlacements.find(p => p.code === matchedWatchItem.code)
    : null;

  /**
   * Adding, and this time it is written down.
   *
   * The list was seeded from the database and everything after that was React
   * state, so an add survived a reload only because the seed came back and an
   * add of something NOT in the seed quietly disappeared. `addToWatchlist` is
   * the write; the local update stays because it is what makes the row appear
   * at once.
   */
  const handleAddSecurity = (e: React.FormEvent) => {
    e.preventDefault();
    const code = newCode.trim().toUpperCase();
    if (!code) return;

    if (watchlist.some((w) => w.code === code)) {
      toast({ message: `${code} is already on your watchlist.`, tone: "info" });
      return;
    }

    const reco = recos.find((r) => r.code === code);
    const item: WatchItem = {
      code,
      name: newName.trim() || code,
      last: reco && reco.target ? reco.target * 0.9 : null,
      changePct: null,
      alert: null,
      dir: null,
      unlisted: false,
    };

    setWatchlist([item, ...watchlist]);
    setShowAddModal(false);
    setNewCode("");
    setNewName("");

    startTransition(async () => {
      const result = await addToWatchlist(code, item.name);
      if (!result.ok) {
        setWatchlist((list) => list.filter((w) => w.code !== code));
        toast({ message: `Could not add ${code}: ${result.error}`, tone: "error" });
        return;
      }
      toast({ message: `${code} added to your watchlist.` });
    });
  };

  /**
   * Removing, with an Undo rather than an "are you sure?".
   *
   * The dialog it replaces interrupted everybody — including the many who meant
   * it — to protect the few who did not, over an action that costs one click to
   * reverse. Now it happens at once and the toast offers it back.
   */
  const handleRemoveSecurity = (idx: number) => {
    const item = watchlist[idx];
    const code = item.code;
    const label = code ?? item.name;
    setWatchlist((list) => list.filter((_, i) => i !== idx));

    const restore = () =>
      setWatchlist((list) =>
        list.some((w) => w.code === code && w.name === item.name) ? list : [item, ...list],
      );

    // An unlisted row has no security code, and the table keys on one. Nothing
    // to write, so nothing is written — and the Undo is still offered, because
    // from the reader's side the row went either way.
    if (!code) {
      toast({
        message: `${label} removed from your watchlist.`,
        action: { label: "Undo", onClick: restore },
      });
      return;
    }

    startTransition(async () => {
      const result = await removeFromWatchlist(code);
      if (!result.ok) {
        restore();
        toast({ message: `Could not remove ${label}: ${result.error}`, tone: "error" });
        return;
      }
      toast({
        message: `${label} removed from your watchlist.`,
        action: {
          label: "Undo",
          onClick: () => {
            restore();
            startTransition(async () => {
              const back = await addToWatchlist(code, item.name);
              if (!back.ok) {
                setWatchlist((list) => list.filter((w) => w.code !== code));
                toast({ message: `Could not restore ${label}.`, tone: "error" });
              }
            });
          },
        },
      });
    });
  };

  const handleOpenAlertSetup = (idx: number) => {
    const item = watchlist[idx];
    setAlertTargetPrice(item.last ? (item.last * 1.05).toFixed(2) : "1.00");
    setAlertDirection("above");
    setShowAlertModal(idx);
  };

  const handleSetAlert = async () => {
    if (showAlertModal === null) return;
    const item = watchlist[showAlertModal];
    const targetVal = parseFloat(alertTargetPrice) || 0;
    if (targetVal <= 0) return;
    if (!item.code) return;

    // Apply locally so the pill shows immediately
    const updated = [...watchlist];
    updated[showAlertModal] = {
      ...item,
      alert: targetVal,
      dir: alertDirection
    };
    setWatchlist(updated);

    // Persist via the Supabase server action
    await addCustomAlert(clientId, item.code, targetVal, alertDirection);

    setShowAlertModal(null);
    alert(`Alert armed for ${item.code} at $${targetVal.toFixed(2)}.`);
  };

  return (
    <div className="space-y-4 text-ink font-body select-none">
      {/* Page Header */}
      <div className="flex justify-between items-end gap-3 flex-wrap">
        <div>
          <div className="font-mono text-xs tracking-wider uppercase text-mut">Tracked securities &amp; price alerts</div>
          <h1 className="font-disp font-medium text-[26px] mt-0.5">Watchlist</h1>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="btn bg-green text-[#08130e] hover:shadow-lg font-semibold py-2 px-4.5 rounded-[10px] text-xs cursor-pointer"
        >
          + Add security
        </button>
      </div>

      {/* Live Placement Banner */}
      {matchedPlacement && (
        <div className="card bg-green-bg border border-green rounded-[14px] p-4.5 shadow-shadow select-none">
          <div className="flex items-center gap-3.5 flex-wrap">
            <div className="flex-1 min-w-50 space-y-1">
              <span className="pill bg-green border border-green-d text-[#08130e] text-[10px] font-bold py-0.5 px-2.5 rounded-full uppercase">
                From your watchlist
              </span>
              <div className="font-semibold text-xs md:text-sm text-ink leading-snug">
                {matchedPlacement.name} has a live placement at a {matchedPlacement.disc}% discount.
              </div>
              <div className="text-[11px] text-mut">
                Closes today &middot; ASX: {matchedPlacement.code} &middot; Offer ${matchedPlacement.price.toFixed(2)}
              </div>
            </div>
            <button
              onClick={() => alert("Redirecting to placements review details...")}
              className="btn bg-navy text-white hover:bg-slate-800 font-semibold py-1.5 px-3 rounded-lg text-xs cursor-pointer"
            >
              Review deal
            </button>
          </div>
        </div>
      )}

      {/* Watchlist Table */}
      <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[12.5px] font-medium">
            <thead>
              <tr className="border-b border-line text-mut select-none">
                <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3">Code</th>
                <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 hidden sm:table-cell">Name</th>
                <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right">Last</th>
                <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right">Today</th>
                <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3">Alert</th>
                <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#f0ede5]">
              {watchlist.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center text-mut py-6">Your watchlist is empty.</td>
                </tr>
              ) : (
                watchlist.map((w, idx) => {
                  return (
                    <tr key={idx} className="hover:bg-paper-2/60 transition-colors">
                      <td className="px-4.5 py-3.5 font-bold">
                        <span className="code text-[12.5px] bg-paper-2 rounded-[5px] px-1.5 py-0.5">{w.code}</span>
                      </td>
                      <td className="px-4.5 py-3.5 text-mut hidden sm:table-cell">
                        {w.name}
                        {w.unlisted && <span className="pill bg-[#ece9f3] text-[#5c5775] text-[9.5px] font-bold px-1.5 py-0.5 rounded-full ml-2">Unlisted</span>}
                      </td>
                      <td className="px-4.5 py-3.5 text-right font-mono text-[13px]">
                        {w.last !== null ? `$${w.last.toFixed(w.last < 10 ? 3 : 2)}` : "—"}
                      </td>
                      <td
                        className={`px-4.5 py-3.5 text-right font-mono text-[13px] ${
                          w.changePct === null
                            ? "text-mut"
                            : w.changePct >= 0
                            ? "text-gain"
                            : "text-loss-d"
                        }`}
                      >
                        {w.changePct === null
                          ? "—"
                          : `${w.changePct >= 0 ? "+" : ""}${w.changePct.toFixed(2)}%`}
                      </td>
                      <td className="px-4.5 py-3.5">
                        {w.alert ? (
                          <span className="pill bg-amber-bg text-amber-d text-[11px] font-bold py-1 px-2.5 rounded-full">
                            {w.dir === "below" ? "≤" : "≥"} ${w.alert.toFixed(2)}
                          </span>
                        ) : (
                          <button
                            onClick={() => handleOpenAlertSetup(idx)}
                            className="text-green-d font-semibold underline underline-offset-2 hover:opacity-85 cursor-pointer text-xs"
                          >
                            Set alert
                          </button>
                        )}
                      </td>
                      <td className="px-4.5 py-3.5 text-right">
                        <button
                          onClick={() => handleRemoveSecurity(idx)}
                          className="p-1 rounded-lg hover:bg-paper-2 text-mut hover:text-ink cursor-pointer"
                        >
                          <X className="w-3.5 h-3.5 stroke-2" />
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add Security Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-navy/55 backdrop-blur-[2px] z-50 flex items-center justify-center p-4.5 overflow-y-auto">
          <form onSubmit={handleAddSecurity} className="bg-white rounded-2xl max-w-110 w-full p-6 shadow-shadow-lg text-ink space-y-4 my-auto max-h-[92vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="font-disp font-medium text-lg text-ink">Add to watchlist</h3>
            <p className="text-xs text-mut leading-normal">
              Track any ASX security for live prices and custom trigger notifications.
            </p>

            <div className="space-y-3">
              <div className="space-y-1">
                <label className="block text-xs font-semibold text-ink">Code</label>
                <input
                  type="text"
                  value={newCode}
                  onChange={e => setNewCode(e.target.value)}
                  placeholder="e.g. WBC"
                  required
                  className="w-full border border-line-2 bg-white rounded-[9px] px-3.5 py-2 text-sm focus:border-green focus:outline-none"
                />
              </div>
              <div className="space-y-1">
                <label className="block text-xs font-semibold text-ink">Name</label>
                <input
                  type="text"
                  value={newName}
                  onChange={e => setNewName(e.target.value)}
                  placeholder="e.g. Westpac Banking"
                  className="w-full border border-line-2 bg-white rounded-[9px] px-3.5 py-2 text-sm focus:border-green focus:outline-none"
                />
              </div>
            </div>

            <div className="flex gap-2.5 pt-2 select-none">
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="btn border border-line rounded-[10px] py-2 px-4 hover:border-mut text-xs font-semibold cursor-pointer flex-1 bg-white"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn bg-green text-[#08130e] hover:shadow-lg rounded-[10px] py-2 px-4 text-xs font-semibold cursor-pointer flex-1.5"
              >
                Add security
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Set Alert Modal */}
      {showAlertModal !== null && (
        <div className="fixed inset-0 bg-navy/55 backdrop-blur-[2px] z-50 flex items-center justify-center p-4.5 overflow-y-auto">
          {(() => {
            const item = watchlist[showAlertModal];
            return (
              <div className="bg-white rounded-2xl max-w-110 w-full p-6 shadow-shadow-lg text-ink space-y-4 my-auto max-h-[92vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
                <h3 className="font-disp font-medium text-lg text-ink">Price alert &middot; {item.code}</h3>
                <p className="text-xs text-mut">
                  {item.name} &middot; last closes ${item.last ? item.last.toFixed(2) : "—"}
                </p>

                <div className="space-y-3">
                  <div className="space-y-1">
                    <label className="block text-xs font-semibold text-ink">Notify when price</label>
                    <select
                      value={alertDirection}
                      onChange={e => setAlertDirection(e.target.value as "above" | "below")}
                      className="w-full border border-line-2 bg-white rounded-[9px] px-3 py-2 text-sm focus:border-green focus:outline-none"
                    >
                      <option value="above">rises above</option>
                      <option value="below">falls below</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="block text-xs font-semibold text-ink">Target price ($)</label>
                    <input
                      type="text"
                      value={alertTargetPrice}
                      onChange={e => setAlertTargetPrice(e.target.value)}
                      className="w-full border border-line-2 bg-white rounded-[9px] px-3.5 py-2 font-mono text-sm focus:border-green focus:outline-none"
                    />
                  </div>
                </div>

                <div className="flex gap-2.5 pt-2 select-none">
                  <button
                    onClick={() => setShowAlertModal(null)}
                    className="btn border border-line rounded-[10px] py-2 px-4 hover:border-mut text-xs font-semibold cursor-pointer flex-1 bg-white"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSetAlert}
                    className="btn bg-green text-[#08130e] hover:shadow-lg rounded-[10px] py-2 px-4 text-xs font-semibold cursor-pointer flex-1.5"
                  >
                    Set alert
                  </button>
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
