"use client";

import React, { useState } from "react";
import { grainOfKey, type RealizedPeriod } from "@/lib/data/compute";

/**
 * Realised P&L over time — a diverging column chart, one column per period.
 *
 * FORM: the reader's job is "when did we make money, and how much", which is
 * magnitude plus polarity across an ordered axis. Columns, because time reads
 * left-to-right; diverging from a zero baseline, because the sign is half the
 * story. Periods with no sales are still drawn — skipping them would compress
 * the gaps and make the desk look busier than it was.
 *
 * GRAIN: one column is a month, a quarter or a year, and the bucketer chooses
 * which from the span (`grainFor` in `compute.ts`) so the count stays near a
 * dozen at any range. This chart reads the grain back off the bucket key and
 * spends it on prose only — the geometry is identical at every grain.
 *
 * COLOUR: the design system's diverging pair, --color-gain / --color-loss.
 * Validated against a white surface, that pair passes lightness, chroma and
 * contrast but lands at ΔE 7.2 under deuteranopia — inside the 6–8 floor band,
 * legal ONLY alongside secondary encoding. Two are present, neither decorative:
 *   1. column DIRECTION — gains rise above the baseline, losses fall below;
 *   2. the axis itself, with the zero line drawn heavier than the gridlines.
 * A reader who cannot separate the hues still reads the chart correctly.
 *
 * PROVISIONAL COLUMNS: a period containing a sale that drew on no cost basis
 * is hatched. Those "profits" are really just proceeds, and a solid column would
 * present them as fact.
 */

const W = 760;
const H = 300;
/*
 * The gutters, sized for the labels that go in them.
 *
 * `PAD_L` holds a y-axis figure right-aligned 8px off the axis. At 64 a
 * six-character label — "−$12.5k" — started at x=0 and touched the edge of the
 * viewBox; 76 gives it room to grow one more character before that happens
 * again.
 *
 * `PAD_B` carries two stacked lines, the period and the sale count. The second
 * sat at H − PAD_B + 28 against a 46px gutter, which put its descenders past
 * the bottom of the box.
 */
const PAD_L = 76;
const PAD_R = 16;
const PAD_T = 16;
const PAD_B = 56;
const MAX_BAR = 44; // ≤ 24px is for thin bar charts; a period column reads wider
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

/**
 * The y axis: round bounds, and the gridlines between them.
 *
 * ── The domain comes from the TICKS, not from the data ────────────────
 * It was the other way round. The scale mapped the raw `[dataMin, dataMax]`
 * onto the plot and the ticks were then rounded OUTWARD from that — so the
 * lowest tick sat below the bottom of the plot and was drawn there anyway,
 * gridline and figure both, in the band the period labels live in. With a low
 * of −$4.3k the `−$5k` rule ran straight through `Aug 25 … Jun 26` and its
 * figure read as the first entry in that row. Rounding first and scaling to
 * the rounded bounds puts every gridline inside the plot BY CONSTRUCTION, and
 * it makes the floor and the ceiling of the chart two round numbers, which is
 * what a reader estimates against anyway.
 *
 * ── The step is the finest round one that stays legible ───────────────
 * `10^floor(log10(span)) / 2` gave two rungs per decade, so a span just over a
 * power of ten was rounded out to nearly double itself and the tallest column
 * used two thirds of the height it had. Walking a 1 / 2 / 2.5 / 5 ladder and
 * taking the first step that fits inside `MAX_INTERVALS` keeps the domain
 * close to the data while guaranteeing ≥ 32px between figures — which is also
 * what stops the old 20-gridline case, a span of 999 stepping by 50.
 *
 * Zero needs no special case: `min ≤ 0 ≤ max` here, `lo` is a multiple of
 * `step` and the walk moves in whole steps, so it lands on zero exactly.
 */
const MAX_INTERVALS = 7; // eight gridlines across a 228px plot
const STEP_LADDER = [1, 2, 2.5, 5, 10, 20, 25, 50, 100];

