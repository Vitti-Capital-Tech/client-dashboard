"use client";

import React, { useState, useEffect, useRef } from "react";
import type { OptionTableItem } from "@/lib/options/from-stored-pnl";
import type { ClientPortfolio } from "@/lib/pnl/client-portfolio";

const money0 = (n: number) => `$${Math.round(n).toLocaleString("en-AU")}`;

interface Message {
  role: "user" | "ai";
  text: string;
  brief?: boolean;
}

export function AskVittiClient({
  clientName,
  marketValue,
  portfolio,
  options,
  openPlacements,
}: {
  clientName: string;
  /** Current holdings of the active account, at last price. */
  marketValue: number;
  /** The desk's stored figures — see lib/pnl/client-portfolio.ts. */
  portfolio: ClientPortfolio;
  options: OptionTableItem[];
  openPlacements: number;
}) {
  const pnl = portfolio.total.pnl;
  const cost = portfolio.total.buyPrice;

  /** In the money AND inside the window — the only options worth naming. */
  const urgentOptions = options.filter(
    (o) => o.status === "live" && o.money.isItm && o.dte !== null && o.dte <= 14 && o.dte >= 0,
  );

  const [messages, setMessages] = useState<Message[]>(() => [
    {
      // No hardcoded date. The greeting used to read "your briefing for Friday,
      // 12 Jun 2026" whatever day it actually was.
      role: "ai",
      text: `Hello, ${clientName.split(" ")[0]}. I’m Vitti Intelligence — I can answer from your holdings, your options and the deals on our book.`,
      brief: true
    },
    {
      // Was: "…The MRD placement closes at 4:00pm, and one of your unlisted
      // options is in the money inside its exercise window." Both invented, and
      // stated about this client's own book.
      role: "ai",
      text:
        `Your lifetime profit and loss is ${pnl >= 0 ? "+" : ""}${money0(pnl)} on ${money0(cost)} invested, and this account holds ${money0(marketValue)} at last price.` +
        (urgentOptions.length > 0
          ? ` ${urgentOptions.length} of your options ${urgentOptions.length === 1 ? "is" : "are"} in the money inside the exercise window — worth a look.`
          : "") +
        " Ask me anything below."
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

    /**
     * Answers are assembled from the data this component was handed, and nothing
     * else.
     *
     * Every branch here used to carry invented specifics — a day move multiplied
     * by a stray `105`, "PLS +2.1% and BHP +0.8%", "Year to date +6.4%, ahead of
     * the ASX 200 at +5.4%", a week of events that had not happened, and a whole
     * placement complete with a **desk recommendation** ("a spec buy with a
     * $0.78 target"). None of it came from anywhere. Fabricated market colour is
     * bad; a fabricated price target on a deal is advice nobody gave.
     *
     * So the rule is now: answer from the figures, or say what cannot be
     * answered yet. An assistant that declines is useful; one that invents is
     * worse than none.
     */
    let ans =
      "I can answer from your holdings, your profit and loss, and your options and their exercise windows. Ask about any of those, or about a specific holding.";

    const isPortfolio = /portfolio|how am i|doing|profit|loss|p&l|return/i.test(q);
    const isDeals = /placement|deal|ipo|book|offer/i.test(q);
    const isOptions = /option|expiry|exercise|itm/i.test(q);
    const isMarket = /market|today|asx|index|week|outlook|news/i.test(q);

    if (isOptions) {
      if (urgentOptions.length > 0) {
        const details = urgentOptions
          .map(
            (o) =>
              `${o.ticker} (${o.dte}d left${o.strike !== null ? `, strike $${o.strike.toFixed(2)}` : ""})`,
          )
          .join(", ");
        ans = `You have ${urgentOptions.length} option${urgentOptions.length > 1 ? "s" : ""} in the money and close to expiry: ${details}. Unlisted options are not auto-exercised, so these are the ones to act on — the Options tab has the full register.`;
      } else if (options.length > 0) {
        ans = `You hold ${options.length} option series. None is both in the money and inside its exercise window right now. The Options tab lists them all with strikes and expiry dates.`;
      } else {
        ans = "There are no option series on your register at the moment.";
      }
    } else if (isPortfolio) {
      ans =
        `Your lifetime profit and loss is ${pnl >= 0 ? "+" : ""}${money0(pnl)} on ${money0(cost)} invested, across ${portfolio.rows.length} line${portfolio.rows.length === 1 ? "" : "s"} of history. ` +
        `This account currently holds ${money0(marketValue)} at last price. ` +
        (portfolio.outsideTotal > 0
          ? `${portfolio.outsideTotal} line${portfolio.outsideTotal === 1 ? " is" : "s are"} outside that total while the desk confirms the cost base. `
          : "") +
        "The Portfolio tab breaks it down parcel by parcel.";
    } else if (isDeals) {
      ans =
        openPlacements > 0
          ? `There ${openPlacements === 1 ? "is" : "are"} ${openPlacements} placement${openPlacements === 1 ? "" : "s"} open on our book. The Placements tab has the terms and the closing times, and you can bid from there.`
          : "There are no placements open on our book right now. I will have them here as soon as the desk opens one.";
    } else if (isMarket) {
      // Deliberately refused. There is no market data feed behind this app, and
      // the previous answer to this question was pure invention.
      ans =
        "I do not have a market feed behind me, so I will not guess at today's moves or an index comparison. Your adviser can give you the market read — what I can do is your holdings, your profit and loss, and your options.";
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
