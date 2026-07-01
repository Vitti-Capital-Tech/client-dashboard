"use client";

import React, { useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { AlertRow } from "@/lib/data/queries";
import { ackAlert } from "@/app/actions/alerts";
import { signOut } from "@/app/actions/session";

/**
 * Interactive portal shell (client island). The layout Server Component fetches
 * session + alerts + badge counts and hands them here as props; this component
 * owns the drawer/menu state and calls server actions for ack / sign-out.
 */

interface NavItem {
  k: string;
  label: string;
  path: string;
  icon: string;
  tab: boolean;
  ai?: boolean;
  badge?: string;
}

export function PortalShell({
  role,
  clientName,
  clientAv,
  alerts,
  clientLabels,
  pendingAllocCount,
  children,
}: {
  role: "client" | "admin";
  clientName: string;
  clientAv: string;
  alerts: AlertRow[];
  clientLabels: Record<string, string>;
  pendingAllocCount: number;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [isAlertsOpen, setIsAlertsOpen] = useState(false);
  const [isMoreOpen, setIsMoreOpen] = useState(false);
  const [, startTransition] = useTransition();

  const handleSignOut = async () => {
    await signOut();
    router.push("/");
  };

  const navItems: { client: NavItem[]; admin: NavItem[] } = {
    client: [
      { k: "dashboard", label: "Home", path: "/portal/client", icon: "M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5", tab: true },
      { k: "invest", label: "Invest", path: "/portal/client/invest", icon: "M13 2 4.5 13.5H11L9.5 22 19 10h-6.5z", tab: true },
      { k: "positions", label: "Portfolio", path: "/portal/client/positions", icon: "M4 19V5M4 19h16M8 15l3-4 3 2 4-6", tab: true },
      { k: "insights", label: "Insights", path: "/portal/client/insights", icon: "M3 3v18h18M7 13l3 3 4-6 4 4", tab: true },
      { k: "askvitti", label: "Ask Vitti", path: "/portal/client/askvitti", icon: "M21 11.5a8.4 8.4 0 0 1-8.5 8.4 8.6 8.6 0 0 1-3.9-.9L3 20.5l1.5-5.4a8.4 8.4 0 1 1 16.5-3.6zM8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01", tab: true, ai: true },
      { k: "markets", label: "Markets", path: "/portal/client/markets", icon: "M3 3v18h18M7 14l3-4 3 3 5-7", tab: false },
      { k: "placements", label: "All deals", path: "/portal/client/placements", icon: "M13 2 4.5 13.5H11L9.5 22 19 10h-6.5z", tab: false },
      { k: "options", label: "Options", path: "/portal/client/options", icon: "M3 5h18v14H3zM7 12h4M7 15h7M15 9h3", tab: false },
      { k: "watchlist", label: "Watchlist", path: "/portal/client/watchlist", icon: "m12 3 2.7 5.8 6.3.7-4.7 4.3 1.3 6.2L12 16.8 6.4 20l1.3-6.2L3 9.5l6.3-.7z", tab: false },
      { k: "alerts", label: "Alerts", path: "/portal/client/alerts", icon: "M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0", tab: false, badge: "alerts" }
    ],
    admin: [
      { k: "overview", label: "Overview", path: "/portal/staff", icon: "M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5", tab: true },
      { k: "clients", label: "Clients", path: "/portal/staff/clients", icon: "M16 7a4 4 0 1 0-8 0 4 4 0 0 0 8 0zM3 21c0-3.9 4-7 9-7s9 3.1 9 7", tab: true },
      { k: "placements", label: "Placements", path: "/portal/staff/placements", icon: "M13 2 4.5 13.5H11L9.5 22 19 10h-6.5z", tab: true, badge: "pendingAlloc" },
      { k: "options", label: "Options", path: "/portal/staff/options", icon: "M3 5h18v14H3zM7 12h4M7 15h7M15 9h3", tab: true },
      { k: "alerts", label: "Alerts", path: "/portal/staff/alerts", icon: "M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0", tab: false, badge: "alerts" },
      { k: "audit", label: "Audit log", path: "/portal/staff/audit", icon: "M9 11l3 3 8-8M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11", tab: false }
    ]
  };

  const items = role === "admin" ? navItems.admin : navItems.client;

  const unreadAlerts = alerts.filter((a) => !a.ack);
  const alertsCount = unreadAlerts.length;

  const getBadgeValue = (badgeName?: string) => {
    if (badgeName === "alerts") return alertsCount > 0 ? alertsCount : null;
    if (badgeName === "pendingAlloc") return pendingAllocCount > 0 ? pendingAllocCount : null;
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
    const path = {
      expiry: "M12 8v5l3 2M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z",
      itm: "M4 18l6-6 4 4 6-8M14 8h4v4",
      window: "M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
      price: "M3 17l6-6 4 4 8-8M21 7v6h-6"
    }[a.kind] || "M12 8v5l3 2";

    const colors: Record<string, string> = {
      red: "bg-loss-bg text-loss-d",
      amber: "bg-amber-bg text-amber-d",
      green: "bg-green-bg text-green-d"
    };

    return (
      <div className={`w-8.5 h-8.5 rounded-[9px] flex-none flex items-center justify-center ${colors[col] || "bg-paper-2 text-mut"}`}>
        <svg className="w-4.25 h-4.25 stroke-current stroke-[1.8] fill-none stroke-linecap-round stroke-linejoin-round" viewBox="0 0 24 24">
          <path d={path} />
        </svg>
      </div>
    );
  };

  const sidebar = (
    <aside className="hidden md:flex w-59 flex-none bg-navy text-[#c2c7d8] flex-col p-5 sticky top-0 h-screen z-40 select-none">
      <Link href="/" className="inline-flex items-center gap-2.5 font-disp font-semibold text-xl tracking-wide text-white py-1 px-2 mb-2">
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
      <div className="mx-2 my-1.5 text-[11px] tracking-[0.12em] uppercase font-semibold text-green mb-4">
        {role === "admin" ? "Vitti staff console" : "Client portal"}
      </div>

      <nav className="flex-1 space-y-0.5">
        {items.map((it) => {
          const isActive = pathname === it.path;
          const badgeVal = getBadgeValue(it.badge);
          return (
            <Link
              key={it.k}
              href={it.path}
              className={`flex items-center gap-2.75 w-full text-left font-medium text-[13.5px] px-3 py-2.5 rounded-[9px] cursor-pointer transition-colors ${
                isActive
                  ? "bg-navy-3 text-white"
                  : it.ai
                  ? "text-[#9fe9cf] hover:bg-green/12 hover:text-[#9fe9cf]"
                  : "text-mut-d hover:text-white hover:bg-white/5"
              }`}
            >
              <svg className="w-4.5 h-4.5 stroke-current fill-none stroke-[1.7] stroke-linecap-round stroke-linejoin-round flex-none" viewBox="0 0 24 24">
                <path d={it.icon} />
              </svg>
              <span>{it.label}</span>
              {it.ai && <span className="ml-auto text-[8.5px] font-bold tracking-wider bg-green text-[#08130e] px-1.5 py-0.5 rounded-[5px]">AI</span>}
              {badgeVal !== null && (
                <span className={`ml-auto text-[10.5px] font-bold rounded-full px-2 py-0.5 min-w-4.5 text-center ${it.badge === "pendingAlloc" ? "bg-green text-[#08130e]" : "bg-loss text-white"}`}>
                  {badgeVal}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="mt-auto border-t border-navy-line pt-3.5 space-y-1">
        <div className="flex items-center gap-2.5 py-1.5 px-2">
          <div className="w-8 h-8 rounded-full bg-green text-[#08130e] font-bold text-xs flex items-center justify-center flex-none">
            {role === "admin" ? "SG" : clientAv}
          </div>
          <div className="leading-tight">
            <div className="text-[12.5px] font-semibold text-white truncate max-w-35">{role === "admin" ? "S. Goyal" : clientName}</div>
            <div className="text-[10.5px] text-mut-d truncate max-w-35">{role === "admin" ? "Director · admin" : "Wholesale client"}</div>
          </div>
        </div>
        <button
          onClick={handleSignOut}
          className="flex items-center gap-2 text-xs text-mut-d hover:text-white hover:bg-white/5 p-2 w-full rounded-lg transition-colors cursor-pointer"
        >
          <svg className="w-3.75 h-3.75 stroke-current fill-none stroke-[1.7]" viewBox="0 0 24 24">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
          </svg>
          <span>Sign out</span>
        </button>
      </div>
    </aside>
  );

  const topbar = (
    <header className="flex items-center gap-4 bg-white/85 backdrop-blur-sm border-b border-line px-6 h-14.5 sticky top-0 z-30 select-none">
      <div className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-green-d bg-green-bg py-1.5 px-3.5 rounded-full" title="Broker front-office feed">
        <span className="w-1.5 h-1.5 rounded-full bg-green animate-pulse shadow-[0_0_0_3px_rgba(54,187,145,0.18)]" />
        <span>Broker feed &middot; live</span>
      </div>

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

      {/* Alerts toggle button */}
      <button
        onClick={() => setIsAlertsOpen(true)}
        className="relative flex p-1.5 rounded-[9px] hover:bg-white border border-transparent hover:border-line cursor-pointer text-ink transition-all"
        aria-label="Alerts"
      >
        <svg className="w-4.75 h-4.75 stroke-current fill-none stroke-[1.7] stroke-linecap-round stroke-linejoin-round" viewBox="0 0 24 24">
          <path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        {alertsCount > 0 && (
          <span className="absolute top-0.75 right-0.5 min-w-3.75 h-3.75 px-1 rounded-full bg-loss text-white text-[9px] font-bold flex items-center justify-center border-2 border-paper">
            {alertsCount}
          </span>
        )}
      </button>

      <div className="w-7.75 h-7.75 rounded-full bg-navy text-white font-semibold text-[11px] flex items-center justify-center flex-none">
        {role === "admin" ? "SG" : clientAv}
      </div>
    </header>
  );

  const bottomnav = (
    <nav className="flex md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-line px-1.5 pb-3.5 pt-2 z-20">
      {items.filter(it => it.tab).map(it => {
        const isActive = pathname === it.path;
        const badgeVal = getBadgeValue(it.badge);
        return (
          <button
            key={it.k}
            onClick={() => router.push(it.path)}
            className={`flex-1 flex flex-col items-center gap-0.75 text-[9.5px] font-semibold cursor-pointer relative ${isActive ? "text-green-d" : "text-mut hover:text-ink"}`}
          >
            <svg className="w-5 h-5 stroke-current fill-none stroke-[1.8] stroke-linecap-round stroke-linejoin-round" viewBox="0 0 24 24">
              <path d={it.icon} />
            </svg>
            <span>{it.label}</span>
            {badgeVal !== null && (
              <span className="absolute -top-0.75 right-[50%] -mr-4 bg-loss text-white text-[8.5px] font-bold rounded-full px-1 min-w-3.5 text-center">
                {badgeVal}
              </span>
            )}
          </button>
        );
      })}

      {/* More menu drawer trigger */}
      <button
        onClick={() => setIsMoreOpen(true)}
        className="flex-1 flex flex-col items-center gap-0.75 text-[9.5px] font-semibold cursor-pointer text-mut hover:text-ink"
      >
        <svg className="w-5 h-5 stroke-current fill-none stroke-[1.8] stroke-linecap-round stroke-linejoin-round" viewBox="0 0 24 24">
          <circle cx="5" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="19" cy="12" r="1.6" />
        </svg>
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
            <svg className="w-4.75 h-4.75 stroke-current fill-none stroke-[1.7]" viewBox="0 0 24 24">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
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
              <svg className="w-6 h-6 stroke-current fill-none stroke-[1.7]" viewBox="0 0 24 24">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
          <div className="space-y-1">
            {items.filter(it => !it.tab).map(it => {
              const isActive = pathname === it.path;
              const badgeVal = getBadgeValue(it.badge);
              return (
                <button
                  key={it.k}
                  onClick={() => {
                    setIsMoreOpen(false);
                    router.push(it.path);
                  }}
                  className={`flex items-center gap-3 w-full text-left py-3.5 px-3 rounded-[10px] text-sm font-medium transition-colors hover:bg-paper-2 ${isActive ? "text-green-d bg-paper-2" : "text-ink"}`}
                >
                  <svg className="w-4.75 h-4.75 stroke-current fill-none stroke-[1.7] stroke-linecap-round stroke-linejoin-round" viewBox="0 0 24 24">
                    <path d={it.icon} />
                  </svg>
                  <span>{it.label}</span>
                  {badgeVal !== null && (
                    <span className="ml-auto bg-loss text-white text-[10.5px] font-bold rounded-full px-2 py-0.5 min-w-4.5 text-center">
                      {badgeVal}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );

  return (
    <div className="app-shell flex min-h-screen bg-paper font-body select-none">
      {sidebar}
      <div className="main flex-1 flex flex-col min-w-0 relative pb-16 md:pb-0">
        {topbar}
        <main className="content p-6 flex-1 max-w-300 w-full mx-auto pb-10">
          {children}
        </main>
        {bottomnav}
      </div>

      {alertsDrawer}
      {moreMenuModal}
    </div>
  );
}
