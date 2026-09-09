"use client";

import React, { useEffect, useRef, useState, useTransition } from "react";
import Link, { useLinkStatus } from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Home,
  Zap,
  LineChart,
  CandlestickChart,
  Lightbulb,
  MessageSquareMore,
  TrendingUp,
  Layers,
  Star,
  CreditCard,
  Settings,
  Palette,
  Users,
  Calculator,
  AlertTriangle,
  Bell,
  GitMerge,
  ClipboardCheck,
  Clock,
  ChevronDown,
  Check,
  LogOut,
  MoreHorizontal,
  X,
  type LucideIcon,
} from "lucide-react";
import type { AlertRow } from "@/lib/data/queries";
import { ackAlert } from "@/app/actions/alerts";
import { signOut, setActiveAccount } from "@/app/actions/session";
import { usePnlCalculatorStore } from "@/store/usePnlCalculatorStore";
import { Wordmark } from "@/app/components/Wordmark";
import { isComingSoon } from "@/lib/nav/coming-soon";
import { LeavingOverlay } from "@/app/components/LeavingOverlay";
import { LEAVING_MS, SIGN_OUT_TIPS } from "@/lib/ui/leaving";

type AccountOption = { id: string; label: string; accountType: string };

/**
 * Says the click landed, while the next page is on its way.
 *
 * `useLinkStatus` reads the pending state of the `<Link>` it sits inside, which
 * is why this is a child component rather than a hook call up in the nav: the
 * hook has no way to be told which link it is about.
 *
 * `loading.tsx` already swaps a skeleton into the content area, and that is the
 * better signal — but only once the router has the fallback. Before that (the
 * first visit to a route in dev, a tab whose prefetch has not finished, a phone
 * on a slow connection) there is a gap where a click has visibly done nothing,
 * and "did that register?" is answered by clicking again. This fills the gap in
 * the one place the eye is already looking: the row that was clicked.
 */
function NavPending() {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return (
    <span
      aria-hidden
      className="ml-auto w-3.5 h-3.5 flex-none rounded-full border-[1.5px] border-current border-r-transparent animate-spin opacity-70 motion-reduce:animate-none"
    />
  );
}

/**
 * The nav icon's answer to being pointed at.
 *
 * `group-hover` rather than `hover`, so it reacts to the whole row: pointing at
 * a nav item means pointing at the row, not at eighteen pixels of icon.
 *
 * Interpolated into the class list rather than written as a stacked
 * `group-enabled:group-hover:` variant, which compiles to a selector wanting
 * two separate ancestors and so quietly never matches.
 *
 * 110%, 200ms, and nothing under `prefers-reduced-motion`. Big enough to feel
 * deliberate on a row you are already pointing at, small enough not to shift
 * the label beside it.
 */
const ICON_MOTION =
  "transition-transform duration-200 ease-out group-hover:scale-110 " +
  "motion-reduce:transition-none motion-reduce:group-hover:scale-100";

/**
 * Interactive portal shell (client island). The layout Server Component fetches
 * session + alerts + badge counts and hands them here as props; this component
 * owns the drawer/menu state and calls server actions for ack / sign-out.
 */

interface NavItem {
  k: string;
  label: string;
  path: string;
  icon: LucideIcon;
  tab: boolean;
  ai?: boolean;
  badge?: string;
}


