"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  requestLoginCode,
  verifyLoginCode,
  signInWithPassword,
} from "@/app/actions/session";
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
 * Client sign-in. Staff have their own page at /staff/login.
 *
 * ── The split is about the page, not the permission ─────────────────────────
 * An older version took a `?role=` and dressed itself as either console, which
 * was rightly removed: it asked people to categorise themselves before proving
 * anything, and the role never came from the page. That is still true — the role
 * is stamped on `auth.users` from the email domain and enforced by RLS, so
 * nothing here decides what anyone can see, and a client loading /staff/login
 * gains nothing at all.
 *
 * What justifies two pages now is that this one stopped being only a sign-in
 * form. It offers a password, a reset, and registration of a new client account
 * — none of which apply to staff, and one of which (`/signup`) refuses their
 * addresses outright. The choice was a client page carrying a paragraph of
 * exceptions, or staff getting the form that is actually theirs.
 *
 * So each page refuses the addresses it is not for (`audience`, in
 * ./actions/session.ts) and offers a link to the other, instead of silently
 * mailing a code and landing somebody somewhere the page never described.
 *
 * ── Password or code, never both ────────────────────────────────────────────
 * They are alternatives, not steps: see `requestLoginCode` for why a code on top
 * of a password is not a second factor. Password leads because that is what a
 * newly registered client has, and because the code path costs an email every
 * time it is used. The code stays one click away and is the answer for every
 * client the broker import created, none of whom has ever had a password.
 */
