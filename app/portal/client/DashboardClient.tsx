"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  DollarSign,
  AlertTriangle,
  TrendingDown,
  TrendingUp,
  Zap,
  Clock,
  type LucideIcon,
} from "lucide-react";
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

  /**
   * Open options, soonest expiry first.
   *
   * Already-expired ones are left out: `dte` goes negative once the date has
   * passed, and a window that closed is not upcoming. Four is what fits beside
   * the holdings without the column becoming a second page.
   */
  const expiring = options
    .filter((o) => o.status === "open" && o.dte >= 0)
    .sort((a, b) => a.dte - b.dte)
    .slice(0, 4);

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
    const list: {
      tone: string;
      icon: LucideIcon;
      title: string;
      sub: string;
      path: string;
    }[] = [];

    // 1. Idle Cash
    if (cash >= 20000) {
      list.push({
        tone: "green",
        icon: DollarSign,
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
        icon: AlertTriangle,
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
        icon: TrendingDown,
        title: `${sig.action} ${trimHolding.code}`,
        sub: sig.headline,
        path: "/portal/client/positions"
      });
    }

    // 4. Default: Add to position in buy zone / See weekly idea
    if (list.length < 3) {
      list.push({
        tone: "green",
        icon: Zap,
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
    const Icon = {
      expiry: Clock,
      itm: TrendingUp,
      window: AlertTriangle,
      price: TrendingUp,
    }[kind] || Clock;

    return (
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-none ${col}`}>
        <Icon className="w-4 h-4 stroke-[1.8]" />
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
          Your book is{" "}
          <b className="text-white font-bold">${Math.round(pv).toLocaleString("en-AU")}</b>{" "}
          across {positions.length} holding{positions.length === 1 ? "" : "s"} and cash, with a
          lifetime profit and loss of{" "}
          <b className={`font-bold ${deskPnl >= 0 ? "text-[#5cc79a]" : "text-[#e0795b]"}`}>
            {deskPnl >= 0 ? "+" : ""}${Math.round(deskPnl).toLocaleString("en-AU")}
          </b>{" "}
          on ${Math.round(deskCost).toLocaleString("en-AU")} invested.{" "}
          Figures come from Vitti&apos;s own reconciliation of your contract notes
          and holdings.
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
                  <s.icon className="w-5 h-5 stroke-[1.8]" />
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
          <div className="font-disp font-medium text-xl sm:text-2xl mt-1 text-ink tabular-nums">${Math.round(pv).toLocaleString("en-AU")}</div>
          <div className="text-xs text-mut mt-1">holdings + cash, at last price</div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Cost base</div>
          <div className="font-disp font-medium text-xl sm:text-2xl mt-1 text-ink tabular-nums">${Math.round(deskCost).toLocaleString("en-AU")}</div>
          <div className="text-xs text-mut mt-1">invested, all accounts</div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Profit &amp; loss</div>
          <div className={`font-disp font-medium text-xl sm:text-2xl mt-1 tabular-nums ${deskPnl >= 0 ? "text-gain" : "text-loss-d"}`}>
            {deskPnl >= 0 ? "+" : ""}${Math.round(deskPnl).toLocaleString("en-AU")}
          </div>
          <div className={`text-xs mt-1 font-mono ${deskPnl >= 0 ? "text-gain" : "text-loss-d"}`}>
            {deskPnl >= 0 ? "+" : ""}{deskPnlPct.toFixed(1)}% &middot; realised + open
          </div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Holdings</div>
          <div className="font-disp font-medium text-xl sm:text-2xl mt-1 text-ink tabular-nums">{positions.length}</div>
          <div className="text-xs text-mut mt-1">
            {portfolio.rows.length} line{portfolio.rows.length === 1 ? "" : "s"}{" "}
            of P&amp;L history
          </div>
        </div>
      </div>

      {/*
        Two columns on a desk, one on a phone — and the order below is the order
        it stacks in, which is why the holdings come first: on a phone a client
        scrolls until they see their own money, and anything above that is in
        the way.
      */}
      <div className="grid lg:grid-cols-12 gap-4 items-start">
        {/* What they hold. */}
        <div className="lg:col-span-8 space-y-4">
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
                  {positions.slice(0, 8).map(p => {
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

        {/* What needs attention. */}
        <div className="lg:col-span-4 space-y-4">
          {/* Live Placement Card */}
          {liveDeal && (
            <div className="card bg-green-bg/50 border border-green rounded-[14px] p-4.5 shadow-shadow space-y-3.5 bg-linear-to-b from-green-bg/60 to-card/70">
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

          {/* ── Exercise windows ──────────────────────────────────────
              What replaced "Upcoming dates", which listed a TTM allocation, an
              NVX options expiry and a BHP dividend on fixed dates — three
              events, hardcoded, for companies this client may not hold.

              These are the client's own option holdings, soonest first. It is
              also the thing this product says it is for: "the options whose
              exercise windows you cannot afford to miss". */}
          {expiring.length > 0 && (
            <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
              <div className="px-4.5 py-3.5 border-b border-line flex items-center justify-between gap-2">
                <b className="text-ink text-sm font-semibold">Exercise windows</b>
                <button
                  onClick={() => router.push("/portal/client/options")}
                  className="text-green-d font-semibold text-xs underline underline-offset-2 hover:opacity-85 cursor-pointer"
                >
                  All options
                </button>
              </div>
              <div className="divide-y divide-line">
                {expiring.map((o) => {
                  const itm = isITM(o);
                  // Under a fortnight is where an unlisted grant stops being a
                  // date in the future and becomes something to act on.
                  const urgent = o.dte <= 14;
                  return (
                    <div key={o.id} className="px-4.5 py-3 flex items-center gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="code font-mono text-[12px] bg-paper-2 rounded-[5px] px-1.5 py-0.5 font-bold text-ink">
                            {o.code}
                          </span>
                          {itm && (
                            <span className="text-[9.5px] font-bold uppercase tracking-wider text-green-d bg-green-bg rounded-full px-1.5 py-0.5">
                              In the money
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-mut mt-1 truncate">
                          {o.qty.toLocaleString("en-AU")} @ ${o.strike.toFixed(2)}
                          {o.listed ? "" : " · unlisted"}
                        </div>
                      </div>
                      <div className="text-right flex-none">
                        <div
                          className={`font-mono text-[13px] font-semibold ${
                            urgent ? "text-loss-d" : "text-ink"
                          }`}
                        >
                          {o.dte}d
                        </div>
                        <div className="text-[10.5px] text-mut font-mono">
                          {new Date(o.expiryDate).toLocaleDateString("en-AU", {
                            day: "numeric",
                            month: "short",
                          })}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
