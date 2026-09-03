"use client";

import { useMemo, useState } from "react";
import type { Position, SignalRow } from "@/lib/data/queries";
import { posValue, posCost, posPL } from "@/lib/data/compute";
import type { ClientPortfolio } from "@/lib/pnl/client-portfolio";
import { TablePagination } from "@/app/components/TablePagination";

const money0 = (n: number) => `$${Math.round(n).toLocaleString("en-AU")}`;
const qty0 = (n: number) => (n ? Math.round(n).toLocaleString("en-AU") : "—");

/**
 * A return as a percentage of cost, or null when there is no cost to divide by.
 *
 * Free placement options have a cost base of zero, so `pl / cost` was `Infinity`
 * — and `0 / 0` was `NaN`. Both reached the screen: the Top movers table read
 * `+Infinity%` on three rows and `+NaN%` on a fourth, and because it SORTED by
 * that percentage the infinities took every top slot, so the one thing the table
 * exists to show was pushed off it entirely.
 */
const returnPct = (pl: number, cost: number): number | null =>
  cost > 0 && Number.isFinite(pl / cost) ? (pl / cost) * 100 : null;

const pct1 = (n: number | null) => (n === null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`);

// Reusable Donut Chart Component
const DonutChart = ({ segs, size = 128, thick = 18 }: { segs: { label: string; v: number; col: string }[]; size?: number; thick?: number }) => {
  const r = (size - thick) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const C = 2 * Math.PI * r;
  const total = segs.reduce((sum, s) => sum + s.v, 0);
  const segsWithOffsets = segs.map((s, idx) => {
    const frac = total ? s.v / total : 0;
    const len = frac * C;
    const offset = segs.slice(0, idx).reduce((sum, prev) => {
      const prevFrac = total ? prev.v / total : 0;
      return sum + prevFrac * C;
    }, 0);
    return { ...s, len, offset };
  });

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {segsWithOffsets.map((s, idx) => (
        <circle
          key={idx}
          cx={cx}
          cy={cy}
          r={r}
          fill="none"
          stroke={s.col}
          strokeWidth={thick}
          strokeDasharray={`${s.len} ${C - s.len}`}
          strokeDashoffset={-s.offset}
          transform={`rotate(-90 ${cx} ${cy})`}
        />
      ))}
    </svg>
  );
};

export function PositionsClient({
  positions,
  cash,
  unlisted,
  signals,
  portfolio,
}: {
  positions: Position[];
  cash: number;
  unlisted: number;
  signals: Record<string, SignalRow>;
  /** The desk's own stored figures — see lib/pnl/client-portfolio.ts. */
  portfolio: ClientPortfolio;
}) {
  const [tab, setTab] = useState<"holdings" | "pnl" | "analytics">("holdings");
  const [selectedHolding, setSelectedHolding] = useState<string | null>(null);

  // Search + paging per table. A client with a long history has hundreds of P&L
  // lines — one tested account has 334 — and scrolling is not a way to find a
  // ticker in that.
  const [holdSearch, setHoldSearch] = useState("");
  const [holdPage, setHoldPage] = useState(1);
  const [holdSize, setHoldSize] = useState(25);
  const [pnlSearch, setPnlSearch] = useState("");
  const [pnlPage, setPnlPage] = useState(1);
  const [pnlSize, setPnlSize] = useState(25);

  // Custom states for trade execution inside modal
  const [isTradeModalOpen, setIsTradeModalOpen] = useState(false);
  const [tradeAction, setTradeAction] = useState<"Buy" | "Sell">("Buy");
  const [tradeAmount, setTradeAmount] = useState("10,000");

  // Market value of what is held right now. Cost base and P&L deliberately do
  // NOT come from here any more — see below.
  let tv = 0;
  positions.forEach(p => {
    tv += posValue(p);
  });

  // The desk's stored figures. Cost base and P&L come from here rather than from
  // `tv` above, so this page and the adviser's screen cannot report different
  // returns on the same holdings.
  const deskCost = portfolio.total.buyPrice;
  const deskPnl = portfolio.total.pnl;
  const deskPnlPct = deskCost > 0 ? (deskPnl / deskCost) * 100 : 0;

  const handleOpenHolding = (code: string) => {
    setSelectedHolding(code);
  };

  const handleCloseHolding = () => {
    setSelectedHolding(null);
  };

  const getActionPill = (action: string) => {
    const maps: Record<string, string> = {
      Add: "bg-green-bg text-green-d",
      Hold: "bg-paper-2 text-mut",
      Trim: "bg-amber-bg text-amber-d",
      "Take profit": "bg-amber-bg text-amber-d",
      Watch: "bg-[#ece9f3] text-[#5c5775]"
    };
    return (
      <span className={`pill px-2.5 py-0.5 rounded-full text-[11.5px] font-semibold tracking-wide ${maps[action] || "bg-paper-2 text-mut"}`}>
        {action}
      </span>
    );
  };

  // Run calculation for trade amount
  const tradeCalculatedShares = () => {
    const raw = tradeAmount.replace(/[^0-9]/g, "");
    const amt = raw ? parseInt(raw, 10) : 0;
    const p = positions.find(pos => pos.code === selectedHolding);
    if (!p || !p.last) return 0;
    return Math.round(amt / p.last);
  };

  const executeTradeOrder = () => {
    const p = positions.find(pos => pos.code === selectedHolding);
    if (!p) return;
    const raw = tradeAmount.replace(/[^0-9]/g, "");
    const amt = raw ? parseInt(raw, 10) : 0;
    if (!amt) return;

    // Simulate ordering (in reality we would mutate the DB, but since we are doing standard controlled simulation we can alert and log)
    alert(`Order placed: ${tradeAction === "Buy" ? "Buy" : "Sell"} ${tradeAction === "Buy" ? "$" : ""}${amt.toLocaleString("en-AU")} of ${selectedHolding} routed to the Vitti desk.`);

    setIsTradeModalOpen(false);
    handleCloseHolding();
  };

  // Render analytics view
  /**
   * The desk's own P&L table, for this client.
   *
   * Same rows, same rollup and same corrections as the staff console — see
   * lib/pnl/client-portfolio.ts — minus the desk's working notes. Sorted by
   * absolute P&L so the positions that moved the total are at the top, which is
   * the order somebody reads their own return in.
   */
  const holdingRows = useMemo(() => {
    const q = holdSearch.trim().toLowerCase();
    if (!q) return positions;
    return positions.filter(
      (p) =>
        p.code.toLowerCase().includes(q) || (p.name ?? "").toLowerCase().includes(q),
    );
  }, [positions, holdSearch]);

  const pnlRows = useMemo(() => {
    const q = pnlSearch.trim().toLowerCase();
    return [...portfolio.rows]
      .filter(
        (r) =>
          !q || r.ticker.toLowerCase().includes(q) || r.name.toLowerCase().includes(q),
      )
      .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
  }, [portfolio.rows, pnlSearch]);

  const renderPnl = () => {
    const rows = pnlRows;
    const page = rows.slice((pnlPage - 1) * pnlSize, (pnlPage - 1) * pnlSize + pnlSize);

    return (
      <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
        <div className="flex justify-between items-center px-4.5 py-4 border-b border-line bg-white select-none flex-wrap gap-2">
          <div>
            <b className="text-ink text-sm font-semibold">Profit &amp; loss</b>
            <p className="text-xs text-mut mt-0.5">
              Every parcel across your accounts — sold and still held.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="search"
              value={pnlSearch}
              onChange={(e) => {
                setPnlSearch(e.target.value);
                setPnlPage(1);
              }}
              placeholder="Search ticker or name"
              aria-label="Search profit and loss"
              className="w-46 border border-line-2 bg-white rounded-[9px] px-3 py-2 text-xs focus:border-green focus:outline-none transition-colors"
            />
            <span className="text-mut text-xs font-medium whitespace-nowrap">{rows.length} lines</span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[12.5px] font-medium">
            <thead>
              <tr className="border-b border-line text-mut select-none">
                <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3">Holding</th>
                <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right hidden sm:table-cell">Bought</th>
                <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right hidden sm:table-cell">Sold</th>
                <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right hidden md:table-cell">Held</th>
                <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right">Cost</th>
                <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right">Proceeds / value</th>
                <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right">P&amp;L</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#f0ede5]">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center text-mut py-6">
                    {pnlSearch.trim()
                      ? `Nothing matches "${pnlSearch.trim()}".`
                      : "No figures yet. Your P&L appears once Vitti has processed your first contract notes."}
                  </td>
                </tr>
              ) : (
                page.map((r) => (
                  <tr key={`${r.ticker}-${r.type}`} className="hover:bg-[#faf9f5]">
                    <td className="px-4.5 py-3.5">
                      <span className="code text-[13px] bg-paper-2 rounded-[5px] px-1.5 py-0.5">{r.ticker}</span>
                      <div className="text-[10.5px] text-mut mt-1">
                        {r.name}
                        {r.openPosition && " · open"}
                        {r.type.toLowerCase().includes("option") && " · option"}
                      </div>
                    </td>
                    <td className="px-4.5 py-3.5 text-right font-mono hidden sm:table-cell">{qty0(r.buyQty)}</td>
                    <td className="px-4.5 py-3.5 text-right font-mono hidden sm:table-cell">{qty0(r.sellQty)}</td>
                    <td className="px-4.5 py-3.5 text-right font-mono hidden md:table-cell">{qty0(r.heldQty)}</td>
                    <td className="px-4.5 py-3.5 text-right font-mono">{money0(r.buyPrice)}</td>
                    <td className="px-4.5 py-3.5 text-right font-mono">{money0(r.sellOrCurrent)}</td>
                    <td className={`px-4.5 py-3.5 text-right font-mono font-semibold ${r.pnl >= 0 ? "text-gain" : "text-loss-d"}`}>
                      {r.pnl >= 0 ? "+" : ""}{money0(r.pnl)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-line bg-paper-2 font-semibold">
                  {/* Always the whole portfolio, never the page or the search
                      result — a footer that silently totalled 25 of 334 lines
                      would be a different number every time you paged. */}
                  <td className="px-4.5 py-3.5 text-ink" colSpan={4}>
                    Total{rows.length !== portfolio.rows.length ? " (all lines)" : ""}
                  </td>
                  <td className="px-4.5 py-3.5 text-right font-mono text-ink hidden sm:table-cell">{money0(portfolio.total.buyPrice)}</td>
                  <td className="px-4.5 py-3.5 text-right font-mono text-ink">{money0(portfolio.total.sellOrCurrent)}</td>
                  <td className={`px-4.5 py-3.5 text-right font-mono ${portfolio.total.pnl >= 0 ? "text-gain" : "text-loss-d"}`}>
                    {portfolio.total.pnl >= 0 ? "+" : ""}{money0(portfolio.total.pnl)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        <TablePagination
          totalItems={rows.length}
          currentPage={pnlPage}
          pageSize={pnlSize}
          onPageChange={setPnlPage}
          onPageSizeChange={(size) => {
            setPnlSize(size);
            setPnlPage(1);
          }}
          pageSizeOptions={[10, 25, 50, 100, 1000]}
          itemLabel="lines"
        />

        {/* A total that quietly omits a holding is worse than one that says so. */}
        {portfolio.outsideTotal > 0 && (
          <div className="px-4.5 py-3 border-t border-line text-xs text-mut leading-relaxed">
            {portfolio.outsideTotal} line{portfolio.outsideTotal === 1 ? " is" : "s are"} outside
            the total while Vitti confirms {portfolio.outsideTotal === 1 ? "its" : "their"} cost
            base. Ask your adviser if you would like the detail.
          </div>
        )}
      </div>
    );
  };

  const renderAnalytics = () => {
    // `unlisted || totalAssets * 0.04` used to sit in the middle row — a
    // hardcoded 4% invented whenever the real figure was zero, and not included
    // in `totalAssets`, so the three shares read 100% / 4% / 0% and summed to
    // 104%. Real values only, and the percentages are taken against the sum of
    // the slices actually drawn, so they add up.
    const allocSegs = [
      { label: "Listed equities", v: tv, col: "#1d202f" },
      { label: "Unlisted / options", v: unlisted, col: "#36bb91" },
      { label: "Cash", v: cash, col: "#cfc9bb" },
    ];
    const allocTotal = allocSegs.reduce((sum, a) => sum + a.v, 0);
    const alloc = allocSegs.filter((a) => a.v > 0);
    const share = (v: number) => (allocTotal > 0 ? Math.round((v / allocTotal) * 100) : 0);

    /**
     * Sector exposure, by market value of what is held.
     *
     * `p.sector` rolls a derivative up to its ordinary (see `toPosition`), so an
     * option grant counts as exposure to the underlying's sector — which is the
     * question this chart is asking. Positions worth nothing are left out: a
     * zero-value slice is invisible in the pie and a 0% line in the legend.
     *
     * Labels are no longer cut at the first word, where "Health Care" and
     * "Health Insurance" both rendered as "Health".
     */
    const sectorTotals: Record<string, number> = {};
    positions.forEach(p => {
      const v = posValue(p);
      if (v <= 0) return;
      const sector = p.sector ?? "Other";
      sectorTotals[sector] = (sectorTotals[sector] || 0) + v;
    });

    const palette = ["#1d202f", "#36bb91", "#c98a2b", "#5c5775", "#1f8e6b", "#9aa0b4", "#b8543f", "#4a7fb5"];
    const sectorArr = Object.keys(sectorTotals)
      .map(k => ({ label: k, v: sectorTotals[k] }))
      .sort((a, b) => b.v - a.v);
    const sectorWithColors = sectorArr.map((x, i) => ({ ...x, col: palette[i % palette.length] }));
    const sectorTotal = sectorArr.reduce((sum, x) => sum + x.v, 0);

    // `securities.sector` was NULL on all 775 rows until `npm run
    // backfill:sectors` was written to fill it from Yahoo, and any name Yahoo
    // cannot classify stays NULL by design. Where NOTHING is classified the
    // chart would be one slice reading "Other 100%", which looks broken rather
    // than empty — so it says which it is instead of drawing that.
    const hasSectors = sectorArr.some((x) => x.label !== "Other");

    /**
     * Where the P&L actually comes from — closed parcels vs still-held, and
     * equities vs option grants.
     *
     * This replaces a "Portfolio growth" card whose curve was a hardcoded SVG
     * path (`M0 96 L100 90 … L600 18`) under the caption "Up +6.4% over 12
     * months" — the same invented 6.4% the dashboard was showing. There is no
     * price history in this app to draw a growth curve from, and `pnl_runs` is a
     * record of when the desk RECOMPUTED rather than of how the market moved, so
     * charting it as growth would be a second wrong answer. This is the same
     * total, split four ways, and every number in it is one the desk stands
     * behind.
     */
    const isOption = (t: string) => t.toLowerCase().includes("option");
    const split = [
      {
        label: "Closed",
        v: portfolio.rows.filter((r) => !r.openPosition && !isOption(r.type)).reduce((n, r) => n + r.pnl, 0),
      },
      {
        label: "Still held",
        v: portfolio.rows.filter((r) => r.openPosition && !isOption(r.type)).reduce((n, r) => n + r.pnl, 0),
      },
      {
        label: "Options",
        v: portfolio.rows.filter((r) => isOption(r.type)).reduce((n, r) => n + r.pnl, 0),
      },
    ];
    const splitMax = Math.max(...split.map((x) => Math.abs(x.v)), 1);

    // Sorted by the SIZE of the move, not by percentage. Sorting by percentage
    // put the zero-cost rows — whose percentage was `Infinity` — in every top
    // slot, so the table showed free option grants instead of the positions that
    // actually moved the portfolio.
    const movers = positions
      .map(p => ({
        code: p.code,
        pl: posPL(p),
        plp: returnPct(posPL(p), posCost(p)),
      }))
      .sort((a, b) => Math.abs(b.pl) - Math.abs(a.pl));

    return (
      <div className="space-y-4 select-none">
        {/* Split grid for allocation and sector */}
        <div className="grid md:grid-cols-2 gap-4">
          <div className="card bg-white border border-line rounded-[14px] p-5 shadow-shadow">
            <div className="flex justify-between items-center text-xs mb-3">
              <b className="text-sm font-semibold text-ink">Asset allocation</b>
              <span className="text-mut font-mono">${Math.round(allocTotal).toLocaleString("en-AU")}</span>
            </div>

            <div className="flex gap-5 items-center flex-wrap">
              <div className="relative flex-none">
                <DonutChart segs={alloc} size={128} thick={18} />
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <div className="font-mono font-bold text-base text-ink">{share(tv)}%</div>
                  <div className="text-[9.5px] text-mut uppercase font-semibold">equities</div>
                </div>
              </div>

              <div className="flex-1 min-w-37.5 space-y-2">
                {alloc.length === 0 ? (
                  <p className="text-xs text-mut leading-relaxed">
                    Nothing held in this account right now.
                  </p>
                ) : (
                  alloc.map(a => (
                    <div key={a.label} className="flex items-center gap-2 text-xs font-medium text-ink">
                      <i style={{ backgroundColor: a.col }} className="w-2.5 h-2.5 rounded-[3px] block flex-none" />
                      <span>{a.label}</span>
                      <b className="ml-auto font-mono text-[13px] font-semibold">{share(a.v)}%</b>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          <div className="card bg-white border border-line rounded-[14px] p-5 shadow-shadow flex flex-col">
            <div className="flex justify-between items-center text-xs mb-3">
              <b className="text-sm font-semibold text-ink">Sector exposure</b>
              <span className="text-mut font-mono">${Math.round(sectorTotal).toLocaleString("en-AU")}</span>
            </div>

            {hasSectors ? (
              <div className="flex gap-5 items-center flex-wrap">
                {/* A pie, not a donut: `thick = size / 2` takes the inner radius
                    to zero, so the same component draws both and the two cards
                    on this row stay visually of a piece. */}
                <div className="flex-none">
                  <DonutChart segs={sectorWithColors} size={128} thick={64} />
                </div>

                <div className="flex-1 min-w-37.5 space-y-2">
                  {sectorWithColors.map(x => (
                    <div key={x.label} className="flex items-center gap-2 text-xs font-medium text-ink">
                      <i style={{ backgroundColor: x.col }} className="w-2.5 h-2.5 rounded-[3px] block flex-none" />
                      <span className="truncate" title={x.label}>{x.label}</span>
                      <b className="ml-auto font-mono text-[13px] font-semibold whitespace-nowrap">
                        {sectorTotal > 0 ? Math.round((x.v / sectorTotal) * 100) : 0}%
                      </b>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex-1 flex items-center">
                <p className="text-xs text-mut leading-relaxed">
                  Sector classifications are not on file for these holdings yet, so
                  there is nothing to break down. Your adviser can tell you the
                  exposure in the meantime.
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Bottom split: Movers and Growth */}
        <div className="grid md:grid-cols-2 gap-4">
          <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
            <div className="flex justify-between items-center px-4.5 py-3 border-b border-line">
              <b className="text-sm font-semibold text-ink">Top movers</b>
              <span className="text-mut text-xs font-semibold">unrealised, this account</span>
            </div>
            <table className="w-full border-collapse text-left text-xs font-medium">
              <tbody className="divide-y divide-[#f0ede5]">
                {movers.slice(0, 5).map(m => {
                  const isUp = m.pl >= 0;
                  return (
                    <tr key={m.code}>
                      <td className="px-4.5 py-3"><span className="code text-[12.5px] bg-paper-2 rounded-[5px] px-1.5 py-0.5">{m.code}</span></td>
                      <td className={`px-4.5 py-3 text-right font-mono text-[13px] ${isUp ? "text-gain" : "text-loss-d"}`}>
                        {isUp ? "+" : ""}${Math.round(m.pl).toLocaleString("en-AU")}
                      </td>
                      <td className={`px-4.5 py-3 text-right font-mono text-[13px] ${m.plp === null ? "text-mut" : isUp ? "text-gain" : "text-loss-d"}`}>
                        {pct1(m.plp)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="card bg-white border border-line rounded-[14px] p-5 shadow-shadow space-y-3">
            <div className="flex justify-between items-center text-xs">
              <b className="text-sm font-semibold text-ink">Where the P&amp;L comes from</b>
              <span className="text-mut font-semibold">all accounts</span>
            </div>

            <div className="space-y-2.5 pt-1">
              {split.map((x) => {
                const up = x.v >= 0;
                return (
                  <div key={x.label} className="space-y-1">
                    <div className="flex justify-between items-baseline text-xs font-medium">
                      <span className="text-ink">{x.label}</span>
                      <b className={`font-mono text-[13px] ${up ? "text-gain" : "text-loss-d"}`}>
                        {up ? "+" : ""}{money0(x.v)}
                      </b>
                    </div>
                    {/* Centre line, so a loss reads as a bar going the other way
                        rather than as a smaller gain. */}
                    <div className="relative h-1.5 bg-paper-2 rounded-full overflow-hidden">
                      <div
                        className="absolute top-0 h-full rounded-full"
                        style={{
                          width: `${(Math.abs(x.v) / splitMax) * 50}%`,
                          left: up ? "50%" : undefined,
                          right: up ? undefined : "50%",
                          backgroundColor: up ? "var(--color-green)" : "var(--color-loss)",
                        }}
                      />
                      <div className="absolute left-1/2 top-0 h-full w-px bg-line-2" />
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex justify-between items-baseline text-xs pt-2 border-t border-line">
              <span className="text-mut font-semibold">Total</span>
              <b className={`font-mono text-[13px] ${deskPnl >= 0 ? "text-gain" : "text-loss-d"}`}>
                {deskPnl >= 0 ? "+" : ""}{money0(deskPnl)}
              </b>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const selectedStock = positions.find(pos => pos.code === selectedHolding);
  const advice = selectedHolding ? signals[selectedHolding] : null;

  return (
    <div className="space-y-4">
      {/* Page Header */}
      <div className="flex justify-between items-end gap-3 flex-wrap">
        <div>
          <div className="font-mono text-xs tracking-wider uppercase text-mut">Listed equities &middot; broker feed</div>
          <h1 className="font-disp font-medium text-[26px] mt-0.5 text-ink">Portfolio</h1>
        </div>

        {/* Tabs switcher */}
        <div className="inline-flex bg-paper-2 rounded-[9px] p-0.75">
          <button
            onClick={() => setTab("holdings")}
            className={`text-xs font-semibold px-4 py-2 rounded-[7px] cursor-pointer transition-colors ${tab === "holdings" ? "bg-white text-ink shadow-shadow" : "text-mut hover:text-ink"}`}
          >
            Holdings
          </button>
          <button
            onClick={() => setTab("pnl")}
            className={`text-xs font-semibold px-4 py-2 rounded-[7px] cursor-pointer transition-colors ${tab === "pnl" ? "bg-white text-ink shadow-shadow" : "text-mut hover:text-ink"}`}
          >
            Profit &amp; loss
          </button>
          <button
            onClick={() => setTab("analytics")}
            className={`text-xs font-semibold px-4 py-2 rounded-[7px] cursor-pointer transition-colors ${tab === "analytics" ? "bg-white text-ink shadow-shadow" : "text-mut hover:text-ink"}`}
          >
            Analytics
          </button>
        </div>
      </div>

      {/* KPI Cards Grid

          The first three are the desk's own Grand Total and are the SAME
          question — cost, what it came to, the difference. They were briefly
          shown beside "Market value", which is a different question entirely
          (current holdings of ONE account at last price), and the pair read as a
          catastrophe: $3,289 next to a $9.9M lifetime cost base. Comparable
          figures sit together; the account's current value is labelled as what
          it is and put last. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Cost base</div>
          <div className="font-disp font-medium text-2xl mt-1 text-ink">{money0(deskCost)}</div>
          <div className="text-xs text-mut mt-1">invested, all accounts</div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Proceeds &amp; value</div>
          <div className="font-disp font-medium text-2xl mt-1 text-ink">{money0(portfolio.total.sellOrCurrent)}</div>
          <div className="text-xs text-mut mt-1">sold, plus what is still held</div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Profit &amp; loss</div>
          <div className={`font-disp font-medium text-2xl mt-1 ${deskPnl >= 0 ? "text-gain" : "text-loss-d"}`}>
            {deskPnl >= 0 ? "+" : ""}{money0(deskPnl)}
          </div>
          <div className={`text-xs mt-1 font-mono ${deskPnl >= 0 ? "text-gain" : "text-loss-d"}`}>
            {deskPnl >= 0 ? "+" : ""}{deskPnlPct.toFixed(1)}% &middot; realised + open
          </div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">This account now</div>
          <div className="font-disp font-medium text-2xl mt-1 text-ink">${Math.round(tv + cash).toLocaleString("en-AU")}</div>
          <div className="text-xs text-mut mt-1">
            {positions.length} holding{positions.length === 1 ? "" : "s"} + cash, at last price
          </div>
        </div>
      </div>

      {/* Render selected Tab content */}
      {tab === "analytics" ? (
        renderAnalytics()
      ) : tab === "pnl" ? (
        renderPnl()
      ) : (
        <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
          <div className="flex justify-between items-center px-4.5 py-4 border-b border-line bg-white select-none flex-wrap gap-2">
            <div>
              <b className="text-ink text-sm font-semibold">Holdings</b>
              <p className="text-xs text-mut mt-0.5">Tap a holding for Vitti&apos;s view</p>
            </div>
            <input
              type="search"
              value={holdSearch}
              onChange={(e) => {
                setHoldSearch(e.target.value);
                setHoldPage(1);
              }}
              placeholder="Search ticker or name"
              aria-label="Search holdings"
              className="w-46 border border-line-2 bg-white rounded-[9px] px-3 py-2 text-xs focus:border-green focus:outline-none transition-colors"
            />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-[12.5px] font-medium">
              <thead>
                <tr className="border-b border-line text-mut select-none">
                  <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3">Code</th>
                  <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 hidden sm:table-cell">Holding</th>
                  <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right">Qty</th>
                  <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right hidden sm:table-cell">Last</th>
                  <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right">Value</th>
                  <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right">Unreal. P&amp;L</th>
                  <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-center">Vitti View</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f0ede5]">
                {holdingRows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="text-center text-mut py-6">
                      {holdSearch.trim()
                        ? `Nothing matches "${holdSearch.trim()}".`
                        : "No holdings in this account."}
                    </td>
                  </tr>
                )}
                {holdingRows
                  .slice((holdPage - 1) * holdSize, (holdPage - 1) * holdSize + holdSize)
                  .map(p => {
                  const pl = posPL(p);
                  const plp = returnPct(pl, posCost(p));
                  const val = posValue(p);
                  const isUp = pl >= 0;
                  const sg = signals[p.code];
                  return (
                    <tr
                      key={p.code}
                      onClick={() => handleOpenHolding(p.code)}
                      className="hover:bg-[#faf9f5] cursor-pointer transition-colors"
                    >
                      <td className="px-4.5 py-3"><span className="code text-[13px] bg-paper-2 rounded-[5px] px-1.5 py-0.5">{p.code}</span></td>
                      <td className="px-4.5 py-3 hidden sm:table-cell text-mut">
                        <span className="text-ink font-semibold">{p.name}</span>
                        <div className="text-[10.5px] mt-0.5">{p.sector ?? "—"}</div>
                      </td>
                      <td className="px-4.5 py-3 text-right font-mono">{p.qty.toLocaleString("en-AU")}</td>
                      <td className="px-4.5 py-3 text-right font-mono hidden sm:table-cell">${(p.last ?? 0).toFixed(2)}</td>
                      <td className="px-4.5 py-3 text-right font-mono font-semibold">${Math.round(val).toLocaleString("en-AU")}</td>
                      <td className={`px-4.5 py-3 text-right font-mono ${isUp ? "text-gain" : "text-loss-d"}`}>
                        ${Math.round(pl).toLocaleString("en-AU")}
                        <div className="text-[10.5px]">{pct1(plp)}</div>
                      </td>
                      <td className="px-4.5 py-3 text-center">
                        {getActionPill(sg ? sg.action : "Hold")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <TablePagination
            totalItems={holdingRows.length}
            currentPage={holdPage}
            pageSize={holdSize}
            onPageChange={setHoldPage}
            onPageSizeChange={(size) => {
              setHoldSize(size);
              setHoldPage(1);
            }}
            pageSizeOptions={[10, 25, 50, 100, 1000]}
            itemLabel="holdings"
          />
        </div>
      )}

      {/* Holdings Detailed Advice Modal */}
      {selectedStock && advice && (
        <div className="fixed inset-0 bg-navy/55 backdrop-blur-[2px] z-50 flex items-center justify-center p-4.5">
          <div className="bg-white rounded-2xl max-w-110 w-full p-6 shadow-shadow-lg text-ink space-y-4">
            <div className="flex items-center gap-2.5">
              <span className="code text-lg bg-paper-2 rounded-[5px] px-2 py-0.5">{selectedHolding}</span>
              {getActionPill(advice.action)}
            </div>

            <div>
              <h3 className="font-disp font-medium text-lg leading-tight text-ink">{selectedStock.name}</h3>
            </div>

            <div className="divide-y divide-line">
              <div className="flex justify-between py-2 text-xs">
                <span className="text-mut font-semibold">Your holding</span>
                <b className="font-mono text-ink font-semibold">
                  {selectedStock.qty.toLocaleString("en-AU")} &middot; ${Math.round(posValue(selectedStock)).toLocaleString("en-AU")}
                </b>
              </div>
              <div className="flex justify-between py-2 text-xs">
                <span className="text-mut font-semibold">Unrealised P&amp;L</span>
                <b className={`font-mono font-semibold ${posPL(selectedStock) >= 0 ? "text-gain" : "text-loss-d"}`}>
                  {posPL(selectedStock) >= 0 ? "+" : ""}${Math.round(posPL(selectedStock)).toLocaleString("en-AU")} ({(posPL(selectedStock) / posCost(selectedStock) * 100).toFixed(1)}%)
                </b>
              </div>
              <div className="flex justify-between py-2 text-xs">
                <span className="text-mut font-semibold">Vitti target</span>
                <b className="font-mono text-ink font-semibold">
                  {advice.target && selectedStock.last
                    ? `$${advice.target.toFixed(2)} · +${Math.round((advice.target / selectedStock.last - 1) * 100)}%`
                    : "—"}
                </b>
              </div>
            </div>

            <div className="space-y-1">
              <div className="font-semibold text-[13.5px] leading-snug">{advice.headline}</div>
              <p className="text-xs text-mut leading-relaxed">{advice.detail}</p>
            </div>

            <div className="flex gap-2.5 pt-2">
              <button
                onClick={handleCloseHolding}
                className="btn border border-line rounded-[10px] py-2 px-4 hover:border-mut text-xs font-semibold cursor-pointer flex-1"
              >
                Close
              </button>

              {advice.action === "Add" && (
                <button
                  onClick={() => {
                    setTradeAction("Buy");
                    setIsTradeModalOpen(true);
                  }}
                  className="btn bg-green text-[#08130e] hover:shadow-lg rounded-[10px] py-2 px-4 text-xs font-semibold cursor-pointer flex-1.5"
                >
                  Add to position &rarr;
                </button>
              )}

              {(advice.action === "Trim" || advice.action === "Take profit") && (
                <button
                  onClick={() => {
                    setTradeAction("Sell");
                    setIsTradeModalOpen(true);
                  }}
                  className="btn bg-navy text-white hover:bg-slate-800 rounded-[10px] py-2 px-4 text-xs font-semibold cursor-pointer flex-1.5"
                >
                  Trim &rarr;
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Trade Execution Modal */}
      {isTradeModalOpen && selectedStock && (
        <div className="fixed inset-0 bg-navy/55 backdrop-blur-[2px] z-50 flex items-center justify-center p-4.5">
          <div className="bg-white rounded-2xl max-w-110 w-full p-6 shadow-shadow-lg text-ink space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="font-disp font-medium text-lg text-ink">
              Route {tradeAction === "Buy" ? "Buy" : "Sell"} Order to Desk
            </h3>
            <p className="text-xs text-mut">
              {selectedStock.name} &middot; last close ${(selectedStock.last ?? 0).toFixed(2)}
            </p>

            <div className="space-y-1">
              <label className="block text-xs font-semibold text-ink">Amount to {tradeAction === "Buy" ? "invest" : "sell"} (AUD)</label>
              <input
                type="text"
                value={tradeAmount}
                onChange={e => setTradeAmount(e.target.value.replace(/[^0-9,]/g, ""))}
                className="w-full border border-line-2 bg-white rounded-[9px] px-3.5 py-2.5 font-mono text-sm focus:border-green focus:outline-none"
              />
              <div className="text-[11px] text-mut mt-1">
                &asymp; {tradeCalculatedShares().toLocaleString("en-AU")} shares at ${(selectedStock.last ?? 0).toFixed(2)}
              </div>
            </div>

            <div className="text-xs text-mut bg-paper-2 rounded-[9px] p-3 leading-normal">
              Your order will be routed directly to the Vitti trading desk. Execution prices will be matched as close to the current market price as possible. Brokerage charges apply.
            </div>

            <div className="flex gap-2.5 pt-2">
              <button
                onClick={() => setIsTradeModalOpen(false)}
                className="btn border border-line rounded-[10px] py-2 px-4 hover:border-mut text-xs font-semibold cursor-pointer flex-1"
              >
                Back
              </button>
              <button
                onClick={executeTradeOrder}
                className="btn bg-green text-[#08130e] hover:shadow-lg rounded-[10px] py-2 px-4 text-xs font-semibold cursor-pointer flex-1.5"
              >
                Confirm with Desk
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
