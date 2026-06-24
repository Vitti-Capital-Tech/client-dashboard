"use client";

import React from "react";
import { useDatabaseStore } from "@/store/useDatabaseStore";

export default function ClientMarketsPage() {
  const { db } = useDatabaseStore();
  const note = db.note;

  return (
    <div className="space-y-4 text-ink font-body select-none">
      {/* Page Header */}
      <div className="flex justify-between items-end gap-3 flex-wrap">
        <div>
          <div className="font-mono text-xs tracking-wider uppercase text-mut">Daily ASX briefing &middot; Friday 12 Jun</div>
          <h1 className="font-disp font-medium text-[26px] mt-0.5">Markets &amp; research</h1>
        </div>
        <div className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-green-d bg-green-bg py-1.5 px-3.5 rounded-full select-none">
          <span className="w-1.5 h-1.5 rounded-full bg-green animate-ping" />
          <span>Live &middot; {note.time}</span>
        </div>
      </div>

      {/* Index Strip */}
      <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
        <div className="flex divide-x divide-line overflow-x-auto scrollbar-none py-1">
          {db.indices.map(x => {
            const isUp = x.chg >= 0;
            return (
              <div key={x.code} className="flex-1 min-w-26 px-5 py-3 select-none">
                <div className="font-mono text-[10.5px] text-mut font-semibold tracking-wider uppercase">{x.code}</div>
                <div className="font-mono font-bold text-base mt-0.5 text-ink">
                  {x.last.toLocaleString("en-AU", {
                    minimumFractionDigits: x.dp !== undefined ? x.dp : 1,
                    maximumFractionDigits: x.dp !== undefined ? x.dp : 1
                  })}
                </div>
                <div className={`font-mono text-xs mt-0.5 font-semibold ${isUp ? "text-gain" : "text-loss-d"}`}>
                  {isUp ? "▲" : "▼"} {Math.abs(x.chg).toFixed(2)}%
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Split Layout: Morning Note & Reports */}
      <div className="grid md:grid-cols-12 gap-4">
        {/* Morning Note */}
        <div className="md:col-span-7 space-y-4">
          <div className="card bg-navy text-[#dfe2ee] border-navy p-5 rounded-[14px] shadow-shadow space-y-3.5 relative overflow-hidden bg-linear-to-b from-navy to-[#181a28]">
            <div className="flex justify-between items-center text-xs font-semibold text-white/50 select-none">
              <span>Morning note</span>
              <span>{note.time} &middot; research desk</span>
            </div>
            
            <h3 className="font-disp font-medium text-lg md:text-xl text-white leading-tight">
              {note.title}
            </h3>
            
            <p className="text-xs md:text-sm text-slate-300 leading-relaxed font-medium">
              {note.body}
            </p>

            <button 
              onClick={() => alert("Full RBA miners research PDF would open here.")}
              className="btn bg-green text-[#08130e] hover:shadow-lg font-semibold py-2 px-4 rounded-lg text-xs cursor-pointer select-none"
            >
              Read full note
            </button>
          </div>

          {/* Analyst recommendations table */}
          <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
            <div className="px-4.5 py-3.5 border-b border-line bg-white select-none">
              <b className="text-sm font-semibold text-ink">Desk recommendations</b>
              <p className="text-[11px] text-mut mt-0.5">Analyst targets and ratings</p>
            </div>
            <table className="w-full border-collapse text-left text-xs font-medium">
              <thead>
                <tr className="border-b border-line text-mut select-none">
                  <th className="px-4.5 py-2.5">Code</th>
                  <th className="px-4.5 py-2.5">Rating</th>
                  <th className="px-4.5 py-2.5 text-right">Target</th>
                  <th className="px-4.5 py-2.5 text-right hidden sm:table-cell">Upside</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f0ede5]">
                {db.recos.map(r => {
                  const ratingColor = r.rating.toLowerCase().includes("buy") ? "bg-green-bg text-green-d" : "bg-paper-2 text-mut";
                  return (
                    <tr key={r.code} className="hover:bg-[#faf9f5]">
                      <td className="px-4.5 py-2.5 font-bold"><span className="code text-[12.5px] bg-paper-2 rounded-[5px] px-1.5 py-0.5">{r.code}</span></td>
                      <td className="px-4.5 py-2.5">
                        <span className={`pill text-[10px] font-bold px-2 py-0.5 rounded-full uppercase ${ratingColor}`}>
                          {r.rating}
                        </span>
                      </td>
                      <td className="px-4.5 py-2.5 text-right font-mono text-[12.5px]">
                        {r.tp ? `$${r.tp.toFixed(2)}` : "—"}
                      </td>
                      <td className="px-4.5 py-2.5 text-right font-mono text-mut hidden sm:table-cell">
                        {r.move}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right column: Strategy library and AI teaser */}
        <div className="md:col-span-5 space-y-4">
          <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow space-y-3">
            <b className="text-sm font-semibold text-ink block select-none">Latest strategy reports</b>
            <div className="divide-y divide-[#f0ede5] text-xs font-medium">
              {db.reports.map((rp, idx) => (
                <div key={idx} className="py-2.5 space-y-0.5">
                  <div className="font-semibold text-ink">{rp.title}</div>
                  <div className="text-mut text-[10.5px]">
                    {rp.kind} &middot; {rp.date.toLocaleDateString("en-AU", { day: "numeric", month: "short" })} &middot; {rp.pp} pp
                  </div>
                </div>
              ))}
            </div>
            <button 
              onClick={() => alert("Research library portal would open here.")}
              className="w-full btn ghost sm text-xs font-semibold py-2 border border-line rounded-lg bg-white hover:border-mut cursor-pointer select-none"
            >
              All research reports
            </button>
          </div>

          <div className="card bg-linear-to-b from-green-bg to-white border border-green rounded-[14px] p-4.5 shadow-shadow space-y-2 select-none">
            <div className="flex justify-between items-center text-xs">
              <b className="text-ink text-sm font-semibold">Ask Vitti AI</b>
              <span className="bg-green text-[#08130e] text-[9px] font-bold px-1.5 py-0.5 rounded-[5px]">AI</span>
            </div>
            <p className="text-xs text-mut leading-relaxed">
              Get a plain-English read on today’s market and how it affects your exact holdings.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
