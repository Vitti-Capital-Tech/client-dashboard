"use client";

import React, { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { PlacementCandidateRow } from "@/lib/data/placement-candidates";
import type { AccountRow, ClientRow } from "@/lib/data/queries";
import { promoteCandidate, dismissCandidate } from "@/app/actions/placements";
import { PLACEMENT_TYPES, type PlacementType } from "@/lib/placements/deal-types";
import { parseSummaryTerms } from "@/lib/placements/summary-terms";

/**
 * The deal-mail inbox: placements and IPOs the broker mail told us about.
 *
 * These are NOT deals yet. The upstream feed carries no term FIELDS — a ticker,
 * a subject line and a written summary is all of it — so a candidate cannot
 * become a biddable placement on its own, and this form is where the terms are
 * supplied by a person who knows them.
 *
 * That is the whole reason this is a queue rather than an automatic import.
 * Defaulting the missing terms to zero would put a live deal in front of the
 * desk with a $0 minimum — which does not read as broken, it just accepts the
 * wrong money.
 *
 * The summary TEXT, though, opens with a labelled header the upstream writes for
 * every deal, and the price, raise and close date are in it. `parseSummaryTerms`
 * reads that so the form seeds itself instead of asking someone to retype what
 * is on the screen above them. Seeded fields are shaded and the minimum bid is
 * never one of them: a value read out of LLM prose is worth confirming, and the
 * figure a bid is accepted or rejected against stays typed by hand.
 *
 * The form also takes the FIRST BID — a client and a quantity — because that is
 * normally why the deal is being promoted at all. Optional, since a deal can be
 * opened before anyone has asked for stock, and it books through the same
 * `bookBidForAccount` path as the deal book so the bid is costed and
 * minimum-checked identically wherever it was entered.
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
  settleDate: string;
  /** The first bid. An account id, because that is where a bid lands. */
  accountId: string;
  /** In shares — the unit the desk is instructed in. */
  qty: string;
};

