"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import type {
  Position,
  OptionRow,
  IndexRow,
  PlacementRow,
  AlertRow,
  SignalRow,
} from "@/lib/data/queries";
import type { ClientPortfolio } from "@/lib/pnl/client-portfolio";
import {
  posValue,
  posCost,
  posPL,
  portfolioValue,
  isITM,
} from "@/lib/data/compute";
import { ackAlert } from "@/app/actions/alerts";
import { isComingSoon } from "@/lib/nav/coming-soon";

export function DashboardClient({
  clientId,
  clientName,
  cash,
  positions,
  options,
  indices,
  placements,
  alerts,
  signals,
  noteTime,
  portfolio,
}: {
  clientId: string;
  clientName: string;
  cash: number;
  positions: Position[];
  options: OptionRow[];
  indices: IndexRow[];
  placements: PlacementRow[];
  alerts: AlertRow[];
  signals: Record<string, SignalRow>;
  noteTime: string;
  /** The desk's own stored figures — see lib/pnl/client-portfolio.ts. */
  portfolio: ClientPortfolio;
}) {
  const router = useRouter();
  const [countdown, setCountdown] = useState("closes 4:00:00");

  const pv = portfolioValue(positions, cash);

  // `dailyPL`, and the month- and year-to-date figures that sat beside it, are
  // gone from this page.
  //
  // They were demo scaffolding: `dailyPL` models a day move from fixed
  // per-security factors because the app has no intraday price history, and MTD
  // and YTD were literally `pv * 0.018` and `pv * 0.064` — two hardcoded
  // percentages rendered in green as a client's own return. Harmless while only
  // the desk opened this screen; not harmless at all once a client could sign in
  // and read them as fact.
  //
  // What replaces them is the figure that is real and reproducible: the stored
  // P&L, the same one the adviser sees. A true month- or year-to-date needs the
  // per-sale dates the staff chart replays, which is a feature rather than a
  // subtitle.
  const deskCost = portfolio.total.buyPrice;
  const deskPnl = portfolio.total.pnl;
  const deskPnlPct = deskCost > 0 ? (deskPnl / deskCost) * 100 : 0;

  const liveDeal = placements.find(p => p.stage === "open");
  const myBid = liveDeal ? liveDeal.bids.find(b => b.clientId === clientId) : null;

  // Filter alerts visible to this client
  const clientAlerts = alerts.filter(a => a.clientId === clientId && !a.ack).slice(0, 3);

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

  // Formatted date
  const todayStr = new Date(2026, 5, 12).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "2-digit"
  }) + " · ASX open";

  // Build marquee ticker content
  const renderTicker = () => {
    // `market_indices` is empty in this database, and a marquee with nothing in
    // it still drew its full-width navy bar: a black band under the greeting
    // that looked like a component that had failed to load. No indices, no
    // ticker — the row is worth its space only when it is carrying prices.
    if (indices.length === 0) return null;

    const tickerItems = indices.map(x => {
      const isUp = x.chg >= 0;
      const valStr = x.last.toLocaleString("en-AU", {
        minimumFractionDigits: x.dp !== undefined ? x.dp : 1,
        maximumFractionDigits: x.dp !== undefined ? x.dp : 1
      });
      return (
        <span key={x.code} className="inline-block mr-5.5">
          {x.code} {valStr} {" "}
          <span className={isUp ? "text-[#5cc79a]" : "text-[#e0795b]"}>
            {isUp ? "▲" : "▼"} {Math.abs(x.chg).toFixed(2)}%
          </span>
        </span>
      );
    });

    return (
      <div className="tickwrap mb-4 select-none">
        <div className="tickrun">
          {tickerItems}
          {tickerItems}
        </div>
      </div>
    );
  };

  // Build personalized suggestions based on portfolio state
  const getSuggestions = () => {
    const list = [];

    // 1. Idle Cash
    if (cash >= 20000) {
      list.push({
        tone: "green",
        icon: "M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
        title: `Put $${cash.toLocaleString("en-AU")} cash to work`,
        sub: "Build a plan across timeframes",
        path: "/portal/client/invest"
      });
    }

    // 2. Option exercise windows
    const urgentOpt = options.find(o => o.status === "open" && isITM(o) && !o.listed && o.dte <= 14 && o.dte >= 0);
    if (urgentOpt) {
      list.push({
        tone: "red",
        icon: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
        title: `Act on ${urgentOpt.code} — ${urgentOpt.dte}d left`,
        sub: "Unlisted, in the money, window closing",
        path: "/portal/client/options"
      });
    }

    // 3. Trim / Take profit signals
    const trimHolding = positions.find(p => {
      const sig = signals[p.code];
      return sig && (sig.action === "Take profit" || sig.action === "Trim");
    });
    if (trimHolding) {
      const sig = signals[trimHolding.code];
      list.push({
        tone: "amber",
        icon: "M4 19V5M4 19h16M8 11l3 3 4-6",
        title: `${sig.action} ${trimHolding.code}`,
        sub: sig.headline,
        path: "/portal/client/positions"
      });
    }

    // 4. Default: Add to position in buy zone / See weekly idea
    if (list.length < 3) {
      list.push({
        tone: "green",
        icon: "M13 2 4.5 13.5H11L9.5 22 19 10h-6.5z",
        title: "See this week's idea",
        sub: "Curated, with target and timeframe",
        path: "/portal/client/invest"
      });
    }

    // A suggestion is an invitation to go somewhere. Two of these lead to
    // Invest, which is not finished — offering them would be the dashboard
    // walking a client into the page the nav has just told them is not ready.
    return list.filter((s) => !isComingSoon(s.path)).slice(0, 3);
  };

  const suggestions = getSuggestions();

  const getSuggIconColor = (tone: string) => {
    if (tone === "red") return "bg-[#fbe7e1] text-loss";
    if (tone === "amber") return "bg-[#fdeede] text-amber-d";
    return "bg-green-bg text-green-d";
  };

  const getAlertIco = (kind: string, sev: string) => {
    const col = sev === "red" ? "text-loss-d bg-loss-bg" : (sev === "amber" ? "text-amber-d bg-amber-bg" : "text-green-d bg-green-bg");
    const path = {
      expiry: "M12 8v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
      itm: "M4 18l6-6 4 4 6-8M14 8h4v4",
      window: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
      price: "M3 17l6-6 4 4 8-8M21 7v6h-6"
    }[kind] || "M12 8v5l3 2";

    return (
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-none ${col}`}>
        <svg className="w-4 h-4 stroke-current fill-none stroke-[1.8]" viewBox="0 0 24 24">
          <path d={path} />
        </svg>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* Page Header */}
      <div className="flex justify-between items-end gap-3 flex-wrap">
        <div>
          <div className="font-mono text-xs tracking-wider uppercase text-mut">{todayStr}</div>
          <h1 className="font-disp font-medium text-[26px] mt-0.5 text-ink">
            Good morning, {clientName.split(" ")[0]}
          </h1>
        </div>
      </div>

      {/* Marquee Ticker */}
      {renderTicker()}

      {/* Morning Briefing Card */}
      <div className="card bg-navy text-[#dfe2ee] border-navy p-5 rounded-[14px] shadow-shadow space-y-3 relative overflow-hidden">
        <div
          className="absolute inset-0 pointer-events-none opacity-5"
          style={{
            backgroundImage: `radial-gradient(ellipse 60% 60% at 50% 0%, #36bb91, transparent)`
          }}
        />
        <div className="flex justify-between items-center text-xs">
          <b className="text-white text-sm font-semibold">Your morning briefing</b>
          <span className="text-mut-d font-medium">{noteTime} &middot; auto-generated</span>
        </div>
        {/* Only figures that exist.
            This paragraph used to read "…up $X (+1.2%) today. Materials led —
            PLS +2.1%, BHP +0.8% — while energy lagged. China stimulus and a
            cooler US CPI are supportive for your resources and financials
            exposure." Every specific in it was hardcoded, under a heading that
            says "auto-generated" — so it read as commentary written from this
            client's own book. It was not. The day move came from
            `dailyPL`'s fixed factors and the market colour from nowhere at all.

            What is left is what the app can stand behind. Real market commentary
            belongs here eventually; inventing it in the meantime is worse than
            leaving the space plain. */}
        <p className="text-sm leading-relaxed text-slate-300">
          Your book is <b className="text-white font-bold">${pv.toLocaleString("en-AU")}</b> across{" "}
          {positions.length} holding{positions.length === 1 ? "" : "s"} and cash, with a lifetime
          profit and loss of{" "}
          <b className={`font-bold ${deskPnl >= 0 ? "text-[#5cc79a]" : "text-[#e0795b]"}`}>
            {deskPnl >= 0 ? "+" : ""}${Math.round(deskPnl).toLocaleString("en-AU")}
          </b>{" "}
          on ${Math.round(deskCost).toLocaleString("en-AU")} invested. Figures come from Vitti&apos;s
          own reconciliation of your contract notes and holdings.
        </p>
      </div>

      {/* Dynamic Suggestions */}
      {suggestions.length > 0 && (
        <div className="space-y-2">
          <div className="font-mono text-[11px] tracking-wider uppercase text-mut">Suggested for you today</div>
          <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-4">
            {suggestions.map((s, idx) => (
              <div
                key={idx}
                onClick={() => router.push(s.path)}
                className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow flex items-center gap-3.5 hover:-translate-y-0.5 transition-transform cursor-pointer select-none"
              >
                <div className={`w-9.5 h-9.5 rounded-[10px] flex-none flex items-center justify-center ${getSuggIconColor(s.tone)}`}>
                  <svg className="w-5 h-5 stroke-current fill-none stroke-[1.8] stroke-linecap-round stroke-linejoin-round" viewBox="0 0 24 24">
                    <path d={s.icon} />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold text-[13px] text-ink leading-tight truncate">{s.title}</div>
                  <div className="text-[11px] text-mut truncate mt-0.5">{s.sub}</div>
                </div>
                <span className="text-green-d font-semibold text-sm flex-none">&rarr;</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Total portfolio</div>
          <div className="font-disp font-medium text-2xl mt-1 text-ink">${pv.toLocaleString("en-AU")}</div>
          <div className="text-xs text-mut mt-1">holdings + cash, at last price</div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Cost base</div>
          <div className="font-disp font-medium text-2xl mt-1 text-ink">${Math.round(deskCost).toLocaleString("en-AU")}</div>
          <div className="text-xs text-mut mt-1">invested, all accounts</div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Profit &amp; loss</div>
          <div className={`font-disp font-medium text-2xl mt-1 ${deskPnl >= 0 ? "text-gain" : "text-loss-d"}`}>
            {deskPnl >= 0 ? "+" : ""}${Math.round(deskPnl).toLocaleString("en-AU")}
          </div>
          <div className={`text-xs mt-1 font-mono ${deskPnl >= 0 ? "text-gain" : "text-loss-d"}`}>
            {deskPnl >= 0 ? "+" : ""}{deskPnlPct.toFixed(1)}% &middot; realised + open
          </div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Holdings</div>
          <div className="font-disp font-medium text-2xl mt-1 text-ink">{positions.length}</div>
          <div className="text-xs text-mut mt-1">
            {portfolio.rows.length} line{portfolio.rows.length === 1 ? "" : "s"} of P&amp;L history
          </div>
        </div>
      </div>

      {/* Main Content Grid */}
      <div className="grid lg:grid-cols-12 gap-4">
        {/* Left Column (equities performance & positions) */}
        <div className="lg:col-span-7 space-y-4">
          {/* Performance Line Chart Card */}
          <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow space-y-3">
            <div className="flex justify-between items-center text-xs">
              <b className="text-ink text-sm font-semibold">Portfolio performance</b>
              <span className="text-mut font-semibold">1Y &middot; time-weighted</span>
            </div>

            <div className="w-full relative h-32.5 pt-2">
              <svg className="w-full h-full block" viewBox="0 0 600 120" preserveAspectRatio="none">
                <defs>
                  <linearGradient id="gd" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0" stopColor="#36bb91" stopOpacity="0.18" />
                    <stop offset="1" stopColor="#36bb91" stopOpacity="0" />
                  </linearGradient>
                </defs>
                {/* Reference line */}
                <path d="M0 100 L100 95 L200 90 L300 82 L400 74 L500 66 L600 60" fill="none" stroke="#c7c2b5" strokeWidth="1.4" strokeDasharray="4 5" />
                {/* Area under curve */}
                <path d="M0 96 L50 90 L100 93 L150 78 L200 82 L250 64 L300 70 L350 50 L400 56 L450 35 L500 41 L550 22 L600 16 V120 H0Z" fill="url(#gd)" />
                {/* Chart Line */}
                <path d="M0 96 L50 90 L100 93 L150 78 L200 82 L250 64 L300 70 L350 50 L400 56 L450 35 L500 41 L550 22 L600 16" fill="none" stroke="#36bb91" strokeWidth="2.5" />
              </svg>
            </div>
          </div>

          {/* Positions Preview Table */}
          <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
            <div className="flex justify-between items-center px-4.5 py-4 border-b border-line bg-white">
              <b className="text-ink text-sm font-semibold">Open positions</b>
              <button
                onClick={() => router.push("/portal/client/positions")}
                className="text-green-d font-semibold text-xs underline underline-offset-2 hover:opacity-85 cursor-pointer"
              >
                View all
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-line">
                    <th className="font-semibold text-mut text-[10.5px] uppercase tracking-wider px-4 py-2.5">Code</th>
                    <th className="font-semibold text-mut text-[10.5px] uppercase tracking-wider px-4 py-2.5 hidden sm:table-cell">Holding</th>
                    <th className="font-semibold text-mut text-[10.5px] uppercase tracking-wider px-4 py-2.5 text-right">Value</th>
                    <th className="font-semibold text-mut text-[10.5px] uppercase tracking-wider px-4 py-2.5 text-right">Unreal. P&amp;L</th>
                    <th className="font-semibold text-mut text-[10.5px] uppercase tracking-wider px-4 py-2.5 text-right hidden sm:table-cell">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#f0ede5] font-medium">
                  {positions.slice(0, 5).map(p => {
                    const pl = posPL(p);
                    const plp = pl / posCost(p) * 100;
                    const val = posValue(p);
                    const isUp = pl >= 0;
                    return (
                      <tr key={p.code}>
                        <td className="px-4 py-3"><span className="code text-[13px] bg-paper-2 rounded-[5px] px-1.5 py-0.5">{p.code}</span></td>
                        <td className="px-4 py-3 hidden sm:table-cell">
                          <div className="text-ink font-semibold">{p.name}</div>
                          <div className="text-mut text-[10.5px] mt-0.5">{p.qty.toLocaleString("en-AU")} @ ${p.cost.toFixed(2)}</div>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-[13px]">${Math.round(val).toLocaleString("en-AU")}</td>
                        <td className={`px-4 py-3 text-right font-mono text-[13px] ${isUp ? "text-gain" : "text-loss-d"}`}>
                          ${Math.round(pl).toLocaleString("en-AU")}
                          <div className="text-[10.5px]">{isUp ? "+" : ""}{plp.toFixed(1)}%</div>
                        </td>
                        {/* Was a "Day" column reading `p.code === "PLS" ? "+2.1%" : "+0.4%"`
                            — one hardcoded move for one ticker and one for
                            everything else, in green either way. There is no
                            intraday price history here to fill it from, so the
                            column shows the parcel's cost instead, which is a
                            fact the ledger holds. */}
                        <td className="px-4 py-3 text-right font-mono text-[13px] hidden sm:table-cell text-mut">
                          ${Math.round(posCost(p)).toLocaleString("en-AU")}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right Column (Live deal & widgets) */}
        <div className="lg:col-span-5 space-y-4">
          {/* Live Placement Card */}
          {liveDeal && (
            <div className="card bg-green-bg/50 border border-green rounded-[14px] p-4.5 shadow-shadow space-y-3.5 bg-linear-to-b from-green-bg/60 to-white/70">
              <div className="flex justify-between items-center text-xs">
                <b className="text-green-d text-sm font-semibold flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-green animate-ping" />
                  Live placement
                </b>
                <span className="text-mut font-mono text-[11px]" id="cd-1">{countdown}</span>
              </div>
              <div>
                <h3 className="font-disp font-medium text-lg leading-tight text-ink">{liveDeal.name}</h3>
                <div className="font-mono text-xs text-mut mt-1">
                  ASX: {liveDeal.code} &middot; ${liveDeal.price.toFixed(2)} &middot; {liveDeal.disc}% disc
                </div>
                <div className="text-xs text-mut mt-1">
                  Raise ${liveDeal.raise}m &middot; min ${liveDeal.min.toLocaleString("en-AU")} &middot; {liveDeal.opts}
                </div>
              </div>
              {myBid && (
                <div>
                  <span className="pill bg-green-bg border border-green/30 text-green-d text-[11px] font-semibold py-1 px-3.5 rounded-full">
                    Your bid: ${myBid.amount.toLocaleString("en-AU")}
                  </span>
                </div>
              )}
              <button
                onClick={() => router.push(`/portal/client/placements`)}
                className="w-full btn bg-green hover:shadow-lg hover:shadow-green-bg text-[#08130e] font-semibold py-2.5 rounded-[10px] text-xs cursor-pointer select-none transition-all"
              >
                {myBid ? "View your bid" : "Review &amp; bid"}
              </button>
            </div>
          )}

          {/* Ask Vitti AI Card */}
          <div className="card bg-linear-to-b from-green-bg to-white/80 border border-green rounded-[14px] p-4.5 shadow-shadow space-y-2">
            <div className="flex justify-between items-center text-xs">
              <b className="text-ink text-sm font-semibold">Ask Vitti</b>
              <span className="bg-green text-[#08130e] text-[9px] font-bold px-1.5 py-0.5 rounded-[5px]">AI</span>
            </div>
            {/* Was: "You're up $X today; the MRD book closes at 4:00pm and one
                option needs attention." — a fabricated day move, a hardcoded
                ticker and an invented alert, in quotes, under an AI badge. A
                prompt is honest; a fake answer is not. */}
            <p className="text-[13px] text-mut italic leading-normal">
              Ask about your holdings, your options and their exercise windows, or
              anything in your book.
            </p>
            {/* Disabled for the same reason the nav entry is: the page behind
                it is still being built. A card that describes the feature and
                then refuses to open it is honest; one that opens a half-written
                page is not. */}
            <button
              disabled
              title="Vitti Intelligence is coming soon"
              className="w-full btn bg-navy/45 text-white/80 font-semibold py-2 rounded-lg text-xs cursor-not-allowed select-none mt-2"
            >
              Vitti Intelligence &middot; coming soon
            </button>
          </div>

          {/* Markets indices. Absent entirely when there are no indices: the
              card is a 2×2 grid of numbers, and with none it drew a heading, a
              link and a hole. The "Briefing" link is gone with the rest — it
              pointed at Markets, which is still being built. */}
          {indices.length > 0 && (
          <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow space-y-3">
            <div className="flex justify-between items-center text-xs">
              <b className="text-ink text-sm font-semibold">Markets</b>
            </div>
            <div className="grid grid-cols-2 gap-3.5">
              {indices.slice(0, 4).map(x => {
                const isUp = x.chg >= 0;
                return (
                  <div key={x.code} className="space-y-0.5">
                    <div className="text-[10.5px] font-mono font-semibold text-mut uppercase tracking-wider">{x.code}</div>
                    <div className="font-mono font-semibold text-[13px] text-ink">
                      {x.last.toLocaleString("en-AU", {
                        minimumFractionDigits: x.dp !== undefined ? x.dp : 1,
                        maximumFractionDigits: x.dp !== undefined ? x.dp : 1
                      })}
                    </div>
                    <div className={`text-[10.5px] font-semibold ${isUp ? "text-gain" : "text-loss-d"}`}>
                      {isUp ? "+" : ""}{x.chg.toFixed(2)}%
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          )}

          {/* Alerts preview */}
          <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow space-y-3">
            <div className="flex justify-between items-center text-xs">
              <b className="text-ink text-sm font-semibold">Alerts</b>
              <button
                onClick={() => router.push("/portal/client/alerts")}
                className="text-green-d font-semibold text-xs underline underline-offset-2 hover:opacity-85 cursor-pointer"
              >
                {alerts.filter(a => a.clientId === clientId && !a.ack).length} unread
              </button>
            </div>
            <div className="space-y-2">
              {clientAlerts.length > 0 ? (
                clientAlerts.map(a => (
                  <div key={a.id} className="flex gap-2.5 p-2.5 border border-line rounded-xl bg-white items-start text-xs">
                    {getAlertIco(a.kind, a.sev)}
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-ink leading-tight truncate">{a.title}</div>
                      <div className="text-[11px] text-mut truncate mt-0.5">{a.sub}</div>
                    </div>
                    {!a.ack && (
                      <button
                        onClick={() => ackAlert(a.id)}
                        className="btn ghost sm text-[10px] py-1 px-2 border border-line rounded-md hover:border-green cursor-pointer flex-none align-self-center"
                      >
                        Ack
                      </button>
                    )}
                  </div>
                ))
              ) : (
                <div className="text-[12.5px] text-mut py-1">No unread alerts.</div>
              )}
            </div>
          </div>

          {/* Upcoming dates checklist */}
          <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow space-y-3">
            <b className="text-ink text-sm font-semibold block">Upcoming dates</b>
            <table className="w-full border-collapse text-xs text-ink leading-relaxed">
              <tbody className="divide-y divide-[#f0ede5]">
                <tr>
                  <td className="py-2 pr-2">
                    TTM allocation
                    <div className="text-mut text-[10.5px]">if your bid is filled</div>
                  </td>
                  <td className="py-2 text-right font-mono font-semibold">
                    {new Date(2026, 5, 12).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
                  </td>
                </tr>
                <tr>
                  <td className="py-2 pr-2">
                    NVX options expiry
                    <div className="text-mut text-[10.5px]">listed &middot; in the money</div>
                  </td>
                  <td className="py-2 text-right font-mono font-semibold text-gain">
                    {new Date(2026, 5, 17).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
                  </td>
                </tr>
                <tr>
                  <td className="py-2 pr-2">
                    BHP dividend
                  </td>
                  <td className="py-2 text-right font-mono font-semibold">
                    {new Date(2026, 5, 25).toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
