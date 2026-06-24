"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

export default function Home() {
  const router = useRouter();

  const handleStartLogin = (role: "client" | "admin") => {
    router.push(`/login?role=${role}`);
  };

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

        {/* Roles Selectors */}
        <div className="grid md:grid-cols-2 gap-5 max-w-205">
          <button 
            onClick={() => handleStartLogin("client")}
            className="group text-left bg-navy-2 border border-navy-line hover:border-green rounded-[18px] p-6.5 transition-all cursor-pointer hover:-translate-y-0.75 hover:shadow-shadow-lg"
          >
            <div className="w-11.5 h-11.5 rounded-xl bg-navy-3 flex items-center justify-center mb-4 transition-colors">
              <svg className="w-5.75 h-5.75 fill-none stroke-green stroke-[1.7] stroke-linecap-round stroke-linejoin-round" viewBox="0 0 24 24">
                <path d="M4 19V5M4 19h16M8 15l3-4 3 2 4-6" />
              </svg>
            </div>
            <h3 className="font-disp font-medium text-2xl mb-1 text-white">Client sign in</h3>
            <p className="text-xs sm:text-[13.5px] text-[#aab0c2] mb-4 leading-normal">
              See your portfolio, options, placements and alerts — your data only.
            </p>
            <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-green group-hover:translate-x-1 transition-transform">
              Continue as client &rarr;
            </span>
          </button>

          <button 
            onClick={() => handleStartLogin("admin")}
            className="group text-left bg-navy-2 border border-navy-line hover:border-green rounded-[18px] p-6.5 transition-all cursor-pointer hover:-translate-y-0.75 hover:shadow-shadow-lg"
          >
            <div className="w-11.5 h-11.5 rounded-xl bg-navy-3 flex items-center justify-center mb-4 transition-colors">
              <svg className="w-5.75 h-5.75 fill-none stroke-green stroke-[1.7] stroke-linecap-round stroke-linejoin-round" viewBox="0 0 24 24">
                <circle cx="12" cy="8" r="3.4" />
                <path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" />
                <path d="M19 4.5l1.4 1.4M4.6 4.5 3.2 5.9" />
              </svg>
            </div>
            <h3 className="font-disp font-medium text-2xl mb-1 text-white">Vitti staff sign in</h3>
            <p className="text-xs sm:text-[13.5px] text-[#aab0c2] mb-4 leading-normal">
              Consolidated book across all clients, bidding on their behalf, allocations, alerts and audit.
            </p>
            <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-green group-hover:translate-x-1 transition-transform">
              Continue as staff &rarr;
            </span>
          </button>
        </div>
      </main>

      {/* Footer */}
      <footer className="relative z-10 border-t border-navy-line mt-12 py-6 px-6 md:px-10 text-[11.5px] text-[#7e8298] max-w-280 w-full mx-auto leading-relaxed text-center md:text-left">
        Vitti Capital Pty Ltd (ABN 13 670 030 145) is a Corporate Authorised Representative (001306367) of Point Capital Group Pty Ltd (ABN 41 625 931 900), holder of AFSL 518031. For wholesale clients (s761G / s761GA, Corporations Act 2001). Figures shown are illustrative prototype data. &copy; Vitti Capital 2026.
      </footer>
    </div>
  );
}
