"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useDatabaseStore } from "@/store/useDatabaseStore";
import { portfolioValue } from "@/lib/db";

export default function StaffClientsPage() {
  const router = useRouter();
  const { db, setViewClient } = useDatabaseStore();

  const clientIds = Object.keys(db.clients);

  const handleViewClient = (cid: string) => {
    setViewClient(cid);
    router.push(`/portal/staff/clients/${cid}`);
  };

  return (
    <div className="space-y-4 text-ink font-body select-none">
      {/* Page Header */}
      <div>
        <div className="font-mono text-xs tracking-wider uppercase text-mut">Verified advisers register</div>
        <h1 className="font-disp font-medium text-[26px] mt-0.5">Wholesale clients register</h1>
        <p className="text-xs text-mut mt-1">
          Full register of wholesale clients with verified s708 certificates, portfolio values, and active bids.
        </p>
      </div>

      {/* Client Register Table */}
      <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs font-medium">
            <thead>
              <tr className="border-b border-line text-mut select-none">
                <th className="px-4.5 py-3 font-semibold uppercase tracking-wider text-[10.5px]">Client</th>
                <th className="px-4.5 py-3 font-semibold uppercase tracking-wider text-[10.5px]">Structure</th>
                <th className="px-4.5 py-3 font-semibold uppercase tracking-wider text-[10.5px] text-right">Portfolio value</th>
                <th className="px-4.5 py-3 font-semibold uppercase tracking-wider text-[10.5px] text-center">Active bids</th>
                <th className="px-4.5 py-3 font-semibold uppercase tracking-wider text-[10.5px] text-right">s708 expiry</th>
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
                    <td className="px-4.5 py-3.5 flex items-center gap-2">
                      <span className="w-6.5 h-6.5 rounded-full bg-paper-2 border border-line flex items-center justify-center font-bold text-[10.5px] text-ink uppercase">
                        {cl.av}
                      </span>
                      <span className="font-bold text-ink">{cl.name}</span>
                    </td>
                    <td className="px-4.5 py-3.5 text-mut">{cl.type}</td>
                    <td className="px-4.5 py-3.5 text-right font-mono text-[13px]">${Math.round(val).toLocaleString("en-AU")}</td>
                    <td className="px-4.5 py-3.5 text-center">
                      <span className={`pill text-[10.5px] font-bold rounded-full px-2 py-0.5 ${bidCount > 0 ? "bg-green-bg text-green-d" : "bg-paper-2 text-mut"}`}>
                        {bidCount} bids
                      </span>
                    </td>
                    <td className="px-4.5 py-3.5 text-right text-mut font-mono">{cl.s708}</td>
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
