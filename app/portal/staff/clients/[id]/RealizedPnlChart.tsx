"use client";

import React, { useState } from "react";
import type { RealizedPeriod } from "@/lib/data/compute";

/**
 * Realised P&L over time — a diverging column chart, one column per month.
 *
 * FORM: the reader's job is "when did we make money, and how much", which is
 * magnitude plus polarity across an ordered axis. Columns, because time reads
 * left-to-right; diverging from a zero baseline, because the sign is half the
 * story. Months with no sales are still drawn — skipping them would compress
 * the gaps and make the desk look busier than it was.
 *
 * COLOUR: the design system's diverging pair, --color-gain / --color-loss.
 * Validated against a white surface, that pair passes lightness, chroma and
 * contrast but lands at ΔE 7.2 under deuteranopia — inside the 6–8 floor band,
 * legal ONLY alongside secondary encoding. Two are present, neither decorative:
 *   1. column DIRECTION — gains rise above the baseline, losses fall below;
 *   2. the axis itself, with the zero line drawn heavier than the gridlines.
 * A reader who cannot separate the hues still reads the chart correctly.
 *
 * PROVISIONAL COLUMNS: a month containing a sale that drew on no cost basis is
 * hatched. Those "profits" are really just proceeds, and a solid column would
 * present them as fact.
 */

const W = 760;
const H = 300;
const PAD_L = 64; // y-axis labels
const PAD_R = 16;
const PAD_T = 16;
const PAD_B = 46; // month labels + the sale count beneath them
const MAX_BAR = 44; // ≤ 24px is for thin bar charts; a monthly column reads wider
const R = 4; // rounded data-end

const money = (n: number) =>
  (n < 0 ? "−$" : "$") +
  Math.abs(n).toLocaleString("en-AU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const compact = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1000 ? `${Math.round(a / 100) / 10}k` : `${Math.round(a)}`;
  return `${n < 0 ? "−" : ""}$${s}`;
};

/** Axis ticks at clean round numbers spanning the data, always including zero. */
function ticks(min: number, max: number): number[] {
  const span = Math.max(Math.abs(min), Math.abs(max));
  if (span === 0) return [0];
  const step = Math.pow(10, Math.floor(Math.log10(span))) / 2;
  const out: number[] = [];
  for (let v = Math.floor(min / step) * step; v <= max + 1e-9; v += step) {
    out.push(Math.abs(v) < 1e-9 ? 0 : v);
  }
  if (!out.some((v) => v === 0)) out.push(0);
  return out.sort((a, b) => a - b);
}

/** Column with the data-end rounded and the baseline end square. */
function columnPath(x: number, w: number, yTop: number, yBase: number) {
  const h = Math.abs(yBase - yTop);
  const r = Math.min(R, w / 2, h);
  return yTop < yBase
    ? // grows upward — round the top
      `M${x},${yBase} V${yTop + r} A${r},${r} 0 0 1 ${x + r},${yTop} H${x + w - r} A${r},${r} 0 0 1 ${x + w},${yTop + r} V${yBase} Z`
    : // grows downward — round the bottom
      `M${x},${yBase} V${yTop - r} A${r},${r} 0 0 0 ${x + r},${yTop} H${x + w - r} A${r},${r} 0 0 0 ${x + w},${yTop - r} V${yBase} Z`;
}