export function PortalShell({
  role,
  clientName,
  clientAv,
  userEmail,
  alerts,
  clientLabels,
  pendingAllocCount,
  pendingMergeCount,
  accounts,
  activeAccountId,
  children,
}: {
  role: "client" | "admin";
  clientName: string;
  clientAv: string;
  /** The address this session is signed in as. Null if it could not be read. */
  userEmail: string | null;
  alerts: AlertRow[];
  clientLabels: Record<string, string>;
  pendingAllocCount: number;
  pendingMergeCount: number;
  accounts: AccountOption[];
  activeAccountId: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [isAlertsOpen, setIsAlertsOpen] = useState(false);
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const [isSwitching, startTransition] = useTransition();

  // Sign-out asks first. It is one click from the nav, it ends the session for
  // whoever is at the keyboard, and on the staff console it also drops the
  // client being inspected and anything unsaved in the P&L Calculator — none of
  // which announces itself until it is gone. `isSigningOut` is separate from the
  // dialog being open because the work outlives the click: the button has to
  // stay disabled while the server action runs and the redirect resolves.
  const [isSignOutOpen, setIsSignOutOpen] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);
  /** The send-off, up from the moment it is confirmed until /login. */
  const [isLeaving, setIsLeaving] = useState(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // The profile menu under the avatar.
  const [isProfileOpen, setIsProfileOpen] = useState(false);
  const profileRef = useRef<HTMLDivElement | null>(null);

  // A menu opened by a click has to close on one too, anywhere outside it —
  // and on Escape. Without that it survives navigation and sits over the next
  // page. `mousedown` rather than `click` so it closes on the way down, before
  // whatever was clicked underneath reacts to it.
  useEffect(() => {
    if (!isProfileOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!profileRef.current?.contains(e.target as Node)) setIsProfileOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsProfileOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [isProfileOpen]);

  // Navigating closes it as well, and needs no effect of its own: every nav
  // link is outside the menu, so the mousedown above has already fired by the
  // time the route changes.

  // Focus lands on CANCEL, not on the confirming action. A dialog that opens
  // with the destructive button focused turns a stray Enter — the one that may
  // well have opened it — into a confirmed sign-out.
  useEffect(() => {
    if (isSignOutOpen) cancelRef.current?.focus();
  }, [isSignOutOpen]);

  // Escape closes it, as every other dismissible surface in the shell should.
  // Ignored mid-sign-out: there is nothing left to cancel once the session is
  // already being torn down, and closing the dialog would only hide that.
  useEffect(() => {
    if (!isSignOutOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isSigningOut) setIsSignOutOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isSignOutOpen, isSigningOut]);

  const handleSignOut = async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    setIsLeaving(true);
    // Sign-out is a client-side `router.push`, so module-scope stores are NOT torn
    // down the way a full document load would tear them down. The P&L Calculator
    // keeps parsed client trade data in one, so it has to be cleared explicitly or
    // the next person to sign in on this browser inherits it.
    usePnlCalculatorStore.getState().reset();

    /**
     * The panel runs FIRST, and the session is torn down after it.
     *
     * Racing the two — `Promise.all` on the action and a timer — looked
     * tidier and did not work: `signOut` is a server action, and finishing one
     * refreshes the current route. The portal layout then finds no session and
     * redirects to /login, so the browser left while the send-off was still on
     * its second beat. It read as a flash, which is worse than not having one.
     *
     * Waiting first costs three seconds of a session whose owner is watching a
     * screen that says it is ending, and during which the shell has already
     * been replaced by that screen. Nothing can be done with those seconds,
     * which is what makes them affordable.
     */
    await new Promise((r) => setTimeout(r, LEAVING_MS.signOut));
    await signOut();
    // `/login` rather than `/`, which is now only a redirect to it. Left in the
    // signing-out state on purpose: the navigation is the next thing that
    // happens, and re-enabling the button first only invites a second click.
    router.push("/login");
  };

  // Client account switcher: persist the choice (server action revalidates the
  // portal), then refresh so every page re-renders scoped to the new account.
  const handleAccountChange = (id: string) => {
    if (id === activeAccountId) return;
    startTransition(async () => {
      await setActiveAccount(id);
      router.refresh();
    });
  };

  const activeAccount = accounts.find((a) => a.id === activeAccountId);

  const navItems: { client: NavItem[]; admin: NavItem[] } = {
    client: [
      { k: "dashboard", label: "Home", path: "/portal/client", icon: Home, tab: true },
      { k: "invest", label: "Invest", path: "/portal/client/invest", icon: Zap, tab: true },
      { k: "positions", label: "Portfolio", path: "/portal/client/positions", icon: LineChart, tab: true },
      { k: "market", label: "Market", path: "/portal/client/market", icon: CandlestickChart, tab: true },
      { k: "insights", label: "Insights", path: "/portal/client/insights", icon: Lightbulb, tab: true },
      { k: "askvitti", label: "Ask Vitti", path: "/portal/client/askvitti", icon: MessageSquareMore, tab: true, ai: true },
      { k: "markets", label: "Markets", path: "/portal/client/markets", icon: TrendingUp, tab: false },
      { k: "options", label: "Options", path: "/portal/client/options", icon: Layers, tab: false },
      { k: "watchlist", label: "Watchlist", path: "/portal/client/watchlist", icon: Star, tab: false }
      // Accounts and Settings are not here: they are about the person
      // signed in rather than about their money, and they now sit under the
      // avatar with the address and the way out. Customise is not here
      // either — it lives inside Settings, one door rather than two.
      // No "Alerts" entry: the bell in the top bar opens the same list, from
      // every page, with the same unread count on it. Two doors to one drawer
      // is one door too many, and the nav one was the slower of the two.
      // `/portal/client/alerts` still exists and still renders.
    ],
    admin: [
      { k: "overview", label: "Overview", path: "/portal/staff", icon: Home, tab: true },
      { k: "clients", label: "Clients", path: "/portal/staff/clients", icon: Users, tab: true },
      { k: "placements", label: "Placements", path: "/portal/staff/placements", icon: Zap, tab: true, badge: "pendingAlloc" },
      { k: "options", label: "Options", path: "/portal/staff/options", icon: Layers, tab: true },
      { k: "pnl-calculator", label: "PNL Calculator", path: "/portal/staff/pnl-calculator", icon: Calculator, tab: true },
      { k: "mismatches", label: "Mismatched Qty", path: "/portal/staff/mismatches", icon: AlertTriangle, tab: true },
      { k: "alerts", label: "Alerts", path: "/portal/staff/alerts", icon: Bell, tab: false, badge: "alerts" },
      { k: "merge", label: "Account requests", path: "/portal/staff/merge-requests", icon: GitMerge, tab: false, badge: "pendingMerge" },
      { k: "audit", label: "Audit log", path: "/portal/staff/audit", icon: ClipboardCheck, tab: false }
    ]
  };

  /**
   * The nav, minus the pages that are not finished.
   *
   * They used to be listed and greyed with a SOON chip, on the argument that
   * removing an entry reads as "this product does not have that". It reads
   * worse the other way round: a nav is a list of places you can go, and four
   * rows out of eleven that refuse to go anywhere is a menu mostly made of
   * disappointments. They come back by deleting their line from
   * lib/nav/coming-soon.ts, which is the same edit that re-enables the
   * dashboard's links into them.
   */
  const items = (role === "admin" ? navItems.admin : navItems.client).filter(
    (it) => !isComingSoon(it.path),
  );

  const unreadAlerts = alerts.filter((a) => !a.ack);
  const alertsCount = unreadAlerts.length;

  const getBadgeValue = (badgeName?: string) => {
    if (badgeName === "alerts") return alertsCount > 0 ? alertsCount : null;
    if (badgeName === "pendingAlloc") return pendingAllocCount > 0 ? pendingAllocCount : null;
    if (badgeName === "pendingMerge") return pendingMergeCount > 0 ? pendingMergeCount : null;
    return null;
  };

  const handleAck = (id: string) => {
    startTransition(() => {
      void ackAlert(id);
    });
  };

  const alertIco = (a: AlertRow) => {
    const map: Record<string, string> = { expiry: "amber", itm: "green", window: "red", price: a.sev === "amber" ? "amber" : "green" };
    const col = a.sev === "red" ? "red" : (a.sev === "amber" ? "amber" : map[a.kind] || "green");

    const Icon = {
      expiry: Clock,
      itm: TrendingUp,
      window: AlertTriangle,
      price: TrendingUp,
    }[a.kind] || Clock;

    const colors: Record<string, string> = {
      red: "bg-loss-bg text-loss-d",
      amber: "bg-amber-bg text-amber-d",
      green: "bg-green-bg text-green-d"
    };

    return (
      <div className={`w-8.5 h-8.5 rounded-[9px] flex-none flex items-center justify-center ${colors[col] || "bg-paper-2 text-mut"}`}>
        <Icon className="w-4.25 h-4.25 stroke-[1.8]" />
      </div>
    );
  };

  const sidebar = (
    <aside className="hidden md:flex w-59 flex-none bg-navy text-[#c2c7d8] flex-col p-5 sticky top-0 h-screen z-40 select-none">
      <Link href="/" className="inline-flex w-fit py-1 px-2 mb-2">
        <Wordmark className="text-xl text-white" />
      </Link>
      <div className="mx-2 my-1.5 text-[11px] tracking-[0.12em] uppercase font-semibold text-green mb-4">
        {role === "admin" ? "Vitti staff console" : "Client portal"}
      </div>

      <nav className="flex-1 space-y-0.5">
        {items.map((it) => {
          const isActive = pathname === it.path;
          const badgeVal = getBadgeValue(it.badge);
          const body = (
            <>
              <it.icon className={`w-4.5 h-4.5 stroke-[1.7] flex-none ${ICON_MOTION}`} />
              <span>{it.label}</span>
              <NavPending />
              {it.ai && <span className="ml-auto text-[8.5px] font-bold tracking-wider bg-green text-[#08130e] px-1.5 py-0.5 rounded-[5px]">AI</span>}
              {badgeVal !== null && (
                <span className={`ml-auto text-[10.5px] font-bold rounded-full px-2 py-0.5 min-w-4.5 text-center ${it.badge === "pendingAlloc" ? "bg-green text-[#08130e]" : "bg-loss text-white"}`}>
                  {badgeVal}
                </span>
              )}
            </>
          );

          return (
            <Link
              key={it.k}
              href={it.path}
              className={`group flex items-center gap-2.75 w-full text-left font-medium text-[13.5px] px-3 py-2.5 rounded-[9px] cursor-pointer transition-colors ${
                isActive
                  ? "bg-navy-3 text-white"
                  : it.ai
                  ? "text-[#9fe9cf] hover:bg-green/12 hover:text-[#9fe9cf]"
                  : "text-mut-d hover:text-white hover:bg-white/5"
              }`}
            >
              {body}
            </Link>
          );
        })}
      </nav>

      {/* Who you are and how to leave both live under the avatar in the top bar
          now — see `profileMenu`. They were here as well, which meant the same
          two facts in two places on desktop and only one of them on mobile,
          where this sidebar does not exist at all. */}
    </aside>
  );

  const topbar = (
    <header className="topbar flex items-center gap-3 sm:gap-4 bg-white/85 backdrop-blur-sm border-b border-line px-4 sm:px-6 sticky top-0 z-30 select-none">
      {/*
        The brand, on phones only.

        The sidebar carries it on a desktop and is hidden below `md`, so a phone
        had no wordmark anywhere — the top of the app simply was not there. What
        occupied this space instead was a green "Broker feed · live" pill, which
        is a status light for a pipeline the client does not own, on a screen
        about their money. It said nothing they could act on and nothing they
        would miss.
      */}
      <Link href="/portal/client" className="md:hidden flex-none">
        <Wordmark className="text-base text-ink" markSize={22} />
      </Link>

      <input
        className="hidden md:block w-57.5 border border-line bg-white rounded-[9px] text-[12.5px] text-mut px-3.5 py-2 placeholder-mut-d focus:outline-none focus:border-green"
        placeholder="Search securities, clients, deals…"
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            alert("Search is illustrative in this prototype.");
            e.currentTarget.value = "";
          }
        }}
      />

      <div className="flex-1" />

      {/*
        Account switcher — from `md` up only.

        A `<select>` is as wide as its widest option, and these are company
        names: "Psg Capital Investments PTY LTD · Wholesale" is over 300px. On a
        375px phone it pushed the alerts bell and the avatar off the right of
        the header — both simply gone, and the page scrolled sideways to reach
        them. Capped here so a longer name cannot do it again on a small laptop
        either.

        Phones switch accounts inside the profile menu instead, where there is
        room for the names to be read in full. See `profileMenu`.
      */}
      {role === "client" && accounts.length > 0 && (
        accounts.length === 1 ? (
          <span
            className="hidden md:inline-flex items-center gap-1.5 text-[12px] font-semibold text-ink bg-paper-2 border border-line rounded-full py-1.5 px-3 max-w-56 min-w-0"
            title={activeAccount?.accountType}
          >
            <CreditCard className="w-3.5 h-3.5 stroke-[1.8] flex-none" />
            <span className="truncate">{activeAccount?.label}</span>
          </span>
        ) : (
          <label
            className="relative hidden md:inline-flex items-center min-w-0"
            title="Switch account"
          >
            <CreditCard className="w-3.5 h-3.5 stroke-[1.8] text-mut absolute left-2.5 pointer-events-none" />
            <select
              value={activeAccountId}
              onChange={(e) => handleAccountChange(e.target.value)}
              disabled={isSwitching}
              aria-label="Active account"
              className="appearance-none cursor-pointer text-[12px] font-semibold text-ink bg-paper-2 border border-line rounded-full py-1.5 pl-7.5 pr-7 hover:border-green focus:outline-none focus:border-green disabled:opacity-60 max-w-56 truncate"
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label} · {a.accountType}
                </option>
              ))}
            </select>
            <ChevronDown className="w-3 h-3 stroke-[2] text-mut absolute right-2.5 pointer-events-none" />
          </label>
        )
      )}

      {/* Alerts toggle button */}
      <button
        onClick={() => setIsAlertsOpen(true)}
        className="relative flex p-1.5 rounded-[9px] hover:bg-white border border-transparent hover:border-line cursor-pointer text-ink transition-all"
        aria-label="Alerts"
      >
        <Bell className="w-4.75 h-4.75 stroke-[1.7]" />
        {alertsCount > 0 && (
          <span className="absolute top-0.75 right-0.5 min-w-3.75 h-3.75 px-1 rounded-full bg-loss text-white text-[9px] font-bold flex items-center justify-center border-2 border-paper">
            {alertsCount}
          </span>
        )}
      </button>

      {/* Profile: identity, and the way out. `relative` so the panel hangs off
          the avatar rather than off the header. */}
      <div className="relative flex-none" ref={profileRef}>
        <button
          onClick={() => setIsProfileOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={isProfileOpen}
          aria-label="Your profile"
          className={`w-7.75 h-7.75 rounded-full bg-navy text-white font-semibold text-[11px] flex items-center justify-center cursor-pointer transition-shadow ${
            isProfileOpen ? "ring-2 ring-green ring-offset-1" : "hover:opacity-90"
          }`}
        >
          {role === "admin" ? "SG" : clientAv}
        </button>

        {isProfileOpen && (
          <div
            role="menu"
            className="absolute right-0 top-full mt-2 w-64 bg-white border border-line rounded-[12px] shadow-shadow-lg p-1.5 z-40"
          >
            <div className="flex items-center gap-2.5 p-2.5">
              <div className="w-9 h-9 rounded-full bg-navy text-white font-semibold text-xs flex items-center justify-center flex-none">
                {role === "admin" ? "SG" : clientAv}
              </div>
              <div className="min-w-0 leading-tight">
                <div className="text-[13px] font-semibold text-ink truncate">
                  {role === "admin" ? "S. Goyal" : clientName}
                </div>
                <div className="text-[11px] text-mut truncate">
                  {role === "admin" ? "Director · admin" : "Wholesale client"}
                </div>
              </div>
            </div>

            {/* The address is the one identifying thing a person can check at a
                glance — on a shared machine it answers "whose session is this"
                faster than a name two people might share. */}
            {userEmail && (
              <div className="px-2.5 pb-2 text-[11px] text-mut break-all">{userEmail}</div>
            )}

            {/*
              Which account the figures on screen belong to — and, with more
              than one, how to change it.

              The header's switcher is hidden below `md` because a company name
              in a `<select>` is wider than a phone. Here the names have a
              column to themselves and can be read in full, which is the better
              place for them anyway: this menu is already "who am I and what is
              mine".
            */}
            {role === "client" && accounts.length > 1 && (
              <div className="md:hidden">
                <div className="px-2.5 pb-1 text-[10.5px] font-semibold uppercase tracking-wider text-mut">
                  Account
                </div>
                {accounts.map((a) => {
                  const active = a.id === activeAccountId;
                  return (
                    <button
                      key={a.id}
                      role="menuitemradio"
                      aria-checked={active}
                      disabled={isSwitching}
                      onClick={() => {
                        setIsProfileOpen(false);
                        handleAccountChange(a.id);
                      }}
                      className={`flex items-start gap-2 w-full text-left p-2.5 rounded-[9px] cursor-pointer transition-colors disabled:opacity-60 ${
                        active ? "bg-paper-2" : "hover:bg-paper-2"
                      }`}
                    >
                      <Check
                        className={`w-3.5 h-3.5 stroke-[2.5] flex-none mt-0.5 ${
                          active ? "text-green-d" : "text-transparent"
                        }`}
                        aria-hidden
                      />
                      <span className="min-w-0">
                        <span className="block text-[12.5px] font-semibold text-ink leading-snug">
                          {a.label}
                        </span>
                        <span className="block text-[11px] text-mut">{a.accountType}</span>
                      </span>
                    </button>
                  );
                })}
                <div className="border-t border-line my-1" />
              </div>
            )}

            {role === "client" && accounts.length > 1 && activeAccount && (
              <div className="hidden md:block px-2.5 pb-2 text-[11px] text-mut">
                Viewing <span className="font-semibold text-ink">{activeAccount.label}</span>
              </div>
            )}

            <div className="border-t border-line my-1" />

            {/* Where the person, rather than the portfolio, is managed.
                Client-only: neither page exists on the staff console. */}
            {role === "client" && (
              <>
                <Link
                  role="menuitem"
                  href="/portal/client/accounts"
                  onClick={() => setIsProfileOpen(false)}
                  className="flex items-center gap-2.5 w-full text-left text-[13px] font-medium text-ink hover:bg-paper-2 p-2.5 rounded-[9px] cursor-pointer transition-colors"
                >
                  <CreditCard className="w-4 h-4 stroke-[1.7] flex-none" />
                  Accounts
                </Link>
                <Link
                  role="menuitem"
                  href="/portal/client/settings"
                  onClick={() => setIsProfileOpen(false)}
                  className="flex items-center gap-2.5 w-full text-left text-[13px] font-medium text-ink hover:bg-paper-2 p-2.5 rounded-[9px] cursor-pointer transition-colors"
                >
                  <Settings className="w-4 h-4 stroke-[1.7] flex-none" />
                  Settings
                </Link>
              </>
            )}

            {/* Staff keep the theme link here because there is no staff
                Settings page for it to live inside. A client reaches the same
                page through Settings, so offering it twice would be the second
                door this menu was built to remove. */}
            {role === "admin" && (
              <Link
                role="menuitem"
                href="/portal/staff/customise"
                onClick={() => setIsProfileOpen(false)}
                className="flex items-center gap-2.5 w-full text-left text-[13px] font-medium text-ink hover:bg-paper-2 p-2.5 rounded-[9px] cursor-pointer transition-colors"
              >
                <Palette className="w-4 h-4 stroke-[1.7] flex-none text-green-d" />
                Customise theme
              </Link>
            )}

            <button
              role="menuitem"
              onClick={() => {
                setIsProfileOpen(false);
                setIsSignOutOpen(true);
              }}
              className="flex items-center gap-2.5 w-full text-left text-[13px] font-medium text-ink hover:bg-paper-2 p-2.5 rounded-[9px] cursor-pointer transition-colors"
            >
              <LogOut className="w-4 h-4 stroke-[1.7] flex-none" />
              Sign out
            </button>
          </div>
        )}
      </div>

      {/*
        Sign out, mobile only.

        The sidebar carries it on desktop, but the sidebar is `hidden md:flex` —
        so below md there was no way to sign out at all. On a phone, which is the
        device most likely to be handed to someone else or left on a table, that
        is the wrong control to be missing.

        `md:hidden` rather than shown everywhere, because two sign-outs on one
        screen invites the question of whether they do the same thing. Placed
        after the avatar so it reads as an action on the identity beside it, and
        it opens the same dialog the sidebar does.
      */}
      <button
        onClick={() => setIsSignOutOpen(true)}
        className="md:hidden relative flex p-1.5 rounded-[9px] hover:bg-white border border-transparent hover:border-line cursor-pointer text-ink transition-all"
        aria-label="Sign out"
        title="Sign out"
      >
        <LogOut className="w-4.75 h-4.75 stroke-[1.7]" />
      </button>
    </header>
  );

  const bottomnav = (
    <nav className="tabbar flex md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-line px-1.5 pt-2 z-20">
      {items.filter(it => it.tab).map(it => {
        const isActive = pathname === it.path;
        const badgeVal = getBadgeValue(it.badge);
        return (
          // A Link and not a button: `router.push` cannot prefetch, so every tap
          // on a phone waited for a round trip the sidebar had already made.
          <Link
            key={it.k}
            href={it.path}
            className={`group flex-1 flex flex-col items-center gap-0.75 text-[9.5px] font-semibold relative cursor-pointer ${
              isActive ? "text-green-d" : "text-mut hover:text-ink"
            }`}
          >
            <it.icon className={`w-5 h-5 stroke-[1.8] ${ICON_MOTION}`} />
            <span>{it.label}</span>
            {badgeVal !== null && (
              <span className="absolute -top-0.75 right-[50%] -mr-4 bg-loss text-white text-[8.5px] font-bold rounded-full px-1 min-w-3.5 text-center">
                {badgeVal}
              </span>
            )}
          </Link>
        );
      })}

      {/* More menu drawer trigger */}
      <button
        onClick={() => setIsMoreOpen(true)}
        className="flex-1 flex flex-col items-center gap-0.75 text-[9.5px] font-semibold cursor-pointer text-mut hover:text-ink"
      >
        <MoreHorizontal className="w-5 h-5 stroke-[1.8]" />
        <span>More</span>
      </button>
    </nav>
  );

  // Alerts Slide-out Drawer
  const alertsDrawer = (
    <>
      <div
        className={`fixed inset-0 bg-navy/55 backdrop-blur-[2px] transition-opacity z-50 ${isAlertsOpen ? "opacity-100 block" : "opacity-0 hidden"}`}
        onClick={() => setIsAlertsOpen(false)}
      />
      <div className={`fixed top-0 right-0 w-98 max-w-[94vw] h-full bg-paper border-l border-line z-50 shadow-shadow-lg transition-all duration-300 transform flex flex-col ${isAlertsOpen ? "translate-x-0" : "translate-x-full"}`}>
        <div className="flex justify-between items-center px-4.5 py-3 border-b border-line bg-paper sticky top-0 z-10">
          <h3 className="font-disp text-xl font-medium text-ink">Alerts</h3>
          <button
            onClick={() => setIsAlertsOpen(false)}
            className="p-1.5 rounded-[9px] hover:bg-white text-ink cursor-pointer"
          >
            <X className="w-4.75 h-4.75 stroke-[1.7]" />
          </button>
        </div>
        <div className="p-4.5 overflow-y-auto flex-1 space-y-2.5">
          {alerts.length === 0 ? (
            <div className="text-center text-mut py-10 text-[13px]">No alerts triggered.</div>
          ) : (
            alerts.map(a => {
              const borderColors = {
                red: "border-l-[3px] border-l-loss",
                amber: "border-l-[3px] border-l-amber",
                green: "border-l-[3px] border-l-green"
              };
              return (
                <div
                  key={a.id}
                  className={`flex gap-3 p-3.5 border border-line bg-white rounded-xl items-start ${a.ack ? "opacity-75" : `shadow-shadow ${borderColors[a.sev] || ""}`}`}
                >
                  {alertIco(a)}
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-semibold text-ink leading-tight flex items-center gap-1.5 flex-wrap">
                      {role === "admin" && a.clientId && (
                        <span className="bg-paper-2 text-mut text-[10.5px] font-semibold px-2 py-0.5 rounded-sm uppercase">{clientLabels[a.clientId] ?? ""}</span>
                      )}
                      {a.title}
                    </div>
                    <div className="text-xs text-mut mt-0.5 leading-normal">{a.sub}</div>
                    <div className="text-[9.5px] font-mono text-mut-d mt-1.5">
                      {new Date(a.ts).toLocaleDateString("en-AU", { day: "numeric", month: "short" })} &middot; {new Date(a.ts).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </div>
                  {!a.ack && (
                    <button
                      onClick={() => handleAck(a.id)}
                      className="btn ghost sm text-xs py-1.5 px-2.5 rounded-lg bg-white border border-line hover:border-green cursor-pointer flex-none self-center"
                    >
                      Ack
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );

  // More Menu Modal for Mobile
  const moreMenuModal = (
    <>
      <div
        className={`fixed inset-0 bg-navy/55 backdrop-blur-[2px] transition-opacity z-50 ${isMoreOpen ? "opacity-100 flex items-center justify-center p-4.5" : "opacity-0 hidden"}`}
        onClick={() => setIsMoreOpen(false)}
      >
        <div className="bg-white rounded-2xl max-w-110 w-full p-6 shadow-shadow-lg max-h-[90vh] overflow-auto text-ink" onClick={e => e.stopPropagation()}>
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-disp font-medium text-[22px]">More</h3>
            <button onClick={() => setIsMoreOpen(false)} className="text-mut hover:text-ink cursor-pointer">
              <X className="w-6 h-6 stroke-[1.7]" />
            </button>
          </div>
          <div className="space-y-1">
            {items.filter(it => !it.tab).map(it => {
              const isActive = pathname === it.path;
              const badgeVal = getBadgeValue(it.badge);
              return (
                <Link
                  key={it.k}
                  href={it.path}
                  onClick={() => setIsMoreOpen(false)}
                  className={`group flex items-center gap-3 w-full text-left py-3.5 px-3 rounded-[10px] text-sm font-medium transition-colors hover:bg-paper-2 ${
                    isActive ? "text-green-d bg-paper-2" : "text-ink"
                  }`}
                >
                  <it.icon className={`w-4.75 h-4.75 stroke-[1.7] flex-none ${ICON_MOTION}`} />
                  <span>{it.label}</span>
                  {badgeVal !== null && (
                    <span className="ml-auto bg-loss text-white text-[10.5px] font-bold rounded-full px-2 py-0.5 min-w-4.5 text-center">
                      {badgeVal}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );

  /**
   * Sign-out confirmation.
   *
   * Styled on the More menu above — same overlay, same card — but sits at z-[60]
   * so it is above the drawer and that menu rather than behind whichever was
   * open when it was raised.
   *
   * The layout follows the lesson in LLD §8.37: the overlay scrolls
   * (`overflow-y-auto`) and the card is `my-auto max-h-[92vh] overflow-y-auto`,
   * so it centres when it fits and scrolls when it does not. This dialog is short
   * enough to fit anywhere, but ten modals in this app were unreachable on a
   * short screen for exactly the want of those classes.
   */
  const signOutModal = (
    <div
      className={`fixed inset-0 bg-navy/55 backdrop-blur-[2px] transition-opacity z-[60] ${
        isSignOutOpen
          ? "opacity-100 flex items-center justify-center p-4.5 overflow-y-auto"
          : "opacity-0 hidden"
      }`}
      onClick={() => {
        // A backdrop click cancels — but not once the session is already going,
        // where dismissing the dialog would just hide work in progress.
        if (!isSigningOut) setIsSignOutOpen(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="signout-title"
        aria-describedby="signout-body"
        className="bg-white rounded-2xl max-w-100 w-full p-6 shadow-shadow-lg my-auto max-h-[92vh] overflow-y-auto text-ink"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3.5">
          <span className="shrink-0 w-9 h-9 rounded-full bg-loss-bg grid place-items-center">
            <LogOut
              className="w-4.5 h-4.5 stroke-loss-d stroke-[1.8]"
              aria-hidden="true"
            />
          </span>
          <div className="min-w-0">
            <h3 id="signout-title" className="font-disp font-medium text-[20px] leading-snug">
              Sign out of Vitti Capital?
            </h3>
            <p id="signout-body" className="text-[13.5px] text-mut mt-1.5 leading-relaxed">
              {role === "admin" ? (
                <>
                  You will need a new one-time code to sign back in. The client
                  you are inspecting is cleared, and anything loaded into the
                  P&amp;L Calculator on this browser is discarded.
                </>
              ) : (
                <>
                  You will need your password or a one-time code to sign back in.
                </>
              )}
            </p>
          </div>
        </div>

        <div className="flex gap-2.5 mt-6">
          <button
            ref={cancelRef}
            type="button"
            onClick={() => setIsSignOutOpen(false)}
            disabled={isSigningOut}
            className="flex-1 btn rounded-[10px] py-2.5 text-[13px] font-semibold cursor-pointer select-none border border-line-2 bg-white text-ink hover:bg-paper-2 transition-colors disabled:opacity-55 disabled:cursor-not-allowed"
          >
            Stay signed in
          </button>
          <button
            type="button"
            onClick={handleSignOut}
            disabled={isSigningOut}
            className="flex-1 btn rounded-[10px] py-2.5 text-[13px] font-semibold cursor-pointer select-none bg-loss text-white hover:opacity-90 transition-opacity disabled:opacity-55 disabled:cursor-not-allowed"
          >
            {isSigningOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </div>
    </div>
  );

  // The whole shell goes, not a panel over it: what is underneath belongs to a
  // session being torn down as this renders.
  if (isLeaving) {
    return (
      <LeavingOverlay
        tone="muted"
        title="Signing you out"
        subtitle="Ending this session…"
        tips={SIGN_OUT_TIPS}
        durationMs={LEAVING_MS.signOut}
        icon={
          <svg
            viewBox="0 0 24 24"
            className="h-6 w-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {/* The same door as the way in, walked the other way. */}
            <path pathLength="1" d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h8" />
            <path pathLength="1" d="M18 12H10M14 8l4 4-4 4" />
          </svg>
        }
      />
    );
  }

  return (
    <div className="app-shell flex min-h-screen bg-paper font-body select-none">
      {sidebar}
      <div className="main clears-tabbar flex-1 flex flex-col min-w-0 relative overflow-x-clip">
        {topbar}
        <main className="content p-4 sm:p-6 flex-1 max-w-300 w-full mx-auto pb-10">
          {children}
        </main>
        {bottomnav}
      </div>

      {alertsDrawer}
      {moreMenuModal}
      {signOutModal}
    </div>
  );
}
