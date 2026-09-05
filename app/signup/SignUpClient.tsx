"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { startSignUp, completeSignUp } from "@/app/actions/signup";
import { requestAccountClaim } from "@/app/actions/accounts";
import {
  passwordProblem,
  confirmationProblem,
  MIN_PASSWORD_LENGTH,
} from "@/lib/auth/password";
import { accountNumberProblem } from "@/lib/accounts/account-number";
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

type Step = "details" | "verify" | "account";

const STEPS: { key: Step; label: string }[] = [
  { key: "details", label: "Your details" },
  { key: "verify", label: "Verify email" },
  { key: "account", label: "Link account" },
];

/**
 * The three-step registration form.
 *
 * ── Where the password lives between steps ──────────────────────────────────
 * In this component's state, and nowhere else. `startSignUp` validates it and
 * discards it; the auth user is created without one. It is sent again with the
 * code at step 2, which is the point where `completeSignUp` can set it — after
 * `verifyOtp` has proved the mailbox and produced a session.
 *
 * The alternative, stashing it server-side between the two calls, would mean a
 * password at rest in a cookie or a table for the minute it takes somebody to
 * read their email. Sending it twice over the same TLS connection is the cheaper
 * of the two, and it means an abandoned sign-up leaves no credential anywhere.
 *
 * ── Why step 3 has no skip ──────────────────────────────────────────────────
 * A login with no account attached can reach the portal and see nothing — no
 * positions, no P&L, an account switcher with nothing in it. That is not a
 * lighter version of the product, it is a broken one, and the desk would field
 * the call. So the number is required here, and `page.tsx` sends anybody who
 * closed the tab back to this step until it is done.
 */
export function SignUpClient({ start }: { start: Step }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>(start);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [digits, setDigits] = useState<string[]>(emptyCode);
  const [accountNumber, setAccountNumber] = useState("");
  const [note, setNote] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  // ── Step 1 ────────────────────────────────────────────────────────────────
  const handleDetails = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;

    // Checked here only to save a round trip; `startSignUp` re-checks all of it,
    // because a form is not a security boundary.
    const weak = passwordProblem(password);
    if (weak) return setError(weak);
    const mismatch = confirmationProblem(password, confirmation);
    if (mismatch) return setError(mismatch);

    setBusy(true);
    setError(null);
    const result = await startSignUp({ name, email, password, confirmation });
    setBusy(false);

    if (!result.ok) {
      setError(result.error);
      if (result.retryAfter) setCooldown(result.retryAfter);
      return;
    }

    setDigits(emptyCode());
    setCooldown(60);
    setStep("verify");
  };

  // ── Step 2 ────────────────────────────────────────────────────────────────
  const verify = async (code: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);

    const result = await completeSignUp({ name, email, code, password });
    setBusy(false);

    if (!result.ok) {
      setError(result.error);
      setDigits(emptyCode());
      return;
    }

    // Signed in from here on. The password is no longer needed in memory, and
    // the account step is the only thing left.
    setPassword("");
    setConfirmation("");
    setStep("account");
    // The server page derives the step from the session on any later visit, so
    // refresh to keep a reload on this URL consistent with what just happened.
    router.refresh();
  };

  const resend = async () => {
    setBusy(true);
    setError(null);
    const result = await startSignUp({ name, email, password, confirmation });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      if (result.retryAfter) setCooldown(result.retryAfter);
      return;
    }
    setCooldown(60);
  };

  // ── Step 3 ────────────────────────────────────────────────────────────────
  const handleAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;

    const problem = accountNumberProblem(accountNumber);
    if (problem) return setError(problem);

    setBusy(true);
    setError(null);
    try {
      await requestAccountClaim(accountNumber, note);
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : "Something went wrong.");
      return;
    }
    router.push("/portal/client");
  };

  return (
    <AuthShell>
      <div className="space-y-5">
        <Stepper current={step} />

        {step === "details" && (
          <form onSubmit={handleDetails} className="space-y-5" noValidate>
            <div>
              <h1 className="font-disp font-medium text-3xl text-ink">
                Create your account
              </h1>
              <p className="text-[13.5px] text-mut mt-1.5 leading-relaxed">
                For Vitti Capital wholesale clients. You will need the account
                number from your broker statement to finish.
              </p>
            </div>

            <Field
              id="name"
              label="Full name"
              type="text"
              autoComplete="name"
              value={name}
              onChange={setName}
              placeholder="James Halloran"
              autoFocus
            />

            <Field
              id="email"
              label="Email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={setEmail}
              placeholder="you@example.com"
            />

            <Field
              id="password"
              label="Password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={setPassword}
              placeholder="••••••••••"
              hint={`At least ${MIN_PASSWORD_LENGTH} characters, with a letter and a number.`}
            />

            <Field
              id="confirmation"
              label="Confirm password"
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={setConfirmation}
              placeholder="••••••••••"
            />

            {error && <FormError id="signup-error">{error}</FormError>}

            <button
              type="submit"
              disabled={
                busy ||
                name.trim() === "" ||
                email.trim() === "" ||
                password === "" ||
                confirmation === ""
              }
              className={`${buttonClass} bg-navy text-white hover:bg-slate-800`}
            >
              {busy ? "Sending code…" : "Continue"}
            </button>

            <p className="text-xs text-mut text-center">
              Already have an account?{" "}
              <Link
                href="/login"
                className="font-semibold text-green-d underline underline-offset-2"
              >
                Sign in
              </Link>
            </p>
          </form>
        )}

        {step === "verify" && (
          <div className="space-y-5">
            <div>
              <h1 className="font-disp font-medium text-3xl text-ink">
                Confirm your email
              </h1>
              <p className="text-[13.5px] text-mut mt-1.5 leading-relaxed">
                We sent a {CODE_LENGTH}-digit code to{" "}
                <span className="font-semibold text-ink break-all">{email}</span>.
                Entering it confirms the address and sets your password.
              </p>
            </div>

            <CodeInput
              digits={digits}
              onChange={setDigits}
              onError={setError}
              disabled={busy}
            />

            {error && <FormError id="signup-error">{error}</FormError>}

            <button
              type="button"
              onClick={() => void verify(digits.join(""))}
              disabled={busy || !codeComplete(digits)}
              className={`${buttonClass} bg-navy text-white hover:bg-slate-800`}
            >
              {busy ? "Confirming…" : "Confirm email"}
            </button>

            <div className="flex items-center justify-between gap-3 text-[12.5px] font-semibold">
              <button
                type="button"
                onClick={() => {
                  setStep("details");
                  setError(null);
                }}
                className="text-green-d underline underline-offset-2 cursor-pointer"
              >
                &larr; Change details
              </button>

              <button
                type="button"
                disabled={cooldown > 0 || busy}
                onClick={() => void resend()}
                className="text-green-d underline underline-offset-2 cursor-pointer disabled:text-mut disabled:no-underline disabled:cursor-not-allowed"
              >
                {cooldown > 0 ? `Resend in ${cooldown}s` : "Resend code"}
              </button>
            </div>
          </div>
        )}

        {step === "account" && (
          <form onSubmit={handleAccount} className="space-y-5" noValidate>
            <div>
              <h1 className="font-disp font-medium text-3xl text-ink">
                Link your account
              </h1>
              <p className="text-[13.5px] text-mut mt-1.5 leading-relaxed">
                Enter the account number on your broker statement. The Vitti desk
                verifies it against the broker record before your holdings appear.
              </p>
            </div>

            <Field
              id="account-number"
              label="Broker account number"
              type="text"
              inputMode="text"
              autoComplete="off"
              value={accountNumber}
              onChange={setAccountNumber}
              placeholder="1102004"
              autoFocus
            />

            <div className="space-y-1.5">
              <label htmlFor="note" className="block text-xs font-semibold text-ink">
                Anything the desk should know{" "}
                <span className="font-normal text-mut">(optional)</span>
              </label>
              <textarea
                id="note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                placeholder="e.g. this is my family trust account, opened last year."
                className={`${fieldClass} resize-none`}
              />
            </div>

            {error && <FormError id="signup-error">{error}</FormError>}

            <button
              type="submit"
              disabled={busy || accountNumber.trim() === ""}
              className={`${buttonClass} bg-green text-[#08130e] hover:shadow-lg hover:shadow-green-bg disabled:shadow-none`}
            >
              {busy ? "Sending to the desk…" : "Finish"}
            </button>

            <p className="text-xs text-mut bg-paper-2 rounded-[9px] p-3 leading-relaxed">
              Your request goes to the Vitti desk for verification — you will not
              see holdings until it is approved. Have more than one account? Add
              the rest from Accounts once you are in; one login can hold several.
            </p>
          </form>
        )}
      </div>
    </AuthShell>
  );
}

