"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { requestLoginCode, verifyLoginCode } from "@/app/actions/session";
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
 * The desk console door. Staff only, one-time code only.
 *
 * ── Why staff have a page of their own again ────────────────────────────────
 * An earlier version of this app split sign-in by `?role=` and it was rightly
 * removed: it asked people to categorise themselves before they had proved
 * anything, and the role never came from the page anyway. Nothing about that has
 * changed — the role is still stamped on `auth.users` from the email domain and
 * still enforced by RLS, and a client who loads this URL gains exactly nothing.
 *
 * What changed is that /login is no longer only a sign-in form. It offers a
 * password, a password reset, and a link to register a new client account —
 * three things that are wrong for staff in different ways, and one of which
 * (`/signup`) refuses their addresses outright. Rather than a client page
 * carrying a paragraph of exceptions, staff get the form that is actually theirs.
 *
 * ── Why there is no password field here ─────────────────────────────────────
 * Staff accounts provision themselves from the email domain alone
 * (`provisionStaffAccount`), and the only thing that makes that safe is that the
 * code has to be READ at a vitti.capital mailbox. A password is a credential
 * that works without the mailbox, so it would remove the very proof the domain
 * rule leans on. `signInWithPassword` and `requestPasswordResetCode` both refuse
 * staff addresses, and the database refuses to create one carrying a password.
 */
export default function StaffLoginPage() {
  const router = useRouter();

  const [sent, setSent] = useState(false);
  const [email, setEmail] = useState("");
  const [digits, setDigits] = useState<string[]>(emptyCode);

  const [error, setError] = useState<string | null>(null);
  const [wrongDoor, setWrongDoor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  /** See the note on the client login page: `busy` is state, and the last
   *  keystroke fires a verify on a render where it is still false. */
  const verifying = useRef(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const sendCode = async (address: string) => {
    setBusy(true);
    setError(null);
    setWrongDoor(null);
    verifying.current = false;

    const result = await requestLoginCode(address, "staff");
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

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!(await sendCode(email))) return;
    setDigits(emptyCode());
    setSent(true);
  };

  const verify = useCallback(
    async (code: string) => {
      if (verifying.current) return;
      verifying.current = true;
      setBusy(true);
      setError(null);

      const result = await verifyLoginCode(email, code);
      if (!result.ok) {
        verifying.current = false;
        setBusy(false);
        setError(result.error);
        setDigits(emptyCode());
        return;
      }

      // The role still decides, not the page. A client address cannot reach here
      // — `requestLoginCode("staff")` refused it before any code was sent — but
      // if one ever did, it lands in the client portal rather than being shown a
      // console it has no rows for.
      router.push(result.role === "admin" ? "/portal/staff" : "/portal/client");
    },
    [email, router],
  );

  const applyDigits = (values: string[]) => {
    setDigits(values);
    if (codeComplete(values)) void verify(values.join(""));
  };

  return (
    <AuthShell>
      {!sent ? (
        <form onSubmit={handleEmailSubmit} className="space-y-5" noValidate>
          <div>
            <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-white bg-navy px-3 py-1.5 rounded-full">
              <svg
                className="w-3.5 h-3.5 fill-none stroke-current stroke-2"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path d="M12 3l7.5 3.75v5.25c0 4.5-3 7.5-7.5 9-4.5-1.5-7.5-4.5-7.5-9V6.75L12 3z" />
              </svg>
              Desk console
            </span>
          </div>

          <div>
            <h1 className="font-disp font-medium text-3xl text-ink">Staff sign in</h1>
            <p className="text-[13.5px] text-mut mt-1.5 leading-relaxed">
              Enter your Vitti Capital address and we will email you a{" "}
              {CODE_LENGTH}-digit code. There is no password.
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="email" className="block text-xs font-semibold text-ink">
              Work email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@vitti.capital"
              required
              aria-describedby={error ? "staff-login-error" : undefined}
              className={fieldClass}
            />
          </div>

          {error && (
            <FormError id="staff-login-error">
              {error}
              {wrongDoor && (
                <>
                  {" "}
                  <Link
                    href={wrongDoor}
                    className="underline underline-offset-2 font-semibold"
                  >
                    Go to the client sign-in →
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
            {busy ? "Sending code…" : "Email me a code"}
          </button>

          <p className="text-xs text-mut text-center">
            Not staff?{" "}
            <Link
              href="/login"
              className="font-semibold text-green-d underline underline-offset-2"
            >
              Client sign-in
            </Link>
          </p>

          <p className="text-xs text-mut bg-paper-2 rounded-[9px] p-3 leading-relaxed">
            Your first sign-in provisions your account automatically — any
            @vitti.capital address works, because only the mailbox can receive
            the code.
          </p>
        </form>
      ) : (
        <div className="space-y-5">
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-green-d bg-green-bg px-3 py-1.5 rounded-full">
            <svg
              className="w-3.5 h-3.5 fill-none stroke-current stroke-2"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <path d="M3.5 7l8.5 6 8.5-6" />
            </svg>
            One-time code
          </span>

          <div>
            <h1 className="font-disp font-medium text-3xl text-ink">
              Check your email
            </h1>
            <p className="text-[13.5px] text-mut mt-1.5 leading-relaxed">
              We sent a {CODE_LENGTH}-digit code to{" "}
              <span className="font-semibold text-ink break-all">{email}</span>. It
              expires shortly.
            </p>
          </div>

          <CodeInput
            digits={digits}
            onChange={applyDigits}
            onError={setError}
            disabled={busy}
          />

          {error && <FormError id="staff-login-error">{error}</FormError>}

          <button
            type="button"
            onClick={() => void verify(digits.join(""))}
            disabled={busy || !codeComplete(digits)}
            className={`${buttonClass} bg-green text-[#08130e] hover:shadow-lg hover:shadow-green-bg disabled:shadow-none`}
          >
            {busy ? "Signing in…" : "Verify & sign in"}
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
              onClick={() => void sendCode(email)}
              className="text-green-d underline underline-offset-2 cursor-pointer disabled:text-mut disabled:no-underline disabled:cursor-not-allowed"
            >
              {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
            </button>
          </div>

          <p className="text-xs text-mut bg-paper-2 rounded-[9px] p-3 leading-relaxed">
            Every sign-in is recorded in the audit log with time, user and device.
          </p>
        </div>
      )}
    </AuthShell>
  );
}
