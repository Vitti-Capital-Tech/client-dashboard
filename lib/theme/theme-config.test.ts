import test from "node:test";
import assert from "node:assert/strict";
import {
  hexToRgb,
  getLuminance,
  hexToRgba,
  adjustLightness,
  generateThemeCssVariables,
  getContrastRatio,
  isContrastAdequate,
  THEME_PRESETS,
  DEFAULT_THEME,
} from "./theme-config.ts";

test("hexToRgb parses 6-digit and 3-digit hex strings accurately", () => {
  assert.deepEqual(hexToRgb("#ffffff"), { r: 255, g: 255, b: 255 });
  assert.deepEqual(hexToRgb("#000000"), { r: 0, g: 0, b: 0 });
  assert.deepEqual(hexToRgb("#fff"), { r: 255, g: 255, b: 255 });
  assert.deepEqual(hexToRgb("#1d202f"), { r: 29, g: 32, b: 47 });
});

test("getLuminance distinguishes light and dark colors", () => {
  const whiteLum = getLuminance("#ffffff");
  const blackLum = getLuminance("#000000");
  const slateLum = getLuminance("#0f172a");
  const paperLum = getLuminance("#f7f6f3");

  assert(whiteLum > 0.95);
  assert(blackLum < 0.05);
  assert(slateLum < 0.5, "Slate should be classified as dark");
  assert(paperLum > 0.5, "Paper should be classified as light");
});

test("hexToRgba correctly formats rgba with alpha clamped", () => {
  const rgba = hexToRgba("#ffffff", 0.5);
  assert.equal(rgba, "rgba(255, 255, 255, 0.500)");

  const clampedHigh = hexToRgba("#000000", 1.5);
  assert.equal(clampedHigh, "rgba(0, 0, 0, 1.000)");

  const clampedLow = hexToRgba("#000000", -0.5);
  assert.equal(clampedLow, "rgba(0, 0, 0, 0.000)");
});

test("adjustLightness shifts color brightness in expected direction", () => {
  const darkened = adjustLightness("#ffffff", -0.2);
  const lumOriginal = getLuminance("#ffffff");
  const lumDarkened = getLuminance(darkened);
  assert(lumDarkened < lumOriginal);

  const lightened = adjustLightness("#000000", 0.2);
  const lumBlack = getLuminance("#000000");
  const lumLightened = getLuminance(lightened);
  assert(lumLightened > lumBlack);
});

test("generateThemeCssVariables outputs all necessary CSS tokens for light theme", () => {
  const vars = generateThemeCssVariables(DEFAULT_THEME);

  assert(vars["--theme-bg"]);
  assert(vars["--theme-card"]);
  assert(vars["--theme-bg-subtle"]);
  assert(vars["--theme-text"]);
  assert(vars["--theme-text-muted"]);
  assert(vars["--theme-border"]);
  assert(vars["--theme-border-subtle"]);
  assert(vars["--theme-accent"]);
  assert(vars["--theme-accent-soft"]);
  assert(vars["--theme-font-body"]);
  assert.equal(vars["--theme-gain"], "#1f9d6b");
  assert.equal(vars["--theme-row-hover"], "#faf9f5");
});

test("generateThemeCssVariables outputs high-contrast tokens for dark theme", () => {
  const midnight = THEME_PRESETS.find((p) => p.id === "midnight")!;
  const vars = generateThemeCssVariables(midnight);

  assert.equal(vars["--theme-gain"], "#34d399", "Dark mode gain should be bright emerald");
  assert.equal(vars["--theme-loss"], "#f87171", "Dark mode loss should be bright coral");
  assert.equal(vars["--theme-amber"], "#fbbf24", "Dark mode amber should be bright gold");
  assert(vars["--theme-row-hover"].startsWith("rgba(255, 255, 255,"), "Hover must be subtle translucent");
  assert(vars["--theme-chip-bg"].startsWith("rgba(255, 255, 255,"), "Ticker chip must be subtle translucent");
});

test("getContrastRatio and isContrastAdequate calculate WCAG compliance", () => {
  const whiteOnBlack = getContrastRatio("#000000", "#ffffff");
  assert(whiteOnBlack >= 20, "White on black contrast should be ~21:1");
  assert(isContrastAdequate("#000000", "#ffffff"));

  const darkOnDark = getContrastRatio("#0f172a", "#1d202f");
  assert(darkOnDark < 2.0, "Dark on dark should fail contrast check");
  assert(!isContrastAdequate("#0f172a", "#1d202f"));
});

test("presets cover both light and dark variations", () => {
  const darkPresets = THEME_PRESETS.filter((p) => getLuminance(p.bgColor) < 0.5);
  const lightPresets = THEME_PRESETS.filter((p) => getLuminance(p.bgColor) >= 0.5);

  assert(darkPresets.length >= 2, "Must have at least 2 dark presets");
  assert(lightPresets.length >= 2, "Must have at least 2 light presets");
});
