"use client";

import React, { useState } from "react";
import { useRouter, useParams } from "next/navigation";
import { useDatabase } from "@/contexts/DatabaseContext";
import {
  clientPositions,
  clientOptions,
  posValue,
  posCost,
  posPL,
  cashOf,
  unlistedValue,
  portfolioValue,
  isITM
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

export default function ClientDetailAdviser() {
  const router = useRouter();
  const params = useParams();
  const cid = (params.id as string) || "C1";

  const { db } = useDatabase();
  const [activeTab, setActiveTab] = useState<"holdings" | "options" | "bids" | "alerts">("holdings");

  const cl = db.clients[cid];
  if (!cl) {
    return <div className="text-mut text-center py-10">Client not found on registry.</div>;
  }

  const positions = clientPositions(db, cid);
  const options = clientOptions(db, cid);
  const cash = cashOf(cid);
  const unlisted = unlistedValue(db, cid);
  
  let tv = 0;
  let tc = 0;
  positions.forEach(p => {
    tv += posValue(p);
    tc += posCost(p);
  });

  const tpl = tv - tc;
  const tplp = tc > 0 ? (tpl / tc) * 100 : 0;
  const totalAssets = tv + cash + unlisted;

  const clientBids = db.placements.filter(p => p.bids.some(b => b.c === cid));

  const clientAlerts = db.alerts.filter(a => a.client === cid);

  const getActionPill = (action: string) => {
    const maps: Record<string, string> = {
      Add: "bg-green-bg text-green-d",
      Hold: "bg-paper-2 text-mut",
      Trim: "bg-amber-bg text-amber-d",
      "Take profit": "bg-amber-bg text-amber-d",
      Watch: "bg-[#ece9f3] text-[#5c5775]"
    };
    return (
      <span className={`pill px-2 py-0.5 rounded-full text-[10.5px] font-semibold ${maps[action] || "bg-paper-2 text-mut"}`}>
        {action}
      </span>
    );
  };

  return (
    <div className="space-y-4 text-ink font-body">
      {/* Back to registry */}
      <div className="select-none">
        <button
          onClick={() => router.push("/portal/staff")}
          className="text-green-d font-semibold text-xs underline underline-offset-2 cursor-pointer hover:opacity-85"
        >
          &larr; Client Register
        </button>
      </div>

      {/* Header Info */}
      <div className="flex gap-4 items-center justify-between flex-wrap select-none border-b border-line pb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-navy text-green flex items-center justify-center font-bold text-sm flex-none">
            {cl.av}
          </div>
          <div>
            <h1 className="font-disp font-medium text-2xl leading-none">{cl.name}</h1>
            <div className="text-xs text-mut mt-1">
              Structure: {cl.type} &middot; s708 certificate expires {cl.s708}
            </div>
          </div>
        </div>

        {/* Tab Selection */}
        <div className="inline-flex bg-paper-2 rounded-[9px] p-0.75">
          {(["holdings", "options", "bids", "alerts"] as const).map(t => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              className={`text-xs font-semibold px-3.5 py-1.5 rounded-[7px] cursor-pointer capitalize transition-colors ${activeTab === t ? "bg-white text-ink shadow-shadow" : "text-mut hover:text-ink"}`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-3 gap-4 select-none">
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Asset value</div>
          <div className="font-disp font-medium text-2xl mt-1 text-ink">${Math.round(totalAssets).toLocaleString("en-AU")}</div>
          <div className="text-xs text-mut mt-1">Positions + cash + unlisted carry</div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Cost invested</div>
          <div className="font-disp font-medium text-2xl mt-1 text-ink">${Math.round(tc).toLocaleString("en-AU")}</div>
          <div className="text-xs text-mut mt-1">net cost base</div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Client P&amp;L</div>
          <div className={`font-disp font-medium text-2xl mt-1 ${tpl >= 0 ? "text-gain" : "text-loss-d"}`}>
            {tpl >= 0 ? "+" : ""}${Math.round(tpl).toLocaleString("en-AU")}
          </div>
          <div className={`text-xs mt-1 font-mono ${tpl >= 0 ? "text-gain" : "text-loss-d"}`}>
            {tpl >= 0 ? "+" : ""}{tplp.toFixed(1)}%
          </div>
        </div>
      </div>

      {/* Detailed views rendered based on tab */}
      {activeTab === "holdings" && (
        <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
          <div className="px-4.5 py-3.5 border-b border-line bg-white select-none">
            <b className="text-sm font-semibold text-ink">Equities portfolio</b>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs font-medium">
              <thead>
                <tr className="border-b border-line text-mut select-none">
                  <th className="px-4.5 py-2.5">Code</th>
                  <th className="px-4.5 py-2.5">Stock</th>
                  <th className="px-4.5 py-2.5 text-right">Qty</th>
                  <th className="px-4.5 py-2.5 text-right">Cost price</th>
                  <th className="px-4.5 py-2.5 text-right">Last close</th>
                  <th className="px-4.5 py-2.5 text-right">Market value</th>
                  <th className="px-4.5 py-2.5 text-right">Unreal. P&amp;L</th>
                  <th className="px-4.5 py-2.5 text-center">Desk view</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f0ede5]">
                {positions.map(p => {
                  const pl = posPL(p);
                  const plp = pl / posCost(p) * 100;
                  const isUp = pl >= 0;
                  const sg = db.signals[p.code];
                  return (
                    <tr key={p.code} className="hover:bg-[#faf9f5]">
                      <td className="px-4.5 py-3"><span className="code font-mono px-1.5 py-0.5 rounded-[5px] bg-paper-2">{p.code}</span></td>
                      <td className="px-4.5 py-3 text-mut">{p.name}</td>
                      <td className="px-4.5 py-3 text-right font-mono">{p.qty.toLocaleString("en-AU")}</td>
                      <td className="px-4.5 py-3 text-right font-mono">${p.cost.toFixed(2)}</td>
                      <td className="px-4.5 py-3 text-right font-mono">${p.last.toFixed(2)}</td>
                      <td className="px-4.5 py-3 text-right font-mono font-semibold">${Math.round(posValue(p)).toLocaleString("en-AU")}</td>
                      <td className={`px-4.5 py-3 text-right font-mono ${isUp ? "text-gain" : "text-loss-d"}`}>
                        ${Math.round(pl).toLocaleString("en-AU")}
                        <div className="text-[10px]">{isUp ? "+" : ""}{plp.toFixed(1)}%</div>
                      </td>
                      <td className="px-4.5 py-3 text-center">
                        {getActionPill(sg ? sg.action : "Hold")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === "options" && (
        <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
          <div className="px-4.5 py-3.5 border-b border-line bg-white select-none">
            <b className="text-sm font-semibold text-ink">Client option register</b>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs font-medium">
              <thead>
                <tr className="border-b border-line text-mut select-none">
                  <th className="px-4.5 py-2.5">Series</th>
                  <th className="px-4.5 py-2.5">Type</th>
                  <th className="px-4.5 py-2.5 text-right">Qty</th>
                  <th className="px-4.5 py-2.5 text-right">Strike</th>
                  <th className="px-4.5 py-2.5 text-right">Underlying</th>
                  <th className="px-4.5 py-2.5 text-center">Moneyness</th>
                  <th className="px-4.5 py-2.5">Expiry window</th>
                  <th className="px-4.5 py-2.5 text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f0ede5]">
                {options.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="text-center text-mut py-6">No option assets on record.</td>
                  </tr>
                ) : (
                  options.map(o => {
                    const isItmVal = isITM(o);
                    return (
                      <tr key={o.id} className="hover:bg-[#faf9f5]">
                        <td className="px-4.5 py-3">
                          <span className="code font-mono px-1.5 py-0.5 rounded-[5px] bg-paper-2">{o.code}</span>
                          <span className="text-[10px] text-mut ml-2">{o.listed ? "Listed" : "Unlisted"}</span>
                        </td>
                        <td className="px-4.5 py-3 text-mut">{o.type}</td>
                        <td className="px-4.5 py-3 text-right font-mono">{o.qty ? o.qty.toLocaleString("en-AU") : "—"}</td>
                        <td className="px-4.5 py-3 text-right font-mono">${o.strike.toFixed(2)}</td>
                        <td className="px-4.5 py-3 text-right font-mono">${o.under.toFixed(2)}</td>
                        <td className="px-4.5 py-3 text-center">
                          <div className="inline-flex items-center gap-1.5">
                            <MoneynessBar strike={o.strike} under={o.under} type={o.type} />
                            <span className={`pill text-[10px] font-bold rounded-full px-1.5 py-0.5 ${isItmVal ? "bg-green-bg text-green-d" : "bg-paper-2 text-mut"}`}>
                              {isItmVal ? "ITM" : "OTM"}
                            </span>
                          </div>
                        </td>
                        <td className="px-4.5 py-3">
                          <ExpiryRail dte={o.dte} />
                        </td>
                        <td className="px-4.5 py-3 text-right capitalize text-mut font-semibold">{o.status}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === "bids" && (
        <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
          <div className="px-4.5 py-3.5 border-b border-line bg-white select-none">
            <b className="text-sm font-semibold text-ink">Bidding activities</b>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs font-medium">
              <thead>
                <tr className="border-b border-line text-mut select-none">
                  <th className="px-4.5 py-2.5">Deal</th>
                  <th className="px-4.5 py-2.5">Type</th>
                  <th className="px-4.5 py-2.5 text-right">Bid size</th>
                  <th className="px-4.5 py-2.5 text-right">Allotted</th>
                  <th className="px-4.5 py-2.5">Timeline close</th>
                  <th className="px-4.5 py-2.5 text-right">Payment</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f0ede5]">
                {clientBids.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center text-mut py-6">No bids recorded.</td>
                  </tr>
                ) : (
                  clientBids.map(p => {
                    const bid = p.bids.find(b => b.c === cid)!;
                    return (
                      <tr key={p.id} className="hover:bg-[#faf9f5]">
                        <td className="px-4.5 py-3 font-bold"><span className="code font-mono px-1.5 py-0.5 rounded-[5px] bg-paper-2">{p.code}</span> &middot; {p.name}</td>
                        <td className="px-4.5 py-3 text-mut">{p.type}</td>
                        <td className="px-4.5 py-3 text-right font-mono">${bid.amount.toLocaleString("en-AU")}</td>
                        <td className="px-4.5 py-3 text-right font-mono">
                          {bid.alloc === null ? "—" : `$${bid.alloc.toLocaleString("en-AU")}`}
                        </td>
                        <td className="px-4.5 py-3 text-mut font-mono text-[11px]">
                          {p.closeDate.toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
                        </td>
                        <td className="px-4.5 py-3 text-right">
                          <span className={`pill text-[10px] font-bold px-2 py-0.5 rounded-full ${bid._paid ? "bg-green-bg text-green-d" : "bg-amber-bg text-amber-d"}`}>
                            {bid._paid ? "Received" : "Outstanding"}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === "alerts" && (
        <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
          <div className="px-4.5 py-3.5 border-b border-line bg-white select-none">
            <b className="text-sm font-semibold text-ink">Active alerts</b>
          </div>
          <div className="divide-y divide-line">
            {clientAlerts.length === 0 ? (
              <div className="text-center text-mut py-8 text-xs select-none">No active alerts set for this client.</div>
            ) : (
              clientAlerts.map(a => (
                <div key={a.id} className="p-4 flex justify-between items-center text-xs">
                  <div>
                    <div className="font-semibold text-ink flex items-center gap-2">
                      <span className={`pill text-[9px] font-bold px-1.5 py-0.5 rounded-full ${a.sev === "red" ? "bg-loss-bg text-loss-d" : (a.sev === "amber" ? "bg-amber-bg text-amber-d" : "bg-green-bg text-green-d")}`}>
                        {a.sev}
                      </span>
                      {a.title}
                    </div>
                    <p className="text-mut text-[11.5px] mt-0.5 leading-normal">{a.sub}</p>
                  </div>
                  <span className="text-[10px] font-mono text-mut leading-normal select-none">
                    {a.ack ? "Acknowledged" : "Active"}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
