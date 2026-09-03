"use client";

import React, { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type {
  AccountRow,
  MergeRequestRow,
  ClaimRequestRow,
} from "@/lib/data/queries";
import { ACCOUNT_TYPES } from "@/lib/data/discovery";
import {
  createAccount,
  requestAccountMerge,
  requestAccountClaim,
} from "@/app/actions/accounts";
import { accountNumberProblem } from "@/lib/accounts/account-number";

function s708Label(iso: string | null): string {
  if (!iso) return "Verification pending";
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-AU", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

const statusPill: Record<string, string> = {
  pending: "bg-amber-bg text-amber-d",
  approved: "bg-green-bg text-green-d",
  rejected: "bg-loss-bg text-loss-d",
};

export function AccountsClient({
  accounts,
  requests,
  claims,
}: {
  accounts: AccountRow[];
  requests: MergeRequestRow[];
  claims: ClaimRequestRow[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Create form
  const [label, setLabel] = useState("");
  const [type, setType] = useState<string>(ACCOUNT_TYPES[0]);
  const [createErr, setCreateErr] = useState<string | null>(null);

  // Claim form — add an account that already exists, by its broker number.
  const [claimNumber, setClaimNumber] = useState("");
  const [claimNote, setClaimNote] = useState("");
  const [claimErr, setClaimErr] = useState<string | null>(null);
  const [claimOk, setClaimOk] = useState<string | null>(null);

  // Merge form
  const [sourceId, setSourceId] = useState(accounts[0]?.id ?? "");
  const [targetId, setTargetId] = useState(accounts[1]?.id ?? "");
  const [note, setNote] = useState("");
  const [mergeErr, setMergeErr] = useState<string | null>(null);

  const run = (fn: () => Promise<void>, onErr: (m: string) => void) => {
    startTransition(async () => {
      try {
        await fn();
        router.refresh();
      } catch (e) {
        onErr(e instanceof Error ? e.message : "Something went wrong");
      }
    });
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    setCreateErr(null);
    run(async () => {
      await createAccount(label, type);
      setLabel("");
    }, setCreateErr);
  };

  const handleMerge = (e: React.FormEvent) => {
    e.preventDefault();
    setMergeErr(null);
    run(async () => {
      await requestAccountMerge(sourceId, targetId, note);
      setNote("");
    }, setMergeErr);
  };

  const handleClaim = (e: React.FormEvent) => {
    e.preventDefault();
    setClaimErr(null);
    setClaimOk(null);
    // Checked here only to save a round trip on an obviously empty box; the
    // action re-checks, because a form is not a security boundary.
    const problem = accountNumberProblem(claimNumber);
    if (problem) {
      setClaimErr(problem);
      return;
    }
    run(async () => {
      await requestAccountClaim(claimNumber, claimNote);
      setClaimNumber("");
      setClaimNote("");
      setClaimOk("Sent to the Vitti desk. They will verify it against the broker record.");
    }, setClaimErr);
  };

  const labelOf = (id: string) => accounts.find((a) => a.id === id)?.label ?? "";

  return (
    <div className="space-y-5 text-ink font-body">
      <div className="select-none">
        <div className="font-mono text-xs tracking-wider uppercase text-mut">Account management</div>
        <h1 className="font-disp font-medium text-[26px] mt-0.5">Your accounts</h1>
        <p className="text-xs text-mut mt-1">
          Add an account you already hold, open a new one, or request to merge two of your
          accounts. Adding and merging both need Vitti desk approval.
        </p>
      </div>

      {/* Accounts list */}
      <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
        <div className="px-4.5 py-3.5 border-b border-line select-none">
          <b className="text-sm font-semibold text-ink">Accounts ({accounts.length})</b>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs font-medium">
            <thead>
              <tr className="border-b border-line text-mut select-none">
                <th className="px-4.5 py-2.5">Account</th>
                {/* The number is what a client quotes to add another account,
                    so it belongs on the screen where they do that. */}
                <th className="px-4.5 py-2.5">Number</th>
                <th className="px-4.5 py-2.5">Structure</th>
                <th className="px-4.5 py-2.5 text-right">Cash</th>
                <th className="px-4.5 py-2.5">s708 certificate</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#f0ede5]">
              {accounts.map((a) => (
                <tr key={a.id} className="hover:bg-[#faf9f5]">
                  <td className="px-4.5 py-3 font-semibold text-ink">{a.label}</td>
                  <td className="px-4.5 py-3 font-mono text-mut whitespace-nowrap">
                    {a.externalRef ?? "—"}
                  </td>
                  <td className="px-4.5 py-3 text-mut">{a.accountType}</td>
                  <td className="px-4.5 py-3 text-right font-mono whitespace-nowrap">
                    ${a.cash.toLocaleString("en-AU")} {a.currency}
                  </td>
                  <td className="px-4.5 py-3">
                    <span className={a.s708Expiry ? "text-mut" : "text-amber-d font-semibold"}>
                      {s708Label(a.s708Expiry)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-5">
        {/* Claim an existing account, by its broker number */}
        <form
          onSubmit={handleClaim}
          className="card bg-white border border-line rounded-[14px] shadow-shadow p-5 space-y-4"
        >
          <b className="text-sm font-semibold text-ink block select-none">
            Add an account you already hold
          </b>
          <div className="space-y-1">
            <label htmlFor="claim-number" className="block text-xs font-semibold text-ink">
              Account number
            </label>
            <input
              id="claim-number"
              value={claimNumber}
              onChange={(e) => setClaimNumber(e.target.value)}
              placeholder="e.g. 1102004"
              // `inputMode` rather than `type="number"`: not every account
              // number is numeric ('PLACEVITT'), and a number input would also
              // add spinners and swallow a leading zero.
              inputMode="text"
              autoComplete="off"
              required
              className="w-full border border-line-2 bg-white rounded-[9px] px-3 py-2.5 text-sm font-mono focus:border-green focus:outline-none"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="claim-note" className="block text-xs font-semibold text-ink">
              Note to the desk (optional)
            </label>
            <textarea
              id="claim-note"
              value={claimNote}
              onChange={(e) => setClaimNote(e.target.value)}
              placeholder="e.g. this is our unit trust account"
              className="w-full border border-line-2 bg-white rounded-[9px] px-3 py-2 text-xs min-h-16 focus:border-green focus:outline-none"
            />
          </div>
          <p className="text-[11.5px] text-mut leading-normal">
            Use the account number on your broker statement. The desk verifies it against the
            broker record before the account appears on your login — we never confirm or deny an
            account number here.
          </p>
          {claimErr && (
            <p className="text-[12px] font-semibold text-loss-d bg-loss-bg rounded-[8px] px-3 py-2">{claimErr}</p>
          )}
          {claimOk && (
            <p className="text-[12px] font-semibold text-green-d bg-green-bg rounded-[8px] px-3 py-2">{claimOk}</p>
          )}
          <button
            type="submit"
            disabled={isPending}
            className="w-full btn bg-green text-[#08130e] hover:shadow-lg rounded-[10px] py-2.5 text-[13px] font-semibold cursor-pointer disabled:opacity-60"
          >
            Request access
          </button>
        </form>

        {/* Create account */}
        <form
          onSubmit={handleCreate}
          className="card bg-white border border-line rounded-[14px] shadow-shadow p-5 space-y-4"
        >
          <b className="text-sm font-semibold text-ink block select-none">Open a new account</b>
          <div className="space-y-1">
            <label className="block text-xs font-semibold text-ink">Account label</label>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Family Trust"
              required
              className="w-full border border-line-2 bg-white rounded-[9px] px-3 py-2.5 text-sm focus:border-green focus:outline-none"
            />
          </div>
          <div className="space-y-1">
            <label className="block text-xs font-semibold text-ink">Structure</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="w-full border border-line-2 bg-white rounded-[9px] px-3 py-2.5 text-sm focus:border-green focus:outline-none"
            >
              {ACCOUNT_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <p className="text-[11.5px] text-mut leading-normal">
            New accounts start empty; your s708 certificate will be verified by the desk before you can bid.
          </p>
          {createErr && (
            <p className="text-[12px] font-semibold text-loss-d bg-loss-bg rounded-[8px] px-3 py-2">{createErr}</p>
          )}
          <button
            type="submit"
            disabled={isPending}
            className="w-full btn bg-navy text-white hover:bg-slate-800 rounded-[10px] py-2.5 text-[13px] font-semibold cursor-pointer disabled:opacity-60"
          >
            Create account
          </button>
        </form>

        {/* Request merge */}
        <form
          onSubmit={handleMerge}
          className="card bg-white border border-line rounded-[14px] shadow-shadow p-5 space-y-4"
        >
          <b className="text-sm font-semibold text-ink block select-none">Request an account merge</b>
          {accounts.length < 2 ? (
            <p className="text-xs text-mut">You need at least two accounts to request a merge.</p>
          ) : (
            <>
              <div className="space-y-1">
                <label className="block text-xs font-semibold text-ink">Merge this account…</label>
                <select
                  value={sourceId}
                  onChange={(e) => setSourceId(e.target.value)}
                  className="w-full border border-line-2 bg-white rounded-[9px] px-3 py-2.5 text-sm focus:border-green focus:outline-none"
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.label}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className="block text-xs font-semibold text-ink">…into this account</label>
                <select
                  value={targetId}
                  onChange={(e) => setTargetId(e.target.value)}
                  className="w-full border border-line-2 bg-white rounded-[9px] px-3 py-2.5 text-sm focus:border-green focus:outline-none"
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.label}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className="block text-xs font-semibold text-ink">Note to the desk (optional)</label>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  className="w-full border border-line-2 bg-white rounded-[9px] px-3 py-2 text-xs min-h-16 focus:border-green focus:outline-none"
                />
              </div>
              <p className="text-[11.5px] text-mut leading-normal">
                On approval, <b>{labelOf(sourceId)}</b>&apos;s holdings, cash and bids move into{" "}
                <b>{labelOf(targetId)}</b>, and {labelOf(sourceId)} is closed.
              </p>
              {mergeErr && (
                <p className="text-[12px] font-semibold text-loss-d bg-loss-bg rounded-[8px] px-3 py-2">{mergeErr}</p>
              )}
              <button
                type="submit"
                disabled={isPending || sourceId === targetId}
                className="w-full btn bg-green text-[#08130e] hover:shadow-lg rounded-[10px] py-2.5 text-[13px] font-semibold cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
              >
                Request merge
              </button>
            </>
          )}
        </form>
      </div>

      {/* Account requests (claims) history */}
      <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
        <div className="px-4.5 py-3.5 border-b border-line select-none">
          <b className="text-sm font-semibold text-ink">Requests to add an account</b>
        </div>
        <div className="divide-y divide-line">
          {claims.length === 0 ? (
            <div className="text-center text-mut py-8 text-xs select-none">
              No requests yet.
            </div>
          ) : (
            claims.map((c) => (
              <div
                key={c.id}
                className="p-4 flex justify-between items-start gap-4 text-xs"
              >
                <div className="min-w-0">
                  <div className="font-semibold text-ink font-mono">{c.accountNumber}</div>
                  {c.note && <p className="text-mut text-[11.5px] mt-0.5">{c.note}</p>}
                  <div className="text-[10.5px] font-mono text-mut mt-1">
                    Requested{" "}
                    {new Date(c.requestedAt).toLocaleDateString("en-AU", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                    {c.decidedBy && ` · ${c.status} by ${c.decidedBy}`}
                  </div>
                  {/* Only ever the desk's own words. A rejection reason the desk
                      did not write would be this screen guessing on their
                      behalf about somebody's account. */}
                  {c.decisionNote && (
                    <p className="text-mut text-[11.5px] mt-1 leading-normal">
                      {c.decisionNote}
                    </p>
                  )}
                </div>
                <span
                  className={`pill text-[10px] font-bold px-2.5 py-1 rounded-full capitalize flex-none ${statusPill[c.status] ?? "bg-paper-2 text-mut"}`}
                >
                  {c.status}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Merge requests history */}
      <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
        <div className="px-4.5 py-3.5 border-b border-line select-none">
          <b className="text-sm font-semibold text-ink">Merge requests</b>
        </div>
        <div className="divide-y divide-line">
          {requests.length === 0 ? (
            <div className="text-center text-mut py-8 text-xs select-none">No merge requests yet.</div>
          ) : (
            requests.map((r) => (
              <div key={r.id} className="p-4 flex justify-between items-center gap-4 text-xs">
                <div>
                  <div className="font-semibold text-ink">
                    {r.sourceLabel} <span className="text-mut">→</span> {r.targetLabel}
                  </div>
                  {r.note && <p className="text-mut text-[11.5px] mt-0.5">{r.note}</p>}
                  <div className="text-[10.5px] font-mono text-mut mt-1">
                    Requested {new Date(r.requestedAt).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })}
                    {r.decidedBy && ` · ${r.status} by ${r.decidedBy}`}
                  </div>
                </div>
                <span className={`pill text-[10px] font-bold px-2.5 py-1 rounded-full capitalize ${statusPill[r.status] ?? "bg-paper-2 text-mut"}`}>
                  {r.status}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
