"use client";

import React, { useState } from "react";
import type { RealizedSummary } from "@/lib/data/compute";

/**
 * Realised P&L per company — a diverging horizontal bar chart.
 *
 * FORM: the reader's job is polarity plus magnitude ("which trades made money,
 * and how much"), so bars diverge from a zero baseline rather than sharing a
 * left edge. Ranked by result, gains at the top.
 *
 * COLOUR: the design system's diverging pair, --color-gain / --color-loss.
 * Validated against a white surface: lightness band, chroma and contrast all
 * pass, but CVD separation lands at ΔE 7.2 (deuteranopia) — inside the 6–8
 * floor band, which is legal ONLY alongside secondary encoding. Two are
 * present and neither is decorative:
 *   1. bar DIRECTION — gains run right of the baseline, losses run left;
 *   2. a DIRECT VALUE LABEL with an explicit sign on every bar.
 * A reader who cannot separate the hues still reads the chart correctly.
 *
 * PROVISIONAL BARS: where the ledger never saw the units bought, the sale is
 * booked against zero cost and the "profit" is really just proceeds. Those bars
 * are hatched and their label carries a caret, because presenting them as solid
 * fact would be the single most misleading thing this chart could do.
 */

type Row = { parent: string } & RealizedSummary;

// Geometry. A fixed viewBox keeps the SVG crisp while scaling responsively.
const W = 760;
const ROW_H = 26; // 18px bar + 8px air → the 2px surface gap and then some
const BAR_H = 18; // ≤ 24px cap
const R = 4; // rounded data-end
const GUTTER_L = 58; // ticker labels
const LABEL_W = 98; // room for a 2dp value label past either bar tip
const PAD_T = 26; // axis ticks
const PAD_B = 8;

/** Cents are never rounded away — these are settled cash amounts. */
const money = (n: number) =>
  (n < 0 ? "−$" : "$") +
  Math.abs(n).toLocaleString("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/** Axis ticks at clean round numbers spanning the data. */
function ticks(min: number, max: number): number[] {
  const span = Math.max(Math.abs(min), Math.abs(max));
  if (span === 0) return [0];
  const step = Math.pow(10, Math.floor(Math.log10(span))) / 2;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) {
    out.push(Math.abs(v) < 1e-9 ? 0 : v);
  }
  return out.includes(0) ? out : [...out, 0].sort((a, b) => a - b);
}

/**
 * Bar path with the data-end rounded and the baseline end square, per the mark
 * spec. `dir` is +1 for a bar growing right, −1 for one growing left.
 */
function barPath(x0: number, x1: number, y: number, h: number, dir: 1 | -1) {
  const len = Math.abs(x1 - x0);
  const r = Math.min(R, len); // a stub bar must not over-round
  return dir === 1
    ? `M${x0},${y} H${x0 + len - r} A${r},${r} 0 0 1 ${x0 + len},${y + r} V${y + h - r} A${r},${r} 0 0 1 ${x0 + len - r},${y + h} H${x0} Z`
    : `M${x0},${y} H${x0 - len + r} A${r},${r} 0 0 0 ${x0 - len},${y + r} V${y + h - r} A${r},${r} 0 0 0 ${x0 - len + r},${y + h} H${x0} Z`;
}

