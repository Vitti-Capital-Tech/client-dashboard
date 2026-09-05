import Link from "next/link";

/**
 * One sign-in for clients and staff alike.
 *
 * There were once two cards here, "For clients" and "For the desk". They began
 * as buttons into `/login?role=client|admin`, became descriptive when the role
 * stopped being something you pick — it follows from the email domain and is
 * settled after the code is verified — and are now gone entirely: a public page
 * has no reason to describe the firm's internal console to whoever reads it,
 * and the sign-in below is the only thing on this page anyone needs.
 *
 * No `"use client"` either — with the router gone this page is static.
 */
export default function Home() {
  return (
    <div className="relative min-h-screen bg-navy text-white overflow-hidden flex flex-col justify-between font-body">
      {/* Radial grid background */}
      <div 
        className="absolute inset-0 pointer-events-none opacity-40"
        style={{
          backgroundImage: `
            linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)
          `,
          backgroundSize: "54px 54px",
          maskImage: "radial-gradient(ellipse 80% 70% at 70% 0%, #000, transparent)",
          WebkitMaskImage: "radial-gradient(ellipse 80% 70% at 70% 0%, #000, transparent)"
        }}
      />

      {/* Header */}
      <header className="relative z-10 flex items-center justify-between px-6 py-6 md:px-10">
        <Link href="/" className="inline-flex items-center gap-2 font-disp font-semibold text-xl tracking-wide decoration-0">
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
      </header>

      {/* Main Wrap */}
      <main className="relative z-10 max-w-280 w-full mx-auto px-6 md:px-10 py-10 flex-1 flex flex-col justify-center">
        <div className="max-w-190 mb-12">
          <p className="font-mono text-xs tracking-[0.2em] uppercase text-green mb-5">
            Client portal &amp; placement desk
          </p>
          <h1 className="font-disp font-medium text-4xl sm:text-5xl md:text-6xl leading-[1.05] tracking-tight">
            Your capital,<br />
            <em className="not-italic text-green font-serif">in perfect order.</em>
          </h1>
          <p className="mt-6 text-base sm:text-lg text-slate-300 max-w-[36em] leading-relaxed">
            One platform for portfolios, placements, and the options whose exercise windows you cannot afford to miss — for Vitti Capital&apos;s wholesale clients and the team who looks after them.
          </p>
        </div>

        {/* One way in. */}
        <div className="max-w-205">
          <Link
            href="/login"
            className="group inline-flex items-center gap-2.5 bg-green text-[#08130e] rounded-[12px] px-7 py-3.5 text-[14px] font-semibold transition-all hover:shadow-lg hover:shadow-green-bg"
          >
            Sign in
            <span className="transition-transform group-hover:translate-x-1">&rarr;</span>
          </Link>
          <p className="text-[13px] text-[#7e8298] mt-3.5 leading-relaxed">
            Enter your email and we will send you a one-time code — no password.
            Your workspace is chosen for you once you are signed in.
          </p>
        </div>

      </main>

      {/* Footer */}
      <footer className="relative z-10 border-t border-navy-line mt-12 py-6 px-6 md:px-10 text-[11.5px] text-[#7e8298] max-w-280 w-full mx-auto leading-relaxed text-center md:text-left">
        Vitti Capital Pty Ltd (ABN 13 670 030 145) is a Corporate Authorised Representative (001306367) of Point Capital Group Pty Ltd (ABN 41 625 931 900), holder of AFSL 518031. For wholesale clients (s761G / s761GA, Corporations Act 2001). Figures shown are illustrative prototype data. &copy; Vitti Capital 2026.
      </footer>
    </div>
  );
}
