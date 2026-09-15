"use client";

import { useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { BookOpen, ChevronDown } from "lucide-react";
import { glossaryForPage, glossaryDefinition } from "@/lib/glossary";

/**
 * The financial terms on this page, explained at the top of it.
 *
 * ── The problem ─────────────────────────────────────────────────────────────
 * Clients were reading "Unrealised P&L" as a pending action and asking the desk
 * to realise it for them. Renaming that column to "Open P&L" removes one trap;
 * it does nothing for strike, spot, moneyness, scaleback or s708, and a portal
 * for wholesale investors is made of those words.
 *
 * ── Why not tooltips, and why not a glossary page ───────────────────────────
 * A tooltip answers at the exact moment of confusion, which is the right
 * instinct, but it is invisible until hovered and hover does not exist on a
 * phone — so the client who most needs it never learns it is there. A /glossary
 * route has the opposite failure: perfectly discoverable, and nobody navigates
 * away from their portfolio to read a dictionary.
 *
 * ── Why the collapsed state lists the words ─────────────────────────────────
 * This strip sits at the top of the page and is never fully closed: collapsed,
 * it still shows every term it covers as a row of chips. That is the part that
 * matters. A client scanning the Options tab reads `Strike · Spot · Moneyness`
 * before they read the table, so they know both that those words have meanings
 * and that the meanings are one click away — without the definitions pushing
 * their own numbers below the fold on every single visit.
 *
 * ── Why it reads its own route ──────────────────────────────────────────────
 * The page passes nothing. `lib/glossary.ts` maps route → terms, so a page
 * cannot drift out of step with the words on it by somebody editing a prop, and
 * the whole product's vocabulary can be reviewed by reading one map. A route
 * with no terms listed renders nothing, so dropping this into a page is safe.
 */
const STORAGE_KEY = "vitti_glossary_open";

/**
 * Open or closed, shared by every strip and remembered between visits.
 *
 * ── Why a module store, and why not an effect ───────────────────────────────
 * `NewsViewToggle`'s reasoning, for the same two reasons. A client who opens
 * the definitions on Portfolio has told us they want them; walking to Options
 * and finding them shut again is the product forgetting something it was just
 * told. And `localStorage` does not exist on the server, so the saved value
 * cannot be read during the render that produces the HTML — reading it in a
 * mount effect and calling `setState` renders once and throws that render away,
 * which is what the lint rule about setState in effects is for.
 * `useSyncExternalStore` has a server snapshot for exactly this case.
 */
let current: boolean | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): boolean {
  // Cached in a module variable because getSnapshot must return a stable value
  // between renders — reading storage on every call is a fresh read each time
  // React checks for a change.
  if (current !== null) return current;
  try {
    current = window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    // Private windows and blocked site data both throw. The strip still works;
    // it just forgets.
    current = false;
  }
  return current;
}

/**
 * Closed, on the server and on the hydrating client alike.
 *
 * It has to be a constant, and closed is the right constant: the collapsed
 * strip still names every term it covers, so the first paint is already doing
 * the job, and opening by default would push the client's own figures down the
 * page on every visit for the sake of words most of them know.
 */
function getServerSnapshot(): boolean {
  return false;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function setGlossaryOpen(next: boolean): void {
  if (current === next) return;
  current = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
  } catch {
    // The toggle still works for this visit; only the memory of it is lost.
  }
  for (const listener of listeners) listener();
}

export function GlossaryStrip() {
  const pathname = usePathname();
  const entries = glossaryForPage(pathname ?? "");
  const open = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // A page whose terms nobody has listed says nothing rather than showing an
  // empty box that looks like something that failed to load.
  if (entries.length === 0) return null;

  return (
    <section className="card bg-card border border-line rounded-[14px] shadow-shadow overflow-hidden">
      {/*
        One button wrapping label, chips and chevron. The chips are spans rather
        than buttons of their own: nesting interactive elements is invalid HTML
        and gives keyboard users a tab stop per term for no added ability.
      */}
      <button
        type="button"
        onClick={() => setGlossaryOpen(!open)}
        aria-expanded={open}
        aria-controls="glossary-terms"
        className="w-full text-left px-4 py-3 hover:bg-paper-2/40 transition-colors"
      >
        <span className="flex items-center gap-2.5">
          <BookOpen className="w-3.5 h-3.5 stroke-[1.8] text-mut flex-none" />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-mut">
            What these terms mean
          </span>
          <span className="text-[11px] font-medium text-mut-d ml-auto flex items-center gap-1 flex-none">
            <span className="hidden sm:inline">{open ? "Hide" : "Show definitions"}</span>
            <ChevronDown
              className={`w-3.5 h-3.5 stroke-[1.8] transition-transform ${open ? "rotate-180" : ""}`}
            />
          </span>
        </span>

        {!open && (
          <span className="flex flex-wrap gap-1.5 mt-2">
            {entries.map((e) => (
              <span
                key={e.slug}
                className="pill bg-paper-2 text-ink/80 text-[11px] font-medium rounded-full px-2 py-0.5 border border-line/60"
              >
                {e.term}
              </span>
            ))}
          </span>
        )}
      </button>

      {open && (
        <dl
          id="glossary-terms"
          className="border-t border-line px-4 py-3.5 grid gap-x-8 gap-y-3 sm:grid-cols-2"
        >
          {entries.map((e) => (
            <div key={e.slug}>
              <dt className="text-xs font-semibold text-ink">
                {e.term}
                {e.also && (
                  <span className="font-normal text-mut-d ml-1.5">
                    &middot; also {e.also.join(", ")}
                  </span>
                )}
              </dt>
              <dd className="text-xs text-mut leading-relaxed mt-0.5">{glossaryDefinition(e)}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}
