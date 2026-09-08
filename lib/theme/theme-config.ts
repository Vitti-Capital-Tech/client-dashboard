export interface ThemeConfig {
  id: string;
  name: string;
  isDark?: boolean;
  // Core 3 Palette Colors
  bgColor: string;       // Background Canvas
  textColor: string;     // Text / Foreground
  accentColor: string;   // Primary Brand / Highlight Accent

  // Opacity & Surface Controls
  cardOpacity: number;       // 0.80 to 1.0
  borderOpacity: number;     // 0.05 to 0.30
  mutedTextOpacity: number;  // 0.40 to 0.80
  accentGlowOpacity: number; // 0.08 to 0.35

  // Typography
  fontFamily: string; // "hanken" | "inter" | "outfit" | "jakarta" | "fraunces" | "plex-mono" | "system"
}

export interface FontOption {
  id: string;
  name: string;
  category: "Sans-Serif" | "Serif" | "Monospace" | "System";
  cssFamily: string;
  description: string;
  sample: string;
}

export const FONT_OPTIONS: FontOption[] = [
  {
    id: "hanken",
    name: "Hanken Grotesk",
    category: "Sans-Serif",
    cssFamily: "var(--font-hanken-grotesk), system-ui, sans-serif",
    description: "Vitti brand default — refined, balanced, modern grotesque",
    sample: "Precision Wealth & Placements",
  },
  {
    id: "inter",
    name: "Inter",
    category: "Sans-Serif",
    cssFamily: "var(--font-inter), -apple-system, BlinkMacSystemFont, sans-serif",
    description: "Ultra-clean, high-legibility tech standard",
    sample: "Precision Wealth & Placements",
  },
  {
    id: "outfit",
    name: "Outfit",
    category: "Sans-Serif",
    cssFamily: "var(--font-outfit), -apple-system, BlinkMacSystemFont, sans-serif",
    description: "Geometric, contemporary, vibrant digital fintech",
    sample: "Precision Wealth & Placements",
  },
  {
    id: "jakarta",
    name: "Plus Jakarta Sans",
    category: "Sans-Serif",
    cssFamily: "var(--font-plus-jakarta-sans), -apple-system, BlinkMacSystemFont, sans-serif",
    description: "Sophisticated, crisp corporate banking aesthetic",
    sample: "Precision Wealth & Placements",
  },
  {
    id: "fraunces",
    name: "Fraunces Serif",
    category: "Serif",
    cssFamily: "var(--font-fraunces), Georgia, serif",
    description: "Classic luxury editorial serif with warm distinction",
    sample: "Precision Wealth & Placements",
  },
  {
    id: "plex-mono",
    name: "IBM Plex Mono",
    category: "Monospace",
    cssFamily: "var(--font-ibm-plex-mono), ui-monospace, monospace",
    description: "Algorithmic, quantitative trading terminal aesthetic",
    sample: "Precision Wealth & Placements",
  },
  {
    id: "system",
    name: "System Native",
    category: "System",
    cssFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    description: "Native OS interface font (San Francisco / Segoe UI)",
    sample: "Precision Wealth & Placements",
  },
];

