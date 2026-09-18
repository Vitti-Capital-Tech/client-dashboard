"use client";

import React, { useState } from "react";
import { Clock, TrendingUp, AlertTriangle } from "lucide-react";
import type { AlertRow, ClientRow } from "@/lib/data/queries";
import { addCustomAlert } from "@/app/actions/alerts";
import { useAlertsRead } from "@/app/components/useAlertsRead";
import { TimeAgo } from "@/app/components/TimeAgo";

export function StaffAlertsClient({ alerts, clients }: { alerts: AlertRow[]; clients: ClientRow[] }) {
  const clientMap: Record<string, ClientRow> = {};
  for (const c of clients) clientMap[c.id] = c;

  const [showAddModal, setShowAddModal] = useState(false);

  // Form states
  const [client, setClient] = useState(clients[0]?.id ?? "");
  const [code, setCode] = useState("BHP");
  const [direction, setDirection] = useState<"above" | "below">("above");
  const [targetVal, setTargetVal] = useState("46.00");

  /**
   * Reading this page IS acknowledging these alerts — the Acknowledge button is
   * gone, here and on the bell. The write happens when the desk leaves, so the
   * "new" markers hold still while they are being read. See
   * app/components/useAlertsRead.ts.
   *
   * Staff read state is its own column. A client opening their portal does not
   * clear the desk's queue, and the desk reading an alert does not silence the
   * client's badge — that used to be one shared boolean, and it was wrong in
   * both directions. See the alert-read-state migration.
   */
  useAlertsRead(alerts, true);

  const visibleAlerts = alerts;
  const newAlerts = visibleAlerts.filter(a => !a.read);
  const earlierAlerts = visibleAlerts.filter(a => a.read);

  // Three bands, in the order the desk needs them: act now, new, history.
  // Critical is drawn from the new ones only — a red alert already read and
  // decided about should not keep shouting from the top of the console.
  const critical = newAlerts.filter(a => a.sev === "red");
  const restNew = newAlerts.filter(a => a.sev !== "red");

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

  const renderAlertItem = (a: AlertRow) => {
    const borderColors = {
      red: "border-l-[3px] border-l-loss",
      amber: "border-l-[3px] border-l-amber",
      green: "border-l-[3px] border-l-green"
    };
    const isNew = !a.read;

    const clientBadge = a.clientId ? (
      <span className="w-5.5 h-5.5 rounded-full bg-paper-2 border border-line flex items-center justify-center font-bold text-[9px] text-ink uppercase flex-none select-none">
        {clientMap[a.clientId]?.initials || a.clientId}
      </span>
    ) : null;

    return (
      <div
        key={a.id}
        className={`flex gap-3.5 p-3.5 border border-line bg-white rounded-xl items-start ${isNew ? `shadow-shadow ${borderColors[a.sev] || ""}` : "opacity-70"}`}
      >
        {alertIco(a)}
        <div className="flex-1 min-w-0 space-y-0.5">
          <div className="text-[13px] font-semibold text-ink leading-tight flex items-center gap-1.5 flex-wrap">
            {clientBadge}
            <span>{a.title}</span>
          </div>
          <div className="text-xs text-mut leading-normal">{a.sub}</div>
          <div className="text-[10.5px] text-mut-d mt-2 select-none flex items-center gap-1.5">
            <TimeAgo iso={a.ts} />
            {a.kind === "window" && <span>&middot; unlisted exercise window</span>}
          </div>
        </div>
        {isNew && (
          <span
            aria-label="New"
            className="w-1.75 h-1.75 rounded-full bg-green flex-none self-center"
          />
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
        {/*
          "New" is simply what is unread, straight from the server. It holds
          still while the page is open because the read is written on the way
          out, not on the way in — see app/components/useAlertsRead.ts.
        */}
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">New</div>
          <div className="font-disp font-medium text-2xl mt-1 text-ink">{newAlerts.length}</div>
          <div className={`text-xs mt-1 font-semibold ${newAlerts.length > 0 ? "text-green-d" : "text-mut"}`}>
            {newAlerts.length > 0 ? "since the desk last looked" : "all caught up"}
          </div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Critical (&le;3d / window)</div>
          <div className="font-disp font-medium text-2xl mt-1 text-ink">
            {critical.length}
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
        {/*
          Claimed "In-app + email · manual ack required" and neither half was
          true: there is no mailer in the codebase, and acknowledging is gone —
          opening the bell or this page is what marks an alert read.
        */}
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Delivery</div>
          <div className="font-disp font-medium text-2xl mt-1 text-ink">In-app</div>
          <div className="text-xs text-mut mt-1">read when opened</div>
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

      {/* New (everything below critical) */}
      {restNew.length > 0 && (
        <div className="space-y-2 pt-2">
          <div className="font-mono text-[11px] tracking-wider uppercase text-mut font-semibold">New</div>
          <div className="space-y-3">{restNew.map(renderAlertItem)}</div>
        </div>
      )}

      {/* Earlier */}
      <div className="space-y-2 pt-2">
        {earlierAlerts.length > 0 && (
          <div className="font-mono text-[11px] tracking-wider uppercase text-mut font-semibold">Earlier</div>
        )}
        <div className="space-y-3">
          {visibleAlerts.length === 0 ? (
            <div className="card bg-white border border-line rounded-[14px] p-8 text-center text-mut select-none">
              No alerts. New triggers will appear here and in client portals.
            </div>
          ) : (
            earlierAlerts.map(renderAlertItem)
          )}
        </div>
      </div>

      {/* Custom Price Alert Modal */}
      {showAddModal && (
        <div className="fixed inset-0 bg-navy/55 backdrop-blur-[2px] z-50 flex items-center justify-center p-4.5 overflow-y-auto">
          <form onSubmit={handleAddCustomAlert} className="bg-white rounded-2xl max-w-110 w-full p-6 shadow-shadow-lg text-ink space-y-4 my-auto max-h-[92vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
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
