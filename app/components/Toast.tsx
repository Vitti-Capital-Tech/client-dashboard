"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Check, X, AlertTriangle } from "lucide-react";

/**
 * Small confirmations, in the corner, that go away by themselves.
 *
 * ── What this replaces ─────────────────────────────────────────────────────
 * `window.alert` and `window.confirm`. They are modal, they are drawn by the
 * operating system rather than by us, they say "localhost:3000 says", and they
 * stop everything until dismissed — for the sake of telling somebody that a
 * company was added to a list. On a client portal for a wealth manager they
 * read as a bug.
 *
 * ── Undo instead of "are you sure?" ────────────────────────────────────────
 * A confirm dialog interrupts everyone, including the many people who meant
 * it, to protect the few who did not. For anything reversible the better trade
 * is to do it at once and offer it back: the action is instant for whoever
 * meant it, and one click away from undone for whoever did not. That is what
 * `action` is for. It is not a substitute for a real confirmation on something
 * irreversible — sign-out still asks, and it should.
 */

export type ToastTone = "success" | "error" | "info";

export type ToastInput = {
  message: string;
  tone?: ToastTone;
  /** An offer to reverse what just happened, e.g. Undo. */
  action?: { label: string; onClick: () => void };
};

type Toast = ToastInput & { id: number };

const ToastContext = createContext<((t: ToastInput) => void) | null>(null);

/**
 * How long a toast stays.
 *
 * One with an Undo stays longer because it has to be READ and then acted on,
 * and four seconds is not enough to notice a line, understand it, and decide to
 * reverse it.
 */
const PLAIN_MS = 4000;
const WITH_ACTION_MS = 7000;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      const id = nextId.current++;
      // Three at a time. A stack that grows without limit covers the page it is
      // reporting on, and nobody reads the fourth one anyway.
      setToasts((list) => [...list.slice(-2), { ...input, id }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), input.action ? WITH_ACTION_MS : PLAIN_MS),
      );
    },
    [dismiss],
  );

  // Nothing should outlive the tree that scheduled it.
  useEffect(() => {
    const scheduled = timers.current;
    return () => {
      for (const t of scheduled.values()) clearTimeout(t);
      scheduled.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={toast}>
      {children}

      {/*
        `bottom-20` on small screens: the portal's tab bar is fixed to the
        bottom on mobile, and a toast landing on top of it hides the navigation
        and takes the tap meant for it.
      */}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="fixed z-100 bottom-20 md:bottom-6 right-4 md:right-6 left-4 md:left-auto flex flex-col gap-2 pointer-events-none"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className="toast-in pointer-events-auto flex items-center gap-2.5 md:w-84 bg-white border border-line rounded-[11px] shadow-shadow-lg px-3.5 py-3"
          >
            <span
              className={`w-6 h-6 rounded-full flex-none flex items-center justify-center ${
                t.tone === "error"
                  ? "bg-loss-bg text-loss-d"
                  : t.tone === "info"
                  ? "bg-paper-2 text-mut"
                  : "bg-green-bg text-green-d"
              }`}
            >
              {t.tone === "error" ? (
                <AlertTriangle className="w-3.5 h-3.5 stroke-[2]" aria-hidden />
              ) : (
                <Check className="w-3.5 h-3.5 stroke-[2.5]" aria-hidden />
              )}
            </span>

            <span className="flex-1 text-[12.5px] leading-snug text-ink">{t.message}</span>

            {t.action && (
              <button
                type="button"
                onClick={() => {
                  t.action?.onClick();
                  dismiss(t.id);
                }}
                className="flex-none text-[12px] font-semibold text-green-d underline underline-offset-2 hover:opacity-80 cursor-pointer"
              >
                {t.action.label}
              </button>
            )}

            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss"
              className="flex-none text-mut hover:text-ink cursor-pointer"
            >
              <X className="w-3.5 h-3.5 stroke-[2]" aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * Raise a toast.
 *
 * Returns a no-op outside the provider rather than throwing. A toast is a
 * courtesy on top of an action that has already happened; taking a page down
 * because the courtesy has nowhere to render would be the wrong order of
 * priorities.
 */
export function useToast(): (t: ToastInput) => void {
  const ctx = useContext(ToastContext);
  return ctx ?? (() => {});
}
