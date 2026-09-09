/**
 * The screens shown while the app is on its way somewhere else, and the lines
 * printed on them.
 *
 * ── Why a wait gets a screen at all ────────────────────────────────────────
 * Signing in, signing out and ending every session all do real work: a round
 * trip to Supabase Auth, and — on the way into the portal — a layout and a page
 * that between them make several database calls, each with a measured floor of
 * about 350ms from here. Until now that time was spent on a button reading
 * "Signing in…" and then a screen that changed when it felt like it. This says
 * what is happening, and uses the second it was going to cost anyway.
 *
 * ── Why some of these hold, and one does not ───────────────────────────────
 * `signIn` has no minimum. People signing in want to be in, and the wait is
 * whatever the server takes; padding it would be charging them for a tip they
 * did not ask for. Endings are different — they are once-in-a-while, nobody is
 * being kept from anything, and an action this final should visibly complete
 * rather than blink.
 *
 * The floor for those is set by reading rather than by taste. The tip arrives
 * 0.54s in, and a ten-word line takes roughly two and a half seconds to read
 * unhurried, so under about three seconds shows a sentence nobody can finish.
 * The tips are kept near ten words for the same reason: the cheap way to make a
 * line readable is to make it shorter, not to hold the reader longer.
 */
export const LEAVING_MS = {
  /** Signing out of this browser. Common enough not to dwell. */
  signOut: 3000,
  /** Ending every session everywhere. Rare, final, worth a beat longer. */
  sessionsEnded: 3400,
} as const;

/**
 * Lines shown while somebody waits.
 *
 * Every one of these is true of this app as it stands. That is the whole
 * constraint and it is not a small one: a tip is read as a statement from the
 * firm, on a screen the client cannot dismiss, and a helpful sentence about a
 * feature that does not exist is worse than a blank space. When a page here is
 * still being built, its tip waits until it is not.
 */
export const SIGN_IN_TIPS = [
  "Your P&L is Vitti's own reconciliation of your contract notes.",
  "Portfolio splits your holdings by sector, held and all-time.",
  "Options tracks exercise windows and tells you before they close.",
  "Market carries every price-sensitive ASX filing of the day.",
  "The bell holds your alerts, on every page, unread first.",
  "Hold another account? Add it under Accounts with its broker number.",
] as const;

export const SIGN_OUT_TIPS = [
  "Signing in again takes a one-time code, or your password.",
  "Every sign-in is recorded in the audit log with time and device.",
  "Alerts keep arriving while you are away. The bell will have them.",
  "Settings holds your login details and the look of this portal.",
  "Appearance is saved per browser, so each device can differ.",
] as const;

export const SESSIONS_ENDED_TIPS = [
  "Every device is signed out, including the one you are reading this on.",
  "Signing back in takes a one-time code, or your password.",
  "Worth changing your password too, if the reason was a lost device.",
  "The audit log records this, with the time it happened.",
] as const;

/** One line from a pool, chosen at random. See `LeavingOverlay` for the timing. */
export function pickTip(tips: readonly string[]): string | null {
  if (tips.length === 0) return null;
  return tips[Math.floor(Math.random() * tips.length)];
}