export const THEME_PRESETS: ThemeConfig[] = [
  {
    id: "classic",
    name: "Vitti Classic",
    isDark: false,
    bgColor: "#f7f6f3",
    textColor: "#1d202f",
    accentColor: "#36bb91",
    cardOpacity: 1,
    borderOpacity: 0.12,
    mutedTextOpacity: 0.62,
    accentGlowOpacity: 0.14,
    fontFamily: "hanken",
  },
  {
    id: "midnight",
    name: "Midnight Slate",
    isDark: true,
    bgColor: "#0f172a",
    textColor: "#f8fafc",
    accentColor: "#14b8a6",
    cardOpacity: 0.96,
    borderOpacity: 0.14,
    mutedTextOpacity: 0.60,
    accentGlowOpacity: 0.18,
    fontFamily: "inter",
  },
  {
    id: "onyx",
    name: "Onyx Terminal",
    isDark: true,
    bgColor: "#090a0f",
    textColor: "#e2e8f0",
    accentColor: "#06b6d4",
    cardOpacity: 0.94,
    borderOpacity: 0.15,
    mutedTextOpacity: 0.58,
    accentGlowOpacity: 0.18,
    fontFamily: "plex-mono",
  },
  {
    id: "editorial",
    name: "Warm Espresso",
    isDark: false,
    bgColor: "#faf8f5",
    textColor: "#292524",
    accentColor: "#d97706",
    cardOpacity: 1,
    borderOpacity: 0.11,
    mutedTextOpacity: 0.64,
    accentGlowOpacity: 0.14,
    fontFamily: "fraunces",
  },
  {
    id: "forest",
    name: "Forest & Mint",
    isDark: true,
    bgColor: "#0b1a15",
    textColor: "#ecfdf5",
    accentColor: "#10b981",
    cardOpacity: 0.95,
    borderOpacity: 0.16,
    mutedTextOpacity: 0.60,
    accentGlowOpacity: 0.20,
    fontFamily: "outfit",
  },
  {
    id: "nordic",
    name: "Nordic Frost",
    isDark: false,
    bgColor: "#f1f5f9",
    textColor: "#1e293b",
    accentColor: "#3b82f6",
    cardOpacity: 0.98,
    borderOpacity: 0.12,
    mutedTextOpacity: 0.60,
    accentGlowOpacity: 0.15,
    fontFamily: "jakarta",
  },
];

export const DEFAULT_THEME = THEME_PRESETS[0];

