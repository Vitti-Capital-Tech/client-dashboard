"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
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

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<ThemeConfig>(DEFAULT_THEME);
  const [mounted, setMounted] = useState(false);

  // On mount: read from localStorage if present
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as ThemeConfig;
        if (parsed && parsed.bgColor && parsed.textColor) {
          setThemeState(parsed);
          applyThemeToDom(parsed);
        }
      }
    } catch {
      // Ignore localStorage read error
    }
    setMounted(true);
  }, []);

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

  // Sync theme changes to DOM and localStorage after mount
  useEffect(() => {
    if (!mounted) return;
    applyThemeToDom(theme);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(theme));
    } catch {
      // Ignore localStorage write error
    }
  }, [theme, mounted]);

  const setTheme = (updater: ThemeConfig | ((prev: ThemeConfig) => ThemeConfig)) => {
    setThemeState(updater);
  };

  const resetTheme = () => {
    setThemeState(DEFAULT_THEME);
    if (typeof document !== "undefined") {
      const root = document.documentElement;
      root.removeAttribute("data-theme-active");
      root.removeAttribute("data-theme-mode");
      // Clean up inline properties
      const vars = generateThemeCssVariables(DEFAULT_THEME);
      for (const k of Object.keys(vars)) {
        root.style.removeProperty(k);
      }
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        // Ignore
      }
    }
  };


  const isDark = getLuminance(theme.bgColor) < 0.5;
  const isCustomized =
    theme.id !== "classic" ||
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
        var raw = localStorage.getItem("${STORAGE_KEY}");
        if (!raw) return;
        var theme = JSON.parse(raw);
        if (!theme || !theme.bgColor || !theme.textColor) return;
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
