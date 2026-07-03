"use client";

import React, { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { MergeRequestRow } from "@/lib/data/queries";
import { decideAccountMerge } from "@/app/actions/accounts";

const statusPill: Record<string, string> = {
  pending: "bg-amber-bg text-amber-d",
  approved: "bg-green-bg text-green-d",
  rejected: "bg-loss-bg text-loss-d",
};

function fmt(iso: string): string {
  return new Date(iso).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function MergeRequestsClient({ requests }: { requests: MergeRequestRow[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const decide = (id: string, approve: boolean) => {
    setError(null);
    setBusyId(id);
    startTransition(async () => {
      try {
        await decideAccountMerge(id, approve);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Something went wrong");
      } finally {
        setBusyId(null);
      }
    });
  };

  const pending = requests.filter((r) => r.status === "pending");
  const decided = requests.filter((r) => r.status !== "pending");

  return (
    <div className="space-y-5 text-ink font-body">
      <div className="select-none">
        <div className="font-mono text-xs tracking-wider uppercase text-mut">Client account operations</div>
        <h1 className="font-disp font-medium text-[26px] mt-0.5">Account merge requests</h1>
        <p className="text-xs text-mut mt-1">
          Approving a merge moves the source account&apos;s holdings, cash and bids into the target and closes the source.
        </p>
      </div>

      {error && (
        <p className="text-[12px] font-semibold text-loss-d bg-loss-bg rounded-[8px] px-3 py-2">{error}</p>
      )}

      {/* Pending queue */}
      <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
        <div className="px-4.5 py-3.5 border-b border-line select-none">
          <b className="text-sm font-semibold text-ink">Awaiting decision ({pending.length})</b>
        </div>
        <div className="divide-y divide-line">
          {pending.length === 0 ? (
            <div className="text-center text-mut py-8 text-xs select-none">No pending requests.</div>
          ) : (
            pending.map((r) => (
              <div key={r.id} className="p-4 flex flex-wrap justify-between items-center gap-3 text-xs">
                <div>
                  <div className="font-semibold text-ink">
                    {r.clientName} · {r.sourceLabel} <span className="text-mut">→</span> {r.targetLabel}
                  </div>
                  {r.note && <p className="text-mut text-[11.5px] mt-0.5">{r.note}</p>}
                  <div className="text-[10.5px] font-mono text-mut mt-1">Requested {fmt(r.requestedAt)}</div>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => decide(r.id, true)}
                    disabled={isPending && busyId === r.id}
                    className="btn bg-green text-[#08130e] font-semibold px-3.5 py-1.5 rounded-[8px] cursor-pointer disabled:opacity-60"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => decide(r.id, false)}
                    disabled={isPending && busyId === r.id}
                    className="btn bg-white border border-line text-mut hover:text-ink font-semibold px-3.5 py-1.5 rounded-[8px] cursor-pointer disabled:opacity-60"
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Decided history */}
      {decided.length > 0 && (
        <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
          <div className="px-4.5 py-3.5 border-b border-line select-none">
            <b className="text-sm font-semibold text-ink">Decided</b>
          </div>
          <div className="divide-y divide-line">
            {decided.map((r) => (
              <div key={r.id} className="p-4 flex justify-between items-center gap-4 text-xs">
                <div>
                  <div className="font-semibold text-ink">
                    {r.clientName} · {r.sourceLabel} <span className="text-mut">→</span> {r.targetLabel}
                  </div>
                  <div className="text-[10.5px] font-mono text-mut mt-1">
                    {r.decidedAt ? fmt(r.decidedAt) : fmt(r.requestedAt)}
                    {r.decidedBy && ` · by ${r.decidedBy}`}
                  </div>
                </div>
                <span className={`pill text-[10px] font-bold px-2.5 py-1 rounded-full capitalize ${statusPill[r.status] ?? "bg-paper-2 text-mut"}`}>
                  {r.status}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
