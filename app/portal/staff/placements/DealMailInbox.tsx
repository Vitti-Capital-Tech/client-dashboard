"use client";

import React, { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { PlacementCandidateRow } from "@/lib/data/placement-candidates";
import {
  promoteCandidate,
  dismissCandidate,
  PLACEMENT_TYPES,
  type PlacementType,
} from "@/app/actions/placements";

/**
 * The deal-mail inbox: placements and IPOs the broker mail told us about.
 *
 * These are NOT deals yet. The upstream feed carries a ticker, a subject line
 * and a written summary; it carries no price, no raise size and no minimum bid
 * — the three things a bid is measured against. So a candidate cannot become a
 * biddable placement on its own, and the form below is where those terms are
 * supplied by a person who knows them.
 *
 * That is the whole reason this is a queue rather than an automatic import.
 * Defaulting the missing terms to zero would put a live deal in front of the
 * desk with a $0 minimum — which does not read as broken, it just accepts the
 * wrong money.
 */

const fmtWhen = (iso: string): string =>
  new Date(iso).toLocaleString("en-AU", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });

/** Empty rather than zero: a blank asks to be filled, a 0 looks answered. */
type FormState = {
  code: string;
  name: string;
  type: PlacementType;
  price: string;
  raiseMillions: string;
  minBid: string;
  opts: string;
  closeDate: string;
};