export function RealizedPnlChart({ periods }: { periods: RealizedPeriod[] }) {
  const [hover, setHover] = useState<number | null>(null);

  if (periods.length === 0) {
    return (
      <div className="card bg-white border border-line rounded-[14px] shadow-shadow px-5 py-8 text-center">
        <div className="text-sm text-mut">
          No completed sales yet — realised P&amp;L appears once a position is sold.
        </div>
      </div>
    );
  }

  const values = periods.map((p) => p.realizedPl);
  const maxPos = Math.max(0, ...values);
  const minNeg = Math.min(0, ...values);
  const span = maxPos - minNeg || 1;

  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const zeroY = PAD_T + (maxPos / span) * plotH;
  const scaleY = (v: number) => zeroY - (v / span) * plotH;

  const slot = plotW / periods.length;
  const barW = Math.min(MAX_BAR, slot - 10); // leftover band stays as air

  const total = periods.reduce((s, p) => s + p.realizedPl, 0);
  const anyUncosted = periods.some((p) => p.hasUncosted);
  // A crowded axis is worse than a sparse one — thin the labels, never the bars.
  const labelEvery = slot < 44 ? 2 : 1;

  return (
    <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
      <div className="px-4.5 py-3.5 border-b border-line select-none flex items-baseline justify-between">
        <div>
          <b className="text-sm font-semibold text-ink">Realised P&amp;L by month</b>
          <div className="text-[11px] text-mut mt-0.5">
            Attributed to the month each sale settled. Open positions are not
            shown — nothing is realised until it is sold.
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-[10px] tracking-wider uppercase text-mut">
            Total
          </div>
          <div
            className={`font-mono text-[15px] tabular-nums ${total >= 0 ? "text-gain" : "text-loss-d"}`}
          >
            {money(total)}
          </div>
        </div>
      </div>

      {anyUncosted && (
        <div className="px-4.5 pt-3 flex items-center gap-1.5 text-[11px] text-mut select-none">
          <svg width="12" height="10" aria-hidden>
            <rect width="12" height="10" rx="2" fill="url(#legendHatch)" />
            <defs>
              <pattern
                id="legendHatch"
                width="4"
                height="4"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <rect width="4" height="4" fill="var(--color-gain)" opacity="0.35" />
                <line x1="0" y1="0" x2="0" y2="4" stroke="var(--color-gain)" strokeWidth="2" />
              </pattern>
            </defs>
          </svg>
          Hatched months include a sale with no cost basis in the ledger — that
          figure is overstated.
        </div>
      )}

      <div className="relative px-2 pb-2">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          role="img"
          aria-label="Realised profit and loss by month"
          style={{ display: "block" }}
        >
          <defs>
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

          {/* Gridlines — hairline, solid, recessive. Zero sits heavier: it is
              the reference every column is read against. */}
          {ticks(minNeg, maxPos).map((t) => (
            <g key={t}>
              <line
                x1={PAD_L}
                y1={scaleY(t)}
                x2={W - PAD_R}
                y2={scaleY(t)}
                stroke={t === 0 ? "var(--color-line-2)" : "var(--color-line)"}
                strokeWidth="1"
              />
              <text
                x={PAD_L - 8}
                y={scaleY(t) + 3.5}
                textAnchor="end"
                className="font-mono"
                fontSize="9.5"
                fill="var(--color-mut-d)"
              >
                {t === 0 ? "0" : compact(t)}
              </text>
            </g>
          ))}

          {periods.map((p, i) => {
            const x = PAD_L + i * slot + (slot - barW) / 2;
            const up = p.realizedPl >= 0;
            const tone = up ? "gain" : "loss";
            const isHover = hover === i;
            const empty = p.saleCount === 0;

            const rawY = scaleY(p.realizedPl);
            // A non-zero month always gets at least a 2px stub; sub-pixel
            // columns read as a rendering fault rather than "very small".
            const yTop =
              p.realizedPl === 0
                ? zeroY
                : up
                  ? Math.min(rawY, zeroY - 2)
                  : Math.max(rawY, zeroY + 2);

            return (
              <g
                key={p.key}
                tabIndex={0}
                aria-label={`${p.label}, realised ${money(p.realizedPl)}${p.hasUncosted ? ", includes a sale with no cost basis" : ""}`}
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
                style={{ cursor: "default", outline: "none" }}
              >
                {/* Hit target spans the whole slot, not just the painted column. */}
                <rect
                  x={PAD_L + i * slot}
                  y={PAD_T}
                  width={slot}
                  height={plotH}
                  fill={isHover ? "var(--color-paper)" : "transparent"}
                />

                {!empty && (
                  <path
                    d={columnPath(x, barW, yTop, zeroY)}
                    fill={p.hasUncosted ? `url(#hatch-${tone})` : `var(--color-${tone})`}
                    opacity={isHover ? 0.85 : 1}
                  />
                )}

                {/* Month label. Text wears text tokens, never the data colour. */}
                {i % labelEvery === 0 && (
                  <text
                    x={PAD_L + i * slot + slot / 2}
                    y={H - PAD_B + 16}
                    textAnchor="middle"
                    className="font-mono"
                    fontSize="10"
                    fill={isHover ? "var(--color-ink)" : "var(--color-mut)"}
                  >
                    {p.label}
                  </text>
                )}
                {!empty && i % labelEvery === 0 && (
                  <text
                    x={PAD_L + i * slot + slot / 2}
                    y={H - PAD_B + 28}
                    textAnchor="middle"
                    fontSize="9"
                    fill="var(--color-mut-d)"
                  >
                    {p.saleCount} sale{p.saleCount === 1 ? "" : "s"}
                  </text>
                )}
              </g>
            );
          })}
        </svg>

        {/* Tooltip. Values lead, labels follow. */}
        {hover !== null && periods[hover] && (
          <div
            className="pointer-events-none absolute left-1/2 -translate-x-1/2 top-2 z-10 bg-navy text-white rounded-[10px] px-3 py-2 shadow-shadow-lg text-[11px] leading-relaxed max-w-[300px]"
            role="status"
          >
            <div className="font-mono font-bold text-[13px]">
              {periods[hover].label} {money(periods[hover].realizedPl)}
            </div>
            {periods[hover].saleCount === 0 ? (
              <div className="opacity-70">No sales settled this month.</div>
            ) : (
              <>
                <div className="opacity-80">
                  {periods[hover].saleCount} sale
                  {periods[hover].saleCount === 1 ? "" : "s"} ·{" "}
                  {money(periods[hover].proceeds)} proceeds ·{" "}
                  {money(periods[hover].costOfSold)} cost
                </div>
                <div className="mt-1 space-y-0.5">
                  {periods[hover].contributors.slice(0, 6).map((c) => (
                    <div key={c.parent} className="flex justify-between gap-3">
                      <span className="font-mono opacity-80">
                        {c.parent}
                        {c.noCostBasis && " ^"}
                      </span>
                      <span
                        className="font-mono tabular-nums"
                        style={{
                          color:
                            c.realizedPl >= 0
                              ? "var(--color-green)"
                              : "var(--color-loss)",
                        }}
                      >
                        {money(c.realizedPl)}
                      </span>
                    </div>
                  ))}
                </div>
                {periods[hover].hasUncosted && (
                  <div className="mt-1 text-[10.5px]" style={{ color: "var(--color-amber)" }}>
                    ^ no purchase in the ledger — booked at $0 cost, so this
                    month is overstated.
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
