"use client";

import React, { useState, useEffect } from "react";
import { useDatabaseStore } from "@/store/useDatabaseStore";
import { Placement } from "@/lib/db";

import { useShallow } from "zustand/react/shallow";

export default function ClientPlacementsPage() {
  const clientId = useDatabaseStore(state => state.clientId);
  const placeBid = useDatabaseStore(state => state.placeBid);
  const withdrawBid = useDatabaseStore(state => state.withdrawBid);
  const notifyBpayPayment = useDatabaseStore(state => state.notifyBpayPayment);
  const db = useDatabaseStore(state => state.db);
  const [selectedDealId, setSelectedDealId] = useState<string | null>(null);
  
  // Bid form inputs
  const [bidAmount, setBidAmount] = useState("25,000");
  const [agreeTerms, setAgreeTerms] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [countdown, setCountdown] = useState("closes 4:00:00");

  const openPlacements = db.placements.filter(p => p.stage === "open" || p.stage === "upcoming");
  const myPlacements = db.placements.filter(p => p.bids.some(b => b.c === clientId));

  // Live countdown timer for the book close (closes 4:00pm)
  useEffect(() => {
    const timer = setInterval(() => {
      const now = new Date();
      const close = new Date();
      close.setHours(16, 0, 0, 0);
      const diff = Math.max(0, close.getTime() - now.getTime());
      
      if (diff === 0) {
        setCountdown("closed");
      } else {
        const h = Math.floor(diff / 3600000);
        const m = Math.floor((diff % 3600000) / 60000);
        const s = Math.floor((diff % 60000) / 1000);
        setCountdown(`closes ${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`);
      }
    }, 1000);

    return () => clearInterval(timer);
  }, []);

  const getSponsorBadge = (stage: string) => {
    if (stage === "open") {
      return (
        <span className="pill live bg-green-bg text-green-d text-[11px] font-bold px-2 py-0.5 rounded-full inline-flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-green" /> Live
        </span>
      );
    }
    return (
      <span className="pill bg-paper-2 text-mut text-[11px] font-bold px-2 py-0.5 rounded-full">
        Upcoming
      </span>
    );
  };

  const handleOpenDeal = (id: string) => {
    const p = db.placements.find(x => x.id === id);
    if (!p) return;
    setSelectedDealId(id);
    
    // Autofill amount if bid exists
    const bid = p.bids.find(b => b.c === clientId);
    if (bid) {
      setBidAmount(bid.amount.toLocaleString("en-AU"));
    } else {
      setBidAmount("25,000");
    }
    setAgreeTerms(false);
  };

  const handlePlaceBidReview = () => {
    const p = db.placements.find(x => x.id === selectedDealId);
    if (!p) return;
    const raw = bidAmount.replace(/[^0-9]/g, "");
    const amt = raw ? parseInt(raw, 10) : 0;
    if (amt < p.min) {
      alert(`Minimum bid is $${p.min.toLocaleString("en-AU")}`);
      return;
    }
    setShowConfirmModal(true);
  };

  const handleConfirmBid = () => {
    if (!selectedDealId) return;
    const raw = bidAmount.replace(/[^0-9]/g, "");
    const amt = raw ? parseInt(raw, 10) : 0;
    
    placeBid(selectedDealId, amt);
    setShowConfirmModal(false);
    alert(`Bid of $${amt.toLocaleString("en-AU")} placed successfully.`);
  };

  const handleWithdrawBid = () => {
    if (!selectedDealId) return;
    const p = db.placements.find(x => x.id === selectedDealId);
    if (!p) return;
    
    if (confirm(`Are you sure you want to withdraw your bid on ${p.name}?`)) {
      withdrawBid(selectedDealId);
      setSelectedDealId(null);
      alert("Bid withdrawn.");
    }
  };

  const handleBpayPayment = () => {
    if (!selectedDealId) return;
    notifyBpayPayment(selectedDealId);
    alert("Payment notification submitted to the Vitti desk.");
  };

  // Render Placement Detailed Bidding Form
  const renderBiddingForm = (p: Placement, hasBid: boolean) => {
    const raw = bidAmount.replace(/[^0-9]/g, "");
    const amt = raw ? parseInt(raw, 10) : 0;
    const sharesCount = Math.round(amt / p.price);
    const isValid = amt >= p.min;

    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 select-none">
          <button 
            onClick={() => setSelectedDealId(null)}
            className="text-green-d font-semibold text-sm underline underline-offset-2 cursor-pointer hover:opacity-85"
          >
            &larr; Placements
          </button>
        </div>

        <div className="flex justify-between items-end gap-3 flex-wrap">
          <div>
            <h1 className="font-disp font-medium text-2xl text-ink">
              {p.name} <span className="font-mono text-sm font-normal text-mut uppercase ml-1">ASX: {p.code}</span>
            </h1>
          </div>
          <span className="pill live bg-green-bg text-green-d text-xs font-bold py-1.5 px-3 rounded-full font-mono">
            {countdown}
          </span>
        </div>

        <div className="grid md:grid-cols-3 gap-4">
          <div className="md:col-span-2 space-y-4">
            {/* KPI Cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="card bg-white border border-line rounded-[14px] p-3 shadow-shadow select-none">
                <div className="text-[10px] uppercase font-mono tracking-wider text-mut">Offer price</div>
                <div className="font-mono font-bold text-[18px] text-ink mt-0.5">${p.price.toFixed(2)}</div>
              </div>
              <div className="card bg-white border border-line rounded-[14px] p-3 shadow-shadow select-none">
                <div className="text-[10px] uppercase font-mono tracking-wider text-mut">Discount</div>
                <div className="font-mono font-bold text-[18px] text-gain mt-0.5">+{p.disc}%</div>
                <div className="text-[9.5px] text-mut mt-0.5">to last close</div>
              </div>
              <div className="card bg-white border border-line rounded-[14px] p-3 shadow-shadow select-none">
                <div className="text-[10px] uppercase font-mono tracking-wider text-mut">Raise size</div>
                <div className="font-mono font-bold text-[18px] text-ink mt-0.5">${p.raise}m</div>
              </div>
              <div className="card bg-white border border-line rounded-[14px] p-3 shadow-shadow select-none">
                <div className="text-[10px] uppercase font-mono tracking-wider text-mut">Minimum</div>
                <div className="font-mono font-bold text-[18px] text-ink mt-0.5">${p.min.toLocaleString("en-AU")}</div>
              </div>
            </div>

            {/* Terms Description */}
            <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow space-y-3">
              <div className="flex justify-between items-center select-none">
                <b className="text-sm font-semibold text-ink">Terms</b>
                <span className="pill text-[11px] font-bold bg-[#ece9f3] text-[#5c5775] px-2.5 py-0.5 rounded-full">
                  Wholesale s708
                </span>
              </div>
              <p className="text-xs text-mut leading-relaxed">
                New fully paid ordinary shares at ${p.price.toFixed(2)}, a {p.disc}% discount to last close of ${(p.last || 0).toFixed(2)}.{" "}
                {p.opts !== "None" ? `Includes ${p.opts.toLowerCase()}. ` : ""}Lead manager: Vitti Capital.
              </p>
              
              <table className="w-full border-collapse text-xs text-ink leading-relaxed">
                <tbody className="divide-y divide-[#f0ede5] font-medium">
                  <tr>
                    <td className="py-2 text-mut font-semibold">Bids close</td>
                    <td className="py-2 text-right font-mono">
                      {p.closeDate.toLocaleDateString("en-AU", { day: "numeric", month: "short" })} &middot; 4:00pm
                    </td>
                  </tr>
                  <tr>
                    <td className="py-2 text-mut font-semibold">Allocations</td>
                    <td className="py-2 text-right font-mono">
                      {p.allocDate.toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
                    </td>
                  </tr>
                  <tr>
                    <td className="py-2 text-mut font-semibold">Settlement</td>
                    <td className="py-2 text-right font-mono">
                      {p.settleDate.toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
                    </td>
                  </tr>
                  <tr>
                    <td className="py-2 text-mut font-semibold">Allotment</td>
                    <td className="py-2 text-right font-mono">
                      {p.allotDate.toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Vitti Research Teaser */}
            <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow space-y-2 select-none">
              <div className="flex justify-between items-center text-xs">
                <b className="text-sm font-semibold text-ink">Vitti research</b>
                <span className="text-mut-d font-mono">Spec buy &middot; TP $0.78</span>
              </div>
              <p className="text-xs text-ink font-semibold">{p.code} initiation — drilling the Pilbara&apos;s quiet corner</p>
              <button 
                onClick={() => alert("Morning note PDF would open in a new tab.")}
                className="btn ghost sm text-[11px] py-1.5 px-3 border border-line rounded-lg hover:border-mut cursor-pointer transition-colors"
              >
                Read the note
              </button>
            </div>
          </div>

          {/* Place Bid Widget */}
          <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow h-fit space-y-4">
            <b className="text-sm font-semibold text-ink block select-none">Place your bid</b>
            
            <div className="space-y-1">
              <label className="block text-xs font-semibold text-ink select-none">Bid amount (AUD)</label>
              <input
                type="text"
                value={bidAmount}
                onChange={e => setBidAmount(e.target.value.replace(/[^0-9,]/g, ""))}
                className="w-full border border-line-2 bg-white rounded-[9px] px-3.5 py-2.5 font-mono text-sm focus:border-green focus:outline-none"
              />
              <div className="text-[11.5px] text-mut mt-1">
                = {amt ? sharesCount.toLocaleString("en-AU") : "—"} shares
                {p.opts !== "None" && " + free attaching options"}
              </div>
              {!isValid && amt > 0 && (
                <div className="text-[11px] text-loss-d font-semibold select-none">
                  Minimum bid is ${p.min.toLocaleString("en-AU")}.
                </div>
              )}
            </div>

            <button
              onClick={handlePlaceBidReview}
              disabled={!isValid}
              className="w-full btn bg-green hover:shadow-lg hover:shadow-green-bg text-[#08130e] font-semibold py-2.5 rounded-[10px] text-xs cursor-pointer select-none transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none"
            >
              Review bid
            </button>

            <div className="space-y-1 pt-1.5 select-none">
              <div className="text-[11.5px] text-mut flex items-center gap-1.5">
                <span className="text-green-d font-bold">✓</span>
                <span>s708 verified &middot; expires {db.clients[clientId].s708}</span>
              </div>
              <div className="text-[11px] text-mut leading-normal">
                Amend or withdraw any time before the book closes.
              </div>
            </div>
          </div>
        </div>

        {/* Confirmation Modal */}
        {showConfirmModal && (
          <div className="fixed inset-0 bg-navy/55 backdrop-blur-[2px] z-50 flex items-center justify-center p-4.5">
            <div className="bg-white rounded-2xl max-w-110 w-full p-6 shadow-shadow-lg text-ink space-y-4" onClick={e => e.stopPropagation()}>
              <h3 className="font-disp font-medium text-lg text-ink">Confirm your bid</h3>
              <p className="text-xs text-mut">
                {p.name} &middot; {p.type} at ${p.price.toFixed(2)}
              </p>

              <div className="divide-y divide-line">
                <div className="flex justify-between py-2 text-xs">
                  <span className="text-mut font-semibold">Bid amount</span>
                  <b className="font-mono text-ink font-semibold">${amt.toLocaleString("en-AU")}</b>
                </div>
                <div className="flex justify-between py-2 text-xs">
                  <span className="text-mut font-semibold">Shares at ${p.price.toFixed(2)}</span>
                  <b className="font-mono text-ink font-semibold">{sharesCount.toLocaleString("en-AU")}</b>
                </div>
                <div className="flex justify-between py-2 text-xs">
                  <span className="text-mut font-semibold">Payment if fully allocated</span>
                  <b className="font-mono text-ink font-semibold">${amt.toLocaleString("en-AU")}.00</b>
                </div>
              </div>

              <label className="flex gap-2.5 items-start text-xs text-mut cursor-pointer select-none py-1">
                <input 
                  type="checkbox" 
                  checked={agreeTerms} 
                  onChange={e => setAgreeTerms(e.target.checked)} 
                  className="mt-1" 
                />
                <span>
                  I confirm I am a wholesale client (s708), I have read the term sheet, and I understand allocations may be scaled and are conditional on payment by settlement.
                </span>
              </label>

              <div className="flex gap-2.5 pt-2 select-none">
                <button 
                  onClick={() => setShowConfirmModal(false)}
                  className="btn border border-line rounded-[10px] py-2 px-4 hover:border-mut text-xs font-semibold cursor-pointer flex-1"
                >
                  Back
                </button>
                <button 
                  onClick={handleConfirmBid}
                  disabled={!agreeTerms}
                  className="btn bg-green text-[#08130e] hover:shadow-lg rounded-[10px] py-2 px-4 text-xs font-semibold cursor-pointer flex-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Place bid
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  // Render Deal Tracking timeline view
  const renderTrackingTimeline = (p: Placement, bid: typeof p.bids[0]) => {
    const isAllocated = bid.alloc !== null;
    const isPaid = bid._paid;
    const isSettled = p.stage === "settled";
    const closingText = p.stage === "open" ? `closes ${countdown}` : "closed";

    const timelineRow = (status: "done" | "now" | "todo", title: string, subtitle: React.ReactNode) => {
      const bulletColors = {
        done: "bg-green text-white",
        now: "bg-amber text-white font-bold",
        todo: "bg-white border-2 border-line-2 text-transparent"
      };
      return (
        <div className="tl-row">
          <div className="rail2">
            <div className={`node ${bulletColors[status] || ""}`}>
              {status === "done" ? "✓" : status === "now" ? "!" : ""}
            </div>
            <div className={`bar ${status === "done" ? "done" : ""}`} />
          </div>
          <div className="body select-none">
            <div className={`t ${status === "todo" ? "text-mut" : "text-ink"}`}>{title}</div>
            <div className="s">{subtitle}</div>
          </div>
        </div>
      );
    };

    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 select-none">
          <button 
            onClick={() => setSelectedDealId(null)}
            className="text-green-d font-semibold text-sm underline underline-offset-2 cursor-pointer hover:opacity-85"
          >
            &larr; Placements
          </button>
        </div>

        <div className="flex justify-between items-end gap-3 flex-wrap">
          <div>
            <h1 className="font-disp font-medium text-2xl text-ink">
              {p.name} <span className="font-mono text-sm font-normal text-mut uppercase ml-1">{p.code}</span>
            </h1>
          </div>
        </div>

        <div className="grid md:grid-cols-3 gap-4">
          <div className="md:col-span-2 space-y-4">
            {/* Timeline wrapper card */}
            <div className="card bg-white border border-line rounded-[14px] p-5 shadow-shadow">
              <div className="space-y-0.5">
                {timelineRow("done", "Bid placed", `${new Date(2026, 5, 12).toLocaleDateString("en-AU", { day: "numeric", month: "short" })} &middot; $${bid.amount.toLocaleString("en-AU")}`)}
                
                {timelineRow(
                  p.stage === "open" ? "now" : "done",
                  "Bids close",
                  `${p.closeDate.toLocaleDateString("en-AU", { day: "numeric", month: "short" })} &middot; 4:00pm${p.stage === "open" ? " · you can amend until then" : ""}`
                )}

                {timelineRow(
                  isAllocated ? "done" : (p.stage === "closed" ? "now" : "todo"),
                  isAllocated ? "Allocation confirmed" : "Allocation pending",
                  isAllocated 
                    ? `${p.allocDate.toLocaleDateString("en-AU", { day: "numeric", month: "short" })} &middot; ${bid.alloc === 0 ? "nil allocation" : (bid.alloc! < bid.amount ? `scaled to ${Math.round(bid.alloc! / bid.amount * 100)}%` : "filled in full")}`
                    : `Expected ${p.allocDate.toLocaleDateString("en-AU", { day: "numeric", month: "short" })}`
                )}

                {/* Conditional Payment step */}
                {bid.alloc! > 0 && (
                  <div className="tl-row">
                    <div className="rail2">
                      <div className={`node font-bold ${isPaid ? "bg-green text-white" : "bg-amber text-white"}`}>
                        {isPaid ? "✓" : "$"}
                      </div>
                      <div className={`bar ${isPaid ? "done" : ""}`} />
                    </div>
                    <div className="body">
                      <div className="t font-semibold text-ink">{isPaid ? "Payment received" : "Payment due"}</div>
                      <div className="s text-xs text-mut leading-normal">
                        {isPaid 
                          ? "Confirmed by the Vitti desk" 
                          : `By ${p.settleDate.toLocaleDateString("en-AU", { day: "numeric", month: "short" })} &middot; $${bid.alloc!.toLocaleString("en-AU")}`}
                      </div>
                      
                      {!isPaid && (
                        <div className="card border border-line bg-paper p-3.5 rounded-xl shadow-none mt-2 max-w-90 space-y-2 select-none">
                          <div className="divide-y divide-line text-xs leading-normal">
                            <div className="flex justify-between py-1.5">
                              <span className="text-mut">Amount</span>
                              <b className="font-mono text-ink">${bid.alloc!.toLocaleString("en-AU")}.00</b>
                            </div>
                            <div className="flex justify-between py-1.5">
                              <span className="text-mut">BPAY biller</span>
                              <b className="font-mono text-ink">254312</b>
                            </div>
                            <div className="flex justify-between py-1.5">
                              <span className="text-mut">Reference</span>
                              <b className="font-mono text-ink">9920 4471 02</b>
                            </div>
                          </div>
                          <button 
                            onClick={handleBpayPayment}
                            className="w-full btn bg-navy text-white hover:bg-slate-800 font-semibold py-2 rounded-lg text-xs cursor-pointer"
                          >
                            I&apos;ve paid — notify Vitti
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Settle timeline segment */}
                {bid.alloc! !== 0 && timelineRow(
                  isSettled ? "done" : "todo",
                  "Settlement",
                  p.settleDate.toLocaleDateString("en-AU", { day: "numeric", month: "short" })
                )}

                {/* Allotment segment */}
                {bid.alloc! !== 0 && timelineRow(
                  isSettled ? "done" : "todo",
                  "Allotment & quotation",
                  `${p.allotDate.toLocaleDateString("en-AU", { day: "numeric", month: "short" })}${isSettled ? " · holding now in your portfolio" : " · holding appears in your portfolio"}`
                )}
              </div>
            </div>
          </div>

          {/* Right column: Manage & Advice */}
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3.5 select-none">
              <div className="card bg-white border border-line rounded-[14px] p-4 shadow-shadow">
                <div className="text-[10px] uppercase font-mono tracking-wider text-mut">You bid</div>
                <div className="font-mono font-bold text-[18px] text-ink mt-0.5">${bid.amount.toLocaleString("en-AU")}</div>
              </div>
              
              {isAllocated && bid.alloc! > 0 ? (
                <div className="card bg-green-bg border border-green rounded-[14px] p-4 shadow-shadow text-green-d">
                  <div className="text-[10px] uppercase font-mono tracking-wider">Allotted</div>
                  <div className="font-mono font-bold text-[18px] mt-0.5">${bid.alloc!.toLocaleString("en-AU")}</div>
                  <div className="text-[10px] font-semibold mt-0.5">{Math.round(bid.alloc! / bid.amount * 100)}% scale</div>
                </div>
              ) : (
                <div className="card bg-white border border-line rounded-[14px] p-4 shadow-shadow text-mut">
                  <div className="text-[10px] uppercase font-mono tracking-wider">Allotted</div>
                  <div className="font-bold text-[16px] mt-0.5">
                    {bid.alloc === 0 ? "Nil" : "Pending"}
                  </div>
                </div>
              )}
            </div>

            {/* Manage bid action */}
            {p.stage === "open" && (
              <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow space-y-2 select-none">
                <b className="text-xs font-semibold text-ink block">Manage bid</b>
                <div className="flex gap-2">
                  <button 
                    onClick={() => handleOpenDeal(p.id)}
                    className="btn ghost sm text-xs py-1.5 border border-line rounded-lg hover:border-mut cursor-pointer flex-1 bg-white font-semibold"
                  >
                    Amend
                  </button>
                  <button 
                    onClick={handleWithdrawBid}
                    className="btn ghost sm text-xs py-1.5 border border-line rounded-lg hover:border-mut cursor-pointer flex-1 bg-white font-semibold"
                  >
                    Withdraw
                  </button>
                </div>
              </div>
            )}

            {/* Desk Adviser Contact */}
            <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow space-y-3 select-none">
              <b className="text-xs font-semibold text-ink block">Need help?</b>
              <p className="text-xs text-mut leading-relaxed">
                Your adviser is S. Goyal. Message the desk for a reply within the trading day.
              </p>
              <button 
                onClick={() => alert("Secure adviser messaging would open here.")}
                className="w-full btn ghost sm text-xs font-semibold py-2 border border-line rounded-lg bg-white hover:border-mut cursor-pointer"
              >
                Message the desk
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // If a specific deal is selected, render the details subview
  if (selectedDealId) {
    const deal = db.placements.find(x => x.id === selectedDealId);
    if (deal) {
      const bid = deal.bids.find(b => b.c === clientId);
      if (bid) {
        return renderTrackingTimeline(deal, bid);
      }
      return renderBiddingForm(deal, false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Page Header */}
      <div>
        <div className="font-mono text-xs tracking-wider uppercase text-mut">Capital raises</div>
        <h1 className="font-disp font-medium text-[26px] mt-0.5 text-ink">Placements</h1>
      </div>

      {/* Open & Upcoming raises */}
      <div className="space-y-3">
        <div className="font-mono text-[11px] tracking-wider uppercase text-mut">Open &amp; Upcoming Deals</div>
        <div className="grid sm:grid-cols-2 gap-4">
          {openPlacements.map(p => {
            const hasBid = p.bids.some(b => b.c === clientId);
            const myPlacedBid = p.bids.find(b => b.c === clientId);
            
            return (
              <div 
                key={p.id}
                className={`card bg-white border rounded-[14px] p-4.5 shadow-shadow flex flex-col justify-between space-y-3.5 ${p.stage === "open" ? "border-green bg-green-bg/5" : "border-line"}`}
              >
                <div className="flex justify-between items-center select-none">
                  <b className="font-disp text-base font-semibold text-ink leading-tight">{p.name}</b>
                  {getSponsorBadge(p.stage)}
                </div>

                <div className="font-mono text-[11.5px] text-mut leading-none select-none">
                  ASX: {p.code} &middot; {p.type} 
                  {p.price ? ` &middot; $${p.price.toFixed(2)}` : ""}
                  {p.disc ? ` &middot; ${p.disc}% disc` : ""}
                </div>

                <div className="text-xs text-mut leading-normal select-none">
                  Raise ${p.raise}m &middot; min ${p.min.toLocaleString("en-AU")}
                  {p.opts !== "None" && ` &middot; ${p.opts}`}
                </div>

                <div className="font-mono text-[11px] text-mut select-none">
                  {p.stage === "open" 
                    ? `Closes ${p.closeDate.toLocaleDateString("en-AU", { day: "numeric", month: "short" })}` 
                    : `Opens ${p.closeDate.toLocaleDateString("en-AU", { day: "numeric", month: "short" })}`}
                </div>

                {myPlacedBid && (
                  <div>
                    <span className="pill bg-green-bg text-green-d text-[11px] font-semibold py-1 px-3.5 rounded-full select-none">
                      Your bid: ${myPlacedBid.amount.toLocaleString("en-AU")}
                    </span>
                  </div>
                )}

                <div className="pt-1.5 select-none">
                  <button
                    onClick={() => {
                      if (p.stage === "open") {
                        handleOpenDeal(p.id);
                      } else {
                        alert(`Interest registered. You will be notified the moment ${p.code} opens.`);
                      }
                    }}
                    className={`w-full btn font-semibold py-2 rounded-[10px] text-xs cursor-pointer select-none transition-all ${p.stage === "open" ? "bg-green text-[#08130e] hover:shadow-lg hover:shadow-green-bg" : "btn ghost border border-line bg-white hover:border-mut"}`}
                  >
                    {p.stage === "open" 
                      ? (myPlacedBid ? "View your bid" : "Review &amp; bid") 
                      : "Register interest"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Client's Bids & Allocations tracker table */}
      <div className="space-y-2 pt-2">
        <div className="font-mono text-[11px] tracking-wider uppercase text-mut">Your bids &amp; allocations</div>
        
        <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-[12.5px] font-medium">
              <thead>
                <tr className="border-b border-line text-mut select-none">
                  <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3">Deal</th>
                  <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right">Your bid</th>
                  <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right">Allotted</th>
                  <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 hidden sm:table-cell">Settlement</th>
                  <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f0ede5]">
                {myPlacements.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="text-center text-mut py-6">No bids recorded yet.</td>
                  </tr>
                ) : (
                  myPlacements.map(p => {
                    const bid = p.bids.find(b => b.c === clientId)!;
                    
                    let statusPill = <span className="pill bg-green-bg text-green-d text-[11px] font-bold py-1 px-2 rounded-full">Bid placed</span>;
                    if (bid.alloc === null) {
                      if (p.stage === "closed") {
                        statusPill = <span className="pill bg-amber-bg text-amber-d text-[11px] font-bold py-1 px-2 rounded-full">Awaiting allocation</span>;
                      }
                    } else if (bid.alloc === 0) {
                      statusPill = <span className="pill bg-loss-bg text-loss-d text-[11px] font-bold py-1 px-2 rounded-full">Nil allocation</span>;
                    } else if (p.stage === "settled") {
                      statusPill = <span className="pill bg-green-bg text-green-d text-[11px] font-bold py-1 px-2 rounded-full">Settled</span>;
                    } else {
                      statusPill = <span className="pill bg-amber-bg text-amber-d text-[11px] font-bold py-1 px-2 rounded-full">Payment due</span>;
                    }

                    return (
                      <tr 
                        key={p.id}
                        onClick={() => handleOpenDeal(p.id)}
                        className="hover:bg-[#faf9f5] cursor-pointer transition-colors"
                      >
                        <td className="px-4.5 py-3.5">
                          <span className="text-ink font-semibold">{p.code} &middot; {p.name}</span>
                          <div className="text-[10.5px] text-mut mt-0.5">{p.type}</div>
                        </td>
                        <td className="px-4.5 py-3.5 text-right font-mono">${bid.amount.toLocaleString("en-AU")}</td>
                        <td className="px-4.5 py-3.5 text-right font-mono">
                          {bid.alloc === null 
                            ? "—" 
                            : (bid.alloc === 0 
                                ? "Nil" 
                                : `$${bid.alloc.toLocaleString("en-AU")}${bid.alloc < bid.amount ? ` (${Math.round(bid.alloc / bid.amount * 100)}%)` : ""}`)}
                        </td>
                        <td className="px-4.5 py-3.5 hidden sm:table-cell font-mono text-[11.5px] text-mut">
                          {p.settleDate.toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
                        </td>
                        <td className="px-4.5 py-3.5 text-right">
                          {statusPill}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