export function DealMailInbox({
  candidates,
  clients,
  accounts,
}: {
  candidates: PlacementCandidateRow[];
  clients: ClientRow[];
  /** Every account, for the first bid — a bid belongs to an account, not a client. */
  accounts: AccountRow[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [openId, setOpenId] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [showDecided, setShowDecided] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  /** Fields seeded from the mail and not yet touched — see `startPromote`. */
  const [fromMail, setFromMail] = useState<Set<keyof FormState>>(new Set());

  const pending = candidates.filter((c) => !c.placementId && !c.dismissedAt);
  const decided = candidates.filter((c) => c.placementId || c.dismissedAt);

  // Grouped by client name, since that is what the operator is looking for: they
  // are told "book Cameron in for 50,000", not an account id. The group is the
  // client and the options are their accounts, so a client holding an SMSF and a
  // personal account still has to say which one takes the stock.
  const byClient = clients
    .map((c) => ({ client: c, own: accounts.filter((a) => a.clientId === c.id) }))
    .filter((g) => g.own.length > 0);

  const startPromote = (c: PlacementCandidateRow) => {
    setNote(null);
    setOpenId(c.id);

    // The summary's own header carries most of the terms — see `summary-terms.ts`.
    // Read once, on open, so editing a field is never fighting a re-parse.
    const read = parseSummaryTerms(c.summary);

    setForm({
      // The ticker is the one term the FEED carries reliably, so it seeds the
      // code regardless of what the summary says.
      code: c.ticker,
      // The summary's `Company:` line gives the full registered name; the feed's
      // `company` is often just the ticker again.
      name: read.name ?? (c.company && c.company !== c.ticker ? c.company : ""),
      // The two classifications can disagree — a real GLL mail is `IPO` upstream
      // and `Placement` in its own summary header. The header sits beside the
      // price and the close date, so it wins; the feed is the fallback, and both
      // are only a default the operator can change.
      type:
        read.type ?? (c.dealType?.toLowerCase() === "ipo" ? "Pre-IPO" : "Placement"),
      price: read.price != null ? String(read.price) : "",
      raiseMillions: read.raiseMillions != null ? String(read.raiseMillions) : "",
      // Never seeded, on purpose. No real summary carries a minimum, and it is
      // the figure a bid is accepted or rejected against — so it stays the one
      // field a person has certainly looked at.
      minBid: "",
      opts: read.opts ?? "",
      closeDate: read.closeDate ?? "",
      settleDate: read.settleDate ?? "",
      accountId: "",
      qty: "",
    });

    // What was read rather than typed. The form marks these, because the summary
    // is LLM prose about an email: a value from it is worth confirming, and a
    // filled box that nobody checked is exactly what the empty ones prevented.
    setFromMail(
      new Set(
        (
          [
            read.name && "name",
            read.type && "type",
            read.price != null && "price",
            read.raiseMillions != null && "raiseMillions",
            read.opts && "opts",
            read.closeDate && "closeDate",
            read.settleDate && "settleDate",
          ] as (keyof FormState | false | undefined)[]
        ).filter((k): k is keyof FormState => Boolean(k)),
      ),
    );
  };

  const submitPromote = (candidateId: string) => {
    if (!form) return;
    setNote(null);
    const code = form.code.toUpperCase();
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
        settleDate: form.settleDate || null,
        // Both or neither: a quantity with nobody to book it for, or a client
        // with no quantity, is a half-finished instruction rather than a deal
        // opened without a bid.
        openingBid:
          form.accountId && Number(form.qty) > 0
            ? { accountId: form.accountId, qty: Number(form.qty) }
            : null,
      });
      if (!res.ok) {
        setNote({ tone: "bad", text: res.error });
        return;
      }
      setOpenId(null);
      setForm(null);
      // The deal opened either way — a bid that did not book says so plainly,
      // because it is now only fixable from the deal book.
      setNote(
        res.bidError
          ? {
              tone: "bad",
              text: `${code} is open for bids, but the bid did not book: ${res.bidError}`,
            }
          : {
              tone: "ok",
              text: res.bid
                ? `${code} is now open for bids · bid booked for $${res.bid.amount.toLocaleString("en-AU")}.`
                : `${code} is now open for bids.`,
            },
      );
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

  /** Editing a field is the operator taking ownership of it, so the mark clears. */
  const touch = (k: keyof FormState) =>
    setFromMail((s) => {
      if (!s.has(k)) return s;
      const next = new Set(s);
      next.delete(k);
      return next;
    });

  const field = (k: keyof FormState) => ({
    value: form?.[k] ?? "",
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      touch(k);
      setForm((f) => (f ? { ...f, [k]: e.target.value } : f));
    },
    title: fromMail.has(k)
      ? "Read from the deal mail — check it against the offer document."
      : undefined,
    className: `w-full border rounded-[8px] px-2 py-1.5 text-xs focus:border-mut outline-none ${
      fromMail.has(k) ? "border-amber-d/40 bg-amber-bg/50" : "border-line bg-white"
    }`,
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
                  {/* The copy changes with the parse, because the two situations
                      ask for different work: confirming read values, or entering
                      everything. Saying "these are not in the mail" over a filled
                      form would teach the operator to ignore this line. */}
                  <div className="text-[11px] text-mut">
                    {fromMail.size > 0 ? (
                      <>
                        <span className="rounded-[4px] bg-amber-bg/50 border border-amber-d/40 px-1 py-0.5">
                          Shaded
                        </span>{" "}
                        fields were read from the summary above — check them against the offer
                        document, since it is a written summary and not the offer itself. The
                        minimum bid is never in the mail, so it is always entered here.
                      </>
                    ) : (
                      <>
                        This summary carries no terms. Enter them from the offer document —
                        a bid is measured against the price and the minimum, so neither can
                        be guessed.
                      </>
                    )}
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
                        onChange={(e) => {
                          touch("type");
                          setForm((f) => (f ? { ...f, type: e.target.value as PlacementType } : f));
                        }}
                        title={
                          fromMail.has("type")
                            ? "Read from the deal mail — check it against the offer document."
                            : undefined
                        }
                        className={`w-full border rounded-[8px] px-2 py-1.5 text-xs focus:border-mut outline-none ${
                          fromMail.has("type")
                            ? "border-amber-d/40 bg-amber-bg/50"
                            : "border-line bg-white"
                        }`}
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
                      {/* Not a term a bid is measured against, which is why it may
                          stay blank — but the client portal counts the payment
                          down to it, so blank renders an em dash where clients
                          look for a date. */}
                      <span className="text-[10px] uppercase tracking-wider text-mut font-semibold">
                        Settlement
                      </span>
                      <input {...field("settleDate")} type="date" />
                    </label>
                    <label className="space-y-1">
                      <span className="text-[10px] uppercase tracking-wider text-mut font-semibold">
                        Attaching options
                      </span>
                      <input {...field("opts")} placeholder="1 free option (1:2)" />
                    </label>
                  </div>

                  {/* The first bid — deliberately below the grid and not in it.
                      Those fields are terms OF the offer; these two are what the
                      desk is doing about it, and the money is shown rather than
                      typed because the desk instructs in shares. */}
                  <div className="border-t border-line pt-3 space-y-2">
                    <div className="text-[11px] text-mut">
                      Booking the first bid is optional — leave the client blank to open the
                      deal now and take bids from the book later.
                    </div>
                    <div className="flex flex-wrap gap-2.5 items-end">
                      <label className="space-y-1 grow min-w-45">
                        <span className="text-[10px] uppercase tracking-wider text-mut font-semibold block">
                          Client (account)
                        </span>
                        <select
                          value={form.accountId}
                          onChange={(e) =>
                            setForm((f) => (f ? { ...f, accountId: e.target.value } : f))
                          }
                          className="w-full border border-line rounded-[8px] px-2 py-1.5 text-xs bg-white focus:border-mut outline-none"
                        >
                          <option value="">No bid yet</option>
                          {byClient.map(({ client, own }) => (
                            <optgroup key={client.id} label={client.name}>
                              {own.map((a) => (
                                <option key={a.id} value={a.id}>
                                  {client.name} · {a.label}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                      </label>
                      <label className="space-y-1">
                        <span className="text-[10px] uppercase tracking-wider text-mut font-semibold block">
                          Bid qty
                        </span>
                        <input
                          {...field("qty")}
                          type="number"
                          min="1"
                          step="1"
                          placeholder="shares"
                          className="w-32 border border-line rounded-[8px] px-2 py-1.5 text-xs bg-white focus:border-mut outline-none"
                        />
                      </label>
                      <div className="text-[11px] text-mut pb-2">
                        {Number(form.qty) > 0 && Number(form.price) > 0
                          ? `≈ $${(
                              Math.round(Number(form.qty) * Number(form.price) * 100) / 100
                            ).toLocaleString("en-AU")} at $${form.price}/share`
                          : "Costed at the price above once both are filled."}
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={() => submitPromote(c.id)}
                    disabled={isPending}
                    className="btn bg-green text-[#08130e] font-semibold px-3.5 py-1.5 rounded-[8px] cursor-pointer disabled:opacity-60"
                  >
                    {isPending
                      ? "Opening…"
                      : form.accountId && Number(form.qty) > 0
                        ? "Open for bids & book"
                        : "Open for bids"}
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