/** The 1–2–3 rail. Purely orienting: it is not clickable, because going back to
 *  a completed step would mean undoing something that already happened. */
function Stepper({ current }: { current: Step }) {
  const index = STEPS.findIndex((s) => s.key === current);
  return (
    <ol className="flex items-center gap-2 select-none" aria-label="Progress">
      {STEPS.map((s, i) => {
        const done = i < index;
        const active = i === index;
        return (
          <li key={s.key} className="flex items-center gap-2 flex-1 last:flex-none">
            <div className="flex items-center gap-1.5">
              <span
                aria-current={active ? "step" : undefined}
                className={`w-5.5 h-5.5 rounded-full grid place-items-center text-[10.5px] font-semibold ${
                  done
                    ? "bg-green text-[#08130e]"
                    : active
                      ? "bg-navy text-white"
                      : "bg-paper-2 text-mut"
                }`}
              >
                {done ? "✓" : i + 1}
              </span>
              <span
                className={`text-[11.5px] font-semibold whitespace-nowrap ${
                  active ? "text-ink" : "text-mut"
                }`}
              >
                {s.label}
              </span>
            </div>
            {i < STEPS.length - 1 && (
              <span
                className={`h-px flex-1 ${done ? "bg-green" : "bg-line"}`}
                aria-hidden="true"
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** A labelled input. Three steps' worth of the same five lines, named once. */
function Field({
  id,
  label,
  hint,
  value,
  onChange,
  ...input
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "id">) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-xs font-semibold text-ink">
        {label}
      </label>
      <input
        id={id}
        name={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required
        className={fieldClass}
        {...input}
      />
      {hint && <p className="text-[11.5px] text-mut">{hint}</p>}
    </div>
  );
}
