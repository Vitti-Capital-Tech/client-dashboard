"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { requestPasswordResetCode, resetPassword } from "@/app/actions/session";
import {
  passwordProblem,
  confirmationProblem,
  MIN_PASSWORD_LENGTH,
} from "@/lib/auth/password";
import {
  AuthShell,
  FormError,
  fieldClass,
  buttonClass,
} from "@/app/components/AuthShell";
import {
  CodeInput,
  CODE_LENGTH,
  emptyCode,
  codeComplete,
} from "@/app/components/CodeInput";

/**
 * Set a new password, in two steps: prove the mailbox, then choose.
 *
 * ── The same code as everything else ────────────────────────────────────────
 * This calls `requestLoginCode` — not a separate "reset" send. There is one kind
 * of emailed code in this system and one template behind it, which is why a
 * password can be reset with no new mail plumbing at all. See `resetPassword`
 * for why a code rather than the conventional reset link.
 *
 * ── The new password is collected AFTER the code ────────────────────────────
 * Both on the same screen, but the code is above it, and nothing is sent until
 * both are filled. Asking for the password first would mean typing one twice
 * before discovering the code had expired.
 */
export function ResetPasswordClient({ initialEmail }: { initialEmail: string }) {
  const router = useRouter();

  const [sent, setSent] = useState(false);
  const [email, setEmail] = useState(initialEmail);
  const [digits, setDigits] = useState<string[]>(emptyCode);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");

  const [error, setError] = useState<string | null>(null);
  /** Staff have no password to reset — the link to where they do sign in. */
  const [wrongDoor, setWrongDoor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const send = async (address: string) => {
    setBusy(true);
    setError(null);
    setWrongDoor(null);
    const result = await requestPasswordResetCode(address);
    setBusy(false);

    if (!result.ok) {
      setError(result.error);
      setWrongDoor(result.wrongDoor ?? null);
      if (result.retryAfter) setCooldown(result.retryAfter);
      return false;
    }
    setCooldown(60);
    return true;
  };

  const handleEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!(await send(email))) return;
    setDigits(emptyCode());
    setSent(true);
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;

    const weak = passwordProblem(password);
    if (weak) return setError(weak);
    const mismatch = confirmationProblem(password, confirmation);
    if (mismatch) return setError(mismatch);

    setBusy(true);
    setError(null);
    const result = await resetPassword(email, digits.join(""), password);

    if (!result.ok) {
      setBusy(false);
      setError(result.error);
      setDigits(emptyCode());
      return;
    }

    // The reset signs them in — `verifyOtp` produced a session and there is no
    // reason to make somebody who just proved the mailbox and set a password
    // type it straight back in.
    router.push(result.role === "admin" ? "/portal/staff" : "/portal/client");
  };

  return (
    <AuthShell>
      {!sent ? (
        <form onSubmit={handleEmail} className="space-y-5" noValidate>
          <div>
            <h1 className="font-disp font-medium text-3xl text-ink">
              Reset your password
            </h1>
            <p className="text-[13.5px] text-mut mt-1.5 leading-relaxed">
              Enter your email and we will send a {CODE_LENGTH}-digit code to
              confirm it is you.
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="email" className="block text-xs font-semibold text-ink">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              aria-describedby={error ? "reset-error" : undefined}
              className={fieldClass}
            />
          </div>

          {error && (
            <FormError id="reset-error">
              {error}
              {wrongDoor && (
                <>
                  {" "}
                  <Link
                    href={wrongDoor}
                    className="underline underline-offset-2 font-semibold"
                  >
                    Go to the staff sign-in →
                  </Link>
                </>
              )}
            </FormError>
          )}

          <button
            type="submit"
            disabled={busy || email.trim() === ""}
            className={`${buttonClass} bg-navy text-white hover:bg-slate-800`}
          >
            {busy ? "Sending code…" : "Send me a code"}
          </button>

          <p className="text-xs text-mut text-center">
            <Link
              href="/login"
              className="font-semibold text-green-d underline underline-offset-2"
            >
              &larr; Back to sign in
            </Link>
          </p>
        </form>
      ) : (
        <form onSubmit={handleReset} className="space-y-5" noValidate>
          <div>
            <h1 className="font-disp font-medium text-3xl text-ink">
              Choose a new password
            </h1>
            <p className="text-[13.5px] text-mut mt-1.5 leading-relaxed">
              Enter the code we sent to{" "}
              <span className="font-semibold text-ink break-all">{email}</span>,
              then pick a new password.
            </p>
          </div>

          <CodeInput
            digits={digits}
            onChange={setDigits}
            onError={setError}
            disabled={busy}
          />

          <div className="space-y-1.5">
            <label htmlFor="password" className="block text-xs font-semibold text-ink">
              New password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••"
              required
              className={fieldClass}
            />
            <p className="text-[11.5px] text-mut">
              At least {MIN_PASSWORD_LENGTH} characters, with a letter and a
              number.
            </p>
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="confirmation"
              className="block text-xs font-semibold text-ink"
            >
              Confirm new password
            </label>
            <input
              id="confirmation"
              name="confirmation"
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
              placeholder="••••••••••"
              required
              className={fieldClass}
            />
          </div>

          {error && (
            <FormError id="reset-error">
              {error}
              {wrongDoor && (
                <>
                  {" "}
                  <Link
                    href={wrongDoor}
                    className="underline underline-offset-2 font-semibold"
                  >
                    Go to the staff sign-in →
                  </Link>
                </>
              )}
            </FormError>
          )}

          <button
            type="submit"
            disabled={
              busy ||
              !codeComplete(digits) ||
              password === "" ||
              confirmation === ""
            }
            className={`${buttonClass} bg-green text-[#08130e] hover:shadow-lg hover:shadow-green-bg disabled:shadow-none`}
          >
            {busy ? "Saving…" : "Save password & sign in"}
          </button>

          <div className="flex items-center justify-between gap-3 text-[12.5px] font-semibold">
            <button
              type="button"
              onClick={() => {
                setSent(false);
                setError(null);
              }}
              className="text-green-d underline underline-offset-2 cursor-pointer"
            >
              &larr; Use a different email
            </button>

            <button
              type="button"
              disabled={cooldown > 0 || busy}
              onClick={() => void send(email)}
              className="text-green-d underline underline-offset-2 cursor-pointer disabled:text-mut disabled:no-underline disabled:cursor-not-allowed"
            >
              {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
            </button>
          </div>
        </form>
      )}
    </AuthShell>
  );
}
