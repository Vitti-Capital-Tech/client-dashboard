"use client";

import React, { useMemo, useState } from "react";
import { posValue, posCost, posPL } from "@/lib/data/compute";
import { sectorMix, type SectorScope } from "@/lib/pnl/sector-mix";
import type { ClientPortfolioRow } from "@/lib/pnl/client-portfolio";
import type { Position } from "@/lib/data/queries";

/**
 * Portfolio analytics: allocation, sector split, and where the P&L came from.
 *
 * ── Why it lives here and not on the Portfolio page ────────────────────────
 * It was a fifth tab there, behind Holdings — which meant the one view that
 * answers "what does my money look like" sat underneath the one that answers
 * "what do I own", and the client's Home page showed a table of holdings that
 * the Portfolio page then showed again. Two screens, one answer, and the
 * interesting one buried.
 *
 * So this moved to Home whole, and the tab is gone rather than duplicated: the
 * same card in two places drifts the moment either is edited.
 *
 * ── Scope ──────────────────────────────────────────────────────────────────
 * Every figure here is the WHOLE book — every account this login holds — which
 * is what the P&L split card has always said of itself. The account filter on
 * the Portfolio page never applied to it.
 */

/**
 * Reusable donut / pie.
 *
 * `thick = size / 2` takes the inner radius to zero, so the same component
 * draws both and the cards on a row stay visually of a piece.
 *
 * `onHover` is optional. Where it is given, each slice becomes focusable and
 * reports itself on pointer AND on keyboard focus — a chart whose figures are
 * only reachable with a mouse simply has no figures for anyone using a
 * keyboard, and on a touch screen "hover" never happens at all, which is why
 * the caller also renders the same numbers in the legend.
 */
const DonutChart = ({
  segs,
  size = 128,
  thick = 18,
  onHover,
  activeLabel,
}: {
  segs: { label: string; v: number; col: string }[];
  size?: number;
  thick?: number;
  onHover?: (label: string | null) => void;
  activeLabel?: string | null;
}) => {
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

  const interactive = Boolean(onHover);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      onMouseLeave={onHover ? () => onHover(null) : undefined}
      role={interactive ? "group" : undefined}
    >
      {segsWithOffsets.map((s, idx) => {
        const dimmed = interactive && activeLabel !== null && activeLabel !== s.label;
        return (
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
            opacity={dimmed ? 0.32 : 1}
            style={
              interactive
                ? { cursor: "pointer", transition: "opacity 120ms" }
                : undefined
            }
            tabIndex={interactive ? 0 : undefined}
            onMouseEnter={onHover ? () => onHover(s.label) : undefined}
            onFocus={onHover ? () => onHover(s.label) : undefined}
            onBlur={onHover ? () => onHover(null) : undefined}
          >
            {/* A native tooltip as the floor: it works before any JS runs and
                on platforms where the hover state never fires. */}
            {interactive && <title>{s.label}</title>}
          </circle>
        );
      })}
    </svg>
  );
};

const palette = ["#1d202f", "#36bb91", "#c98a2b", "#5c5775", "#1f8e6b", "#9aa0b4", "#b8543f", "#4a7fb5"];

