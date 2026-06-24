"use client";

import React, { useState } from "react";
import { useDatabase } from "@/contexts/DatabaseContext";

export default function ClientWatchlistPage() {
  const { db, clientId, addCustomAlert } = useDatabase();
  
  // Local list state since watchlist can be mutated locally or from DB
  const [watchlist, setWatchlist] = useState(() => {
    return db.watch[clientId] || [];
  });

  const [showAddModal, setShowAddModal] = useState(false);
  const [showAlertModal, setShowAlertModal] = useState<number | null>(null); // Index of watch item

  // Form inputs
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  
  const [alertDirection, setAlertDirection] = useState<"above" | "below">("above");
  const [alertTargetPrice, setAlertTargetPrice] = useState("");

  const livePlacements = db.placements.filter(p => p.stage === "open");

  // Check if any stock on the watchlist has an active placement raise
  const activePlacementMatches = () => {
    return watchlist.find(w => livePlacements.some(p => p.code === w.code));
  };

  const matchedWatchItem = activePlacementMatches();
  const matchedPlacement = matchedWatchItem 
    ? livePlacements.find(p => p.code === matchedWatchItem.code) 
    : null;

  const handleAddSecurity = (e: React.FormEvent) => {
    e.preventDefault();
    const code = newCode.trim().toUpperCase();
    if (!code) return;

    if (watchlist.some(w => w.code === code)) {
      alert(`${code} is already on your watchlist.`);
      return;
    }

    const reco = db.recos.find(r => r.code === code);
    const item = {
      code,
      name: newName.trim() || code,
      last: reco && reco.tp ? reco.tp * 0.9 : 1.00,
      chg: 1.2,
      alert: null
    };

    setWatchlist([item, ...watchlist]);
    setShowAddModal(false);
    setNewCode("");
    setNewName("");
    alert(`${code} added to watchlist.`);
  };

  const handleRemoveSecurity = (idx: number) => {
    const item = watchlist[idx];
    if (confirm(`Remove ${item.code} from watchlist?`)) {
      const updated = [...watchlist];
      updated.splice(idx, 1);
      setWatchlist(updated);
      alert(`${item.code} removed.`);
    }
  };

  const handleOpenAlertSetup = (idx: number) => {
    const item = watchlist[idx];
    setAlertTargetPrice(item.last ? (item.last * 1.05).toFixed(2) : "1.00");
    setAlertDirection("above");
    setShowAlertModal(idx);
  };

  const handleSetAlert = () => {
    if (showAlertModal === null) return;
    const item = watchlist[showAlertModal];
    const targetVal = parseFloat(alertTargetPrice) || 0;
    if (targetVal <= 0) return;

    // Apply locally
    const updated = [...watchlist];
    updated[showAlertModal] = {
      ...item,
      alert: targetVal,
      dir: alertDirection
    };
    setWatchlist(updated);

    // Push into context state database
    addCustomAlert(item.code, targetVal, alertDirection);

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
            <div className="flex-1 min-w-[200px] space-y-1">
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
              className="btn bg-navy text-white hover:bg-slate-800 font-semibold py-1.5 px-3 rounded-[8px] text-xs cursor-pointer"
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
                  const isUp = w.chg >= 0;
                  return (
                    <tr key={idx} className="hover:bg-[#faf9f5]">
                      <td className="px-4.5 py-3.5 font-bold">
                        <span className="code text-[12.5px] bg-paper-2 rounded-[5px] px-1.5 py-0.5">{w.code}</span>
                      </td>
                      <td className="px-4.5 py-3.5 text-mut hidden sm:table-cell">
                        {w.name}
                        {w.unl && <span className="pill bg-[#ece9f3] text-[#5c5775] text-[9.5px] font-bold px-1.5 py-0.5 rounded-full ml-2">Unlisted</span>}
                      </td>
                      <td className="px-4.5 py-3.5 text-right font-mono text-[13px]">
                        {w.last !== null ? `$${w.last.toFixed(w.last < 10 ? 3 : 2)}` : "—"}
                      </td>
                      <td className={`px-4.5 py-3.5 text-right font-mono text-[13px] ${w.last !== null ? (isUp ? "text-gain" : "text-loss-d") : "text-mut"}`}>
                        {w.last !== null ? `${isUp ? "+" : ""}${w.chg.toFixed(1)}%` : "—"}
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
                          className="p-1 rounded-[8px] hover:bg-paper-2 text-mut hover:text-ink cursor-pointer"
                        >
                          <svg className="w-3.5 h-3.5 fill-none stroke-current stroke-2" viewBox="0 0 24 24">
                            <path d="M6 6l12 12M18 6 6 18" />
                          </svg>
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
        <div className="fixed inset-0 bg-navy/55 backdrop-blur-[2px] z-50 flex items-center justify-center p-4.5">
          <form onSubmit={handleAddSecurity} className="bg-white rounded-[16px] max-w-[440px] w-full p-6 shadow-shadow-lg text-ink space-y-4" onClick={e => e.stopPropagation()}>
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
        <div className="fixed inset-0 bg-navy/55 backdrop-blur-[2px] z-50 flex items-center justify-center p-4.5">
          {(() => {
            const item = watchlist[showAlertModal];
            return (
              <div className="bg-white rounded-[16px] max-w-[440px] w-full p-6 shadow-shadow-lg text-ink space-y-4" onClick={e => e.stopPropagation()}>
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