export function RealizedPnlChart({ rows }: { rows: Row[] }) {
  const [hover, setHover] = useState<number | null>(null);

  // Only companies with a completed sale have a realised result to plot.
  const data = rows
    .filter((r) => r.unitsSold > 0)
    .sort((a, b) => b.realizedPl - a.realizedPl);

  if (data.length === 0) {
    return (
      <div className="card bg-white border border-line rounded-[14px] shadow-shadow px-5 py-8 text-center">
        <div className="text-sm text-mut">
          No completed sales yet — realised P&amp;L appears once a position is sold.
        </div>
      </div>
    );
  }

  const values = data.map((d) => d.realizedPl);
  const maxPos = Math.max(0, ...values);
  const maxNeg = Math.min(0, ...values);
  const span = maxPos - maxNeg || 1;

  const plotL = GUTTER_L + LABEL_W;
  const plotR = W - LABEL_W;
  const plotW = plotR - plotL;
  const zeroX = plotL + (-maxNeg / span) * plotW;
  const scale = (v: number) => zeroX + (v / span) * plotW;

  const H = PAD_T + data.length * ROW_H + PAD_B;
  const anyProvisional = data.some((d) => d.shortHistory);

  return (
    <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
      <div className="px-4.5 py-3.5 border-b border-line select-none">
        <b className="text-sm font-semibold text-ink">Realised P&amp;L by company</b>
        <div className="text-[11px] text-mut mt-0.5">
          Settled sales only, valued at weighted-average cost. Open positions are
          not shown.
        </div>
      </div>

      {/* Legend — three states, so identity never rests on hue alone. */}
      <div className="px-4.5 pt-3 flex items-center gap-4 flex-wrap text-[11px] text-mut select-none">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-2.5 rounded-[2px]" style={{ background: "var(--color-gain)" }} />
          Gain
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-2.5 rounded-[2px]" style={{ background: "var(--color-loss)" }} />
          Loss
        </span>
        {anyProvisional && (
          <span className="flex items-center gap-1.5">
            <svg width="12" height="10" aria-hidden>
              <rect width="12" height="10" rx="2" fill="url(#legendHatch)" />
              <defs>
                <pattern id="legendHatch" width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                  <rect width="4" height="4" fill="var(--color-gain)" opacity="0.35" />
                  <line x1="0" y1="0" x2="0" y2="4" stroke="var(--color-gain)" strokeWidth="2" />
                </pattern>
              </defs>
            </svg>
            Provisional — no cost basis in the ledger
          </span>
        )}
      </div>

      <div className="relative px-2 pb-3">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          role="img"
          aria-label="Realised profit and loss by company"
          style={{ display: "block" }}
        >
          <defs>
            {/* 45° hatch in each polarity, marking a provisional figure. */}
            {(["gain", "loss"] as const).map((tone) => (
              <pattern
                key={tone}
                id={`hatch-${tone}`}
                width="5"
                height="5"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <rect width="5" height="5" fill={`var(--color-${tone})`} opacity="0.3" />
                <line x1="0" y1="0" x2="0" y2="5" stroke={`var(--color-${tone})`} strokeWidth="2.5" />
              </pattern>
            ))}
          </defs>

          {/* Gridlines — hairline, solid, recessive. */}
          {ticks(maxNeg, maxPos).map((t) => (
            <g key={t}>
              <line
                x1={scale(t)}
                y1={PAD_T - 8}
                x2={scale(t)}
                y2={H - PAD_B}
                stroke={t === 0 ? "var(--color-line-2)" : "var(--color-line)"}
                strokeWidth="1"
              />
              <text
                x={scale(t)}
                y={PAD_T - 13}
                textAnchor="middle"
                className="font-mono"
                fontSize="9.5"
                fill="var(--color-mut-d)"
              >
                {t === 0 ? "0" : `${t < 0 ? "−" : ""}$${Math.abs(t) >= 1000 ? `${Math.abs(t) / 1000}k` : Math.abs(t)}`}
              </text>
            </g>
          ))}

          {data.map((d, i) => {
            const y = PAD_T + i * ROW_H + (ROW_H - BAR_H) / 2;
            const up = d.realizedPl >= 0;
            const tone = up ? "gain" : "loss";
            const isHover = hover === i;

            // A non-zero result always gets at least a 2px stub. Sub-pixel bars
            // read as a rendering fault rather than "very small", and the exact
            // figure is on the label beside it either way.
            const raw = scale(d.realizedPl);
            const tipX =
              d.realizedPl === 0
                ? raw
                : up
                  ? Math.max(raw, zeroX + 2)
                  : Math.min(raw, zeroX - 2);

            return (
              <g
                key={d.parent}
                tabIndex={0}
                role="listitem"
                aria-label={`${d.parent}, realised ${money(d.realizedPl)}${d.shortHistory ? ", provisional, no cost basis" : ""}`}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                style={{ cursor: "default", outline: "none" }}
              >
                {/* Hit target spans the full row, not just the painted bar. */}
                <rect
                  x={GUTTER_L}
                  y={PAD_T + i * ROW_H}
                  width={W - GUTTER_L}
                  height={ROW_H}
                  fill={isHover ? "var(--color-paper)" : "transparent"}
                />

                <text
                  x={GUTTER_L - 10}
                  y={y + BAR_H / 2 + 3.5}
                  textAnchor="end"
                  className="font-mono"
                  fontSize="11"
                  fontWeight="700"
                  fill="var(--color-ink)"
                >
                  {d.parent}
                </text>

                <path
                  d={barPath(zeroX, tipX, y, BAR_H, up ? 1 : -1)}
                  fill={
                    d.shortHistory ? `url(#hatch-${tone})` : `var(--color-${tone})`
                  }
                  opacity={isHover ? 0.85 : 1}
                />

                {/* Direct value label — the secondary encoding the CVD warning
                    requires, so polarity survives without colour. */}
                <text
                  x={up ? tipX + 7 : tipX - 7}
                  y={y + BAR_H / 2 + 3.5}
                  textAnchor={up ? "start" : "end"}
                  className="font-mono"
                  fontSize="10.5"
                  fill="var(--color-mut)"
                >
                  {up ? "+" : ""}
                  {money(d.realizedPl)}
                  {d.shortHistory ? " ^" : ""}
                </text>
              </g>
            );
          })}
        </svg>

        {/* Tooltip. Values lead, labels follow. */}
        {hover !== null && data[hover] && (
          <div
            className="pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-2 z-10 bg-navy text-white rounded-[10px] px-3 py-2 shadow-shadow-lg text-[11px] leading-relaxed"
            role="status"
          >
            <div className="font-mono font-bold text-[13px]">
              {data[hover].parent} {money(data[hover].realizedPl)}
            </div>
            <div className="opacity-80">
              {data[hover].unitsSold.toLocaleString("en-AU")} units sold ·{" "}
              {money(data[hover].proceeds)} proceeds ·{" "}
              {money(data[hover].costOfSold)} cost
            </div>
            <div className="opacity-60">
              {data[hover].tradeCount} trade
              {data[hover].tradeCount === 1 ? "" : "s"}
              {data[hover].firstTrade &&
                ` · ${data[hover].firstTrade} → ${data[hover].lastTrade}`}
            </div>
            {data[hover].shortHistory && (
              <div className="mt-1 text-[10.5px]" style={{ color: "var(--color-amber)" }}>
                Provisional — no purchase in the ledger, so cost is booked at $0
                and this figure is overstated.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
