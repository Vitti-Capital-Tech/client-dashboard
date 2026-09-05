import React from "react";
import { Wordmark } from "@/app/components/Wordmark";

/**
 * The two-column frame every unauthenticated page sits in — sign in, sign up,
 * reset password.
 *
 * Extracted when the second and third of those arrived. The brand aside is forty
 * lines of decoration with a background grid and a pull quote, and three copies
 * of it would drift: the real cost is not the duplication but that a change to
 * the wordmark would land on one page and not the others, which is the kind of
 * difference nobody notices until a client does.
 *
 * No `"use client"`. It has no state and no handlers, so it stays a Server
 * Component when a Server Component renders it, and is simply included in the
 * bundle when one of the client-side forms does.
 */
export function AuthShell({ children }: { children: React.ReactNode }) {
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

        <Wordmark className="relative z-10 text-xl text-white" />

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
          {/* Mobile-only wordmark: the aside is hidden below md, and a bare form
              on a white page has nothing on it saying whose it is. */}
          <Wordmark className="md:hidden text-lg text-ink mb-8" markSize={23} />
          {children}
        </div>
      </main>
    </div>
  );
}


/** The one error presentation, shared so the three forms agree. */
export function FormError({
  id,
  children,
}: {
  id?: string;
  children: React.ReactNode;
}) {
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

/** The shared input styling — one border radius, one focus colour. */
export const fieldClass =
  "w-full border border-line-2 bg-white rounded-[10px] px-3.5 py-3 text-[15px] focus:border-green focus:outline-none transition-colors";

/** Primary action. Navy on the sign-in step, green where a flow completes. */
export const buttonClass =
  "w-full btn rounded-[10px] py-3 text-[13.5px] font-semibold cursor-pointer select-none transition-colors disabled:opacity-55 disabled:cursor-not-allowed";
