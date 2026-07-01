"use client";

import React, { useState } from "react";
import type { ClientRow, OptionRow } from "@/lib/data/queries";
import { isITM } from "@/lib/data/compute";

// Expiry Rail Component
const ExpiryRail = ({ dte }: { dte: number }) => {
  const thresholds = [30, 14, 7, 3, 1];
  const isDanger = dte <= 3 && dte >= 0;
  const isWarn = dte <= 14 && dte > 3;
  const cls = isDanger ? "danger" : isWarn ? "warn" : "";

  const segs = thresholds.map((t, idx) => {
    const lit = dte <= t && dte >= 0;
    const colorClass = lit ? (dte <= 3 ? "lit-red" : "lit-amber") : "";
    return (
      <div key={idx} className={`seg ${colorClass}`}>
        <span className="tk" />
      </div>
    );
  });

  return (
    <div className={`rail ${cls} select-none`}>
      <div className="dleft">{dte < 0 ? "expired" : `${dte}d`}</div>
      <div className="ticks">{segs}</div>
    </div>
  );
};

// Moneyness Bar Component
const MoneynessBar = ({ strike, under, type }: { strike: number; under: number; type: "Call" | "Put" }) => {
  let m = under - strike;
  if (type === "Put") m = -m;
  const span = strike * 0.5 || 0.5;
  const frac = Math.max(-1, Math.min(1, m / span));
  const w = Math.abs(frac) * 27;
  const col = m > 0 ? "var(--color-green)" : "var(--color-loss)";

  return (
    <span className="mbar select-none">
      <i />
      <b
        style={{
          backgroundColor: col,
          width: `${w}px`,
          left: m > 0 ? "50%" : "auto",
          right: m > 0 ? "auto" : "50%"
        }}
      />
    </span>
  );
};

