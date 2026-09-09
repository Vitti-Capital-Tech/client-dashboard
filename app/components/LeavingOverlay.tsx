"use client";

import { useEffect, useState, type ReactNode } from "react";
import { pickTip } from "@/lib/ui/leaving";

/**
 * The screen shown while the app is on its way somewhere else.
 *
 * Fixed rather than a block in the flow, so the page it is leaving goes with
 * it — a panel sitting inside the portal shell would keep a nav and a heading
 * that belong to a page already on its way out.
 *
 * It arrives in four beats: the mark lands, its stroke draws, a ring goes out
 * from it, then the words rise underneath. All of it is over inside the first
 * second, because the screen itself is only up for about three — an animation
 * still introducing itself when the page changes is worse than none.
 *
 * ── The bar tells the truth or it sweeps ───────────────────────────────────
 * Given a `durationMs` it fills across in exactly that time, and the caller is
 * expected to be holding for the same number. Given none it sweeps instead,
 * because a round trip has no percentage to report and a bar that pretends to
 * know is worse than one that admits it does not.
 */
export function LeavingOverlay({
  title,
  subtitle,
  tips,
  durationMs,
  tone = "accent",
  icon,
}: {
  title: string;
  subtitle: string;
  /** A pool, so somebody who signs in twice is not read the same line twice. */
  tips: readonly string[];
  /**
   * How long the caller is holding for. Omit when the wait is a round trip of
   * unknown length — the bar sweeps instead of filling.
   */
  durationMs?: number;
  /** Muted for endings; nobody is celebrating a sign-out. */
  tone?: "accent" | "muted";
  /**
   * Paths must carry `pathLength="1"`. That normalises the dash to the path's
   * own length, which is what lets one CSS rule draw a door and a tick without
   * knowing how long either of them is.
   */
  icon?: ReactNode;
}) {
  const accent = tone === "accent";

  /**
   * Chosen after mount, not during render.
   *
   * A random pick while rendering differs between the server's HTML and the
   * client's first pass, which is a hydration mismatch. An effect runs only in
   * the browser and only after hydration, so the server renders no tip and the
   * client adds one — a frame later, which is invisible under the 0.54s the
   * animation delays it by anyway.
   *
   * Set once. A re-render mid-animation must not swap the sentence out from
   * under somebody who is halfway through reading it.
   */
  const [tip, setTip] = useState<string | null>(null);

  useEffect(() => {
    // The rule against setState in an effect is right nearly everywhere, and
    // wrong here: this value has to differ between visits and must NOT differ
    // between the server render and the first client one. An effect is the only
    // place both are true.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTip(pickTip(tips));
    // Once, on arrival — deliberately not re-run when `tips` is re-created.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="fixed inset-0 z-100 flex flex-col items-center justify-center gap-3 bg-paper px-6 text-center"
      role="status"
      aria-live="polite"
    >
      <span aria-hidden className="relative flex h-12 w-12 items-center justify-center">
        {/* Behind the mark and not part of it, sized off the parent so it stays
            centred on the mark rather than on whatever the mark draws. */}
        <span
          className={`leave-ring absolute inset-0 rounded-full ${
            accent ? "bg-green" : "bg-mut"
          }`}
        />
        <span
          className={`leave-mark relative flex h-12 w-12 items-center justify-center rounded-full ${
            accent ? "bg-green text-[#08130e]" : "bg-paper-2 text-mut"
          }`}
        >
          {icon ?? (
            <svg viewBox="0 0 24 24" className="h-6 w-6">
              <path
                pathLength="1"
                d="M5 12.5l4.5 4.5L19 7.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </span>
      </span>

      <p className="leave-rise leave-rise-1 text-[15px] font-semibold text-ink">{title}</p>
      <p className="leave-rise leave-rise-2 text-[12.5px] text-mut">{subtitle}</p>

      <span
        aria-hidden
        className="leave-rise leave-rise-3 mt-1 h-1 w-40 overflow-hidden rounded-full bg-line relative"
      >
        {durationMs === undefined ? (
          <span className={`leave-sweep block h-full rounded-full ${accent ? "bg-green" : "bg-mut"}`} />
        ) : (
          <span
            className={`leave-fill block h-full rounded-full ${accent ? "bg-green" : "bg-mut"}`}
            style={{ animationDuration: `${durationMs}ms` }}
          />
        )}
      </span>

      {/* Last to arrive, and the only thing here worth reading rather than
          watching. The wait is what buys the time to read it. */}
      {tip && (
        <p className="leave-rise leave-rise-4 mt-5 max-w-xs text-[12.5px] leading-relaxed text-mut">
          {tip}
        </p>
      )}
    </div>
  );
}