function axisFor(min: number, max: number) {
  const span = max - min;
  // Nothing realised, or it all netted off: one rule, and it sits centred
  // rather than pinned to the top of an empty plot.
  if (span === 0) return { lo: -1, hi: 1, values: [0] };

  const mag = Math.pow(10, Math.floor(Math.log10(span)) - 1);
  let step = STEP_LADDER[STEP_LADDER.length - 1] * mag;
  for (const m of STEP_LADDER) {
    step = m * mag;
    if (Math.ceil(max / step) - Math.floor(min / step) <= MAX_INTERVALS) break;
  }

  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const values: number[] = [];
  // `lo + i * step`, not `v += step` — accumulating the step drifts, and a
  // gridline at 4999.999999 is labelled by `compact` as `$5k` while sitting a
  // hair off the line above it.
  for (let i = 0; lo + i * step <= hi + 1e-9; i++) {
    const v = lo + i * step;
    values.push(Math.abs(v) < 1e-9 ? 0 : v);
  }
  return { lo, hi, values };
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
  // Zero is always in the domain: a chart of nothing but gains still has to
  // show the baseline they are gains ABOVE.
  const axis = axisFor(Math.min(0, ...values), Math.max(0, ...values));
  const span = axis.hi - axis.lo;

  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const zeroY = PAD_T + (axis.hi / span) * plotH;
  const scaleY = (v: number) => zeroY - (v / span) * plotH;

  const slot = plotW / periods.length;
  const barW = Math.min(MAX_BAR, slot - 10); // leftover band stays as air

  const total = periods.reduce((s, p) => s + p.realizedPl, 0);
  const anyUncosted = periods.some((p) => p.hasUncosted);

  /**
   * What one column IS, in prose. The grain rides on the bucket key, so the
   * header, the legend and the tooltip cannot drift out of step with the axis
   * the way a hard-coded "by month" did the moment a three-year range started
   * drawing `Q3 25`.
   */
  const grain = grainOfKey(periods[0].key);

  /** The bucket that opens a year, which is where the year is worth printing. */
  const opensYear = (label: string) =>
    grain === "year" || label.startsWith("Jan") || label.startsWith("Q1");

  /**
   * A crowded axis is worse than a sparse one — thin the labels, never the bars.
   *
   * ── Measured off the label that is actually there ──────────────────
   * These were two constants hand-sized for `Aug 25`, which stopped being the
   * only thing the axis carries once the bucketer began drawing quarters and
   * years: `Q3 25` is five characters and `2024` is four, so a month's
   * threshold turned away labels that had room to spare. Both widths now come
   * off the longest label in the DATA at the face's own advance, so the axis
   * degrades at the width it genuinely runs out at rather than at the one
   * width someone happened to measure.
   *
   * ── Shorten before thinning ──────────────────────────────────
   * The first response to a tight axis is to drop the YEAR, not the label:
   * `Aug` is ~22px against `Aug 25`'s ~43px, every bucket stays named, and the
   * year is still shown where it changes and on the first column, which is
   * where a reader looks for it. Only when even that will not fit are labels
   * dropped — which now takes a range past a dozen YEARS, because every
   * shorter one is bucketed down to roughly twelve columns first.
   */
  const CH = 7.2; // one monospace advance at 12px
  const AIR = 10; // the air two neighbouring labels must leave between them
  const widest = (pick: (label: string) => string) =>
    Math.max(...periods.map((p) => pick(p.label).length)) * CH + AIR;
  const fullLabel = slot >= widest((l) => l);
  const labelEvery = fullLabel
    ? 1
    : Math.max(1, Math.ceil(widest((l) => l.split(" ")[0]) / slot));
  // "18 sales" is eight characters in the PROPORTIONAL face (this line is not
  // `font-mono`), so ~40 units — and at 56 it was being shown in a 60-unit
  // slot, two thirds full, which is the row that still read as crowded after
  // the period labels were shortened. It now needs half the band free.
  const SALE_COUNT_W = 80;
  const showSaleCounts = slot >= SALE_COUNT_W;

  /**
   * Tick figures live in the y gutter — and the gutter stops at the plot floor.
   *
   * `axisFor` is what keeps the bottom GRIDLINE out of the label band; this
   * keeps the FIGURE out of it too. Centred on that lowest rule the figure
   * lands on the floor, one text ascent from the row of period labels and
   * immediately to the left of the first of them — read across, `−$5k  Aug 25
   * Sep 25` is a row of periods with a stray figure at the head of it, and the
   * eye pairs the figure with `Aug 25` rather than with the baseline it
   * measures. Sitting it just above its own rule instead keeps the gutter a
   * column of money and the row beneath it a row of dates, which is what each
   * of them is.
   */
  const tickLabelY = (v: number) => Math.min(scaleY(v) + 3.5, H - PAD_B - 6);

  return (
    <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
      <div className="px-4.5 py-3.5 border-b border-line select-none flex items-baseline justify-between">
        <div>
          <b className="text-sm font-semibold text-ink">
            Realised P&amp;L by {grain}
          </b>
          <div className="text-[11px] text-mut mt-0.5">
            Attributed to the {grain} each sale settled. Open positions are not
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
          Hatched {grain}s include a sale with no cost basis in the ledger —
          that figure is overstated.
        </div>
      )}

      <div className="relative px-2 pb-2">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          role="img"
          aria-label={`Realised profit and loss by ${grain}`}
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
          {axis.values.map((t) => (
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
                y={tickLabelY(t)}
                textAnchor="end"
                className="font-mono"
                fontSize="12"
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
            // A non-zero period always gets at least a 2px stub; sub-pixel
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

                {/* Period label. Text wears text tokens, never the data colour. */}
                {i % labelEvery === 0 && (
                  <text
                    x={PAD_L + i * slot + slot / 2}
                    y={H - PAD_B + 20}
                    textAnchor="middle"
                    className="font-mono"
                    fontSize="12"
                    fill={isHover ? "var(--color-ink)" : "var(--color-mut)"}
                  >
                    {fullLabel || i === 0 || opensYear(p.label)
                      ? p.label
                      : p.label.split(" ")[0]}
                  </text>
                )}
                {!empty && showSaleCounts && i % labelEvery === 0 && (
                  <text
                    x={PAD_L + i * slot + slot / 2}
                    y={H - PAD_B + 35}
                    textAnchor="middle"
                    fontSize="10.5"
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
              <div className="opacity-70">No sales settled this {grain}.</div>
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
                    <div key={c.code} className="flex justify-between gap-3">
                      <span className="font-mono opacity-80">
                        {/* The instrument, so this names the same thing the
                            table below it does — an option sale reads as the
                            option, not as its ordinary. */}
                        {c.code}
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
                    {grain} is overstated.
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
