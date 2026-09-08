"use client";

import React, { useState } from "react";
import {
  Palette,
  RotateCcw,
  Check,
  CheckCircle2,
  Sparkles,
  Sliders,
  Type,
  Sun,
  Moon,
  TrendingUp,
  CreditCard,
  Zap,
  AlertTriangle,
  MousePointer,
} from "lucide-react";
import { useTheme } from "@/app/components/ThemeProvider";
import {
  THEME_PRESETS,
  FONT_OPTIONS,
  type ThemeConfig,
  getLuminance,
  hexToRgba,
  adjustLightness,
  getContrastRatio,
} from "@/lib/theme/theme-config";

export function CustomiseClient({
  clientName,
}: {
  clientName: string;
}) {
  const { theme, setTheme, resetTheme, isCustomized, isDark } = useTheme();
  const [copied, setCopied] = useState(false);
  const [presetTab, setPresetTab] = useState<"all" | "light" | "dark">("all");

  // Contrast calculation
  const contrastRatio = getContrastRatio(theme.bgColor, theme.textColor);
  const isAdequate = contrastRatio >= 4.5;

  // 1-Click Mode Switcher (Light vs Dark)
  const handleToggleMode = (targetDark: boolean) => {
    if (targetDark) {
      // Switch to Midnight Slate or harmonised dark while preserving user accent
      setTheme((prev) => ({
        ...prev,
        id: "midnight",
        isDark: true,
        bgColor: "#0f172a",
        textColor: "#f8fafc",
        accentColor: prev.accentColor || "#14b8a6",
        cardOpacity: 0.96,
        borderOpacity: 0.14,
        mutedTextOpacity: 0.60,
      }));
    } else {
      // Switch to Classic Light while preserving user accent
      setTheme((prev) => ({
        ...prev,
        id: "classic",
        isDark: false,
        bgColor: "#f7f6f3",
        textColor: "#1d202f",
        accentColor: prev.accentColor || "#36bb91",
        cardOpacity: 1,
        borderOpacity: 0.12,
        mutedTextOpacity: 0.62,
      }));
    }
  };

  // Quick helper to apply a preset
  const handleSelectPreset = (preset: ThemeConfig) => {
    setTheme({ ...preset });
  };

  // Helper to update specific fields
  const updateTheme = (fields: Partial<ThemeConfig>) => {
    setTheme((prev) => ({
      ...prev,
      id: "custom",
      ...fields,
    }));
  };

  // Smart background color update that guards against unreadable text
  const updateBgColor = (newBg: string) => {
    const isNewDark = getLuminance(newBg) < 0.5;
    let newTextColor = theme.textColor;
    if (getContrastRatio(newBg, theme.textColor) < 3.0) {
      newTextColor = isNewDark ? "#f8fafc" : "#1d202f";
    }
    setTheme((prev) => ({
      ...prev,
      id: "custom",
      bgColor: newBg,
      textColor: newTextColor,
    }));
  };

  const handleCopyPalette = () => {
    const data = JSON.stringify(theme, null, 2);
    void navigator.clipboard.writeText(data);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Filter presets based on selected tab
  const filteredPresets = THEME_PRESETS.filter((p) => {
    const isPresetDark = getLuminance(p.bgColor) < 0.5;
    if (presetTab === "light") return !isPresetDark;
    if (presetTab === "dark") return isPresetDark;
    return true;
  });

  // Live preview calculations
  const previewCardBg = isDark
    ? hexToRgba(adjustLightness(theme.bgColor, 0.08), theme.cardOpacity)
    : hexToRgba("#ffffff", theme.cardOpacity);
  const previewBorder = hexToRgba(theme.textColor, theme.borderOpacity);
  const previewMuted = hexToRgba(theme.textColor, theme.mutedTextOpacity);
  const previewAccentSoft = hexToRgba(theme.accentColor, theme.accentGlowOpacity);
  const selectedFontObj =
    FONT_OPTIONS.find((f) => f.id === theme.fontFamily) || FONT_OPTIONS[0];

  return (
    <div className="space-y-7 max-w-5xl mx-auto pb-12">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-line pb-5">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-mut">
            <Palette className="w-4 h-4 text-green-d" />
            <span>Platform Customisation</span>
          </div>
          <h1 className="font-disp font-medium text-[28px] text-ink mt-1">
            Personalise Appearance
          </h1>
          <p className="text-sm text-mut mt-0.5">
            Select a curated theme preset or craft a custom color palette, opacities, and typography.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={resetTheme}
            disabled={!isCustomized}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold border border-line bg-paper-2 hover:bg-paper-border text-mut hover:text-ink transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            title="Reset theme to Vitti Classic default"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset to Default</span>
          </button>

          <button
            type="button"
            onClick={handleCopyPalette}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold border border-line bg-card hover:bg-paper-2 text-ink shadow-2xs transition-colors cursor-pointer"
            title="Copy theme JSON configuration to clipboard"
          >
            {copied ? (
              <>
                <Check className="w-3.5 h-3.5 text-green-d" />
                <span className="text-green-d">Copied!</span>
              </>
            ) : (
              <>
                <Sparkles className="w-3.5 h-3.5 text-amber-d" />
                <span>Copy Palette JSON</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Quick 1-Click Appearance Mode Switcher Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-2xl border border-line bg-card shadow-shadow">
        <div className="flex items-center gap-3">
          <div
            className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
              isDark
                ? "bg-indigo-500/15 text-indigo-400 border border-indigo-500/25"
                : "bg-amber-500/15 text-amber-600 border border-amber-500/25"
            }`}
          >
            {isDark ? <Moon className="w-5 h-5" /> : <Sun className="w-5 h-5" />}
          </div>
          <div>
            <div className="text-xs font-bold text-ink flex items-center gap-2">
              <span>{isDark ? "Dark Theme Mode" : "Light Theme Mode"}</span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-paper-2 border border-line/60 text-mut font-semibold">
                {isDark ? "Low-Light Optimized" : "High Clarity Paper"}
              </span>
            </div>
            <div className="text-3xs text-mut mt-0.5">
              {isDark
                ? "Tables, tickers, and financial numbers are balanced for dark background readability."
                : "Classic daytime financial aesthetic with clean borders and contrast."}
            </div>
          </div>
        </div>

        {/* 1-Click Segmented Mode Switcher */}
        <div className="flex items-center gap-1.5 bg-paper-2 p-1 rounded-xl border border-line/60 self-start sm:self-center">
          <button
            type="button"
            onClick={() => handleToggleMode(false)}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
              !isDark
                ? "bg-card text-ink shadow-xs border border-line/60 font-bold"
                : "text-mut hover:text-ink"
            }`}
          >
            <Sun className="w-3.5 h-3.5 text-amber-500" />
            <span>Light</span>
          </button>
          <button
            type="button"
            onClick={() => handleToggleMode(true)}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
              isDark
                ? "bg-card text-ink shadow-xs border border-line/60 font-bold"
                : "text-mut hover:text-ink"
            }`}
          >
            <Moon className="w-3.5 h-3.5 text-indigo-400" />
            <span>Dark</span>
          </button>
        </div>
      </div>

      {/* Grid: Left Column Controls, Right Column Live Preview */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-7 items-start">
        {/* Main Controls (7 cols) */}
        <div className="lg:col-span-7 space-y-7">
          {/* Section 1: Curated Theme Presets */}
          <div className="card bg-card border border-line rounded-2xl p-5 shadow-shadow space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-amber-d" />
                <h2 className="font-semibold text-sm text-ink">Curated Presets</h2>
              </div>

              {/* Filter Tabs for Presets */}
              <div className="flex items-center gap-1 bg-paper-2 p-0.5 rounded-lg border border-line/60">
                <button
                  type="button"
                  onClick={() => setPresetTab("all")}
                  className={`px-2.5 py-1 rounded-md text-3xs font-semibold cursor-pointer transition-colors ${
                    presetTab === "all"
                      ? "bg-card text-ink shadow-2xs font-bold"
                      : "text-mut hover:text-ink"
                  }`}
                >
                  All (6)
                </button>
                <button
                  type="button"
                  onClick={() => setPresetTab("light")}
                  className={`px-2.5 py-1 rounded-md text-3xs font-semibold cursor-pointer transition-colors ${
                    presetTab === "light"
                      ? "bg-card text-ink shadow-2xs font-bold"
                      : "text-mut hover:text-ink"
                  }`}
                >
                  ☀️ Light (3)
                </button>
                <button
                  type="button"
                  onClick={() => setPresetTab("dark")}
                  className={`px-2.5 py-1 rounded-md text-3xs font-semibold cursor-pointer transition-colors ${
                    presetTab === "dark"
                      ? "bg-card text-ink shadow-2xs font-bold"
                      : "text-mut hover:text-ink"
                  }`}
                >
                  🌙 Dark (3)
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {filteredPresets.map((p) => {
                const isSelected =
                  theme.id === p.id ||
                  (theme.bgColor === p.bgColor &&
                    theme.textColor === p.textColor &&
                    theme.accentColor === p.accentColor &&
                    theme.fontFamily === p.fontFamily);

                const lum = getLuminance(p.bgColor);
                const isDarkPreset = lum < 0.5;

                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => handleSelectPreset(p)}
                    className={`relative p-3.5 rounded-xl border text-left transition-all cursor-pointer flex flex-col justify-between gap-3 ${
                      isSelected
                        ? "border-green-d ring-2 ring-green-d/20 bg-green-bg/25 shadow-xs"
                        : "border-line hover:border-mut/40 bg-paper-2/40 hover:bg-paper-2"
                    }`}
                  >
                    <div className="flex items-center justify-between w-full">
                      <div className="flex items-center gap-1.5">
                        <span className="font-semibold text-xs text-ink">{p.name}</span>
                        {isDarkPreset ? (
                          <Moon className="w-3 h-3 text-indigo-400" />
                        ) : (
                          <Sun className="w-3 h-3 text-amber-500" />
                        )}
                      </div>
                      {isSelected && (
                        <CheckCircle2 className="w-4 h-4 text-green-d" />
                      )}
                    </div>

                    {/* Color Swatch Preview & Font Badge */}
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5">
                        <span
                          className="w-4.5 h-4.5 rounded-full border border-black/15 shadow-2xs"
                          style={{ backgroundColor: p.bgColor }}
                          title={`Background: ${p.bgColor}`}
                        />
                        <span
                          className="w-4.5 h-4.5 rounded-full border border-black/15 shadow-2xs"
                          style={{ backgroundColor: p.textColor }}
                          title={`Text: ${p.textColor}`}
                        />
                        <span
                          className="w-4.5 h-4.5 rounded-full border border-black/15 shadow-2xs"
                          style={{ backgroundColor: p.accentColor }}
                          title={`Accent: ${p.accentColor}`}
                        />
                      </div>
                      <span className="text-[10px] font-mono font-medium px-2 py-0.5 rounded-md bg-paper border border-line text-mut">
                        {p.fontFamily}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Section 2: Custom Colour Palette */}
          <div className="card bg-card border border-line rounded-2xl p-5 shadow-shadow space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Palette className="w-4 h-4 text-green-d" />
                <h2 className="font-semibold text-sm text-ink">Core Colour Palette</h2>
              </div>
              <span className="text-2xs font-semibold uppercase tracking-wider text-mut">
                2–3 Colours
              </span>
            </div>

            <p className="text-xs text-mut leading-relaxed">
              Choose your canvas background, primary text, and brand accent. Secondary card surfaces, borders, and muted typography are harmoniously calculated from these selections.
            </p>

            {/* Contrast Safeguard Banner */}
            {!isAdequate && (
              <div className="flex items-center justify-between p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-600 dark:text-amber-400 text-xs">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
                  <span>
                    Low contrast ({contrastRatio.toFixed(1)}:1). Text may be difficult to read.
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const optimalText = isDark ? "#f8fafc" : "#1d202f";
                    updateTheme({ textColor: optimalText });
                  }}
                  className="px-2.5 py-1 rounded-lg bg-amber-500 text-white font-semibold text-2xs cursor-pointer shadow-2xs hover:bg-amber-600 transition-colors shrink-0"
                >
                  Auto-Fix Contrast
                </button>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5 pt-1">
              {/* 1. Background Color */}
              <div className="p-3 rounded-xl border border-line bg-paper-2/40 space-y-2.5">
                <label className="block text-2xs font-semibold uppercase tracking-wider text-mut">
                  1. Background Canvas
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={theme.bgColor}
                    onChange={(e) => updateBgColor(e.target.value)}
                    className="w-9 h-9 rounded-lg border border-line cursor-pointer bg-transparent p-0"
                    title="Choose background color"
                  />
                  <input
                    type="text"
                    value={theme.bgColor.toUpperCase()}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (/^#[0-9A-Fa-f]{0,6}$/.test(val)) {
                        updateBgColor(val);
                      }
                    }}
                    className="w-full font-mono text-xs px-2 py-1.5 rounded-lg border border-line bg-card text-ink focus:outline-none focus:border-green-d uppercase"
                    maxLength={7}
                  />
                </div>
                {/* Quick Swatches */}
                <div className="flex items-center gap-1.5 pt-1">
                  {["#f7f6f3", "#0f172a", "#090a0f", "#faf8f5", "#0b1a15", "#f1f5f9"].map(
                    (hex) => (
                      <button
                        key={hex}
                        type="button"
                        onClick={() => updateBgColor(hex)}
                        className={`w-4 h-4 rounded-full border border-black/20 transition-transform ${
                          theme.bgColor.toLowerCase() === hex.toLowerCase()
                            ? "scale-125 ring-2 ring-green-d/40"
                            : "hover:scale-110"
                        }`}
                        style={{ backgroundColor: hex }}
                      />
                    )
                  )}
                </div>
              </div>

              {/* 2. Text / Ink Color */}
              <div className="p-3 rounded-xl border border-line bg-paper-2/40 space-y-2.5">
                <label className="block text-2xs font-semibold uppercase tracking-wider text-mut">
                  2. Text / Ink
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={theme.textColor}
                    onChange={(e) => updateTheme({ textColor: e.target.value })}
                    className="w-9 h-9 rounded-lg border border-line cursor-pointer bg-transparent p-0"
                    title="Choose text color"
                  />
                  <input
                    type="text"
                    value={theme.textColor.toUpperCase()}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (/^#[0-9A-Fa-f]{0,6}$/.test(val)) {
                        updateTheme({ textColor: val });
                      }
                    }}
                    className="w-full font-mono text-xs px-2 py-1.5 rounded-lg border border-line bg-card text-ink focus:outline-none focus:border-green-d uppercase"
                    maxLength={7}
                  />
                </div>
                {/* Quick Swatches */}
                <div className="flex items-center gap-1.5 pt-1">
                  {["#1d202f", "#f8fafc", "#e2e8f0", "#292524", "#ecfdf5", "#1e293b"].map(
                    (hex) => (
                      <button
                        key={hex}
                        type="button"
                        onClick={() => updateTheme({ textColor: hex })}
                        className={`w-4 h-4 rounded-full border border-black/20 transition-transform ${
                          theme.textColor.toLowerCase() === hex.toLowerCase()
                            ? "scale-125 ring-2 ring-green-d/40"
                            : "hover:scale-110"
                        }`}
                        style={{ backgroundColor: hex }}
                      />
                    )
                  )}
                </div>
              </div>

              {/* 3. Primary / Accent Color */}
              <div className="p-3 rounded-xl border border-line bg-paper-2/40 space-y-2.5">
                <label className="block text-2xs font-semibold uppercase tracking-wider text-mut">
                  3. Accent Brand
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={theme.accentColor}
                    onChange={(e) => updateTheme({ accentColor: e.target.value })}
                    className="w-9 h-9 rounded-lg border border-line cursor-pointer bg-transparent p-0"
                    title="Choose accent color"
                  />
                  <input
                    type="text"
                    value={theme.accentColor.toUpperCase()}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (/^#[0-9A-Fa-f]{0,6}$/.test(val)) {
                        updateTheme({ accentColor: val });
                      }
                    }}
                    className="w-full font-mono text-xs px-2 py-1.5 rounded-lg border border-line bg-card text-ink focus:outline-none focus:border-green-d uppercase"
                    maxLength={7}
                  />
                </div>
                {/* Quick Swatches */}
                <div className="flex items-center gap-1.5 pt-1">
                  {["#36bb91", "#14b8a6", "#06b6d4", "#d97706", "#10b981", "#3b82f6"].map(
                    (hex) => (
                      <button
                        key={hex}
                        type="button"
                        onClick={() => updateTheme({ accentColor: hex })}
                        className={`w-4 h-4 rounded-full border border-black/20 transition-transform ${
                          theme.accentColor.toLowerCase() === hex.toLowerCase()
                            ? "scale-125 ring-2 ring-green-d/40"
                            : "hover:scale-110"
                        }`}
                        style={{ backgroundColor: hex }}
                      />
                    )
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Section 3: Opacity & Surface Refinement */}
          <div className="card bg-card border border-line rounded-2xl p-5 shadow-shadow space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Sliders className="w-4 h-4 text-green-d" />
                <h2 className="font-semibold text-sm text-ink">Opacity &amp; Surface Tuning</h2>
              </div>
              <span className="text-2xs font-semibold uppercase tracking-wider text-mut">
                Transparency &amp; Contrast
              </span>
            </div>

            <p className="text-xs text-mut">
              Adjust opacity and translucency to create solid surfaces or elegant frosted glassmorphism.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-1">
              {/* Card Opacity */}
              <div className="p-3.5 rounded-xl border border-line bg-paper-2/30 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-ink">Card Surface Opacity</span>
                  <span className="font-mono text-mut font-semibold">
                    {Math.round(theme.cardOpacity * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min="0.80"
                  max="1.00"
                  step="0.01"
                  value={theme.cardOpacity}
                  onChange={(e) => updateTheme({ cardOpacity: parseFloat(e.target.value) })}
                  className="w-full accent-green-d cursor-pointer"
                />
                <span className="text-3xs text-mut block">
                  {theme.cardOpacity < 0.95 ? "Translucent / Glassmorphic" : "Solid Opaque"}
                </span>
              </div>

              {/* Border Opacity */}
              <div className="p-3.5 rounded-xl border border-line bg-paper-2/30 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-ink">Borders &amp; Lines Opacity</span>
                  <span className="font-mono text-mut font-semibold">
                    {Math.round(theme.borderOpacity * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min="0.05"
                  max="0.28"
                  step="0.01"
                  value={theme.borderOpacity}
                  onChange={(e) => updateTheme({ borderOpacity: parseFloat(e.target.value) })}
                  className="w-full accent-green-d cursor-pointer"
                />
                <span className="text-3xs text-mut block">
                  {theme.borderOpacity < 0.1 ? "Subtle Faint" : "Crisp High Contrast"}
                </span>
              </div>

              {/* Muted Text Opacity */}
              <div className="p-3.5 rounded-xl border border-line bg-paper-2/30 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-ink">Muted Subtext Opacity</span>
                  <span className="font-mono text-mut font-semibold">
                    {Math.round(theme.mutedTextOpacity * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min="0.40"
                  max="0.80"
                  step="0.02"
                  value={theme.mutedTextOpacity}
                  onChange={(e) =>
                    updateTheme({ mutedTextOpacity: parseFloat(e.target.value) })
                  }
                  className="w-full accent-green-d cursor-pointer"
                />
                <span className="text-3xs text-mut block">
                  Secondary labels and timestamps contrast
                </span>
              </div>

              {/* Accent Glow Opacity */}
              <div className="p-3.5 rounded-xl border border-line bg-paper-2/30 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-ink">Accent Glow &amp; Soft Tint</span>
                  <span className="font-mono text-mut font-semibold">
                    {Math.round(theme.accentGlowOpacity * 100)}%
                  </span>
                </div>
                <input
                  type="range"
                  min="0.08"
                  max="0.30"
                  step="0.01"
                  value={theme.accentGlowOpacity}
                  onChange={(e) =>
                    updateTheme({ accentGlowOpacity: parseFloat(e.target.value) })
                  }
                  className="w-full accent-green-d cursor-pointer"
                />
                <span className="text-3xs text-mut block">
                  Active pills and live indicator background wash
                </span>
              </div>
            </div>
          </div>

          {/* Section 4: Font Family Selection */}
          <div className="card bg-card border border-line rounded-2xl p-5 shadow-shadow space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Type className="w-4 h-4 text-green-d" />
                <h2 className="font-semibold text-sm text-ink">Typography &amp; Font Family</h2>
              </div>
              <span className="text-2xs font-semibold uppercase tracking-wider text-mut">
                Body &amp; Financial
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {FONT_OPTIONS.map((f) => {
                const isSelected = theme.fontFamily === f.id;
                return (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => updateTheme({ fontFamily: f.id })}
                    className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer flex flex-col justify-between gap-2.5 ${
                      isSelected
                        ? "border-green-d ring-2 ring-green-d/20 bg-green-bg/25 shadow-xs"
                        : "border-line hover:border-mut/40 bg-paper-2/40 hover:bg-paper-2"
                    }`}
                  >
                    <div className="flex items-center justify-between w-full">
                      <div>
                        <span className="font-bold text-xs text-ink block">{f.name}</span>
                        <span className="text-3xs text-mut">{f.category}</span>
                      </div>
                      {isSelected && <CheckCircle2 className="w-4 h-4 text-green-d" />}
                    </div>

                    <div
                      className="text-xs text-ink line-clamp-1 py-1 px-2 rounded bg-card/60 border border-line/60"
                      style={{ fontFamily: f.cssFamily }}
                    >
                      $1,428,500.00 &middot; +14.2%
                    </div>

                    <p className="text-3xs text-mut leading-tight line-clamp-1">
                      {f.description}
                    </p>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Live Interactive Preview Widget (5 cols) */}
        <div className="lg:col-span-5 sticky top-20 space-y-4">
          <div className="flex items-center justify-between px-1">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: theme.accentColor }} />
              <h3 className="text-xs font-semibold uppercase tracking-wider text-mut">
                Live Interactive Preview
              </h3>
            </div>
            <span className="text-3xs font-mono font-medium text-mut">
              Updates in real-time
            </span>
          </div>

          {/* Mock Dashboard Preview Container */}
          <div
            className="rounded-2xl p-5 border transition-all shadow-shadow-lg overflow-hidden space-y-4"
            style={{
              backgroundColor: theme.bgColor,
              color: theme.textColor,
              borderColor: previewBorder,
              fontFamily: selectedFontObj.cssFamily,
            }}
          >
            {/* Header / Greeting */}
            <div className="flex items-center justify-between border-b pb-3" style={{ borderColor: previewBorder }}>
              <div>
                <div className="text-3xs font-mono tracking-wider uppercase" style={{ color: previewMuted }}>
                  TUESDAY, 8 SEPT
                </div>
                <h4 className="font-bold text-base mt-0.5" style={{ color: theme.textColor }}>
                  Good morning, {clientName.split(" ")[0]}
                </h4>
              </div>

              {/* Live Broker Feed Pill */}
              <div
                className="inline-flex items-center gap-1.5 text-[10px] font-semibold py-1 px-2.5 rounded-full"
                style={{
                  backgroundColor: previewAccentSoft,
                  color: theme.accentColor,
                }}
              >
                <span
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ backgroundColor: theme.accentColor }}
                />
                <span>Broker feed &middot; live</span>
              </div>
            </div>

            {/* KPI Metric Card */}
            <div
              className="p-4 rounded-xl border space-y-2 transition-all"
              style={{
                backgroundColor: previewCardBg,
                borderColor: previewBorder,
              }}
            >
              <div className="flex items-center justify-between text-xs">
                <span style={{ color: previewMuted }}>Total Portfolio Value</span>
                <span
                  className="text-2xs font-semibold px-2 py-0.5 rounded-full"
                  style={{
                    backgroundColor: isDark ? "rgba(52, 211, 153, 0.15)" : "#e4f5ee",
                    color: isDark ? "#34d399" : "#1f9d6b",
                  }}
                >
                  +14.2% Return
                </span>
              </div>

              <div className="font-mono text-2xl font-bold tracking-tight" style={{ color: theme.textColor }}>
                $1,248,650.00
              </div>

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  className="flex-1 py-1.5 px-3 rounded-lg text-xs font-semibold text-white shadow-xs cursor-pointer flex items-center justify-center gap-1.5"
                  style={{ backgroundColor: theme.accentColor }}
                >
                  <Zap className="w-3.5 h-3.5" />
                  <span>Bid Placements</span>
                </button>
                <button
                  type="button"
                  className="flex-1 py-1.5 px-3 rounded-lg text-xs font-semibold border cursor-pointer flex items-center justify-center gap-1.5"
                  style={{
                    borderColor: previewBorder,
                    color: theme.textColor,
                    backgroundColor: "transparent",
                  }}
                >
                  <CreditCard className="w-3.5 h-3.5" />
                  <span>Withdraw Cash</span>
                </button>
              </div>
            </div>

            {/* Realistic Table Rows Preview (Open, Closed, and Hover) */}
            <div
              className="rounded-xl border overflow-hidden text-xs"
              style={{
                backgroundColor: previewCardBg,
                borderColor: previewBorder,
              }}
            >
              <div
                className="px-3 py-2 border-b font-semibold text-2xs uppercase tracking-wider flex items-center justify-between"
                style={{
                  borderColor: previewBorder,
                  color: previewMuted,
                }}
              >
                <span>Sample Table (Portfolio)</span>
                <span className="flex items-center gap-1 text-3xs font-normal">
                  <MousePointer className="w-3 h-3" /> Hover active
                </span>
              </div>

              <div className="divide-y" style={{ borderColor: previewBorder }}>
                {/* 1. Open Position Row (OD60) */}
                <div
                  className="p-2.5 flex items-center justify-between transition-colors"
                  style={{
                    backgroundColor: isDark ? "rgba(245, 158, 11, 0.12)" : "rgba(247, 236, 214, 0.50)",
                    boxShadow: isDark ? "inset 3.5px 0 0 0 #f59e0b" : "inset 3.5px 0 0 0 #d97706",
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="font-mono font-bold text-2xs px-1.5 py-0.5 rounded border"
                      style={{
                        backgroundColor: isDark ? "rgba(255, 255, 255, 0.08)" : "#efece5",
                        borderColor: previewBorder,
                        color: theme.textColor,
                      }}
                    >
                      OD60
                    </span>
                    <div>
                      <div className="font-semibold text-xs leading-tight" style={{ color: theme.textColor }}>
                        OD6 Metals Ltd
                      </div>
                      <div className="text-3xs" style={{ color: previewMuted }}>
                        38,461 units &middot; Listed Option
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 text-right">
                    <span
                      className="text-[10px] font-bold px-2 py-0.5 rounded-full border"
                      style={{
                        backgroundColor: isDark ? "rgba(251, 191, 36, 0.15)" : "#f7ecd6",
                        color: isDark ? "#fbbf24" : "#9a6a1c",
                        borderColor: isDark ? "rgba(251, 191, 36, 0.3)" : "#e5d5b5",
                      }}
                    >
                      Open
                    </span>
                    <div className="font-mono font-bold text-xs" style={{ color: isDark ? "#34d399" : "#1f9d6b" }}>
                      +$2,423.04
                    </div>
                  </div>
                </div>

                {/* 2. Closed Position Row (HYD) */}
                <div
                  className="p-2.5 flex items-center justify-between transition-colors"
                  style={{
                    backgroundColor: isDark ? "rgba(16, 185, 129, 0.08)" : "rgba(228, 245, 238, 0.45)",
                    boxShadow: isDark ? "inset 3.5px 0 0 0 #10b981" : "inset 3.5px 0 0 0 #10b981",
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="font-mono font-bold text-2xs px-1.5 py-0.5 rounded border"
                      style={{
                        backgroundColor: isDark ? "rgba(255, 255, 255, 0.08)" : "#efece5",
                        borderColor: previewBorder,
                        color: theme.textColor,
                      }}
                    >
                      HYD
                    </span>
                    <div>
                      <div className="font-semibold text-xs leading-tight" style={{ color: theme.textColor }}>
                        Hydrix Limited
                      </div>
                      <div className="text-3xs" style={{ color: previewMuted }}>
                        1,280,953 units &middot; Ordinary
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 text-right">
                    <span
                      className="text-[10px] font-bold px-2 py-0.5 rounded-full border"
                      style={{
                        backgroundColor: isDark ? "rgba(52, 211, 153, 0.15)" : "#e4f5ee",
                        color: isDark ? "#34d399" : "#1f8e6b",
                        borderColor: isDark ? "rgba(52, 211, 153, 0.3)" : "#bde3d2",
                      }}
                    >
                      Closed
                    </span>
                    <div className="font-mono font-bold text-xs" style={{ color: isDark ? "#34d399" : "#1f9d6b" }}>
                      +$4,996.99
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Notification / Alert Card */}
            <div
              className="p-3 rounded-xl border flex items-start gap-2.5 text-xs"
              style={{
                backgroundColor: previewCardBg,
                borderColor: previewBorder,
              }}
            >
              <TrendingUp className="w-4 h-4 mt-0.5 flex-none" style={{ color: theme.accentColor }} />
              <div className="leading-snug">
                <span className="font-semibold" style={{ color: theme.textColor }}>
                  In the money option:
                </span>{" "}
                <span style={{ color: previewMuted }}>
                  OD60 exercise window open. Intrinsic value strikes are updated in real-time.
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
