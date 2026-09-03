"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { requestLoginCode, verifyLoginCode } from "@/app/actions/session";

/**
 * One sign-in, for everybody.
 *
 * ── No admin / client split ──────────────────────────────────────────────────
 * The page used to take a `?role=` and dress itself as either the staff console
 * or the client portal. That was never a security boundary — the role comes from
 * the address's domain and is settled by the database — so all it did was ask
 * people to categorise themselves correctly before they had proved who they
 * were, and give a stranger two different pages to read. One form, and where you
 * land is decided after the code is verified.
 *
 * ── Email, then a code ──────────────────────────────────────────────────────
 * There is no password. A code emailed alongside one would look like a second
 * factor without being one — see `requestLoginCode` for why — so the code IS the
 * credential, and no session exists until it is verified.
 */

/** How long the resend button stays disabled. Matches Supabase's own window. */
const RESEND_SECONDS = 60;

const CODE_LENGTH = 6;

export default function LoginPage() {
  const router = useRouter();

  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [digits, setDigits] = useState<string[]>(Array(CODE_LENGTH).fill(""));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  const boxes = useRef<(HTMLInputElement | null)[]>([]);
  /** Guards the auto-submit: filling the last box and pressing Enter must not
   *  both fire a verify for the same code. */
  const verifying = useRef(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((n) => n - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const sendCode = async (address: string) => {
    setBusy(true);
    setError(null);
    const result = await requestLoginCode(address);
    setBusy(false);

    if (!result.ok) {
      setError(result.error);
      if (result.retryAfter) setCooldown(result.retryAfter);
      return false;
    }

    setCooldown(RESEND_SECONDS);
    return true;
  };

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!(await sendCode(email))) return;

    setDigits(Array(CODE_LENGTH).fill(""));
    setStep("code");
    // The box is not on the page until this render commits.
    requestAnimationFrame(() => boxes.current[0]?.focus());
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
        setDigits(Array(CODE_LENGTH).fill(""));
        boxes.current[0]?.focus();
        return;
      }

      // Left busy on purpose: the navigation is the next thing that happens, and
      // re-enabling the button first only invites a second submit.
      router.push(result.role === "admin" ? "/portal/staff" : "/portal/client");
    },
    [email, router],
  );

  /** Writes `values` into the boxes and verifies as soon as all six are there. */
  const applyDigits = (values: string[]) => {
    setDigits(values);
    const code = values.join("");
    if (code.length === CODE_LENGTH && values.every(Boolean)) void verify(code);
  };

  const handleDigit = (index: number, raw: string) => {
    const value = raw.replace(/\D/g, "").slice(-1);
    const next = [...digits];
    next[index] = value;
    applyDigits(next);
    if (value && index < CODE_LENGTH - 1) boxes.current[index + 1]?.focus();
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !digits[index] && index > 0) {
      e.preventDefault();
      const next = [...digits];
      next[index - 1] = "";
      setDigits(next);
      boxes.current[index - 1]?.focus();
      return;
    }
    if (e.key === "ArrowLeft" && index > 0) boxes.current[index - 1]?.focus();
    if (e.key === "ArrowRight" && index < CODE_LENGTH - 1) boxes.current[index + 1]?.focus();
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
      setError(
        `That code is ${pasted.length} digits — this screen expects ${CODE_LENGTH}. ` +
          `Ask an administrator to check the one-time code length.`,
      );
      return;
    }

    const next = [...digits];
    for (let i = 0; i < pasted.length && index + i < CODE_LENGTH; i++) {
      next[index + i] = pasted[i];
    }
    applyDigits(next);
    boxes.current[Math.min(index + pasted.length, CODE_LENGTH - 1)]?.focus();
  };

  const complete = digits.every(Boolean);

  return (
    <div className="min-h-screen grid md:grid-cols-2 bg-paper text-ink font-body">
      {/* ── Brand aside ─────────────────────────────────────────────────── */}
      <aside className="bg-navy text-white p-10 md:p-14 flex-col justify-between relative overflow-hidden hidden md:flex">
        <div
          className="absolute inset-0 pointer-events-none opacity-10"
          style={{
            backgroundImage: `
              linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)
            `,
            backgroundSize: "40px 40px",
          }}
        />

        <Link
          href="/"
          className="relative z-10 inline-flex items-center gap-2 font-disp font-semibold text-xl tracking-wide decoration-0 text-white"
        >
          <span className="inline-flex gap-[2.5px] items-end h-[1em] text-xl">
            <i className="block w-0.75 h-[0.5em] rounded-xs bg-green" />
            <i className="block w-0.75 h-[0.72em] rounded-xs bg-green" />
            <i className="block w-0.75 h-[0.95em] rounded-xs bg-green" />
          </span>
          Vitti
          <small className="font-body text-[10.5px] font-semibold tracking-[0.16em] uppercase opacity-60 ml-0.5">
            Capital
          </small>
        </Link>

        <div className="relative z-10 my-auto">
          <div className="font-disp font-medium text-3xl md:text-4xl leading-snug max-w-[13em] text-slate-100">
            &quot;Finance should{" "}
            <em className="not-italic text-green font-serif">empower,</em> not
            intimidate.&quot;
          </div>
        </div>

        <div className="relative z-10 text-[12.5px] text-mut-d leading-relaxed">
          Level 49, 8 Parramatta Square, NSW 2150
          <br />
          Wholesale clients only &middot; AFSL 518031
        </div>
      </aside>

      {/* ── The form ────────────────────────────────────────────────────── */}
      <main className="flex items-center justify-center p-6 md:p-10 bg-white">
        <div className="w-full max-w-98">
          {/* Mobile-only wordmark: the aside is hidden below md, and a bare
              form on a white page has nothing on it saying whose it is. */}
          <Link
            href="/"
            className="md:hidden inline-flex items-center gap-2 font-disp font-semibold text-lg tracking-wide decoration-0 text-ink mb-8"
          >
            <span className="inline-flex gap-[2.5px] items-end h-[1em] text-lg">
              <i className="block w-0.75 h-[0.5em] rounded-xs bg-green" />
              <i className="block w-0.75 h-[0.72em] rounded-xs bg-green" />
              <i className="block w-0.75 h-[0.95em] rounded-xs bg-green" />
            </span>
            Vitti
            <small className="font-body text-[10px] font-semibold tracking-[0.16em] uppercase opacity-60 ml-0.5">
              Capital
            </small>
          </Link>

          {step === "email" ? (
            <form onSubmit={handleEmailSubmit} className="space-y-5" noValidate>
              <div>
                <h1 className="font-disp font-medium text-3xl text-ink">Sign in</h1>
                <p className="text-[13.5px] text-mut mt-1.5 leading-relaxed">
                  Enter your email and we will send you a one-time code. No
                  password to remember.
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
                  className="w-full border border-line-2 bg-white rounded-[10px] px-3.5 py-3 text-[15px] focus:border-green focus:outline-none transition-colors"
                />
              </div>

              {error && <FormError id="login-error">{error}</FormError>}

              <button
                type="submit"
                disabled={busy || email.trim() === ""}
                className="w-full btn bg-navy text-white hover:bg-slate-800 rounded-[10px] py-3 text-[13.5px] font-semibold cursor-pointer select-none transition-colors disabled:opacity-55 disabled:cursor-not-allowed"
              >
                {busy ? "Sending code…" : "Email me a code"}
              </button>

              <p className="text-xs text-mut bg-paper-2 rounded-[9px] p-3 leading-relaxed">
                Access is by invitation. If your address is not registered, speak
                to your adviser at Vitti Capital.
              </p>
            </form>
          ) : (
            <div className="space-y-5">
              <div>
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
              </div>

              <div>
                <h1 className="font-disp font-medium text-3xl text-ink">
                  Check your email
                </h1>
                <p className="text-[13.5px] text-mut mt-1.5 leading-relaxed">
                  We sent a {CODE_LENGTH}-digit code to{" "}
                  <span className="font-semibold text-ink break-all">{email}</span>.
                  It expires shortly.
                </p>
              </div>

              <div className="flex gap-2 justify-between py-1" role="group" aria-label="One-time code">
                {digits.map((digit, idx) => (
                  <input
                    key={idx}
                    type="text"
                    maxLength={1}
                    inputMode="numeric"
                    autoComplete={idx === 0 ? "one-time-code" : "off"}
                    pattern="[0-9]*"
                    aria-label={`Digit ${idx + 1}`}
                    value={digit}
                    disabled={busy}
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

              {error && <FormError id="login-error">{error}</FormError>}

              <button
                type="button"
                onClick={() => void verify(digits.join(""))}
                disabled={busy || !complete}
                className="w-full btn bg-green text-[#08130e] hover:shadow-lg hover:shadow-green-bg rounded-[10px] py-3 text-[13.5px] font-semibold cursor-pointer transition-all disabled:opacity-55 disabled:cursor-not-allowed disabled:shadow-none"
              >
                {busy ? "Signing in…" : "Verify & sign in"}
              </button>

              <div className="flex items-center justify-between gap-3 text-[12.5px] font-semibold">
                <button
                  type="button"
                  onClick={() => {
                    setStep("email");
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
                Every sign-in is recorded in the audit log with time, user and
                device.
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

function FormError({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p
      id={id}
      role="alert"
      className="text-[12.5px] font-semibold text-red-700 bg-red-50 border border-red-200 rounded-[9px] px-3 py-2"
    >
      {children}
    </p>
  );
}
