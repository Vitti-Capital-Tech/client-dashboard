"use client";

import React, { useState } from "react";
import { useDatabase } from "@/contexts/DatabaseContext";
import {
  cashOf,
  clientPositions,
  posValue
} from "@/lib/db";

interface PlanItem {
  code: string;
  tf: "Tactical" | "Core" | "Strategic";
  allocPct: number;
  allocAmt: number;
  target: number | null;
  date: Date;
  deal?: string;
}

interface Plan {
  amount: number;
  objective: string;
  risk: string;
  items: PlanItem[];
}

export default function ClientInvestPage() {
  const { db, clientId } = useDatabase();
  
  // Guided investment plan state (simulated session state)
  const [plan, setPlan] = useState<Plan | null>(null);
  const [selectedTheme, setSelectedTheme] = useState("All");
  
  // Modal controllers
  const [showBuilder, setShowBuilder] = useState(false);
  const [showIdeaModal, setShowIdeaModal] = useState<string | null>(null);
  const [showDeployModal, setShowDeployModal] = useState<{ code: string; amt: number } | null>(null);

  // Form states
  const [deployAmt, setDeployAmt] = useState("");
  const [objective, setObjective] = useState("grow");
  const [riskTolerance, setRiskTolerance] = useState("Balanced");
  const [horizon, setHorizon] = useState("Medium (months)");

  // Invest order inputs
  const [investOrderAmt, setInvestOrderAmt] = useState("");

  const cash = cashOf(clientId);
  const positions = clientPositions(db, clientId);

  // Initialize form amount on open
  const handleOpenBuilder = () => {
    const recommendedAmount = Math.max(50000, Math.round(cash * 0.6 / 1000) * 1000);
    setDeployAmt(recommendedAmount.toLocaleString("en-AU"));
    setShowBuilder(true);
  };

  const handleGeneratePlan = () => {
    const raw = deployAmt.replace(/[^0-9]/g, "");
    const amt = raw ? parseInt(raw, 10) : 50000;
    
    const goalObj = db.goals.find(g => g.k === objective) || db.goals[0];
    // Filter ideas that match the themes of the chosen goal
    let pool = db.ideas.filter(i => goalObj.themes.includes(i.theme));
    if (pool.length < 3) pool = [...db.ideas];

    // Filter by risk tolerance
    if (riskTolerance === "Conservative") {
      pool = pool.filter(i => i.risk !== "High");
    }

    // Helper to map ideas to timeframes
    const deriveTF = (i: typeof db.ideas[0]) => {
      if (i.deal || (i.last !== null && i.entryLo !== null && i.entryHi !== null && i.last >= i.entryLo && i.last <= i.entryHi)) return "Tactical";
      if (i.risk === "High") return "Strategic";
      return "Core";
    };

    const TFMETA = {
      Tactical: { label: "Tactical", sub: "2–4 weeks", days: 21, w: 0.30 },
      Core: { label: "Core", sub: "1–3 months", days: 60, w: 0.45 },
      Strategic: { label: "Strategic", sub: "6–12 months", days: 240, w: 0.25 }
    };

    // Distribute into buckets
    const buckets: Record<string, typeof db.ideas> = { Tactical: [], Core: [], Strategic: [] };
    pool.forEach(i => {
      buckets[deriveTF(i)].push(i);
    });

    const picks: typeof db.ideas = [];
    ["Tactical", "Core", "Strategic"].forEach(b => {
      if (buckets[b][0]) picks.push(buckets[b][0]);
    });

    // Fill to 4 from remaining pool if needed
    pool.forEach(i => {
      if (picks.length < 4 && !picks.some(x => x.code === i.code)) {
        picks.push(i);
      }
    });

    const finalPicks = picks.slice(0, 4);
    const wsum = finalPicks.reduce((s, i) => s + TFMETA[deriveTF(i)].w, 0) || 1;

    const items: PlanItem[] = finalPicks.map(i => {
      const tf = deriveTF(i) as "Tactical" | "Core" | "Strategic";
      const pctw = TFMETA[tf].w / wsum;
      
      // Calculate allocation dates from TODAY (Friday 12 Jun 2026)
      const baseDate = new Date(2026, 5, 12);
      baseDate.setDate(baseDate.getDate() + TFMETA[tf].days);

      return {
        code: i.code,
        tf,
        allocPct: Math.round(pctw * 100),
        allocAmt: Math.round((amt * pctw) / 1000) * 1000,
        target: i.target,
        date: baseDate,
        deal: i.deal
      };
    });

    setPlan({
      amount: amt,
      objective: goalObj.label,
      risk: riskTolerance,
      items
    });

    setShowBuilder(false);
    alert(`Guided plan generated successfully with ${items.length} recommendations.`);
  };

  const handleOpenDeploy = (code: string, amt: number) => {
    setInvestOrderAmt(amt.toLocaleString("en-AU"));
    setShowDeployModal({ code, amt });
  };

  const handleExecuteDeploy = () => {
    if (!showDeployModal) return;
    const { code } = showDeployModal;
    const raw = investOrderAmt.replace(/[^0-9]/g, "");
    const amt = raw ? parseInt(raw, 10) : 0;
    
    alert(`Order submitted: Buy $${amt.toLocaleString("en-AU")} of ${code} routed to the Vitti options/placements desk.`);
    setShowDeployModal(null);
  };

  // Check if a client has established a position in a specific stock
  const isHoldingStock = (code: string) => {
    return positions.some(p => p.code === code);
  };

  // Get total deployed amount under this plan
  const getDeployedProgress = () => {
    if (!plan) return 0;
    let sum = 0;
    plan.items.forEach(it => {
      const p = positions.find(pos => pos.code === it.code);
      if (p) {
        sum += posValue(p);
      }
    });
    return Math.min(100, Math.round((sum / plan.amount) * 100));
  };

  const planProgress = getDeployedProgress();

  // Filter ideas based on theme chip selected
  const filteredIdeas = db.ideas.filter(i => {
    if (selectedTheme === "All") return true;
    return i.theme === selectedTheme;
  });

  const getTfChipColor = (tf: string) => {
    if (tf === "Tactical") return "bg-[#fdeede] text-[#a9651a]";
    if (tf === "Strategic") return "bg-[#e9e7f2] text-[#5c5775]";
    return "bg-green-bg text-green-d";
  };

  const ideaOfWeek = db.ideas.find(i => i.code === "MRD") || db.ideas[0];

  return (
    <div className="space-y-4">
      {/* Page Header */}
      <div>
        <div className="font-mono text-xs tracking-wider uppercase text-mut">Curated by Vitti research</div>
        <h1 className="font-disp font-medium text-[26px] mt-0.5 text-ink">Invest</h1>
        <p className="text-xs text-mut mt-1">
          A short, explained set of ideas with clear targets and timeframes — built around what you want, not an endless list.
        </p>
      </div>

      {/* Plan Summary Card */}
      {plan ? (
        <div className="card bg-white border border-green rounded-[14px] p-5 shadow-shadow space-y-4">
          <div className="flex justify-between items-center select-none">
            <div>
              <div className="font-mono text-xs tracking-wider uppercase text-mut">
                Your plan &middot; {plan.objective} &middot; {plan.risk}
              </div>
              <b className="text-base text-ink block mt-0.5">Deploy ${plan.amount.toLocaleString("en-AU")} across {plan.items.length} ideas</b>
            </div>
            <button 
              onClick={handleOpenBuilder}
              className="btn ghost sm text-xs py-1.5 px-3 border border-line rounded-lg hover:border-mut cursor-pointer font-semibold bg-white"
            >
              Rebuild
            </button>
          </div>

          {/* Recommended items grid */}
          <div className="grid sm:grid-cols-2 gap-4">
            {plan.items.map(it => {
              const i = db.ideas.find(x => x.code === it.code);
              const isHeld = isHoldingStock(it.code);
              const tfLabels = { Tactical: "Tactical · 2–4w", Core: "Core · 1–3m", Strategic: "Strategic · 6–12m" };
              return (
                <div key={it.code} className="border border-line rounded-xl p-4.5 space-y-3">
                  <div className="flex justify-between items-center select-none">
                    <span className={`pill text-[10px] font-bold rounded-full px-2.5 py-0.5 ${getTfChipColor(it.tf)}`}>
                      {tfLabels[it.tf]}
                    </span>
                    <span className="font-mono text-xs text-mut font-semibold">{it.allocPct}%</span>
                  </div>

                  <div className="flex items-center gap-1.5 select-none">
                    <span className="code text-[14px] bg-paper-2 rounded-[5px] px-1.5 py-0.5">{it.code}</span>
                    {i && (
                      <span className={`pill text-[10px] font-semibold px-2 py-0.5 rounded-full ${i.risk === "Low" ? "bg-green-bg text-gain" : i.risk === "Medium" ? "bg-amber-bg text-amber-d" : "bg-loss-bg text-loss-d"}`}>
                        {i.risk} risk
                      </span>
                    )}
                  </div>

                  <div className="text-xs font-semibold text-ink leading-tight truncate">{i?.hook}</div>

                  <div className="grid grid-cols-3 gap-2 py-1 select-none">
                    <div>
                      <div className="text-[10px] uppercase font-mono text-mut">Allocate</div>
                      <div className="font-mono font-bold text-xs text-ink">${it.allocAmt.toLocaleString("en-AU")}</div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase font-mono text-mut">Target</div>
                      <div className="font-mono font-bold text-xs text-ink">
                        {it.target ? `$${it.target.toFixed(2)}` : "deal"}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] uppercase font-mono text-mut">By</div>
                      <div className="font-mono font-bold text-xs text-ink">
                        {it.date.toLocaleDateString("en-AU", { day: "numeric", month: "short" })}
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={() => handleOpenDeploy(it.code, it.allocAmt)}
                    className="w-full btn bg-green hover:shadow-lg text-[#08130e] font-semibold py-2 rounded-lg text-xs cursor-pointer select-none"
                  >
                    Deploy ${it.allocAmt.toLocaleString("en-AU")} &rarr;
                  </button>
                </div>
              );
            })}
          </div>

          {/* Targets Checklist */}
          <div className="border-t border-line pt-4 space-y-3">
            <div className="flex justify-between items-center text-xs select-none">
              <b className="text-sm font-semibold text-ink">Your targets</b>
              <span className="text-mut font-semibold">
                {plan.items.filter(it => isHoldingStock(it.code)).length + (planProgress >= 98 ? 1 : 0)} of {plan.items.length + 1} reached
              </span>
            </div>

            <div className="space-y-2 select-none">
              {/* Deploy Target */}
              <div className="space-y-1">
                <div className="flex items-center gap-2.5 text-xs text-ink font-semibold">
                  <span className={`w-4.5 h-4.5 rounded-md border flex items-center justify-center text-[10px] ${planProgress >= 98 ? "bg-green text-white border-green" : "border-line-2 text-transparent bg-white"}`}>
                    {planProgress >= 98 && "✓"}
                  </span>
                  <span>Deploy ${plan.amount.toLocaleString("en-AU")} into the market</span>
                  {planProgress < 98 && <span className="ml-auto font-mono text-green-d text-[11px] font-bold">{planProgress}%</span>}
                </div>
                {planProgress < 98 && (
                  <div className="prog h-1.5 w-full bg-paper-2 rounded-full overflow-hidden">
                    <div style={{ width: `${planProgress}%` }} className="prog-fill h-full bg-green rounded-full" />
                  </div>
                )}
              </div>

              {/* Individual Positions Targets */}
              {plan.items.map(it => {
                const reached = isHoldingStock(it.code);
                return (
                  <div key={it.code} className="flex items-center gap-2.5 text-xs text-ink font-semibold">
                    <span className={`w-4.5 h-4.5 rounded-md border flex items-center justify-center text-[10px] ${reached ? "bg-green text-white border-green" : "border-line-2 text-transparent bg-white"}`}>
                      {reached && "✓"}
                    </span>
                    <span className={reached ? "text-mut line-through" : ""}>Establish your {it.code} position</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className="card bg-navy text-[#dfe2ee] border-navy p-5 rounded-[14px] shadow-shadow space-y-3 relative overflow-hidden">
          <div className="absolute inset-0 pointer-events-none opacity-5 bg-linear-to-r from-green to-transparent" />
          <div className="max-w-125 space-y-1">
            <h3 className="font-disp font-medium text-xl text-white">Put your capital to work, with a plan</h3>
            <p className="text-xs text-slate-300 leading-relaxed">
              Tell us how much to deploy and what you’re after. We’ll return 3–4 recommendations across short, medium and long horizons — each with a target and a date.
            </p>
          </div>
          <button 
            onClick={handleOpenBuilder}
            className="btn bg-green text-[#08130e] hover:shadow-lg font-semibold py-2.5 px-4.5 rounded-[10px] text-xs cursor-pointer select-none"
          >
            Build my plan &rarr;
          </button>
        </div>
      )}

      {/* Idea of the Week */}
      <div className="space-y-2">
        <div className="font-mono text-[11px] tracking-wider uppercase text-mut">Idea of the week</div>
        <div className="card bg-white border border-green/30 rounded-[14px] p-5 shadow-shadow hover:border-green transition-colors">
          <div className="flex gap-4 items-start flex-wrap">
            <div className="flex-1 min-w-55 space-y-2 select-none">
              <div className="flex items-center gap-2">
                <span className="code text-[17px] bg-paper-2 rounded-[5px] px-1.5 py-0.5 font-bold">{ideaOfWeek.code}</span>
                <span className="pill text-[11px] font-bold bg-[#ece9f3] text-[#5c5775] px-2.5 py-0.5 rounded-full">{ideaOfWeek.theme}</span>
                {ideaOfWeek.deal && (
                  <span className="pill live bg-green-bg text-green-d text-[11px] font-bold px-2 py-0.5 rounded-full inline-flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-green animate-pulse" /> Live deal
                  </span>
                )}
              </div>
              <h3 className="font-disp font-medium text-lg leading-tight text-ink">{ideaOfWeek.hook}</h3>
              <p className="text-xs text-mut leading-relaxed">{ideaOfWeek.thesis}</p>
            </div>

            <div className="w-50 flex-none select-none">
              <div className="bg-paper-2 rounded-[10px] p-3 space-y-1.5 text-xs text-mut font-semibold leading-normal">
                <div className="flex justify-between">
                  <span>Target</span>
                  <b className="font-mono text-ink">{ideaOfWeek.target ? `$${ideaOfWeek.target.toFixed(2)}` : "—"}</b>
                </div>
                <div className="flex justify-between">
                  <span>Upside</span>
                  <b className="font-mono text-gain">+32%</b>
                </div>
                <div className="flex justify-between">
                  <span>Risk</span>
                  <b className="text-ink">{ideaOfWeek.risk}</b>
                </div>
                <div className="flex justify-between">
                  <span>Horizon</span>
                  <b className="text-ink font-medium">{ideaOfWeek.horizon}</b>
                </div>
              </div>

              <button 
                onClick={() => setShowIdeaModal(ideaOfWeek.code)}
                className="w-full btn bg-green hover:shadow-lg text-[#08130e] font-semibold py-2 rounded-lg text-xs cursor-pointer mt-3"
              >
                View idea
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Theme chips filters */}
      <div className="space-y-3 pt-2">
        <div className="flex items-center gap-2 text-xs select-none">
          <span className="font-mono text-[11px] uppercase tracking-wider text-mut font-semibold">Browse:</span>
          <div className="flex flex-wrap gap-2">
            {["All", "Blue chips", "Resources", "Pre-IPO & deals", "Income"].map(t => (
              <button
                key={t}
                onClick={() => setSelectedTheme(t)}
                className={`chip2 text-xs font-semibold px-4.5 py-1.5 rounded-full border border-line-2 cursor-pointer transition-colors ${selectedTheme === t ? "bg-navy text-white border-navy" : "bg-white hover:border-green text-mut"}`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Ideas Grid */}
        <div className="grid sm:grid-cols-2 gap-4">
          {filteredIdeas.map(i => {
            const up = i.target && i.last ? Math.round((i.target / i.last - 1) * 100) : null;
            return (
              <div 
                key={i.code}
                className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow flex flex-col justify-between space-y-3"
              >
                <div className="flex justify-between items-center select-none">
                  <div className="flex items-center gap-2">
                    <span className="code text-[14px] bg-paper-2 rounded-[5px] px-1.5 py-0.5 font-bold">{i.code}</span>
                    <span className="pill text-[9.5px] font-bold bg-paper-2 text-mut px-2 py-0.5 rounded-full">{i.theme}</span>
                  </div>
                  <span className={`pill text-[10px] font-semibold px-2 py-0.5 rounded-full ${i.risk === "Low" ? "bg-green-bg text-gain" : i.risk === "Medium" ? "bg-amber-bg text-amber-d" : "bg-loss-bg text-loss-d"}`}>
                    {i.risk} risk
                  </span>
                </div>

                <div className="font-semibold text-sm text-ink leading-snug">{i.hook}</div>
                <div className="text-[11px] text-mut mt-0.5">{i.name}</div>

                <div className="grid grid-cols-3 gap-2 py-1 select-none">
                  <div>
                    <div className="text-[9.5px] uppercase font-mono text-mut">Target</div>
                    <div className="font-mono font-bold text-xs text-ink">
                      {i.target ? `$${i.target.toFixed(2)}` : "Deal"}
                    </div>
                  </div>
                  <div>
                    <div className="text-[9.5px] uppercase font-mono text-mut">Upside</div>
                    <div className={`font-mono font-bold text-xs ${up && up > 0 ? "text-gain" : "text-ink"}`}>
                      {up ? `+${up}%` : "—"}
                    </div>
                  </div>
                  <div>
                    <div className="text-[9.5px] uppercase font-mono text-mut">Horizon</div>
                    <div className="font-bold text-xs text-ink">{i.horizon}</div>
                  </div>
                </div>

                <div className="flex gap-2 pt-1 select-none">
                  <button 
                    onClick={() => setShowIdeaModal(i.code)}
                    className="btn bg-green hover:shadow-lg text-[#08130e] font-semibold py-1.5 px-3 rounded-lg text-xs cursor-pointer flex-[1.4]"
                  >
                    View idea
                  </button>
                  <button 
                    onClick={() => alert(`${i.code} added to watchlist.`)}
                    className="btn ghost border border-line rounded-lg text-mut hover:border-mut py-1.5 px-3 text-xs font-semibold cursor-pointer flex-1 bg-white"
                  >
                    Watch
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Plan Builder Dialog Modal */}
      {showBuilder && (
        <div className="fixed inset-0 bg-navy/55 backdrop-blur-[2px] z-50 flex items-center justify-center p-4.5">
          <div className="bg-white rounded-2xl max-w-110 w-full p-6 shadow-shadow-lg text-ink space-y-4">
            <h3 className="font-disp font-medium text-lg text-ink">Build my plan</h3>
            <p className="text-xs text-mut leading-normal">
              Tell us the brief. We’ll return 3–4 recommendations across timeframes, each with a target and date.
            </p>

            <div className="space-y-3">
              <div className="space-y-1">
                <label className="block text-xs font-semibold text-ink">Amount to deploy (AUD)</label>
                <input
                  type="text"
                  value={deployAmt}
                  onChange={e => setDeployAmt(e.target.value.replace(/[^0-9,]/g, ""))}
                  className="w-full border border-line-2 bg-white rounded-[9px] px-3.5 py-2 font-mono text-sm focus:border-green focus:outline-none"
                />
                <div className="text-[10px] text-mut">Available cash: ${cash.toLocaleString("en-AU")}</div>
              </div>

              <div className="space-y-1">
                <label className="block text-xs font-semibold text-ink">Objective</label>
                <select
                  value={objective}
                  onChange={e => setObjective(e.target.value)}
                  className="w-full border border-line-2 bg-white rounded-[9px] px-3 py-2 text-sm focus:border-green focus:outline-none"
                >
                  <option value="grow">Grow my money</option>
                  <option value="income">Earn income</option>
                  <option value="early">Get in early (Deals)</option>
                  <option value="steady">Keep it steady</option>
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="block text-xs font-semibold text-ink">Risk tolerance</label>
                  <select
                    value={riskTolerance}
                    onChange={e => setRiskTolerance(e.target.value)}
                    className="w-full border border-line-2 bg-white rounded-[9px] px-3 py-2 text-xs focus:border-green focus:outline-none"
                  >
                    <option>Conservative</option>
                    <option>Balanced</option>
                    <option>Aggressive</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="block text-xs font-semibold text-ink">Primary horizon</label>
                  <select
                    value={horizon}
                    onChange={e => setHorizon(e.target.value)}
                    className="w-full border border-line-2 bg-white rounded-[9px] px-3 py-2 text-xs focus:border-green focus:outline-none"
                  >
                    <option>Short (weeks)</option>
                    <option>Medium (months)</option>
                    <option>Long (1 yr+)</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="flex gap-2.5 pt-2 select-none">
              <button 
                onClick={() => setShowBuilder(false)}
                className="btn border border-line rounded-[10px] py-2 px-4 hover:border-mut text-xs font-semibold cursor-pointer flex-1 bg-white"
              >
                Cancel
              </button>
              <button 
                onClick={handleGeneratePlan}
                className="btn bg-green text-[#08130e] hover:shadow-lg rounded-[10px] py-2 px-4 text-xs font-semibold cursor-pointer flex-1.5"
              >
                Generate plan
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Idea Detail Modal */}
      {showIdeaModal && (
        <div className="fixed inset-0 bg-navy/55 backdrop-blur-[2px] z-50 flex items-center justify-center p-4.5">
          {(() => {
            const i = db.ideas.find(x => x.code === showIdeaModal)!;
            const up = i.target && i.last ? Math.round((i.target / i.last - 1) * 100) : null;
            return (
              <div className="bg-white rounded-2xl max-w-110 w-full p-6 shadow-shadow-lg text-ink space-y-4" onClick={e => e.stopPropagation()}>
                <div className="flex items-center gap-2.5 flex-wrap">
                  <span className="code text-lg bg-paper-2 rounded-[5px] px-2 py-0.5">{i.code}</span>
                  <span className={`pill text-[10px] font-semibold px-2 py-0.5 rounded-full bg-paper-2 text-mut`}>{i.theme}</span>
                  {i.deal && (
                    <span className="pill live bg-green-bg text-green-d text-[11px] font-bold px-2 py-0.5 rounded-full inline-flex items-center gap-1">
                      Live deal
                    </span>
                  )}
                </div>

                <div>
                  <h3 className="font-disp font-medium text-lg leading-tight text-ink">{i.hook}</h3>
                  <p className="text-xs text-mut mt-0.5">{i.name}</p>
                </div>

                <p className="text-xs text-mut leading-relaxed">{i.thesis}</p>

                <div className="divide-y divide-line text-xs font-medium leading-normal">
                  <div className="flex justify-between py-2">
                    <span className="text-mut">Entry range</span>
                    <b className="font-mono text-ink">
                      {i.entryLo ? `$${i.entryLo.toFixed(2)}–$${i.entryHi!.toFixed(2)}` : `Deal Price $${(db.placements.find(p => p.id === i.deal)?.price || 0).toFixed(2)}`}
                    </b>
                  </div>
                  <div className="flex justify-between py-2">
                    <span className="text-mut">Price target</span>
                    <b className="font-mono text-ink">{i.target ? `$${i.target.toFixed(2)}` : "—"}</b>
                  </div>
                  <div className="flex justify-between py-2">
                    <span className="text-mut">Implied upside</span>
                    <b className="font-mono text-gain">{up ? `+${up}%` : "—"}</b>
                  </div>
                  <div className="flex justify-between py-2">
                    <span className="text-mut">Time horizon</span>
                    <b>{i.horizon}</b>
                  </div>
                </div>

                <div className="flex gap-2.5 pt-2 select-none">
                  <button 
                    onClick={() => setShowIdeaModal(null)}
                    className="btn border border-line rounded-[10px] py-2 px-4 hover:border-mut text-xs font-semibold cursor-pointer flex-1 bg-white"
                  >
                    Close
                  </button>
                  <button 
                    onClick={() => {
                      setShowIdeaModal(null);
                      handleOpenDeploy(i.code, 15000);
                    }}
                    className="btn bg-green text-[#08130e] hover:shadow-lg rounded-[10px] py-2 px-4 text-xs font-semibold cursor-pointer flex-1.5"
                  >
                    Invest &rarr;
                  </button>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* Deploy Money Modal */}
      {showDeployModal && (
        <div className="fixed inset-0 bg-navy/55 backdrop-blur-[2px] z-50 flex items-center justify-center p-4.5">
          <div className="bg-white rounded-2xl max-w-110 w-full p-6 shadow-shadow-lg text-ink space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="font-disp font-medium text-lg text-ink">Invest in {showDeployModal.code}</h3>
            <p className="text-xs text-mut">
              Execute order with the Vitti desk
            </p>

            <div className="space-y-1">
              <label className="block text-xs font-semibold text-ink">Amount to invest (AUD)</label>
              <input
                type="text"
                value={investOrderAmt}
                onChange={e => setInvestOrderAmt(e.target.value.replace(/[^0-9,]/g, ""))}
                className="w-full border border-line-2 bg-white rounded-[9px] px-3.5 py-2.5 font-mono text-sm focus:border-green focus:outline-none"
              />
              <div className="text-[10px] text-mut">
                Your order is routed directly to the Vitti desk for execution at market prices.
              </div>
            </div>

            <div className="flex gap-2.5 pt-2 select-none">
              <button 
                onClick={() => setShowDeployModal(null)}
                className="btn border border-line rounded-[10px] py-2 px-4 hover:border-mut text-xs font-semibold cursor-pointer flex-1 bg-white"
              >
                Cancel
              </button>
              <button 
                onClick={handleExecuteDeploy}
                className="btn bg-green text-[#08130e] hover:shadow-lg rounded-[10px] py-2 px-4 text-xs font-semibold cursor-pointer flex-1.5"
              >
                Place order
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
