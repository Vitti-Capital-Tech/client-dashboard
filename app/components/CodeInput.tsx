"use client";

import React, { useEffect, useRef } from "react";

/** Digits in an emailed code. Matches `otp_length` in supabase/config.toml. */
export const CODE_LENGTH = 6;

/**
 * The six boxes an emailed code is typed into.
 *
 * Lifted out of the login page when sign-up and password reset needed the same
 * thing. All three consume the same `verifyOtp` call, so they had better agree on
 * how the code is entered — and the paste handling below is the part that would
 * have been reimplemented worse.
 *
 * Controlled: the parent owns `digits` and decides what a full code means, which
 * is what lets sign-in verify on the last keystroke while sign-up waits for a
 * button. The one thing kept internal is focus, since it is nobody else's
 * business — including the "an error cleared the boxes, put the cursor back"
 * case, handled by the effect below rather than by every caller remembering.
 */
export function CodeInput({
  digits,
  onChange,
  onError,
  disabled = false,
  label = "One-time code",
}: {
  digits: string[];
  onChange: (next: string[]) => void;
  onError: (message: string) => void;
  disabled?: boolean;
  label?: string;
}) {
  const boxes = useRef<(HTMLInputElement | null)[]>([]);

  // Empty boxes mean either a fresh mount or a code the parent just rejected and
  // cleared. Both want the cursor in the first box, and neither wants the caller
  // to have to say so.
  const empty = digits.every((d) => !d);
  useEffect(() => {
    if (empty && !disabled) boxes.current[0]?.focus();
  }, [empty, disabled]);

  const handleDigit = (index: number, raw: string) => {
    const value = raw.replace(/\D/g, "").slice(-1);
    const next = [...digits];
    next[index] = value;
    onChange(next);
    if (value && index < CODE_LENGTH - 1) boxes.current[index + 1]?.focus();
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !digits[index] && index > 0) {
      e.preventDefault();
      const next = [...digits];
      next[index - 1] = "";
      onChange(next);
      boxes.current[index - 1]?.focus();
      return;
    }
    if (e.key === "ArrowLeft" && index > 0) boxes.current[index - 1]?.focus();
    if (e.key === "ArrowRight" && index < CODE_LENGTH - 1) {
      boxes.current[index + 1]?.focus();
    }
  };

  /**
   * Codes arrive to be copied, not typed. Without this, pasting all six digits
   * lands one character in one box and looks broken.
   *
   * A paste LONGER than the boxes is refused rather than trimmed. Truncating it
   * silently filled six boxes from an eight-digit code and auto-submitted the
   * first six — which fails as "not a valid code" and sends you looking at the
   * wrong thing. It happened for real: the project's Email OTP Length was 8
   * while this form asked for 6, and the only symptom was a code that never
   * worked. Say what is actually wrong instead.
   */
  const handlePaste = (index: number, e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text").replace(/\D/g, "");
    if (!pasted) return;
    e.preventDefault();

    if (pasted.length > CODE_LENGTH) {
      onError(
        `That code is ${pasted.length} digits — this screen expects ${CODE_LENGTH}. ` +
          `Ask an administrator to check the one-time code length.`,
      );
      return;
    }

    const next = [...digits];
    for (let i = 0; i < pasted.length && index + i < CODE_LENGTH; i++) {
      next[index + i] = pasted[i];
    }
    onChange(next);
    boxes.current[Math.min(index + pasted.length, CODE_LENGTH - 1)]?.focus();
  };

  return (
    <div className="flex gap-2 justify-between py-1" role="group" aria-label={label}>
      {digits.map((digit, idx) => (
        <input
          key={idx}
          type="text"
          maxLength={1}
          inputMode="numeric"
          // Only the first box advertises `one-time-code`: naming all six makes
          // the browser offer to fill each of them with the whole code.
          autoComplete={idx === 0 ? "one-time-code" : "off"}
          pattern="[0-9]*"
          aria-label={`Digit ${idx + 1}`}
          value={digit}
          disabled={disabled}
          ref={(el) => {
            boxes.current[idx] = el;
          }}
          onChange={(e) => handleDigit(idx, e.target.value)}
          onKeyDown={(e) => handleKeyDown(idx, e)}
          onPaste={(e) => handlePaste(idx, e)}
          placeholder="•"
          className="w-12 h-13 text-center font-mono text-xl border border-line-2 bg-white rounded-[10px] focus:border-green focus:outline-none transition-colors disabled:bg-paper-2 disabled:text-mut"
        />
      ))}
    </div>
  );
}

/** A fresh, empty set of boxes. */
export const emptyCode = (): string[] => Array(CODE_LENGTH).fill("");

/** True when every box holds a digit. */
export const codeComplete = (digits: string[]): boolean =>
  digits.length === CODE_LENGTH && digits.every(Boolean);