export function StaffOptionsClient({ options, clients }: { options: OptionRow[]; clients: ClientRow[] }) {
  const clientMap: Record<string, ClientRow> = {};
  for (const c of clients) clientMap[c.id] = c;

  // Filters state
  const [filterClient, setFilterClient] = useState("all");
  const [filterType, setFilterType] = useState("all");
  const [filterExpiry, setFilterExpiry] = useState("all");
  const [filterMoney, setFilterMoney] = useState("all");

  const [showAddModal, setShowAddModal] = useState(false);

  // Form states for manually adding options
  const [uoClient, setUoClient] = useState(clients[0]?.id ?? "");
  const [uoCode, setUoCode] = useState("XYZO");
  const [uoQty, setUoQty] = useState("20,000");
  const [uoStrike, setUoStrike] = useState("1.00");
  const [uoUnder, setUoUnder] = useState("1.10");
  const [uoDte, setUoDte] = useState("20");

  const activeOptions = options.filter(o => {
    if (o.status !== "open") return false;
    if (filterClient !== "all" && o.clientId !== filterClient) return false;
    if (filterType === "listed" && !o.listed) return false;
    if (filterType === "unlisted" && o.listed) return false;
    if (filterExpiry === "7" && !(o.dte <= 7 && o.dte >= 0)) return false;
    if (filterExpiry === "30" && !(o.dte <= 30 && o.dte >= 0)) return false;
    if (filterMoney === "itm" && !isITM(o)) return false;
    if (filterMoney === "otm" && isITM(o)) return false;
    return true;
  });

  const lapsedExpiredOptions = options.filter(o => {
    if (o.status === "open") return false;
    if (filterClient !== "all" && o.clientId !== filterClient) return false;
    return true;
  });

  const handleClearFilters = () => {
    setFilterClient("all");
    setFilterType("all");
    setFilterExpiry("all");
    setFilterMoney("all");
  };

  const handleAddOptionSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    // Simulate addition (normally we would call a DB mutator, but since we are doing controlled mocks we can alert)
    alert(`Unlisted option ${uoCode.toUpperCase()} added on register for ${clientMap[uoClient]?.name || uoClient}.`);
    setShowAddModal(false);
  };

  return (
    <div className="space-y-4 text-ink font-body select-none">
      {/* Page Header */}
      <div className="flex justify-between items-end gap-3 flex-wrap">
        <div>
          <div className="font-mono text-xs tracking-wider uppercase text-mut font-semibold">All clients &middot; listed feed + manual unlisted</div>
          <h1 className="font-disp font-medium text-[26px] mt-0.5">Options tracker</h1>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="btn bg-navy text-white hover:bg-slate-800 font-semibold py-2 px-4.5 rounded-[10px] text-xs cursor-pointer"
        >
          + Add unlisted option
        </button>
      </div>

      {/* Filters Strip */}
      <div className="flex flex-wrap gap-3 items-center text-xs font-semibold bg-white border border-line rounded-xl p-3.5 shadow-shadow">
        <div className="flex items-center gap-1.5">
          <span className="text-mut uppercase text-[10px]">Client</span>
          <select
            value={filterClient}
            onChange={e => setFilterClient(e.target.value)}
            className="border border-line bg-paper px-2 py-1 rounded-md focus:outline-none"
          >
            <option value="all">All clients</option>
            {clients.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-mut uppercase text-[10px]">Type</span>
          <select
            value={filterType}
            onChange={e => setFilterType(e.target.value)}
            className="border border-line bg-paper px-2 py-1 rounded-md focus:outline-none"
          >
            <option value="all">All</option>
            <option value="listed">Listed</option>
            <option value="unlisted">Unlisted</option>
          </select>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-mut uppercase text-[10px]">Expiry</span>
          <select
            value={filterExpiry}
            onChange={e => setFilterExpiry(e.target.value)}
            className="border border-line bg-paper px-2 py-1 rounded-md focus:outline-none"
          >
            <option value="all">Any</option>
            <option value="7">&le; 7 days</option>
            <option value="30">&le; 30 days</option>
          </select>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-mut uppercase text-[10px]">Moneyness</span>
          <select
            value={filterMoney}
            onChange={e => setFilterMoney(e.target.value)}
            className="border border-line bg-paper px-2 py-1 rounded-md focus:outline-none"
          >
            <option value="all">All</option>
            <option value="itm">In the money</option>
            <option value="otm">Out of money</option>
          </select>
        </div>

        {(filterClient !== "all" || filterType !== "all" || filterExpiry !== "all" || filterMoney !== "all") && (
          <button
            onClick={handleClearFilters}
            className="btn ghost sm text-[11px] font-semibold py-1.5 px-3 border border-line rounded-lg bg-paper hover:bg-white cursor-pointer ml-auto"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Active Options Table */}
      <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
        <div className="px-4.5 py-4 border-b border-line bg-white select-none">
          <b className="text-sm font-semibold text-ink">Live client options ({activeOptions.length})</b>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs font-medium">
            <thead>
              <tr className="border-b border-line text-mut select-none">
                <th className="px-4.5 py-2.5">Client</th>
                <th className="px-4.5 py-2.5">Series</th>
                <th className="px-4.5 py-2.5 text-right">Qty</th>
                <th className="px-4.5 py-2.5 text-right">Strike</th>
                <th className="px-4.5 py-2.5 text-right hidden sm:table-cell">Underlying</th>
                <th className="px-4.5 py-2.5 text-center">Moneyness</th>
                <th className="px-4.5 py-2.5 hidden sm:table-cell">Expiry date</th>
                <th className="px-4.5 py-2.5">Window</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#f0ede5]">
              {activeOptions.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-center text-mut py-6">No matching live options found.</td>
                </tr>
              ) : (
                activeOptions.map(o => {
                  const isItmVal = isITM(o);
                  return (
                    <tr key={o.id} className="hover:bg-[#faf9f5]">
                      <td className="px-4.5 py-3 select-none">
                        <span className="w-6.5 h-6.5 rounded-full bg-paper-2 border border-line flex items-center justify-center font-bold text-[9.5px] text-ink uppercase">
                          {clientMap[o.clientId]?.initials || o.clientId}
                        </span>
                      </td>
                      <td className="px-4.5 py-3">
                        <span className="code font-mono px-1.5 py-0.5 rounded-[5px] bg-paper-2">{o.code}</span>
                        <div className="text-[10px] text-mut mt-1">{o.listed ? "Listed" : "Unlisted"}</div>
                      </td>
                      <td className="px-4.5 py-3 text-right font-mono">{o.qty ? o.qty.toLocaleString("en-AU") : "—"}</td>
                      <td className="px-4.5 py-3 text-right font-mono">${o.strike.toFixed(2)}</td>
                      <td className="px-4.5 py-3 text-right font-mono hidden sm:table-cell">${o.under.toFixed(2)}</td>
                      <td className="px-4.5 py-3 text-center">
                        <div className="inline-flex items-center gap-1.5">
                          <MoneynessBar strike={o.strike} under={o.under} type={o.type} />
                          <span className={`pill text-[10px] font-bold rounded-full px-1.5 py-0.5 ${isItmVal ? "bg-green-bg text-green-d" : "bg-paper-2 text-mut"}`}>
                            {isItmVal ? "ITM" : "OTM"}
                          </span>
                        </div>
                      </td>
                      <td className="px-4.5 py-3 hidden sm:table-cell font-mono text-[11px] text-mut">
                        {new Date(o.expiryDate).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
                      </td>
                      <td className="px-4.5 py-3">
                        <ExpiryRail dte={o.dte} />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Lapsed Expired Table */}
      <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
        <div className="px-4.5 py-3.5 border-b border-line bg-white select-none">
          <b className="text-sm font-semibold text-ink">Exercised / Expired options history log</b>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs font-medium">
            <thead>
              <tr className="border-b border-line text-mut select-none">
                <th className="px-4.5 py-2.5">Client</th>
                <th className="px-4.5 py-2.5">Series</th>
                <th className="px-4.5 py-2.5 text-right">Qty</th>
                <th className="px-4.5 py-2.5 text-right">Strike</th>
                <th className="px-4.5 py-2.5">Outcome</th>
                <th className="px-4.5 py-2.5 text-right">Close date</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#f0ede5]">
              {lapsedExpiredOptions.map(o => (
                <tr key={o.id} className="hover:bg-[#faf9f5]">
                  <td className="px-4.5 py-3 select-none">
                    <span className="w-5.5 h-5.5 rounded-full bg-paper-2 border border-line flex items-center justify-center font-bold text-[9px] text-ink uppercase">
                      {clientMap[o.clientId]?.initials || o.clientId}
                    </span>
                  </td>
                  <td className="px-4.5 py-3 font-bold"><span className="code font-mono px-1.5 py-0.5 rounded-[5px] bg-paper-2">{o.code}</span></td>
                  <td className="px-4.5 py-3 text-right font-mono">{o.qty.toLocaleString("en-AU")}</td>
                  <td className="px-4.5 py-3 text-right font-mono">${o.strike.toFixed(2)}</td>
                  <td className="px-4.5 py-3">
                    <span className={`pill text-[10.5px] font-bold px-2 py-0.5 rounded-full ${o.status === "expired" ? "bg-paper-2 text-mut" : "bg-green-bg text-green-d"}`}>
                      {o.status === "expired" ? "Expired OTM" : "Exercised"}
                    </span>
                  </td>
                  <td className="px-4.5 py-3 text-right text-mut font-mono">
                    {new Date(o.expiryDate).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Manual Unlisted Option Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-navy/55 backdrop-blur-[2px] z-50 flex items-center justify-center p-4.5">
          <form onSubmit={handleAddOptionSubmit} className="bg-white rounded-2xl max-w-110 w-full p-6 shadow-shadow-lg text-ink space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="font-disp font-medium text-lg text-ink">Add unlisted option</h3>
            <p className="text-xs text-mut leading-normal">
              Unlisted options are not on the broker feed. Enter them on the client register manually.
            </p>

            <div className="space-y-3">
              <div className="space-y-1">
                <label className="block text-xs font-semibold text-ink">Client</label>
                <select
                  value={uoClient}
                  onChange={e => setUoClient(e.target.value)}
                  className="w-full border border-line-2 bg-white rounded-[9px] px-3 py-2 text-sm focus:border-green focus:outline-none"
                >
                  {clients.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="block text-xs font-semibold text-ink">Code</label>
                  <input
                    type="text"
                    value={uoCode}
                    onChange={e => setUoCode(e.target.value)}
                    required
                    className="w-full border border-line-2 bg-white rounded-[9px] px-3 py-2 text-sm focus:border-green"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-xs font-semibold text-ink font-mono">Quantity</label>
                  <input
                    type="text"
                    value={uoQty}
                    onChange={e => setUoQty(e.target.value.replace(/[^0-9,]/g, ""))}
                    required
                    className="w-full border border-line-2 bg-white rounded-[9px] px-3 py-2 text-sm focus:border-green"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="block text-xs font-semibold text-ink font-mono">Strike ($)</label>
                  <input
                    type="text"
                    value={uoStrike}
                    onChange={e => setUoStrike(e.target.value)}
                    required
                    className="w-full border border-line-2 bg-white rounded-[9px] px-3 py-2 text-sm focus:border-green"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-xs font-semibold text-ink font-mono">Underlying ($)</label>
                  <input
                    type="text"
                    value={uoUnder}
                    onChange={e => setUoUnder(e.target.value)}
                    required
                    className="w-full border border-line-2 bg-white rounded-[9px] px-3 py-2 text-sm focus:border-green"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="block text-xs font-semibold text-ink font-mono">Days to expiry</label>
                <input
                  type="text"
                  value={uoDte}
                  onChange={e => setUoDte(e.target.value.replace(/[^0-9]/g, ""))}
                  required
                  className="w-full border border-line-2 bg-white rounded-[9px] px-3.5 py-2 text-sm focus:border-green"
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
                Add option
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
