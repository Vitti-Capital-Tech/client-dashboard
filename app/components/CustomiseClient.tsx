"use client";

import React from "react";
import { RotateCcw, Check } from "lucide-react";
import { useTheme } from "@/app/components/ThemeProvider";
import {
  THEME_PRESETS,
  FONT_OPTIONS,
  type ThemeConfig,
  getLuminance,
} from "@/lib/theme/theme-config";

/**
 * Appearance: pick a theme, pick a typeface.
 *
 * ── What this used to be, and why it is not that any more ──────────────────
 * It was a 930-line editor: a light/dark banner with marketing copy and a
 * segmented switch, filter tabs over the presets, three raw hex fields with
 * quick swatches, a contrast-ratio meter, four opacity sliders (card surface,
 * borders, muted text, accent glow), a copy-the-palette-as-JSON button, and a
 * mock dashboard with invented holdings as a live preview.
 *
 * It is a client portal for a wholesale broker. The people using it came to
 * look at their money, and none of them wants to tune border opacity to two
 * decimal places on it — but a few would try, and the ones who did would end up
 * with an unreadable statement of their own holdings. The contrast meter was
 * proof of the problem, not a solution to it: a control that needs a warning
 * light bolted on is a control that should not be offered.
 *
 * So what is left is the part that was always the point. Six presets, each one
 * a set of choices somebody made deliberately and checked, and the typeface.
 * Everything the sliders reached — opacity, surfaces, borders — still exists in
 * `ThemeConfig` and still comes from the preset, so a theme saved by the old
 * editor keeps rendering exactly as it did.
 *
 * ── No preview pane ────────────────────────────────────────────────────────
 * There was a mock dashboard on the right, complete with fabricated tickers and
 * a fake alert. It is gone because the theme applies to the live page the
 * instant it is clicked: the portal is the preview, and it is showing the
 * client's real book rather than a drawing of somebody else's.
 */
export function CustomiseClient({
  clientName,
  embedded = false,
}: {
  clientName: string;
  /**
   * Rendered inside another page rather than as one of its own.
   *
   * Settings shows this under Appearance, which means the surrounding page
   * already has a heading and a width. Embedded drops this component's own
   * `<h1>` — two on a page is wrong for a screen reader before it is wrong for
   * a designer — and its page-level centring.
   */
  embedded?: boolean;
}) {
  const { theme, setTheme, resetTheme, isCustomized } = useTheme();

  /**
   * A preset is applied whole.
   *
   * Not merged over what is there: the opacities and surface values are tuned
   * per palette, so carrying the previous theme's across produces a look
   * nobody chose and nobody checked.
   */
  const selectPreset = (preset: ThemeConfig) => setTheme({ ...preset });

  const selectFont = (fontFamily: string) =>
    setTheme((prev) => ({ ...prev, fontFamily }));

  return (
    <div className={embedded ? "space-y-6" : "space-y-6 max-w-3xl mx-auto pb-12"}>
      {!embedded && (
        <div className="select-none">
          <div className="font-mono text-xs tracking-wider uppercase text-mut">
            Appearance
          </div>
          <h1 className="font-disp font-medium text-[26px] text-ink mt-0.5">
            Customise
          </h1>
        </div>
      )}

      <div className="flex items-start justify-between gap-4">
        <p className="text-xs text-mut leading-relaxed max-w-prose">
          Applies as you choose, and is saved in this browser only — it does not
          follow {clientName.split(" ")[0]} to another device, and nobody else
          sees it.
        </p>
        {isCustomized && (
          <button
            type="button"
            onClick={resetTheme}
            className="flex-none inline-flex items-center gap-1.5 text-[12px] font-semibold text-mut hover:text-ink border border-line hover:border-mut/40 rounded-[9px] px-3 py-1.5 cursor-pointer transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5 stroke-[1.7]" />
            Reset
          </button>
        )}
      </div>

      {/* ── Theme ──────────────────────────────────────────────────────── */}
      <section className="space-y-2.5">
        <h2 className="text-xs font-semibold text-ink select-none">Theme</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
          {THEME_PRESETS.map((p) => {
            const selected = theme.id === p.id;
            const dark = getLuminance(p.bgColor) < 0.5;
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => selectPreset(p)}
                aria-pressed={selected}
                className={`rounded-[11px] border p-3 text-left cursor-pointer transition-colors ${
                  selected
                    ? "border-green-d bg-green-bg/30"
                    : "border-line hover:border-mut/40"
                }`}
              >
                {/* The palette itself, at a size you can actually judge — three
                    dots told you a theme had three colours in it, not what it
                    looked like. */}
                <div
                  className="h-11 rounded-[7px] border border-black/10 flex items-center gap-1.5 px-2.5 mb-2.5"
                  style={{ backgroundColor: p.bgColor }}
                >
                  <span
                    className="h-1.5 flex-1 rounded-full"
                    style={{ backgroundColor: p.textColor, opacity: 0.85 }}
                  />
                  <span
                    className="w-4 h-4 rounded-full flex-none"
                    style={{ backgroundColor: p.accentColor }}
                  />
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[12.5px] font-semibold text-ink truncate">
                    {p.name}
                  </span>
                  {selected && (
                    <Check className="w-3.5 h-3.5 stroke-[2.5] text-green-d flex-none" />
                  )}
                </div>
                <span className="text-[11px] text-mut">{dark ? "Dark" : "Light"}</span>
              </button>
            );
          })}
        </div>
      </section>

      {/* ── Typeface ───────────────────────────────────────────────────── */}
      <section className="space-y-2.5">
        <h2 className="text-xs font-semibold text-ink select-none">Typeface</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {FONT_OPTIONS.map((f) => {
            const selected = theme.fontFamily === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => selectFont(f.id)}
                aria-pressed={selected}
                className={`rounded-[11px] border px-3.5 py-3 text-left cursor-pointer transition-colors ${
                  selected
                    ? "border-green-d bg-green-bg/30"
                    : "border-line hover:border-mut/40"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-[12.5px] font-semibold text-ink">{f.name}</span>
                  {selected && (
                    <Check className="w-3.5 h-3.5 stroke-[2.5] text-green-d flex-none" />
                  )}
                </div>
                {/* Set in the face itself, and showing the thing this app is
                    mostly made of: figures. A typeface that sets a nine badly
                    is the wrong typeface here, whatever its name looks like. */}
                <div
                  className="text-[15px] text-ink mt-1.5"
                  style={{ fontFamily: f.cssFamily }}
                >
                  $1,428,500.00 &middot; +14.2%
                </div>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