export default function LoginPage() {
  const router = useRouter();

  /** Which credential is being offered. Not a step — switching abandons neither. */
  const [mode, setMode] = useState<"password" | "code">("password");
  /** Code mode only: whether the code has been sent and the boxes are showing. */
  const [sent, setSent] = useState(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [digits, setDigits] = useState<string[]>(emptyCode);

  const [error, setError] = useState<string | null>(null);
  /** Set when the address belongs at the staff console — the link to offer. */
  const [wrongDoor, setWrongDoor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  /** Guards the auto-submit. `busy` cannot do this job: it is state, so it is
   *  still false on the render where filling the last box already fired a
   *  verify, and clicking the button in that window would send the same code
   *  twice — the second attempt failing against a code the first one spent. */
  const verifying = useRef(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  /** Where a verified session lands. The role is settled server-side. */
  const land = useCallback(
    (role: "admin" | "client") => {
      // Left busy on purpose: the navigation is the next thing that happens, and
      // re-enabling the button first only invites a second submit.
      router.push(role === "admin" ? "/portal/staff" : "/portal/client");
    },
    [router],
  );

  const switchMode = (next: "password" | "code") => {
    setMode(next);
    setSent(false);
    setError(null);
    setWrongDoor(null);
    setDigits(emptyCode());
    verifying.current = false;
  };

  // ── Password ──────────────────────────────────────────────────────────────
  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setWrongDoor(null);

    const result = await signInWithPassword(email, password);
    if (!result.ok) {
      setBusy(false);
      setError(result.error);
      setPassword("");
      // A staff address is the one password failure with somewhere to send them.
      // Matched on the action's own refusal rather than re-testing the domain
      // here, so there stays one copy of the rule.
      if (result.error.startsWith("Vitti Capital staff")) {
        setWrongDoor("/staff/login");
      }
      return;
    }
    land(result.role);
  };

  // ── One-time code ─────────────────────────────────────────────────────────
  const sendCode = async (address: string) => {
    setBusy(true);
    setError(null);
    setWrongDoor(null);
    // A new code is a new attempt — including a resend after one was spent.
    verifying.current = false;
    const result = await requestLoginCode(address, "client");
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
      land(result.role);
    },
    [email, land],
  );

  /** Verifies as soon as all six boxes are filled — the code is the submit. */
  const applyDigits = (values: string[]) => {
    setDigits(values);
    if (codeComplete(values)) void verify(values.join(""));
  };

  /** One error block for all three views, so the "wrong door" link cannot end up
   *  on some of them and not others. */
  const errorBlock = error && (
    <FormError id="login-error">
      {error}
      {wrongDoor && (
        <>
          {" "}
          <Link href={wrongDoor} className="underline underline-offset-2 font-semibold">
            Go to the staff sign-in →
          </Link>
        </>
      )}
    </FormError>
  );

  return (
    <AuthShell>
      {mode === "password" ? (
        <form onSubmit={handlePasswordSubmit} className="space-y-5" noValidate>
          <div>
            <h1 className="font-disp font-medium text-3xl text-ink">Sign in</h1>
            <p className="text-[13.5px] text-mut mt-1.5 leading-relaxed">
              Welcome back. Enter your email and password.
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
              aria-describedby={error ? "login-error" : undefined}
              className={fieldClass}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <label htmlFor="password" className="block text-xs font-semibold text-ink">
                Password
              </label>
              <Link
                // Carries the address across so the reset page does not ask for
                // something the person has already typed.
                href={email.trim() ? `/reset-password?email=${encodeURIComponent(email.trim())}` : "/reset-password"}
                className="text-[11.5px] font-semibold text-green-d underline underline-offset-2"
              >
                Forgot password?
              </Link>
            </div>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••"
              required
              aria-describedby={error ? "login-error" : undefined}
              className={fieldClass}
            />
          </div>

          {errorBlock}

          <button
            type="submit"
            disabled={busy || email.trim() === "" || password === ""}
            className={`${buttonClass} bg-navy text-white hover:bg-slate-800`}
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>

          <Divider />

          <button
            type="button"
            onClick={() => switchMode("code")}
            className="w-full btn rounded-[10px] py-3 text-[13.5px] font-semibold cursor-pointer select-none border border-line-2 bg-white text-ink hover:bg-paper-2 transition-colors"
          >
            Email me a one-time code
          </button>

          <p className="text-xs text-mut text-center">
            New to Vitti Capital?{" "}
            <Link
              href="/signup"
              className="font-semibold text-green-d underline underline-offset-2"
            >
              Create an account
            </Link>
          </p>

          <StaffDoor />
        </form>
      ) : !sent ? (
        <form onSubmit={handleEmailSubmit} className="space-y-5" noValidate>
          <div>
            <h1 className="font-disp font-medium text-3xl text-ink">
              Sign in with a code
            </h1>
            <p className="text-[13.5px] text-mut mt-1.5 leading-relaxed">
              Enter your email and we will send you a {CODE_LENGTH}-digit code.
              Nothing to remember.
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="code-email" className="block text-xs font-semibold text-ink">
              Email
            </label>
            <input
              id="code-email"
              name="email"
              type="email"
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              aria-describedby={error ? "login-error" : undefined}
              className={fieldClass}
            />
          </div>

          {errorBlock}

          <button
            type="submit"
            disabled={busy || email.trim() === ""}
            className={`${buttonClass} bg-navy text-white hover:bg-slate-800`}
          >
            {busy ? "Sending code…" : "Email me a code"}
          </button>

          <Divider />

          <button
            type="button"
            onClick={() => switchMode("password")}
            className="w-full btn rounded-[10px] py-3 text-[13.5px] font-semibold cursor-pointer select-none border border-line-2 bg-white text-ink hover:bg-paper-2 transition-colors"
          >
            Use my password instead
          </button>

          <p className="text-xs text-mut text-center">
            New to Vitti Capital?{" "}
            <Link
              href="/signup"
              className="font-semibold text-green-d underline underline-offset-2"
            >
              Create an account
            </Link>
          </p>

          <StaffDoor />
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

          {errorBlock}

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

/**
 * The way through to the desk console.
 *
 * Deliberately quiet — a small line at the foot rather than a second button.
 * Staff sign in a few times a week and know where they are going; clients are
 * the audience this page is for, and a prominent "Staff" control on it is an
 * invitation to click the wrong one. Anyone who does land there is refused by
 * address and sent straight back.
 */
function StaffDoor() {
  return (
    <p className="text-xs text-mut text-center">
      <Link
        href="/staff/login"
        className="font-semibold underline underline-offset-2 hover:text-ink transition-colors"
      >
        Vitti Capital staff sign-in →
      </Link>
    </p>
  );
}

/** "or" between the two credentials, so neither reads as the submit button. */
function Divider() {
  return (
    <div className="flex items-center gap-3" aria-hidden="true">
      <span className="h-px flex-1 bg-line" />
      <span className="text-[11px] font-semibold uppercase tracking-wider text-mut">
        or
      </span>
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}
