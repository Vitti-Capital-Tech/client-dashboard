"use client";

import React, { useState } from "react";
import { useDatabaseStore } from "@/store/useDatabaseStore";
import { Placement } from "@/lib/db";

import { useShallow } from "zustand/react/shallow";

export default function StaffPlacementsPage() {
  const scaleBids = useDatabaseStore(state => state.scaleBids);
  const updatePlacementStage = useDatabaseStore(state => state.updatePlacementStage);
  const db = useDatabaseStore(state => state.db);
  const [selectedPlacementId, setSelectedPlacementId] = useState<string | null>(null);

  // Allocations publishing states
  const [scalingMethod, setScalingMethod] = useState("pro-rata");
  const [notifyByEmail, setNotifyByEmail] = useState(true);
  const [clientMessage, setClientMessage] = useState("");

  const handleOpenPlacement = (id: string) => {
    setSelectedPlacementId(id);
    const p = db.placements.find(x => x.id === id);
    if (p) {
      setScalingMethod("pro-rata");
      setNotifyByEmail(true);
      setClientMessage(`Your allocation in ${p.name} (${p.code}) is confirmed. Payment details are in your portal; settlement is ${p.settleDate.toLocaleDateString("en-AU")}.`);
    }
  };

  const handleClosePlacement = () => {
    setSelectedPlacementId(null);
  };

  const getScalingFactor = (p: Placement, method: string) => {
    const totalBids = p.bids.reduce((sum, b) => sum + b.amount, 0);
    const raiseLimit = p.raise * 1e6;
    if (method === "full") return 1;
    if (method === "65") return 0.65;
    // Pro-rata scaling based on target raise limit vs total bids made
    return totalBids > 0 ? Math.min(1, raiseLimit / totalBids) : 1;
  };

  const calculateAllottedAmount = (bidAmt: number, factor: number) => {
    // Round to nearest $1,000 just like the HTML does
    return Math.round((bidAmt * factor) / 1000) * 1000;
  };

  const handlePublishAllocations = () => {
    if (!selectedPlacementId) return;
    const p = db.placements.find(x => x.id === selectedPlacementId);
    if (!p) return;

    const f = getScalingFactor(p, scalingMethod);
    const allocations: Record<string, number> = {};
    p.bids.forEach(b => {
      allocations[b.c] = calculateAllottedAmount(b.amount, f);
    });

    // Mutate state context allocations
    scaleBids(selectedPlacementId, allocations);
    // Transition placement to closed state with confirmed allocations
    alert(`Allocations published and client notification alerts dispatched to ${p.bids.length} clients.`);
    handleClosePlacement();
  };

  const handleSettleDeal = () => {
    if (!selectedPlacementId) return;
    const p = db.placements.find(x => x.id === selectedPlacementId);
    if (!p) return;

    if (confirm(`Confirm settlement for ${p.code}? This will issue ordinary shares and attaching options to all allocated clients.`)) {
      updatePlacementStage(selectedPlacementId, "settled");
      alert(`${p.code} settled. Holdings issued to client portfolios.`);
      handleClosePlacement();
    }
  };

  const getStageBadge = (stage: string) => {
    const classes = {
      open: "bg-green-bg text-green-d",
      closed: "bg-amber-bg text-amber-d",
      upcoming: "bg-paper-2 text-mut",
      settled: "bg-[#ece9f3] text-[#5c5775]"
    };
    return (
      <span className={`pill text-[10.5px] font-bold px-2 py-0.5 rounded-full capitalize ${classes[stage as keyof typeof classes] || "bg-paper-2 text-mut"}`}>
        {stage}
      </span>
    );
  };

  if (selectedPlacementId) {
    const p = db.placements.find(x => x.id === selectedPlacementId);
    if (p) {
      const f = getScalingFactor(p, scalingMethod);
      const totalBids = p.bids.reduce((sum, b) => sum + b.amount, 0);
      const isAllocated = p.bids.length > 0 && p.bids[0].alloc !== null;

      return (
        <div className="space-y-4 text-ink font-body">
          {/* Back button */}
          <div className="select-none">
            <button
              onClick={handleClosePlacement}
              className="text-green-d font-semibold text-sm underline underline-offset-2 cursor-pointer hover:opacity-85"
            >
              &larr; Placements
            </button>
          </div>

          <div className="flex justify-between items-end gap-3 flex-wrap select-none border-b border-line pb-4">
            <div>
              <h1 className="font-disp font-medium text-2xl">
                {p.name} <span className="font-mono text-sm font-normal text-mut uppercase ml-1">{p.code}</span>
              </h1>
              <div className="text-xs text-mut mt-1">
                Adviser book manager &middot; {p.type} at ${p.price.toFixed(2)}
              </div>
            </div>
            {getStageBadge(p.stage)}
          </div>

          {/* Manage allocation columns */}
          <div className="grid md:grid-cols-12 gap-4">
            <div className="md:col-span-7 space-y-4">
              <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow space-y-3">
                <b className="text-sm font-semibold block select-none">Client Bids Register</b>
                
                <table className="w-full border-collapse text-left text-xs font-medium">
                  <thead>
                    <tr className="border-b border-line text-mut select-none">
                      <th className="py-2.5">Client</th>
                      <th className="py-2.5 text-right">Bid size</th>
                      <th className="py-2.5 text-right">Allotted</th>
                      <th className="py-2.5 text-right">% Scale</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#f0ede5]">
                    {p.bids.length === 0 ? (
                      <tr>
                        <td colSpan={4} className="text-center text-mut py-6">No bids recorded on this placement.</td>
                      </tr>
                    ) : (
                      p.bids.map(b => {
                        const cl = db.clients[b.c] || { name: b.c, av: "???" };
                        const allottedAmt = isAllocated 
                          ? b.alloc! 
                          : calculateAllottedAmount(b.amount, f);
                        const scalePercent = b.amount > 0 
                          ? Math.round((allottedAmt / b.amount) * 100) 
                          : 100;
                        
                        return (
                          <tr key={b.c} className="hover:bg-[#faf9f5]">
                            <td className="py-3 flex items-center gap-2 select-none">
                              <span className="w-5.5 h-5.5 rounded-full bg-paper-2 border border-line flex items-center justify-center font-bold text-[9px] text-ink uppercase">
                                {cl.av}
                              </span>
                              <span className="font-semibold">{cl.name}</span>
                            </td>
                            <td className="py-3 text-right font-mono">${b.amount.toLocaleString("en-AU")}</td>
                            <td className="py-3 text-right font-mono font-semibold">${allottedAmt.toLocaleString("en-AU")}</td>
                            <td className="py-3 text-right font-mono text-mut">{scalePercent}%</td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Allocation workflow controls */}
            <div className="md:col-span-5 space-y-4">
              {/* Allocate actions */}
              {p.stage === "closed" && !isAllocated && (
                <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow space-y-4">
                  <b className="text-sm font-semibold text-ink block select-none">Allocation workflow</b>
                  
                  <div className="space-y-1">
                    <label className="block text-xs font-semibold text-ink select-none">Scaling policy</label>
                    <select
                      value={scalingMethod}
                      onChange={e => setScalingMethod(e.target.value)}
                      className="w-full border border-line-2 bg-white rounded-[9px] px-3 py-2.5 text-sm focus:border-green focus:outline-none"
                    >
                      <option value="pro-rata">Pro-rata (Raise Cap / Total Bids)</option>
                      <option value="65">65% scale back</option>
                      <option value="full">Full allocation (100% fill)</option>
                    </select>
                  </div>

                  <div className="space-y-1 select-none">
                    <label className="flex gap-2 items-start text-xs text-mut cursor-pointer leading-tight">
                      <input 
                        type="checkbox" 
                        checked={notifyByEmail} 
                        onChange={e => setNotifyByEmail(e.target.checked)} 
                        className="mt-0.5" 
                      />
                      <span>Dispatch email and in-app alerts to clients</span>
                    </label>
                  </div>

                  <div className="space-y-1">
                    <label className="block text-xs font-semibold text-ink">Notification message</label>
                    <textarea
                      value={clientMessage}
                      onChange={e => setClientMessage(e.target.value)}
                      className="w-full border border-line-2 bg-white rounded-[9px] p-2 text-xs font-medium focus:border-green focus:outline-none min-h-16"
                    />
                  </div>

                  <button
                    onClick={handlePublishAllocations}
                    className="w-full btn bg-green hover:shadow-lg text-[#08130e] font-semibold py-2.5 rounded-[10px] text-xs cursor-pointer select-none"
                  >
                    Publish allocations
                  </button>
                </div>
              )}

              {/* Settlement step */}
              {p.stage === "closed" && isAllocated && (
                <div className="card bg-green-bg/50 border border-green rounded-[14px] p-4.5 shadow-shadow space-y-3 bg-linear-to-b from-green-bg/60 to-white/70">
                  <div className="text-xs font-semibold text-green-d select-none">
                    Allocations published
                  </div>
                  <h3 className="font-disp font-medium text-base text-ink select-none">Awaiting Settlement</h3>
                  <p className="text-xs text-mut leading-normal select-none">
                    Funds collection is active. Confirm settlement to allocate listed shares and attaching option registers to portfolios.
                  </p>
                  <button
                    onClick={handleSettleDeal}
                    className="w-full btn bg-green text-[#08130e] font-semibold py-2.5 rounded-[10px] text-xs cursor-pointer"
                  >
                    Confirm Settlement
                  </button>
                </div>
              )}

              {/* Settle feedback */}
              {p.stage === "settled" && (
                <div className="card bg-paper border border-line rounded-[14px] p-4.5 shadow-shadow select-none space-y-1.5">
                  <span className="pill bg-[#ece9f3] text-[#5c5775] text-[10px] font-bold px-2 py-0.5 rounded-full inline-block">
                    Complete
                  </span>
                  <h3 className="font-disp font-medium text-base text-ink">Deal fully settled</h3>
                  <p className="text-xs text-mut leading-normal">
                    Allocated shares and attaching options have been issued to clients on the registry.
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      );
    }
  }

  return (
    <div className="space-y-4 text-ink font-body select-none">
      {/* Page Header */}
      <div>
        <div className="font-mono text-xs tracking-wider uppercase text-mut">Raises desk bookmanager</div>
        <h1 className="font-disp font-medium text-[26px] mt-0.5">Placements management</h1>
      </div>

      {/* Book details list */}
      <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[12.5px] font-medium">
            <thead>
              <tr className="border-b border-line text-mut select-none">
                <th className="px-4.5 py-3">Placement</th>
                <th className="px-4.5 py-3">Type</th>
                <th className="px-4.5 py-3 text-right">Offer Price</th>
                <th className="px-4.5 py-3 text-center">Bids count</th>
                <th className="px-4.5 py-3 text-right">Total raised value</th>
                <th className="px-4.5 py-3">Timeline Close</th>
                <th className="px-4.5 py-3">Stage</th>
                <th className="px-4.5 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#f0ede5]">
              {db.placements.map(p => {
                const bidsValSum = p.bids.reduce((sum, b) => sum + b.amount, 0);
                return (
                  <tr key={p.id} className="hover:bg-[#faf9f5]">
                    <td className="px-4.5 py-3.5 font-bold">
                      <span className="code font-mono px-1.5 py-0.5 rounded-[5px] bg-paper-2">{p.code}</span>
                      <span className="ml-2 font-disp">{p.name}</span>
                    </td>
                    <td className="px-4.5 py-3.5 text-mut">{p.type}</td>
                    <td className="px-4.5 py-3.5 text-right font-mono">${p.price.toFixed(2)}</td>
                    <td className="px-4.5 py-3.5 text-center">{p.bids.length}</td>
                    <td className="px-4.5 py-3.5 text-right font-mono">${bidsValSum.toLocaleString("en-AU")}</td>
                    <td className="px-4.5 py-3.5 text-mut font-mono text-[11px]">
                      {p.closeDate.toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
                    </td>
                    <td className="px-4.5 py-3.5">{getStageBadge(p.stage)}</td>
                    <td className="px-4.5 py-3.5 text-right">
                      {p.stage !== "upcoming" && (
                        <button
                          onClick={() => handleOpenPlacement(p.id)}
                          className="btn ghost sm text-xs font-semibold py-1.5 px-3 border border-line rounded-lg hover:border-mut cursor-pointer transition-colors bg-white"
                        >
                          Manage
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
