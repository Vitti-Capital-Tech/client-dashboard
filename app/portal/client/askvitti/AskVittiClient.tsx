"use client";

import React, { useState, useEffect, useRef } from "react";
import type { OptionRow } from "@/lib/data/queries";
import { isITM } from "@/lib/data/compute";

interface Message {
  role: "user" | "ai";
  text: string;
  brief?: boolean;
}

export function AskVittiClient({
  clientName,
  pv,
  dpl,
  options,
  mrdBid,
}: {
  clientName: string;
  pv: number;
  dpl: number;
  options: OptionRow[];
  mrdBid: number | null;
}) {
  const pvVal = pv;
  const dplVal = dpl;

  const [messages, setMessages] = useState<Message[]>(() => [
    {
      role: "ai",
      text: `Good morning, ${clientName.split(" ")[0]}. I’m Vitti Intelligence. Here’s your briefing for Friday, 12 Jun 2026:`,
      brief: true
    },
    {
      role: "ai",
      text: `Your portfolio is $${Math.round(pvVal).toLocaleString("en-AU")} (${dplVal >= 0 ? "+" : ""}${(dplVal / pvVal * 100).toFixed(1)}% today). The MRD placement closes at 4:00pm, and one of your unlisted options is in the money inside its exercise window. Ask me anything below.`
    }
  ]);
  const [inputValue, setInputValue] = useState("");
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  // Scroll to bottom whenever messages list grows
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSendMessage = (text: string) => {
    const q = text.trim();
    if (!q) return;

    // Push User Message
    const updatedMessages = [...messages, { role: "user" as const, text: q }];
    setMessages(updatedMessages);

    // Calculate Response
    let ans = "I can help with your portfolio, your options and placements, watchlist names, and the daily market read. Try one of the suggestions, or ask about a specific holding.";

    const isPortfolio = /portfolio|how am i|doing today/i.test(q);
    const isWatch = /watch|this week|what.*look/i.test(q);
    const isMrd = /mrd|meridian|placement/i.test(q);
    const isOptions = /option|expiry|exercise|itm/i.test(q);

    if (isPortfolio) {
      ans = `Your portfolio is $${Math.round(pvVal).toLocaleString("en-AU")}, up $${Math.abs(Math.round(dplVal)).toLocaleString("en-AU")} (${dplVal >= 0 ? "+" : ""}${(dplVal / pvVal * 105).toFixed(1)}%) today. The lift is led by your materials names — PLS +2.1% and BHP +0.8%. Year to date you are tracking +6.4%, ahead of the ASX 200 at +5.4%. Nothing in your book needs action right now beyond the MRD book closing at 4:00pm.`;
    } else if (isWatch) {
      ans = `Three things this week: (1) the MRD placement closes today at 4:00pm — you have a live opportunity at a 15.3% discount. (2) Two of your options are inside their expiry window — Aurora (AURO) is in the money with 3 days to exercise, which is the one I would action first. (3) Aurora Biotech’s pre-IPO opens Monday; you flagged interest, so I will alert you when the book opens.`;
    } else if (isMrd) {
      const bidNote = mrdBid ? ` You have placed a bid of $${mrdBid.toLocaleString("en-AU")}.` : "";

      ans = `Meridian Resources (MRD) is raising $12.0m at $0.50, a 15.3% discount to the last close of $0.59, with one free attaching option per two shares. Our desk rates it a spec buy with a $0.78 target. Minimum bid is $10,000 and the book closes at 4:00pm today.${bidNote} Would you like to review this placement?`;
    } else if (isOptions) {
      const urgentOpts = options.filter(o => o.status === "open" && isITM(o) && o.dte <= 14);
      if (urgentOpts.length > 0) {
        const details = urgentOpts.map(o => `${o.code} (${o.dte}d left, strike $${o.strike.toFixed(2)})`).join(", ");
        ans = `You have ${urgentOpts.length} option${urgentOpts.length > 1 ? "s" : ""} in the money and close to expiry: ${details}. Unlisted options are not auto-exercised, so these are the ones to act on. Head over to the Options tab to lodge your instructions.`;
      } else {
        ans = "None of your options are both in the money and near expiry right now — your nearest is comfortably out of the window. I will alert you the moment that changes.";
      }
    }

    // Delay response slightly for natural feel
    setTimeout(() => {
      setMessages(prev => [...prev, { role: "ai" as const, text: ans }]);
    }, 450);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputValue.trim()) return;
    handleSendMessage(inputValue);
    setInputValue("");
  };

  const suggestedQuestions = [
    "How is my portfolio doing today?",
    "What should I watch this week?",
    "Tell me about the MRD placement",
    "Which of my options need attention?"
  ];

  return (
    <div className="space-y-4 max-w-190 mx-auto select-text flex flex-col min-h-[calc(100vh-140px)]">
      {/* Page Header */}
      <div className="select-none">
        <div className="font-mono text-xs tracking-wider uppercase text-mut">Vitti Intelligence &middot; prototype</div>
        <h1 className="font-disp font-medium text-[26px] mt-0.5 text-ink flex items-center gap-2">
          Ask Vitti
          <span className="bg-green text-[#08130e] text-[9.5px] font-bold tracking-wider rounded-[5px] px-2 py-0.5 self-center">AI</span>
        </h1>
        <p className="text-xs text-mut mt-1">
          Daily market and stock updates in plain English. In production, this connects directly to live markets and portfolios.
        </p>
      </div>

      {/* Message Thread Container */}
      <div className="flex-1 border border-line bg-white rounded-2xl shadow-shadow p-4 md:p-5 flex flex-col justify-between space-y-4 min-h-75">

        {/* Chat window bubble list */}
        <div className="space-y-3.5 overflow-y-auto max-h-[50vh] pr-1.5 scrollbar-thin">
          {messages.map((m, idx) => {
            const isUser = m.role === "user";
            return (
              <div key={idx} className={`flex gap-3 items-start ${isUser ? "justify-end" : ""}`}>
                {!isUser && (
                  <div className="w-7.5 h-7.5 rounded-[9px] bg-navy text-green font-disp font-semibold text-base flex items-center justify-center flex-none select-none">
                    V
                  </div>
                )}
                <div className={`rounded-[13px] px-3.5 py-2.5 text-[13.5px] sm:text-[14px] leading-relaxed max-w-[75%] shadow-shadow ${
                  isUser
                    ? "bg-green text-[#08130e] font-medium"
                    : m.brief
                    ? "bg-navy text-white font-normal"
                    : "bg-white border border-line text-ink"
                }`}>
                  {m.text}
                </div>
              </div>
            );
          })}
          <div ref={threadEndRef} />
        </div>

        {/* Suggestion Chips */}
        <div className="flex flex-wrap gap-2 pt-2 border-t border-line select-none">
          {suggestedQuestions.map((q, idx) => (
            <button
              key={idx}
              onClick={() => handleSendMessage(q)}
              className="bg-white border border-line-2 hover:border-green text-ink hover:text-green-d text-[12px] md:text-[12.5px] font-medium px-3.5 py-1.5 rounded-full cursor-pointer hover:-translate-y-px shadow-sm transition-all"
            >
              {q}
            </button>
          ))}
        </div>

        {/* TextInput Box */}
        <form onSubmit={handleSubmit} className="flex gap-2 items-center select-none pt-1">
          <input
            value={inputValue}
            onChange={e => setInputValue(e.target.value)}
            placeholder="Ask about your portfolio, a stock, or the market…"
            className="flex-1 border border-line-2 focus:border-green rounded-[11px] px-4 py-3 text-sm focus:outline-none bg-white text-ink transition-colors"
          />
          <button
            type="submit"
            className="btn bg-navy text-white hover:bg-slate-800 font-semibold py-3 px-5 rounded-[11px] text-xs cursor-pointer select-none transition-colors"
          >
            Send
          </button>
        </form>

        <div className="text-[10px] text-mut text-center select-none pt-1 leading-normal">
          Prototype responses. Vitti Intelligence does not provide personal financial advice.
        </div>
      </div>
    </div>
  );
}
