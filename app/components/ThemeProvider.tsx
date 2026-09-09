"use client";

import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import {
  type ThemeConfig,
  DEFAULT_THEME,
  generateThemeCssVariables,
  getLuminance,
} from "@/lib/theme/theme-config";

interface ThemeContextValue {
  theme: ThemeConfig;
  setTheme: (newTheme: ThemeConfig | ((prev: ThemeConfig) => ThemeConfig)) => void;
  resetTheme: () => void;
  isCustomized: boolean;
  isDark: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const STORAGE_KEY = "vitti_custom_theme";

/**
 * The theme this browser has saved, or the default.
 *
 * Returns the DEFAULT during server rendering and on the very first client
 * render — `typeof window` is the test, and on the client React runs the
 * initialiser during hydration, where the two must agree. After hydration the
 * sync effect writes whatever the browser is actually showing, which the init
 * script has already applied to the document.
 */
function readSavedTheme(): ThemeConfig {
  if (typeof window === "undefined") return DEFAULT_THEME;
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (!saved) return DEFAULT_THEME;
    const parsed = JSON.parse(saved) as ThemeConfig;
    if (parsed && parsed.bgColor && parsed.textColor) return parsed;
  } catch {
    // Unreadable or blocked storage is not an error worth showing anybody.
  }
  return DEFAULT_THEME;
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  /**
   * The saved theme is read once, lazily, rather than in an effect.
   *
   * It used to be `useState(DEFAULT_THEME)` plus a mount effect that read
   * localStorage and called `setThemeState` — which lint flags, correctly, as a
   * synchronous setState inside an effect: it renders the default, then throws
   * that render away and renders again.
   *
   * The reason it was written that way is real, though: `localStorage` does not
   * exist on the server, and a lazy initialiser that read it would give the
   * client different first-render output than the server sent, which is a
   * hydration mismatch. The way out is to keep the FIRST render identical on
   * both sides — the default, always — and to let the initialiser read storage
   * only where there is no server render to disagree with, which is every
   * render after the module has loaded in the browser.
   *
   * The paint is not at risk either way: `ThemeInitScript` has already applied
   * the saved theme (or the default) to the document before React runs at all.
   * This state is what the Customise controls read, not what the page is
   * wearing.
   */
  const [theme, setThemeState] = useState<ThemeConfig>(readSavedTheme);

  /**
   * Whether the theme in state got there by somebody choosing it.
   *
   * A ref and not state: it gates the effect below, and gating an effect is not
   * something the screen needs re-rendering for. It was `useState(false)` set
   * to true from a mount effect, which is a setState inside an effect — a
   * render thrown away to record that a render had happened.
   */
  const chosen = useRef(false);

  const applyThemeToDom = (cfg: ThemeConfig) => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    const vars = generateThemeCssVariables(cfg);
    const lum = getLuminance(cfg.bgColor);
    const isDark = lum < 0.5;

    // Set active theme attributes
    root.setAttribute("data-theme-active", "true");
    root.setAttribute("data-theme-mode", isDark ? "dark" : "light");

