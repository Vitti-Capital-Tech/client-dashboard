"use client";

import { useState, useRef, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { signInWithPassword } from "@/app/actions/session";

function LoginContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const initialRole = (searchParams.get("role") as "client" | "admin") || "client";
  const [step, setStep] = useState<1 | 2>(1);
  const [email, setEmail] = useState(
    initialRole === "admin" ? "goyal.s@vitti.capital" : "james@halloran.com.au"
  );
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState(["", "", "", "", "", ""]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const otpRefs = useRef<(HTMLInputElement | null)[]>([]);

  const handleContinue = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setStep(2);
    // Autofocus first OTP input after state update
    setTimeout(() => {
      otpRefs.current[0]?.focus();
    }, 100);
  };

  const handleOtpChange = (index: number, val: string) => {
    if (/[^0-9]/.test(val)) return; // numbers only
    const newOtp = [...otp];
    newOtp[index] = val;
    setOtp(newOtp);

    if (val && index < 5) {
      otpRefs.current[index + 1]?.focus();
    }
  };

  const handleOtpKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !otp[index] && index > 0) {
      const newOtp = [...otp];
      newOtp[index - 1] = "";
      setOtp(newOtp);
      otpRefs.current[index - 1]?.focus();
    } else if (e.key === "Enter" && otp.every(digit => digit !== "")) {
      handleVerify();
    }
  };

  const handleVerify = async () => {
    // Real Supabase Auth: verify the password (the OTP screen above is a
    // cosmetic 2FA placeholder — real TOTP MFA is a later step). The proxy then
    // keeps the session fresh; server components read role/identity via getUser.
    setSubmitting(true);
    setError(null);
    const result = await signInWithPassword(email, password);
    if (!result.ok) {
      setSubmitting(false);
      setStep(1);
      setError(result.error || "Incorrect email or password.");
      return;
    }
    router.push(result.role === "admin" ? "/portal/staff" : "/portal/client");
  };

  return (
    <div className="min-h-screen grid md:grid-cols-2 bg-paper text-ink font-body">
      {/* Left Aside (Hero Design) */}
      <aside className="bg-navy text-white p-10 md:p-14 flex-col justify-between relative overflow-hidden hidden md:flex">
        {/* Decorative Grid background */}
        <div 
          className="absolute inset-0 pointer-events-none opacity-10"
          style={{
            backgroundImage: `
              linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)
            `,
            backgroundSize: "40px 40px"
          }}
        />

        <Link href="/" className="relative z-10 inline-flex items-center gap-2 font-disp font-semibold text-xl tracking-wide decoration-0 text-white">
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
            &quot;Finance should <em className="not-italic text-green font-serif">empower,</em> not intimidate.&quot;
          </div>
        </div>

        <div className="relative z-10 text-[12.5px] text-mut-d leading-relaxed">
          Level 49, 8 Parramatta Square, NSW 2150<br />
          Wholesale clients only &middot; AFSL 518031
        </div>
      </aside>

      {/* Right Login Area */}
      <main className="flex items-center justify-center p-6 md:p-10 bg-white">
        <div className="w-full max-w-98">
          {step === 1 ? (
            <form onSubmit={handleContinue} className="space-y-4">
              <div className="mb-4">
                <span className={`pill ${initialRole === "admin" ? "dark bg-navy-3 text-slate-300" : "live bg-green-bg text-green-d"} text-[11.5px] font-semibold py-1 px-3.5 rounded-full inline-block`}>
                  {initialRole === "admin" ? "Vitti staff" : "Client portal"}
                </span>
              </div>
              <div>
                <h2 className="font-disp font-medium text-3xl text-ink">
                  {initialRole === "admin" ? "Staff sign in" : "Welcome back"}
                </h2>
                <p className="text-[13.5px] text-mut mt-1">Sign in to your Vitti Capital account.</p>
              </div>

              <div className="space-y-1">
                <label className="block text-xs font-semibold text-ink">Email</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                  className="w-full border border-line-2 bg-white rounded-[10px] px-3.5 py-3 text-[15px] focus:border-green focus:outline-none transition-colors"
                />
              </div>

              <div className="space-y-1">
                <label className="block text-xs font-semibold text-ink">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••"
                  required
                  className="w-full border border-line-2 bg-white rounded-[10px] px-3.5 py-3 text-[15px] focus:border-green focus:outline-none transition-colors"
                />
              </div>

              {error && (
                <p className="text-[12.5px] font-semibold text-red-700 bg-red-50 border border-red-200 rounded-[9px] px-3 py-2">
                  {error}
                </p>
              )}

              <button
                type="submit"
                className="w-full btn bg-navy text-white hover:bg-slate-800 rounded-[10px] py-3 text-[13.5px] font-semibold cursor-pointer select-none transition-colors mt-2"
              >
                Continue
              </button>

              <button
                type="button"
                onClick={() => alert("A reset link would be emailed to you.")}
                className="text-left text-green-d text-[12.5px] font-semibold underline underline-offset-2 block cursor-pointer transition-opacity"
              >
                Forgot password?
              </button>

              <div className="text-xs text-mut bg-paper-2 rounded-[9px] p-3 leading-relaxed mt-4">
                {initialRole === "admin" ? (
                  <>
                    <b>Prototype:</b> staff console — sign in as <code>goyal.s@vitti.capital</code> with the demo password <code>demo1234</code>. Any 6-digit code works.
                  </>
                ) : (
                  <>
                    <b>Prototype:</b> sign in as any client — <code>james@halloran.com.au</code>, <code>margaret.chen@outlook.com</code>, <code>office@endeavourfo.com.au</code>, or <code>david.okafor@gmail.com</code> — with the demo password <code>demo1234</code>. Any 6-digit code works.
                  </>
                )}
              </div>
            </form>
          ) : (
            <div className="space-y-4">
              <div>
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-green-d bg-green-bg px-3 py-1.5 rounded-full">
                  <svg className="w-3.5 h-3.5 fill-none stroke-current stroke-2" viewBox="0 0 24 24">
                    <rect x="4" y="10" width="16" height="11" rx="2" />
                    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
                  </svg>
                  Two-factor authentication
                </span>
              </div>

              <div>
                <h2 className="font-disp font-medium text-3xl text-ink">Enter your code</h2>
                <p className="text-[13.5px] text-mut mt-1">
                  We sent a 6-digit code to your registered device. Enter any digits to continue.
                </p>
              </div>

              <div className="flex gap-2 justify-between py-2">
                {otp.map((digit, idx) => (
                  <input
                    key={idx}
                    type="text"
                    maxLength={1}
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={digit}
                    ref={(el) => { otpRefs.current[idx] = el; }}
                    onChange={(e) => handleOtpChange(idx, e.target.value)}
                    onKeyDown={(e) => handleOtpKeyDown(idx, e)}
                    placeholder="•"
                    className="w-12 h-12 text-center font-mono text-xl border border-line-2 bg-white rounded-[10px] focus:border-green focus:outline-none transition-colors"
                  />
                ))}
              </div>

              <button
                onClick={handleVerify}
                disabled={submitting}
                className="w-full btn bg-green text-[#08130e] hover:shadow-lg hover:shadow-green-bg rounded-[10px] py-3 text-[13.5px] font-semibold cursor-pointer transition-all disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {submitting ? "Signing in…" : "Verify & sign in"}
              </button>

              <button
                type="button"
                onClick={() => setStep(1)}
                className="text-left text-green-d text-[12.5px] font-semibold underline underline-offset-2 block cursor-pointer transition-opacity"
              >
                &larr; Back
              </button>

              <div className="text-xs text-mut bg-paper-2 rounded-[9px] p-3 leading-relaxed">
                Every sign-in is recorded in the audit log with time, user and device.
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-paper text-ink font-body">
        <div className="font-mono text-xs tracking-wider uppercase text-mut">Loading security interface...</div>
      </div>
    }>
      <LoginContent />
    </Suspense>
  );
}
