"use client";

import { useSyncExternalStore } from "react";

/**
 * The two-note chime that plays when an alert arrives, and the mute switch.
 *
 * ── Why it is synthesised and not a file ────────────────────────────────────
 * A short chime is about twenty lines of Web Audio and about 20KB as an mp3.
 * The file would also be a request that can fail, a cache entry that can go
 * stale, and an asset somebody has to keep in the repo — for a sound that is
 * two sine waves. Generating it costs nothing and cannot 404.
 *
 * ── The browser rule that governs this, and why it is not a bug ─────────────
 * Browsers refuse to let a page make noise before the visitor has interacted
 * with it. An `AudioContext` created on load starts SUSPENDED, and `resume()`
 * only succeeds after a real click, key press or tap somewhere on the page.
 *
 * So: a client who loads the portal and leaves it untouched in a background tab
 * gets no sound for the first alert. A client who has clicked anything at all —
 * opened the bell, changed a tab, scrolled with the keyboard — gets every one.
 * There is no way around it and no way to detect it in advance; this is
 * deliberately silent about it rather than throwing, because a portfolio screen
 * that logs errors about a chime is worse than a chime that occasionally does
 * not play.
 *
 * This is also why the tab title carries the count (`TabUnreadCount`): the
 * count is always right, and the sound is the part that is best-effort.
 */

const STORAGE_KEY = "vitti_alert_sound";

/* ───────────────────────────── the preference ────────────────────────────── */

/**
 * On by default, remembered per browser.
 *
 * `NewsViewToggle`'s pattern, for its reasons: `localStorage` does not exist on
 * the server, so reading it during render would make the two disagree, and
 * reading it in a mount effect and calling `setState` renders once and throws
 * that render away. `useSyncExternalStore` has a server snapshot for exactly
 * this.
 */
let current: boolean | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): boolean {
  if (current !== null) return current;
  try {
    // Only an explicit "off" opts out, so an absent or unreadable value lands
    // on the default rather than silencing the product by accident.
    current = window.localStorage.getItem(STORAGE_KEY) !== "off";
  } catch {
    current = true;
  }
  return current;
}

/** On, on the server and on the hydrating client alike — it must be constant. */
function getServerSnapshot(): boolean {
  return true;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function setAlertSound(on: boolean): void {
  if (current === on) return;
  current = on;
  try {
    window.localStorage.setItem(STORAGE_KEY, on ? "on" : "off");
  } catch {
    // The switch still works for this visit; only the memory of it is lost.
  }
  for (const listener of listeners) listener();
}

/** Whether the chime is on, and a setter every mounted toggle hears. */
export function useAlertSound(): [boolean, (on: boolean) => void] {
  return [useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot), setAlertSound];
}

/* ─────────────────────────────── the chime ───────────────────────────────── */

type AudioCtor = typeof AudioContext;

let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor: AudioCtor | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
  if (!Ctor) return null;
  // One context for the life of the page. Creating one per chime leaks: browsers
  // cap them at a few dozen and then refuse to make more.
  ctx ??= new Ctor();
  return ctx;
}

/**
 * Two rising notes, ~0.3s, quiet.
 *
 * A6 then D7 — a small interval up, which reads as a notification rather than
 * as an error. The gain ramps are exponential and start from a near-zero value
 * rather than 0, because `exponentialRampToValueAtTime` cannot touch zero and a
 * square-edged start is the click you hear in badly made UI sounds.
 *
 * Peak gain is 0.12 on purpose. This fires on a screen someone may have open
 * all day beside other work; a sound they reach to mute is a sound that gets
 * muted permanently.
 */
export function playAlertChime(): void {
  if (!getSnapshot()) return;

  const ac = context();
  if (!ac) return;

  // Suspended until the visitor has interacted with the page. Ask, ignore the
  // rejection, and give up quietly if it is still not running.
  void ac.resume?.().catch(() => {});
  if (ac.state !== "running") return;

  const now = ac.currentTime;
  for (const [freq, at] of [
    [880, 0],
    [1174.66, 0.09],
  ] as const) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + at);
    gain.gain.exponentialRampToValueAtTime(0.12, now + at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.22);
    osc.connect(gain).connect(ac.destination);
    osc.start(now + at);
    osc.stop(now + at + 0.24);
  }
}