export function DealMailInbox({ candidates }: { candidates: PlacementCandidateRow[] }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [openId, setOpenId] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [showDecided, setShowDecided] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);

  const pending = candidates.filter((c) => !c.placementId && !c.dismissedAt);
  const decided = candidates.filter((c) => c.placementId || c.dismissedAt);

  const startPromote = (c: PlacementCandidateRow) => {
    setNote(null);
    setOpenId(c.id);
    setForm({
      // The ticker is the one term the mail DOES carry reliably, so it seeds the
      // code. Everything else starts blank on purpose.
      code: c.ticker,
      name: c.company && c.company !== c.ticker ? c.company : "",
      // The feed says `IPO`; this schema has no such value. `Pre-IPO` is the
      // nearest, and it is a default the operator can change rather than a
      // silent translation.
      type: c.dealType?.toLowerCase() === "ipo" ? "Pre-IPO" : "Placement",
      price: "",
      raiseMillions: "",
      minBid: "",
      opts: "",
      closeDate: "",
    });
  };

  const submitPromote = (candidateId: string) => {
    if (!form) return;
    setNote(null);
    startTransition(async () => {
      const res = await promoteCandidate(candidateId, {
        code: form.code,
        name: form.name,
        type: form.type,
        price: Number(form.price),
        raiseMillions: Number(form.raiseMillions) || 0,
        minBid: Number(form.minBid),
        opts: form.opts,
        closeDate: form.closeDate || null,
      });
      if (!res.ok) {
        setNote({ tone: "bad", text: res.error });
        return;
      }
      setOpenId(null);
      setForm(null);
      setNote({ tone: "ok", text: `${form.code.toUpperCase()} is now open for bids.` });
      router.refresh();
    });
  };

  const submitDismiss = (c: PlacementCandidateRow) => {
    const reason = window.prompt(`Why is ${c.ticker} not being offered?`) ?? "";
    setNote(null);
    startTransition(async () => {
      const res = await dismissCandidate(c.id, reason);
      if (!res.ok) {
        setNote({ tone: "bad", text: res.error });
        return;
      }
      router.refresh();
    });
  };

  const field = (k: keyof FormState) => ({
    value: form?.[k] ?? "",
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm((f) => (f ? { ...f, [k]: e.target.value } : f)),
    className:
      "w-full border border-line rounded-[8px] px-2 py-1.5 text-xs bg-white focus:border-mut outline-none",
  });

  return (
    <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden text-ink font-body">
      <div className="px-4.5 py-3.5 border-b border-line flex justify-between items-center gap-3 flex-wrap">
        <div>
          <b className="text-sm font-semibold text-ink">From the deal mail</b>
          <div className="text-[11px] text-mut mt-0.5">
            Placements and IPOs the broker mail announced. Promote one to open it for bids —
            the mail carries no price or minimum, so those are entered here.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-amber-bg text-amber-d">
            {pending.length} awaiting
          </span>
          {decided.length > 0 && (
            <button
              onClick={() => setShowDecided((s) => !s)}
              className="text-green-d font-semibold text-xs underline underline-offset-2 hover:opacity-85 cursor-pointer"
            >
              {showDecided ? "Hide decided" : `Decided (${decided.length})`}
            </button>
          )}
        </div>
      </div>

      {note && (
        <p
          className={`text-[12px] font-semibold px-4.5 py-2 ${
            note.tone === "bad" ? "text-loss-d bg-loss-bg" : "text-green-d bg-green-bg"
          }`}
        >
          {note.text}
        </p>
      )}

      <div className="divide-y divide-line">
        {pending.length === 0 ? (
          <div className="text-center text-mut py-8 text-xs select-none">
            Nothing awaiting a decision.
          </div>
        ) : (
          pending.map((c) => (
            <div key={c.id} className="p-4 text-xs space-y-2">
              <div className="flex justify-between items-start gap-3 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="code text-xs bg-paper-2 rounded-[5px] px-1.5 py-0.5 font-bold">
                      {c.ticker}
                    </span>
                    <span
                      className={`pill text-[10.5px] font-bold px-2 py-0.5 rounded-full ${
                        c.dealType?.toLowerCase() === "ipo"
                          ? "bg-[#ece9f3] text-[#5c5775]"
                          : "bg-green-bg text-green-d"
                      }`}
                    >
                      {c.dealType}
                    </span>
                    <span className="text-[10.5px] font-mono text-mut">
                      {fmtWhen(c.receivedAt)}
                    </span>
                  </div>
                  {c.subject && (
                    <div className="font-semibold text-ink mt-1 leading-snug">{c.subject}</div>
                  )}
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => (openId === c.id ? setOpenId(null) : startPromote(c))}
                    disabled={isPending}
                    className="btn bg-navy hover:bg-slate-800 text-white font-semibold px-3.5 py-1.5 rounded-[8px] cursor-pointer disabled:opacity-60"
                  >
                    {openId === c.id ? "Cancel" : "Promote"}
                  </button>
                  <button
                    onClick={() => submitDismiss(c)}
                    disabled={isPending}
                    className="btn bg-white border border-line text-mut hover:text-ink font-semibold px-3.5 py-1.5 rounded-[8px] cursor-pointer disabled:opacity-60"
                  >
                    Dismiss
                  </button>
                </div>
              </div>

              {c.summary && (
                <p className="text-mut leading-relaxed whitespace-pre-line text-[11.5px]">
                  {c.summary}
                </p>
              )}

              {openId === c.id && form && (
                <div className="border border-line rounded-[10px] p-3 bg-paper/50 space-y-3">
                  <div className="text-[11px] text-mut">
                    These terms are not in the mail. Enter them from the offer document —
                    a bid is measured against the price and the minimum, so neither can be guessed.
                  </div>
                  <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
                    <label className="space-y-1">
                      <span className="text-[10px] uppercase tracking-wider text-mut font-semibold">Code</span>
                      <input {...field("code")} />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[10px] uppercase tracking-wider text-mut font-semibold">Company</span>
                      <input {...field("name")} placeholder="Full name" />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[10px] uppercase tracking-wider text-mut font-semibold">Type</span>
                      <select
                        value={form.type}
                        onChange={(e) =>
                          setForm((f) => (f ? { ...f, type: e.target.value as PlacementType } : f))
                        }
                        className="w-full border border-line rounded-[8px] px-2 py-1.5 text-xs bg-white focus:border-mut outline-none"
                      >
                        {PLACEMENT_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {t}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-1">
                      <span className="text-[10px] uppercase tracking-wider text-mut font-semibold">
                        Price / share
                      </span>
                      <input {...field("price")} type="number" step="0.0001" placeholder="0.145" />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[10px] uppercase tracking-wider text-mut font-semibold">
                        Raise ($m)
                      </span>
                      <input {...field("raiseMillions")} type="number" step="0.01" placeholder="12" />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[10px] uppercase tracking-wider text-mut font-semibold">
                        Min bid ($)
                      </span>
                      <input {...field("minBid")} type="number" step="1" placeholder="10000" />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[10px] uppercase tracking-wider text-mut font-semibold">
                        Close date
                      </span>
                      <input {...field("closeDate")} type="date" />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[10px] uppercase tracking-wider text-mut font-semibold">
                        Attaching options
                      </span>
                      <input {...field("opts")} placeholder="1 free option (1:2)" />
                    </label>
                  </div>
                  <button
                    onClick={() => submitPromote(c.id)}
                    disabled={isPending}
                    className="btn bg-green text-[#08130e] font-semibold px-3.5 py-1.5 rounded-[8px] cursor-pointer disabled:opacity-60"
                  >
                    {isPending ? "Opening…" : "Open for bids"}
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {showDecided && decided.length > 0 && (
        <div className="divide-y divide-line border-t border-line bg-paper/40">
          {decided.map((c) => (
            <div key={c.id} className="px-4 py-2.5 text-xs flex justify-between items-center gap-3">
              <div className="min-w-0">
                <span className="code text-[11px] bg-paper-2 rounded-[5px] px-1.5 py-0.5 font-bold">
                  {c.ticker}
                </span>
                <span className="text-mut ml-2 truncate">{c.subject}</span>
              </div>
              <span
                className={`text-[10.5px] font-bold px-2 py-0.5 rounded-full shrink-0 ${
                  c.placementId ? "bg-green-bg text-green-d" : "bg-paper-2 text-mut"
                }`}
                title={c.dismissReason ?? undefined}
              >
                {c.placementId ? `Promoted by ${c.promotedBy ?? "staff"}` : "Dismissed"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
