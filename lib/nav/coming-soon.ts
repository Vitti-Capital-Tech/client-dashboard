/**
 * The pages that are still being built.
 *
 * One list, because there is more than one way into a page. The nav is the
 * obvious one, but the dashboard also offers "Put $X cash to work" and "See
 * this week's idea" (both Invest), a "Briefing" link (Markets) and an "Open
 * Vitti Intelligence" button (Ask Vitti) — so disabling the nav entry alone
 * left four live doors into three half-written pages, which is worse than
 * having left the nav alone: it says the feature is not ready in one place and
 * hands you into it from another.
 *
 * Kept as paths rather than as a flag on the nav items, since the callers that
 * need it most are not the nav.
 *
 * To ship one of these: delete its line. Nothing else has to be found.
 */
const COMING_SOON: readonly string[] = [
  "/portal/client/invest",
  "/portal/client/askvitti",
  "/portal/client/markets",
  "/portal/client/watchlist",
];

/** Whether this route is still being built, and so must not be navigated to. */
export function isComingSoon(path: string): boolean {
  return COMING_SOON.includes(path);
}
