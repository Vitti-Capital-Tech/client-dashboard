/**
 * Static UI discovery config for the /invest page — goal categories and theme
 * chips. Deliberately NOT persisted (see LLD §7.2): these are presentation
 * scaffolding (icons, labels, blurbs), not mutable data. Client-safe (no
 * server-only imports).
 */

export type Goal = {
  k: string;
  label: string;
  icon: string;
  themes: string[];
  blurb: string;
};

export const GOALS: Goal[] = [
  { k: "grow", label: "Grow my money", icon: "M4 19V5M4 19h16M8 15l3-4 3 2 4-6", themes: ["Resources", "Blue chips"], blurb: "Growth-focused ideas with more upside (and more movement)." },
  { k: "income", label: "Earn income", icon: "M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6", themes: ["Income"], blurb: "Established companies that pay regular dividends." },
  { k: "early", label: "Get in early", icon: "M13 2 4.5 13.5H11L9.5 22 19 10h-6.5z", themes: ["Pre-IPO & deals"], blurb: "Placements and pre-IPO deals — Vitti’s edge, higher risk." },
  { k: "steady", label: "Keep it steady", icon: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z", themes: ["Blue chips", "Income"], blurb: "Larger, lower-volatility names to build a base." },
];

export const THEMES: string[] = ["Blue chips", "Resources", "Pre-IPO & deals", "Income"];