/** Helper: Parse a hex color string (#rgb, #rrggbb) into { r, g, b } */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  let cleaned = hex.trim().replace(/^#/, "");
  if (cleaned.length === 3) {
    cleaned = cleaned
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const num = parseInt(cleaned, 16);
  if (isNaN(num) || cleaned.length !== 6) {
    return { r: 29, g: 32, b: 47 }; // Fallback to navy
  }
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
}

/** Helper: Calculate relative luminance of a color (0 to 1) */
export function getLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** Helper: Convert hex + alpha to rgba string */
export function hexToRgba(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  const clamped = Math.min(1, Math.max(0, alpha));
  return `rgba(${r}, ${g}, ${b}, ${clamped.toFixed(3)})`;
}

/** Helper: Lighten or darken a hex color by an amount (-1 to 1) */
export function adjustLightness(hex: string, amount: number): string {
  const { r, g, b } = hexToRgb(hex);
  const adjust = (c: number) => {
    if (amount > 0) {
      return Math.round(c + (255 - c) * amount);
    }
    return Math.round(c + c * amount);
  };
  const nr = Math.min(255, Math.max(0, adjust(r)));
  const ng = Math.min(255, Math.max(0, adjust(g)));
  const nb = Math.min(255, Math.max(0, adjust(b)));
  return `#${((1 << 24) + (nr << 16) + (ng << 8) + nb).toString(16).slice(1)}`;
}

/**
 * Generate complete CSS variables object based on a ThemeConfig
 */
export function generateThemeCssVariables(config: ThemeConfig): Record<string, string> {
  const lum = getLuminance(config.bgColor);
  const isDark = lum < 0.5;

  // Backgrounds
  const themeBg = config.bgColor;
  // Card surface: in dark mode, elevate slightly from background; in light mode, pure or soft white
  const cardBaseHex = isDark ? adjustLightness(config.bgColor, 0.08) : "#ffffff";
  const themeCard = hexToRgba(cardBaseHex, config.cardOpacity);
  // Secondary background (paper-2)
  const themeBgSubtle = isDark
    ? adjustLightness(config.bgColor, 0.04)
    : adjustLightness(config.bgColor, -0.035);

  // Text & Muted
  const themeText = config.textColor;
  const themeTextMuted = hexToRgba(config.textColor, config.mutedTextOpacity);

  // Borders & Dividers
  const themeBorder = hexToRgba(config.textColor, config.borderOpacity);
  const themeBorderSubtle = hexToRgba(config.textColor, config.borderOpacity * 0.7);

  // Accent & Soft Tint
  const themeAccent = config.accentColor;
  const themeAccentSoft = hexToRgba(config.accentColor, config.accentGlowOpacity);
  const themeAccentHover = adjustLightness(config.accentColor, isDark ? 0.12 : -0.12);

  // Sidebar styling derived from palette
  let themeSidebarBg: string;
  let themeSidebarHover: string;
  let themeSidebarActive: string;
  let themeSidebarBorder: string;

  if (isDark) {
    themeSidebarBg = adjustLightness(config.bgColor, -0.04);
    themeSidebarHover = adjustLightness(config.bgColor, 0.04);
    themeSidebarActive = adjustLightness(config.bgColor, 0.10);
    themeSidebarBorder = hexToRgba(config.textColor, 0.10);
  } else {
    // In light mode: deep contrast tone harmonised with the text palette
    const darkBase = adjustLightness(config.textColor, -0.05);
    themeSidebarBg = darkBase;
    themeSidebarHover = adjustLightness(darkBase, 0.08);
    themeSidebarActive = adjustLightness(darkBase, 0.16);
    themeSidebarBorder = hexToRgba("#ffffff", 0.08);
  }

  // Financial status tokens tailored for dark vs light surfaces
  const themeGain = isDark ? "#34d399" : "#1f9d6b";
  const themeGainBg = isDark ? "rgba(52, 211, 153, 0.14)" : "#e4f5ee";
  const themeLoss = isDark ? "#f87171" : "#d6573a";
  const themeLossD = isDark ? "#fb7185" : "#b8442b";
  const themeLossBg = isDark ? "rgba(248, 113, 113, 0.14)" : "#fae8e2";
  const themeAmber = isDark ? "#fbbf24" : "#c98a2b";
  const themeAmberBg = isDark ? "rgba(251, 191, 36, 0.14)" : "#f7ecd6";
  const themeAmberD = isDark ? "#fde68a" : "#9a6a1c";
  const themeGreenBg = isDark ? "rgba(52, 211, 153, 0.14)" : "#e4f5ee";
  const themeGreenD = isDark ? "#6ee7b7" : "#1f8e6b";

  // Table row interaction & fills
  const themeRowHover = isDark ? "rgba(255, 255, 255, 0.045)" : "#faf9f5";
  const themeChipBg = isDark ? "rgba(255, 255, 255, 0.08)" : "rgba(255, 255, 255, 0.70)";
  const themeRowOpen = isDark ? "rgba(245, 158, 11, 0.12)" : "rgba(247, 236, 214, 0.50)";
  const themeRowClosed = isDark ? "rgba(16, 185, 129, 0.08)" : "rgba(228, 245, 238, 0.45)";

  // Typography
  const fontObj = FONT_OPTIONS.find((f) => f.id === config.fontFamily) || FONT_OPTIONS[0];
  const themeFontBody = fontObj.cssFamily;

  return {
    "--theme-bg": themeBg,
    "--theme-card": themeCard,
    "--theme-bg-subtle": themeBgSubtle,
    "--theme-text": themeText,
    "--theme-text-muted": themeTextMuted,
    "--theme-border": themeBorder,
    "--theme-border-subtle": themeBorderSubtle,
    "--theme-accent": themeAccent,
    "--theme-accent-soft": themeAccentSoft,
    "--theme-accent-hover": themeAccentHover,
    "--theme-sidebar-bg": themeSidebarBg,
    "--theme-sidebar-hover": themeSidebarHover,
    "--theme-sidebar-active": themeSidebarActive,
    "--theme-sidebar-border": themeSidebarBorder,
    "--theme-font-body": themeFontBody,
    "--theme-gain": themeGain,
    "--theme-gain-bg": themeGainBg,
    "--theme-loss": themeLoss,
    "--theme-loss-d": themeLossD,
    "--theme-loss-bg": themeLossBg,
    "--theme-amber": themeAmber,
    "--theme-amber-bg": themeAmberBg,
    "--theme-amber-d": themeAmberD,
    "--theme-green-bg": themeGreenBg,
    "--theme-green-d": themeGreenD,
    "--theme-row-hover": themeRowHover,
    "--theme-chip-bg": themeChipBg,
    "--theme-row-open": themeRowOpen,
    "--theme-row-closed": themeRowClosed,
  };
}

/** Helper: Calculate WCAG contrast ratio between two hex colors (1 to 21) */
export function getContrastRatio(hex1: string, hex2: string): number {
  const l1 = getLuminance(hex1);
  const l2 = getLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Helper: Check if color pair meets WCAG AA (4.5:1 for normal text) */
export function isContrastAdequate(bgColor: string, textColor: string): boolean {
  return getContrastRatio(bgColor, textColor) >= 4.5;
}