    for (const [k, v] of Object.entries(vars)) {
      root.style.setProperty(k, v);
    }
  };

  /**
   * Write the theme out when it CHANGES, and not when it is merely read.
   *
   * The first run is skipped, because on that pass `theme` is whatever
   * `readSavedTheme` found — storing it again would write the file back over
   * itself, and for somebody who has never chosen anything it would save the
   * current default as if they had picked it, quietly pinning them to it if the
   * default ever moves. The document is already painted by `ThemeInitScript` by
   * then, so there is nothing to apply either.
   */
  useEffect(() => {
    if (!chosen.current) {
      chosen.current = true;
      return;
    }
    applyThemeToDom(theme);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
    } catch {
      // Ignore localStorage write error
    }
  }, [theme]);

  const setTheme = (updater: ThemeConfig | ((prev: ThemeConfig) => ThemeConfig)) => {
    setThemeState(updater);
  };

  /**
   * Back to Midnight Slate — not back to the bare stylesheet.
   *
   * This used to strip `data-theme-active` and every inline custom property,
   * which was right while the default WAS the stylesheet's own light palette.
   * Now that the default is a theme like any other, stripping it would drop the
   * person onto the old light look, which nothing else in the product shows
   * them. The saved choice is still cleared, so the next load starts from the
   * default rather than from what they were resetting away from.
   */
  const resetTheme = () => {
    setThemeState(DEFAULT_THEME);
    applyThemeToDom(DEFAULT_THEME);
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore
    }
  };


  const isDark = getLuminance(theme.bgColor) < 0.5;
  const isCustomized =
    theme.id !== DEFAULT_THEME.id ||
    theme.bgColor !== DEFAULT_THEME.bgColor ||
    theme.textColor !== DEFAULT_THEME.textColor ||
    theme.accentColor !== DEFAULT_THEME.accentColor ||
    theme.fontFamily !== DEFAULT_THEME.fontFamily;

  return (
    <ThemeContext.Provider
      value={{
        theme,
        setTheme,
        resetTheme,
        isCustomized,
        isDark,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return ctx;
}

/**
 * Head script that executes synchronously before hydration to prevent
 * flash of unstyled theme on page load.
 */
export function ThemeInitScript() {
  const scriptContent = `
    (function() {
      try {
        // The default is inlined so that somebody who has never chosen a theme
        // still gets one on the FIRST paint. Without it this returned early,
        // the page rendered the stylesheet's light palette, and the dark
        // default only arrived after hydration — a white flash on every first
        // load, which is precisely what this script exists to prevent.
        var DEFAULTS = ${JSON.stringify(DEFAULT_THEME)};
        var raw = localStorage.getItem("${STORAGE_KEY}");
        var theme = raw ? JSON.parse(raw) : DEFAULTS;
        if (!theme || !theme.bgColor || !theme.textColor) theme = DEFAULTS;
        var root = document.documentElement;
        function hexToRgb(h) {
          var c = h.replace('#', '');
          if (c.length === 3) c = c.split('').map(function(x){return x+x;}).join('');
          var n = parseInt(c, 16);
          return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
        }
        function lum(h) {
          var rgb = hexToRgb(h);
          return (0.299*rgb.r + 0.587*rgb.g + 0.114*rgb.b) / 255;
        }
        function rgba(h, a) {
          var rgb = hexToRgb(h);
          return 'rgba(' + rgb.r + ', ' + rgb.g + ', ' + rgb.b + ', ' + Math.min(1, Math.max(0, a)).toFixed(3) + ')';
        }
        function adjust(h, amt) {
          var rgb = hexToRgb(h);
          var nr = amt > 0 ? Math.round(rgb.r + (255 - rgb.r)*amt) : Math.round(rgb.r + rgb.r*amt);
          var ng = amt > 0 ? Math.round(rgb.g + (255 - rgb.g)*amt) : Math.round(rgb.g + rgb.g*amt);
          var nb = amt > 0 ? Math.round(rgb.b + (255 - rgb.b)*amt) : Math.round(rgb.b + rgb.b*amt);
          return '#' + ((1 << 24) + (nr << 16) + (ng << 8) + nb).toString(16).slice(1);
        }
        var isDark = lum(theme.bgColor) < 0.5;
        root.setAttribute('data-theme-active', 'true');
        root.setAttribute('data-theme-mode', isDark ? 'dark' : 'light');
        root.style.setProperty('--theme-bg', theme.bgColor);
        var cardHex = isDark ? adjust(theme.bgColor, 0.08) : '#ffffff';
        root.style.setProperty('--theme-card', rgba(cardHex, theme.cardOpacity || 1));
        var bgSubtle = isDark ? adjust(theme.bgColor, 0.04) : adjust(theme.bgColor, -0.035);
        root.style.setProperty('--theme-bg-subtle', bgSubtle);
        root.style.setProperty('--theme-text', theme.textColor);
        root.style.setProperty('--theme-text-muted', rgba(theme.textColor, theme.mutedTextOpacity || 0.6));
        root.style.setProperty('--theme-border', rgba(theme.textColor, theme.borderOpacity || 0.12));
        root.style.setProperty('--theme-accent', theme.accentColor);
        root.style.setProperty('--theme-accent-soft', rgba(theme.accentColor, theme.accentGlowOpacity || 0.15));
        
        var sidebarBg = isDark ? adjust(theme.bgColor, -0.04) : adjust(theme.textColor, -0.05);
        var sidebarHover = isDark ? adjust(theme.bgColor, 0.04) : adjust(sidebarBg, 0.08);
        var sidebarActive = isDark ? adjust(theme.bgColor, 0.10) : adjust(sidebarBg, 0.16);
        var sidebarBorder = isDark ? rgba(theme.textColor, 0.10) : rgba('#ffffff', 0.08);
        root.style.setProperty('--theme-sidebar-bg', sidebarBg);
        root.style.setProperty('--theme-sidebar-hover', sidebarHover);
        root.style.setProperty('--theme-sidebar-active', sidebarActive);
        root.style.setProperty('--theme-sidebar-border', sidebarBorder);

        root.style.setProperty('--theme-gain', isDark ? '#34d399' : '#1f9d6b');
        root.style.setProperty('--theme-gain-bg', isDark ? 'rgba(52, 211, 153, 0.14)' : '#e4f5ee');
        root.style.setProperty('--theme-loss', isDark ? '#f87171' : '#d6573a');
        root.style.setProperty('--theme-loss-d', isDark ? '#fb7185' : '#b8442b');
        root.style.setProperty('--theme-loss-bg', isDark ? 'rgba(248, 113, 113, 0.14)' : '#fae8e2');
        root.style.setProperty('--theme-amber', isDark ? '#fbbf24' : '#c98a2b');
        root.style.setProperty('--theme-amber-bg', isDark ? 'rgba(251, 191, 36, 0.14)' : '#f7ecd6');
        root.style.setProperty('--theme-amber-d', isDark ? '#fde68a' : '#9a6a1c');
        root.style.setProperty('--theme-green-bg', isDark ? 'rgba(52, 211, 153, 0.14)' : '#e4f5ee');
        root.style.setProperty('--theme-green-d', isDark ? '#6ee7b7' : '#1f8e6b');
        root.style.setProperty('--theme-row-hover', isDark ? 'rgba(255, 255, 255, 0.045)' : '#faf9f5');
        root.style.setProperty('--theme-chip-bg', isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(255, 255, 255, 0.70)');
        root.style.setProperty('--theme-row-open', isDark ? 'rgba(245, 158, 11, 0.12)' : 'rgba(247, 236, 214, 0.50)');
        root.style.setProperty('--theme-row-closed', isDark ? 'rgba(16, 185, 129, 0.08)' : 'rgba(228, 245, 238, 0.45)');
        
        var fonts = {
          hanken: 'var(--font-hanken-grotesk), system-ui, sans-serif',
          inter: "var(--font-inter), -apple-system, BlinkMacSystemFont, sans-serif",
          outfit: "var(--font-outfit), -apple-system, BlinkMacSystemFont, sans-serif",
          jakarta: "var(--font-plus-jakarta-sans), -apple-system, BlinkMacSystemFont, sans-serif",
          fraunces: 'var(--font-fraunces), Georgia, serif',
          'plex-mono': 'var(--font-ibm-plex-mono), ui-monospace, monospace',
          system: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
        };
        if (fonts[theme.fontFamily]) {
          root.style.setProperty('--theme-font-body', fonts[theme.fontFamily]);
        }
      } catch (e) {}
    })();
  `;

  return (
    <script
      id="vitti-theme-init"
      dangerouslySetInnerHTML={{ __html: scriptContent }}
    />
  );
}
