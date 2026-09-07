"use client";

import React, { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { fieldClass } from "./AuthShell";

/**
 * A password box with a show/hide toggle.
 *
 * Five of these across three pages — sign in, sign up (twice), reset (twice) —
 * so it is one component rather than five copies of an absolutely-positioned
 * button. The same argument as `CodeInput`: the fiddly parts below are the ones
 * that would have been reimplemented differently each time.
 *
 * ── Visibility is per-box, not per-form ─────────────────────────────────────
 * "Password" and "Confirm password" each get their own toggle and their own
 * state. Revealing both at once would defeat the point of asking twice: the
 * second box exists to catch a typo in the first, and you catch it by typing it
 * again, not by reading the first one back.
 *
 * ── The button is reachable by keyboard, and is not a submit ────────────────
 * `type="button"` because a bare `<button>` inside a `<form>` defaults to
 * `type="submit"` — the toggle would submit the form and, on the sign-in page,
 * attempt a login with whatever had been typed so far. It stays in the tab order
 * rather than taking `tabIndex={-1}`: someone who cannot see the field is
 * precisely who may need to check what they typed.
 */
export function PasswordInput({
  id,
  label,
  hint,
  value,
  onChange,
  rightSlot,
  ...input
}: {
  id: string;
  label: string;
  /** Small print under the field — the strength rule, where one applies. */
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  /** Rendered on the label row, right-aligned (the "Forgot password?" link). */
  rightSlot?: React.ReactNode;
} & Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "value" | "onChange" | "id" | "type"
>) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="block text-xs font-semibold text-ink">
          {label}
        </label>
        {rightSlot}
      </div>

      <div className="relative">
        <input
          id={id}
          name={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
          // `pr-11` leaves room for the button. Without it a long password runs
          // underneath the icon and the last characters — the ones you are
          // squinting at — are the ones covered.
          className={`${fieldClass} pr-11`}
          {...input}
        />

        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          // `aria-pressed` rather than a label that changes meaning: a screen
          // reader announces the toggle and its state, instead of a button whose
          // name flips as you use it.
          aria-pressed={visible}
          aria-label={visible ? "Hide password" : "Show password"}
          title={visible ? "Hide password" : "Show password"}
          className="absolute right-1 top-1/2 -translate-y-1/2 p-2 rounded-[8px] text-mut hover:text-ink hover:bg-paper-2 focus:outline-none focus:text-ink cursor-pointer transition-colors"
        >
          {visible ? (
            <EyeOff className="w-4.5 h-4.5 stroke-[1.7]" aria-hidden="true" />
          ) : (
            <Eye className="w-4.5 h-4.5 stroke-[1.7]" aria-hidden="true" />
          )}
        </button>
      </div>

      {hint && <p className="text-[11.5px] text-mut">{hint}</p>}
    </div>
  );
}
