"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useDatabase } from "@/contexts/DatabaseContext";
import {
  clientPositions,
  posValue,
  portfolioValue
} from "@/lib/db";

export default function StaffOverview() {
  const router = useRouter();
  const { db, setViewClient } = useDatabase();

  // Derived metrics
  let totalBookValue = 0;
  Object.keys(db.clients).forEach(cid => {
    totalBookValue += portfolioValue(db, cid);
  });

  const activeDeals = db.placements.filter(p => p.stage === "open" || p.stage === "closed");
  const unackAlerts = db.alerts.filter(a => !a.ack);
  const clientIds = Object.keys(db.clients);

  const handleViewClient = (cid: string) => {
    setViewClient(cid);
    router.push(`/portal/staff/clients/${cid}`);
  };

  const getSponsorBadge = (stage: string) => {
    if (stage === "open") {
      return (
        <span className="pill bg-green-bg text-green-d text-[10.5px] font-bold px-2 py-0.5 rounded-full inline-flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-green" /> Live
        </span>
      );
    }
    if (stage === "closed") {
      return (
        <span className="pill bg-amber-bg text-amber-d text-[10.5px] font-bold px-2 py-0.5 rounded-full">
          Closed
        </span>
      );
    }
    if (stage === "settled") {
      return (
        <span className="pill bg-[#ece9f3] text-[#5c5775] text-[10.5px] font-bold px-2 py-0.5 rounded-full">
          Settled
        </span>
      );
    }
    return (
      <span className="pill bg-paper-2 text-mut text-[10.5px] font-bold px-2 py-0.5 rounded-full">
        Upcoming
      </span>
    );
  };

  return (
    <div className="space-y-4 text-ink font-body select-none">
      {/* Page Header */}
      <div>
        <div className="font-mono text-xs tracking-wider uppercase text-mut">Consolidated adviser console</div>
        <h1 className="font-disp font-medium text-[26px] mt-0.5">Overview</h1>
      </div>

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Wholesale book</div>
          <div className="font-disp font-medium text-2xl mt-1 text-ink">${Math.round(totalBookValue).toLocaleString("en-AU")}</div>
          <div className="text-xs text-mut mt-1">across all active clients</div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Active placement raises</div>
          <div className="font-disp font-medium text-2xl mt-1 text-ink">{activeDeals.length} deals</div>
          <div className="text-xs text-mut mt-1">open or awaiting allocation</div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Unack alerts</div>
          <div className={`font-disp font-medium text-2xl mt-1 ${unackAlerts.length > 0 ? "text-loss-d animate-pulse font-bold" : "text-ink"}`}>
            {unackAlerts.length}
          </div>
          <div className="text-xs text-mut mt-1">requiring staff attention</div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Wholesale clients</div>
          <div className="font-disp font-medium text-2xl mt-1 text-ink">{clientIds.length} verified</div>
          <div className="text-xs text-mut mt-1">s708 certificates on register</div>
        </div>
      </div>

      {/* Active raises table */}
      <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow space-y-3">
        <div className="flex justify-between items-center text-xs">
          <b className="text-sm font-semibold text-ink">Active deals book</b>
          <button 
            onClick={() => router.push("/portal/staff/placements")}
            className="text-green-d font-semibold text-xs underline underline-offset-2 hover:opacity-85 cursor-pointer"
          >
            Manage books
          </button>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {db.placements.filter(p => p.stage !== "upcoming").map(p => {
            const totalBidsVal = p.bids.reduce((sum, b) => sum + b.amount, 0);
            return (
              <div key={p.id} className="border border-line rounded-xl p-4 space-y-3">
                <div className="flex justify-between items-center">
                  <div>
                    <span className="code text-xs bg-paper-2 rounded-[5px] px-1.5 py-0.5 font-bold">{p.code}</span>
                    <span className="text-[11px] text-mut ml-2">{p.type}</span>
                  </div>
                  {getSponsorBadge(p.stage)}
                </div>
                <div className="font-semibold text-xs leading-snug">{p.name}</div>
                <div className="grid grid-cols-2 gap-2 text-xs py-1 leading-normal font-mono select-none">
                  <div>
                    <span className="text-mut block text-[9.5px]">Bids (Qty)</span>
                    <b className="text-ink">{p.bids.length} bids</b>
                  </div>
                  <div>
                    <span className="text-mut block text-[9.5px]">Book Value</span>
                    <b className="text-ink">${(totalBidsVal / 1e3).toFixed(0)}k</b>
                  </div>
                </div>
                <button 
                  onClick={() => router.push("/portal/staff/placements")}
                  className="w-full btn bg-navy hover:bg-slate-800 text-white font-semibold py-1.5 rounded-lg text-[11px] cursor-pointer"
                >
                  Manage deal
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Main Split Grid */}
      <div className="grid lg:grid-cols-12 gap-4">
        {/* Client Register Table */}
        <div className="lg:col-span-8 card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
          <div className="px-4.5 py-4 border-b border-line bg-white">
            <b className="text-sm font-semibold text-ink">Wholesale client register</b>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs font-medium">
              <thead>
                <tr className="border-b border-line text-mut select-none">
                  <th className="px-4.5 py-2.5">Client</th>
                  <th className="px-4.5 py-2.5">Structure</th>
                  <th className="px-4.5 py-2.5 text-right">Portfolio value</th>
                  <th className="px-4.5 py-2.5 text-center">Active bids</th>
                  <th className="px-4.5 py-2.5 text-right">s708 expiry</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f0ede5]">
                {clientIds.map(cid => {
                  const cl = db.clients[cid];
                  const val = portfolioValue(db, cid);
                  const bidCount = db.placements.filter(p => p.bids.some(b => b.c === cid)).length;
                  return (
                    <tr 
                      key={cid} 
                      onClick={() => handleViewClient(cid)}
                      className="hover:bg-[#faf9f5] cursor-pointer transition-colors"
                    >
                      <td className="px-4.5 py-3 flex items-center gap-2">
                        <span className="w-6 h-6 rounded-full bg-paper-2 border border-line flex items-center justify-center font-bold text-[10px] text-ink">
                          {cl.av}
                        </span>
                        <span className="font-bold text-ink">{cl.name}</span>
                      </td>
                      <td className="px-4.5 py-3 text-mut">{cl.type}</td>
                      <td className="px-4.5 py-3 text-right font-mono text-[13px]">${Math.round(val).toLocaleString("en-AU")}</td>
                      <td className="px-4.5 py-3 text-center">
                        <span className={`pill text-[10.5px] font-bold rounded-full px-2 py-0.5 ${bidCount > 0 ? "bg-green-bg text-green-d" : "bg-paper-2 text-mut"}`}>
                          {bidCount} bids
                        </span>
                      </td>
                      <td className="px-4.5 py-3 text-right text-mut font-mono">{cl.s708}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Audit trail summary */}
        <div className="lg:col-span-4 card bg-white border border-line rounded-[14px] shadow-shadow flex flex-col justify-between overflow-hidden">
          <div className="px-4.5 py-3.5 border-b border-line bg-white select-none flex justify-between items-center">
            <b className="text-sm font-semibold text-ink">Audit trail</b>
            <button 
              onClick={() => router.push("/portal/staff/audit")}
              className="text-green-d font-semibold text-xs underline underline-offset-2 hover:opacity-85 cursor-pointer"
            >
              Log
            </button>
          </div>

          <div className="p-4 flex-1 overflow-y-auto space-y-3.5 max-h-75">
            {db.audit.slice(0, 5).map((log, idx) => (
              <div key={idx} className="space-y-0.5 text-xs">
                <div className="flex justify-between items-baseline font-mono text-[9.5px] text-mut select-none">
                  <span>{log.user}</span>
                  <span>{new Date(log.ts).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}</span>
                </div>
                <div className="font-semibold text-ink">{log.action}</div>
                <div className="text-mut text-[11px] leading-relaxed truncate">{log.detail}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
