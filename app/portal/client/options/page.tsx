"use client";

import React, { useState } from "react";
import { useDatabaseStore } from "@/store/useDatabaseStore";
import {
  clientOptions,
  isITM,
  moneyness,
  intrinsic
} from "@/lib/db";

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

  const label = dte < 0 ? "expired" : `${dte}d`;

  return (
    <div className={`rail ${cls} select-none`}>
      <div className="dleft">{label}</div>
      <div className="ticks">{segs}</div>
      <div className="labs">
        <span>30</span>
        <span>14</span>
        <span>7</span>
        <span>3</span>
        <span>1</span>
      </div>
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

export default function ClientOptionsPage() {
  const { db, clientId } = useDatabaseStore();
  const [viewMode, setViewMode] = useState<"table" | "cards">("table");

  const options = clientOptions(db, clientId).filter(o => o.status !== "expired");
  const listed = options.filter(o => o.listed);
  const unlisted = options.filter(o => !o.listed);

  const itmCount = options.filter(isITM).length;
  const soonCount = options.filter(o => o.dte <= 7 && o.dte >= 0).length;

  const listedIntrinsicSum = listed
    .filter(isITM)
    .reduce((sum, o) => sum + intrinsic(o), 0);

  const handleActionClick = (code: string) => {
    alert(`Instruction for ${code} would be routed directly to the Vitti options desk.`);
  };

  const renderOptionTable = (rows: typeof options, title: string, subtitle: string) => (
    <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
      <div className="flex justify-between items-center px-4.5 py-4 border-b border-line bg-white">
        <div>
          <b className="text-ink text-sm font-semibold">{title}</b>
          <p className="text-xs text-mut mt-0.5">{subtitle}</p>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-left text-[12.5px] font-medium">
          <thead>
            <tr className="border-b border-line text-mut select-none">
              <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3">Series</th>
              <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right">Qty</th>
              <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right">Strike</th>
              <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right hidden sm:table-cell">Underlying</th>
              <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-center">Moneyness</th>
              <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 hidden sm:table-cell">Expiry</th>
              <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3">Window</th>
              <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#f0ede5]">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="text-center text-mut py-6">No options in this category.</td>
              </tr>
            ) : (
              rows.map(o => {
                const isItmVal = isITM(o);
                const hasAction = !o.listed && isItmVal && o.dte <= 14 && o.dte >= 0;
                return (
                  <tr key={o.id} className="hover:bg-[#faf9f5]">
                    <td className="px-4.5 py-3.5">
                      <span className="code text-[13px] bg-paper-2 rounded-[5px] px-1.5 py-0.5">{o.code}</span>
                      <div className="text-[10.5px] text-mut mt-1">
                        {o.source}
                        {o.status === "pending" && " · quotation pending"}
                      </div>
                    </td>
                    <td className="px-4.5 py-3.5 text-right font-mono">{o.qty ? o.qty.toLocaleString("en-AU") : "—"}</td>
                    <td className="px-4.5 py-3.5 text-right font-mono">${o.strike.toFixed(2)}</td>
                    <td className="px-4.5 py-3.5 text-right font-mono hidden sm:table-cell">${o.under.toFixed(2)}</td>
                    <td className="px-4.5 py-3.5 text-center">
                      <div className="inline-flex items-center gap-1.5">
                        <MoneynessBar strike={o.strike} under={o.under} type={o.type} />
                        <span className={`pill text-[10.5px] font-bold rounded-full px-1.5 py-0.5 ${isItmVal ? "bg-green-bg text-green-d" : "bg-paper-2 text-mut"}`}>
                          {isItmVal ? "ITM" : "OTM"}
                        </span>
                      </div>
                    </td>
                    <td className="px-4.5 py-3.5 hidden sm:table-cell font-mono text-[11px] text-mut">
                      {new Date(2026, 5, 12 + o.dte).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
                    </td>
                    <td className="px-4.5 py-3.5">
                      <ExpiryRail dte={o.dte} />
                    </td>
                    <td className="px-4.5 py-3.5 text-right">
                      {o.listed ? (
                        <button
                          onClick={() => handleActionClick(o.code)}
                          className="btn ghost sm text-xs font-semibold py-1.5 px-3 border border-line rounded-lg bg-white hover:border-mut cursor-pointer transition-colors"
                        >
                          Exercise
                        </button>
                      ) : hasAction ? (
                        <span className="pill bg-loss-bg text-loss-d text-[11px] font-bold py-1.5 px-2.5 rounded-full select-none animate-pulse">
                          Act now
                        </span>
                      ) : (
                        <span className="pill bg-paper-2 text-mut text-[11px] font-bold py-1.5 px-2.5 rounded-full select-none">
                          Hold
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Page Header */}
      <div className="flex justify-between items-end gap-3 flex-wrap">
        <div>
          <div className="font-mono text-xs tracking-wider uppercase text-mut">Listed &amp; unlisted</div>
          <h1 className="font-disp font-medium text-[26px] mt-0.5 text-ink">Options</h1>
          <p className="text-xs text-mut mt-1 max-w-[50em] leading-normal">
            Strike, expiry and moneyness across your option holdings. Unlisted options are not auto-exercised — watch the window.
          </p>
        </div>

        {/* View Mode switcher */}
        <div className="inline-flex bg-paper-2 rounded-[9px] p-0.75">
          <button
            onClick={() => setViewMode("table")}
            className={`text-xs font-semibold px-4 py-2 rounded-[7px] cursor-pointer transition-colors ${viewMode === "table" ? "bg-white text-ink shadow-shadow" : "text-mut hover:text-ink"}`}
          >
            Table
          </button>
          <button
            onClick={() => setViewMode("cards")}
            className={`text-xs font-semibold px-4 py-2 rounded-[7px] cursor-pointer transition-colors ${viewMode === "cards" ? "bg-white text-ink shadow-shadow" : "text-mut hover:text-ink"}`}
          >
            Cards
          </button>
        </div>
      </div>

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Option series</div>
          <div className="font-disp font-medium text-2xl mt-1 text-ink">{options.length}</div>
          <div className="text-xs text-mut mt-1">
            {listed.length} listed &middot; {unlisted.length} unlisted
          </div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">In the money</div>
          <div className="font-disp font-medium text-2xl mt-1 text-ink">{itmCount} series</div>
          <div className="text-xs text-mut mt-1">gain potential</div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Expiring &le;7 days</div>
          <div className={`font-disp font-medium text-2xl mt-1 ${soonCount > 0 ? "text-loss-d" : "text-ink"}`}>
            {soonCount} series
          </div>
          <div className={`text-xs mt-1 ${soonCount > 0 ? "text-loss-d font-bold animate-pulse" : "text-mut"}`}>
            {soonCount > 0 ? "attention needed" : "none"}
          </div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Listed intrinsic</div>
          <div className="font-disp font-medium text-2xl mt-1 text-ink">${Math.round(listedIntrinsicSum).toLocaleString("en-AU")}</div>
          <div className="text-xs text-mut mt-1">at current prices</div>
        </div>
      </div>

      {/* View Content */}
      {viewMode === "cards" ? (
        <div className="grid sm:grid-cols-2 gap-4">
          {options.length === 0 ? (
            <div className="card bg-white border border-line rounded-[14px] p-6 text-center text-mut col-span-2 select-none">
              No active options.
            </div>
          ) : (
            options.map(o => {
              const isItmVal = isITM(o);
              const hasAction = !o.listed && isItmVal && o.dte <= 14 && o.dte >= 0;
              return (
                <div key={o.id} className={`card bg-white border rounded-[14px] p-4.5 shadow-shadow space-y-3 ${hasAction ? "border-green bg-green-bg/5" : "border-line"}`}>
                  <div className="flex justify-between items-center">
                    <div>
                      <span className="code text-[14px] bg-paper-2 rounded-[5px] px-1.5 py-0.5">{o.code}</span>
                      <span className={`pill text-[10.5px] font-bold rounded-full px-2 py-0.5 ml-2 ${o.listed ? "bg-paper-2 text-mut" : "bg-[#ece9f3] text-[#5c5775]"}`}>
                        {o.listed ? "Listed" : "Unlisted"}
                      </span>
                    </div>
                    <span className={`pill text-xs font-bold rounded-full px-2.5 py-0.5 ${isItmVal ? "bg-green-bg text-green-d" : "bg-paper-2 text-mut"}`}>
                      {isItmVal ? "In the money" : "Out of money"}
                    </span>
                  </div>

                  <div className="text-xs text-mut leading-normal">
                    {o.name} &middot; {o.source}
                  </div>

                  <div className="grid grid-cols-3 gap-2 py-1 select-none">
                    <div>
                      <div className="text-[10px] uppercase font-mono tracking-wider text-mut">Qty</div>
                      <div className="font-mono font-semibold text-xs text-ink">{o.qty ? o.qty.toLocaleString("en-AU") : "—"}</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase font-mono tracking-wider text-mut">Strike</div>
                      <div className="font-mono font-semibold text-xs text-ink">${o.strike.toFixed(2)}</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase font-mono tracking-wider text-mut">Underlying</div>
                      <div className="font-mono font-semibold text-xs text-ink">${o.under.toFixed(2)}</div>
                    </div>
                  </div>

                  <div className="py-1">
                    <ExpiryRail dte={o.dte} />
                  </div>

                  <div className="pt-2 select-none">
                    {o.listed ? (
                      <button
                        onClick={() => handleActionClick(o.code)}
                        className="w-full btn ghost sm text-xs font-semibold py-2 rounded-lg bg-white border border-line hover:border-mut cursor-pointer transition-colors"
                      >
                        Exercise / Sell
                      </button>
                    ) : hasAction ? (
                      <button
                        onClick={() => handleActionClick(o.code)}
                        className="w-full btn bg-green text-[#08130e] hover:shadow-lg font-semibold py-2 rounded-lg text-xs cursor-pointer animate-pulse transition-all"
                      >
                        Act now &middot; exercise window open
                      </button>
                    ) : (
                      <div className="text-center">
                        <span className="pill bg-paper-2 text-mut text-[11px] font-bold py-1.5 px-3 rounded-full inline-block">
                          Hold &middot; not in window
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {renderOptionTable(listed, "Listed options", "Quoted on ASX · priced from broker feed")}
          {renderOptionTable(unlisted, "Unlisted options", "Held on issuer register · entered manually")}
        </div>
      )}
    </div>
  );
}
