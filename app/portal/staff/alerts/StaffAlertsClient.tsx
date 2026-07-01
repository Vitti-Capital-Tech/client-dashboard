"use client";

import React, { useState } from "react";
import type { AlertRow, ClientRow } from "@/lib/data/queries";
import { ackAlert, addCustomAlert } from "@/app/actions/alerts";

export function StaffAlertsClient({ alerts, clients }: { alerts: AlertRow[]; clients: ClientRow[] }) {
  const clientMap: Record<string, ClientRow> = {};
  for (const c of clients) clientMap[c.id] = c;

  const [showAddModal, setShowAddModal] = useState(false);

  // Form states
  const [client, setClient] = useState(clients[0]?.id ?? "");
  const [code, setCode] = useState("BHP");
  const [direction, setDirection] = useState<"above" | "below">("above");
  const [targetVal, setTargetVal] = useState("46.00");

  const visibleAlerts = alerts;
  const unackCount = visibleAlerts.filter(a => !a.ack).length;

  const critical = visibleAlerts.filter(a => a.sev === "red" && !a.ack);
  const others = visibleAlerts.filter(a => !(a.sev === "red" && !a.ack));

  const handleAddCustomAlert = async (e: React.FormEvent) => {
    e.preventDefault();
    const threshold = parseFloat(targetVal) || 0;
    if (threshold <= 0) return;

    // Trigger in context state (automatically logs in audit and watchlists)
    await addCustomAlert(client, code.trim().toUpperCase(), threshold, direction);
    setShowAddModal(false);
    alert(`Custom price alert armed for ${code} on client account.`);
  };

  const alertIco = (a: AlertRow) => {
    const map = { expiry: "amber", itm: "green", window: "red", price: a.sev === "amber" ? "amber" : "green" };
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
        <svg className="w-4.25 h-4.25 stroke-current fill-none stroke-[1.8] stroke-linecap-round stroke-linejoin-round" viewBox="0 0 24 24">
          <path d={path} />
        </svg>
      </div>
    );
  };

  const renderAlertItem = (a: AlertRow) => {
    const borderColors = {
      red: "border-l-[3px] border-l-loss",
      amber: "border-l-[3px] border-l-amber",
      green: "border-l-[3px] border-l-green"
    };

    const clientBadge = a.clientId ? (
      <span className="w-5.5 h-5.5 rounded-full bg-paper-2 border border-line flex items-center justify-center font-bold text-[9px] text-ink uppercase flex-none select-none">
        {clientMap[a.clientId]?.initials || a.clientId}
      </span>
    ) : null;

    return (
      <div
        key={a.id}
        className={`flex gap-3.5 p-3.5 border border-line bg-white rounded-xl items-start ${a.ack ? "opacity-70" : `shadow-shadow ${borderColors[a.sev] || ""}`}`}
      >
        {alertIco(a)}
        <div className="flex-1 min-w-0 space-y-0.5">
          <div className="text-[13px] font-semibold text-ink leading-tight flex items-center gap-1.5 flex-wrap">
            {clientBadge}
            <span>{a.title}</span>
          </div>
          <div className="text-xs text-mut leading-normal">{a.sub}</div>
          <div className="text-[9.5px] font-mono text-mut-d mt-2 select-none">
            {new Date(a.ts).toLocaleDateString("en-AU", { day: "numeric", month: "short" })} &middot;{" "}
            {new Date(a.ts).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}
            {a.kind === "window" && " · unlisted exercise window"}
            {a.ack && " · acknowledged"}
          </div>
        </div>
        {!a.ack ? (
          <button
            onClick={() => ackAlert(a.id)}
            className="btn ghost sm text-xs py-1.5 px-3 border border-line bg-white hover:border-green rounded-lg cursor-pointer flex-none self-center font-semibold"
          >
            Acknowledge
          </button>
        ) : (
          <span className="pill bg-paper-2 text-mut text-[10.5px] font-semibold px-2 py-1 rounded-md select-none self-center flex-none">
            Acked
          </span>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-4 text-ink font-body select-none">
      {/* Page Header */}
      <div className="flex justify-between items-end gap-3 flex-wrap">
        <div>
          <div className="font-mono text-xs tracking-wider uppercase text-mut font-semibold">Adviser desk monitor &middot; all client accounts</div>
          <h1 className="font-disp font-medium text-[26px] mt-0.5">Console Alerts</h1>
          <p className="text-xs text-mut mt-1 leading-normal max-w-[50em]">
            Escalating expiry alerts fire at 30, 14, 7, 3 and 1 days. Unlisted in-the-money options inside their window are flagged red.
          </p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="btn bg-navy text-white hover:bg-slate-800 font-semibold py-2 px-4.5 rounded-[10px] text-xs cursor-pointer"
        >
          + Custom price alert
        </button>
      </div>

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Unacknowledged</div>
          <div className="font-disp font-medium text-2xl mt-1 text-ink">{unackCount}</div>
          <div className={`text-xs mt-1 font-semibold ${unackCount > 0 ? "text-loss-d animate-pulse" : "text-mut"}`}>
            {unackCount > 0 ? "requires attention" : "all clear"}
          </div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Critical (&le;3d / window)</div>
          <div className="font-disp font-medium text-2xl mt-1 text-ink">
            {visibleAlerts.filter(a => a.sev === "red" && !a.ack).length}
          </div>
          <div className="text-xs text-mut mt-1">active desk warnings</div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">In the money</div>
          <div className="font-disp font-medium text-2xl mt-1 text-ink">
            {visibleAlerts.filter(a => a.kind === "itm").length}
          </div>
          <div className="text-xs text-mut mt-1">all client registers</div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Delivery</div>
          <div className="font-disp font-medium text-2xl mt-1 text-ink">In-app + email</div>
          <div className="text-xs text-mut mt-1">manual ack required</div>
        </div>
      </div>

      {/* Critical Alerts Block */}
      {critical.length > 0 && (
        <div className="space-y-2">
          <div className="font-mono text-[11px] tracking-wider uppercase text-loss-d font-semibold">Critical — act now</div>
          <div className="space-y-3">
            {critical.map(renderAlertItem)}
          </div>
        </div>
      )}

      {/* All/Other Alerts Block */}
      <div className="space-y-2 pt-2">
        <div className="font-mono text-[11px] tracking-wider uppercase text-mut font-semibold">All alerts</div>
        <div className="space-y-3">
          {others.length === 0 && critical.length === 0 ? (
            <div className="card bg-white border border-line rounded-[14px] p-8 text-center text-mut select-none">
              No alerts. New triggers will appear here and in client portals.
            </div>
          ) : (
            others.map(renderAlertItem)
          )}
        </div>
      </div>

      {/* Custom Price Alert Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-navy/55 backdrop-blur-[2px] z-50 flex items-center justify-center p-4.5">
          <form onSubmit={handleAddCustomAlert} className="bg-white rounded-2xl max-w-110 w-full p-6 shadow-shadow-lg text-ink space-y-4" onClick={e => e.stopPropagation()}>
            <h3 className="font-disp font-medium text-lg text-ink">Create client alert</h3>
            <p className="text-xs text-mut">
              Set custom price triggers for wholesale client portfolios.
            </p>

            <div className="space-y-3">
              <div className="space-y-1">
                <label className="block text-xs font-semibold text-ink">Target Client</label>
                <select
                  value={client}
                  onChange={e => setClient(e.target.value)}
                  className="w-full border border-line-2 bg-white rounded-[9px] px-3 py-2 text-sm focus:border-green focus:outline-none"
                >
                  {clients.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="block text-xs font-semibold text-ink">Stock Code</label>
                  <input
                    type="text"
                    value={code}
                    onChange={e => setCode(e.target.value)}
                    placeholder="e.g. BHP"
                    required
                    className="w-full border border-line-2 bg-white rounded-[9px] px-3 py-2 text-sm focus:border-green focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-xs font-semibold text-ink">Trigger Direction</label>
                  <select
                    value={direction}
                    onChange={e => setDirection(e.target.value as "above" | "below")}
                    className="w-full border border-line-2 bg-white rounded-[9px] px-3 py-2 text-sm focus:border-green focus:outline-none"
                  >
                    <option value="above">rises above</option>
                    <option value="below">falls below</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label className="block text-xs font-semibold text-ink font-mono">Trigger Price ($)</label>
                <input
                  type="text"
                  value={targetVal}
                  onChange={e => setTargetVal(e.target.value)}
                  required
                  className="w-full border border-line-2 bg-white rounded-[9px] px-3.5 py-2 font-mono text-sm focus:border-green focus:outline-none"
                />
              </div>
            </div>

            <div className="flex gap-2.5 pt-2 select-none">
              <button
                type="button"
                onClick={() => setShowAddModal(false)}
                className="btn border border-line rounded-[10px] py-2 px-4 hover:border-mut text-xs font-semibold cursor-pointer flex-1 bg-white"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn bg-green text-[#08130e] hover:shadow-lg rounded-[10px] py-2 px-4 text-xs font-semibold cursor-pointer flex-1.5"
              >
                Arm alert
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
