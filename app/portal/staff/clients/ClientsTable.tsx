"use client";

import { useRouter } from "next/navigation";
import { setViewClient } from "@/app/actions/session";

export type ClientRegistryRow = {
  id: string;
  initials: string;
  name: string;
  accountType: string;
  value: number;
  bidCount: number;
  s708: string;
};

export function ClientsTable({ rows }: { rows: ClientRegistryRow[] }) {
  const router = useRouter();

  const open = (id: string) => {
    void setViewClient(id); // keep the session's view-client in sync
    router.push(`/portal/staff/clients/${id}`);
  };

  return (
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
            {rows.map((r) => (
              <tr
                key={r.id}
                onClick={() => open(r.id)}
                className="hover:bg-[#faf9f5] cursor-pointer transition-colors"
              >
                <td className="px-4.5 py-3.5 flex items-center gap-2">
                  <span className="w-6.5 h-6.5 rounded-full bg-paper-2 border border-line flex items-center justify-center font-bold text-[10.5px] text-ink uppercase">
                    {r.initials}
                  </span>
                  <span className="font-bold text-ink">{r.name}</span>
                </td>
                <td className="px-4.5 py-3.5 text-mut">{r.accountType}</td>
                <td className="px-4.5 py-3.5 text-right font-mono text-[13px]">${Math.round(r.value).toLocaleString("en-AU")}</td>
                <td className="px-4.5 py-3.5 text-center">
                  <span className={`pill text-[10.5px] font-bold rounded-full px-2 py-0.5 ${r.bidCount > 0 ? "bg-green-bg text-green-d" : "bg-paper-2 text-mut"}`}>
                    {r.bidCount} bids
                  </span>
                </td>
                <td className="px-4.5 py-3.5 text-right text-mut font-mono">{r.s708}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