const money0 = (n: number) => `$${Math.round(n).toLocaleString("en-AU")}`;
const pct1 = (n: number | null) => (n === null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`);
const returnPct = (pnl: number, cost: number) =>
  cost > 0 && Number.isFinite(pnl / cost) ? (pnl / cost) * 100 : null;

export function PortfolioAnalytics({
  positions,
  cash,
  unlisted,
  portfolio,
  sectorByTicker,
}: {
  /** Holdings behind the market values and the movers list. */
  positions: Position[];
  cash: number;
  /** Carry on unlisted grants — neither a listed position nor cash. */
  unlisted: number;
  /** The desk's stored figures for the whole book. */
  portfolio: { rows: ClientPortfolioRow[]; total: { buyPrice: number; sellOrCurrent: number; pnl: number } };
  /** Ticker → sector, with derivatives already rolled up to their ordinary. */
  sectorByTicker: Record<string, string | null>;
}) {
  const [sectorScope, setSectorScope] = useState<SectorScope>("held");
  const [hoveredSector, setHoveredSector] = useState<string | null>(null);

  const activePositions = positions;
  const activeCash = cash;
  const tv = activePositions.reduce((sum, p) => sum + posValue(p), 0);

  /**
   * Today's market value for a still-held row, by ticker.
   *
   * The P&L rows are the source of truth for cost and result, but they carry no
   * live price; the holdings snapshot does. Summed rather than looked up,
   * because a client can hold the same security in more than one account and
   * the P&L rows are already rolled up across them.
   */
  const marketValueByTicker = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of activePositions) {
      map.set(p.code, (map.get(p.code) ?? 0) + posValue(p));
    }
    return map;
  }, [activePositions]);

  const mix = useMemo(
    () =>
      sectorMix(
        portfolio.rows,
        sectorScope,
        (ticker) => sectorByTicker[ticker] ?? null,
        (ticker) => marketValueByTicker.get(ticker) ?? null,
      ),
    [portfolio.rows, sectorScope, sectorByTicker, marketValueByTicker],
  );

  const sectorSegs = useMemo(
    () =>
      mix.buckets.map((b, i) => ({
        label: b.label,
        v: b.value,
        col: palette[i % palette.length],
      })),
    [mix.buckets],
  );

  /** The slice being pointed at, or the whole mix when nothing is. */
  const focusedBucket = hoveredSector
    ? mix.buckets.find((b) => b.label === hoveredSector) ?? null
    : null;

  const renderSectorCard = () => {
    const measure = sectorScope === "held" ? "market value" : "amount invested";

    return (
      <div className="card bg-white border border-line rounded-[14px] p-5 shadow-shadow flex flex-col">
        <div className="flex justify-between items-start text-xs mb-3 gap-2 flex-wrap">
          <div>
            <b className="text-sm font-semibold text-ink">Sector split</b>
            <div className="text-[11px] text-mut mt-0.5">by {measure}</div>
          </div>

          <div className="inline-flex bg-paper-2 rounded-[8px] p-0.5 flex-none">
            <button
              onClick={() => {
                setSectorScope("held");
                setHoveredSector(null);
              }}
              className={`text-[11px] font-semibold px-2.5 py-1 rounded-[6px] cursor-pointer transition-colors ${
                sectorScope === "held" ? "bg-white text-ink shadow-shadow" : "text-mut hover:text-ink"
              }`}
            >
              Held now
            </button>
            <button
              onClick={() => {
                setSectorScope("alltime");
                setHoveredSector(null);
              }}
              className={`text-[11px] font-semibold px-2.5 py-1 rounded-[6px] cursor-pointer transition-colors ${
                sectorScope === "alltime" ? "bg-white text-ink shadow-shadow" : "text-mut hover:text-ink"
              }`}
            >
              Incl. past
            </button>
          </div>
        </div>

        {mix.buckets.length === 0 ? (
          <div className="flex-1 flex items-center">
            <p className="text-xs text-mut leading-relaxed">
              {sectorScope === "held"
                ? "Nothing held in your accounts right now."
                : "No holdings on file yet."}
            </p>
          </div>
        ) : mix.unclassified ? (
          <div className="flex-1 flex items-center">
            <p className="text-xs text-mut leading-relaxed">
              Sector classifications are not on file for these holdings yet, so there is
              nothing to break down. Your adviser can tell you the exposure in the meantime.
            </p>
          </div>
        ) : (
          <div className="flex gap-5 items-center flex-wrap">
            {/* A pie, not a donut: `thick = size / 2` takes the inner radius to
                zero, so the same component draws both and the two cards on this
                row stay visually of a piece. The centre is then given back by
                overlaying the readout on top. */}
            <div className="relative flex-none">
              <DonutChart
                segs={sectorSegs}
                size={128}
                thick={focusedBucket ? 44 : 64}
                onHover={setHoveredSector}
                activeLabel={hoveredSector}
              />
              {/* Only drawn while a slice is focused, because the ring only
                  opens up a hole then. */}
              {focusedBucket && (
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none px-6 text-center">
                  <div
                    className={`font-mono font-bold text-[13px] ${focusedBucket.pnl >= 0 ? "text-gain" : "text-loss-d"}`}
                  >
                    {focusedBucket.pnl >= 0 ? "+" : ""}
                    {money0(focusedBucket.pnl)}
                  </div>
                  <div className="text-[8.5px] text-mut uppercase font-semibold tracking-wide">
                    P&amp;L
                  </div>
                </div>
              )}
            </div>

            <div className="flex-1 min-w-45 space-y-1.5">
              {mix.buckets.map((b, i) => {
                const share = mix.total > 0 ? Math.round((b.value / mix.total) * 100) : 0;
                const focused = hoveredSector === b.label;
                return (
                  <button
                    key={b.label}
                    onMouseEnter={() => setHoveredSector(b.label)}
                    onMouseLeave={() => setHoveredSector(null)}
                    onFocus={() => setHoveredSector(b.label)}
                    onBlur={() => setHoveredSector(null)}
                    className={`w-full text-left rounded-[7px] px-1.5 py-1 transition-colors cursor-pointer ${
                      focused ? "bg-paper-2" : ""
                    }`}
                  >
                    <div className="flex items-center gap-2 text-xs font-medium text-ink">
                      <i
                        style={{ backgroundColor: palette[i % palette.length] }}
                        className="w-2.5 h-2.5 rounded-[3px] block flex-none"
                      />
                      <span className="truncate" title={b.label}>
                        {b.label}
                      </span>
                      <b className="ml-auto font-mono text-[13px] font-semibold whitespace-nowrap">
                        {share}%
                      </b>
                    </div>
                    <div className="flex items-baseline gap-2 pl-4.5 mt-0.5">
                      <span
                        className={`font-mono text-[11.5px] font-semibold ${b.pnl >= 0 ? "text-gain" : "text-loss-d"}`}
                      >
                        {b.pnl >= 0 ? "+" : ""}
                        {money0(b.pnl)}
                      </span>
                      <span className="text-[10.5px] text-mut">
                        {pct1(b.returnPct)} · {b.holdings} holding
                        {b.holdings === 1 ? "" : "s"}
                      </span>
                    </div>
                  </button>
                );
              })}

              <div className="flex items-center gap-2 pt-1.5 mt-1 border-t border-line text-xs">
                <span className="text-mut font-medium">Total</span>
                <span className="ml-auto font-mono text-[11.5px] text-mut">
                  {money0(mix.total)}
                </span>
                <span
                  className={`font-mono text-[11.5px] font-semibold ${mix.totalPnl >= 0 ? "text-gain" : "text-loss-d"}`}
                >
                  {mix.totalPnl >= 0 ? "+" : ""}
                  {money0(mix.totalPnl)}
                </span>
              </div>
            </div>
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
      { label: "Cash", v: activeCash, col: "#cfc9bb" },
    ];
    const allocTotal = allocSegs.reduce((sum, a) => sum + a.v, 0);
    const alloc = allocSegs.filter((a) => a.v > 0);
    const share = (v: number) => (allocTotal > 0 ? Math.round((v / allocTotal) * 100) : 0);

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
    const movers = activePositions
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

          {renderSectorCard()}
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

            {/* The card's own total, which is client-wide like the three bars
                above it — NOT the KPI strip's, which follows the account
                filter. Reading `deskPnl` here would have put a one-account
                figure under three all-account bars that do not sum to it. */}
            <div className="flex justify-between items-baseline text-xs pt-2 border-t border-line">
              <span className="text-mut font-semibold">Total</span>
              <b className={`font-mono text-[13px] ${portfolio.total.pnl >= 0 ? "text-gain" : "text-loss-d"}`}>
                {portfolio.total.pnl >= 0 ? "+" : ""}{money0(portfolio.total.pnl)}
              </b>
            </div>
          </div>
        </div>
      </div>
    );
  };
  return renderAnalytics();
}
