"use client";

import React, { useState } from "react";
import { Clock, TrendingUp, AlertTriangle } from "lucide-react";
import type { AlertRow } from "@/lib/data/queries";
import { addCustomAlert } from "@/app/actions/alerts";
import { useAlertsRead } from "@/app/components/useAlertsRead";
import { TimeAgo } from "@/app/components/TimeAgo";
import { GlossaryStrip } from "@/app/components/GlossaryStrip";
import { priceText } from "@/lib/ui/price";

export function AlertsClient({
  alerts,
  clientId,
}: {
  alerts: AlertRow[];
  clientId: string;
}) {
  const [showAddModal, setShowAddModal] = useState(false);

  // Form states
  const [code, setCode] = useState("BHP");
  const [direction, setDirection] = useState<"above" | "below">("above");
  const [targetVal, setTargetVal] = useState("46.00");

  /**
   * Reading this page IS acknowledging these alerts — there is no Acknowledge
   * button any more, here or on the bell. The write happens when you leave, so
   * the "new" markers hold still while you are reading them. See
   * app/components/useAlertsRead.ts.
   *
   * `active` is `true` rather than a piece of state: a page is open by virtue of
   * having been navigated to, and closed by virtue of being navigated away from.
   */
  useAlertsRead(alerts, true);

  const visibleAlerts = alerts;
  const newAlerts = visibleAlerts.filter(a => !a.read);
  const earlierAlerts = visibleAlerts.filter(a => a.read);

  // Three bands, in the order they need reading: act now, new, history.
  // Critical is drawn from the new ones only — a red alert you have already
  // read and decided about should not keep shouting from the top of the page.
  const critical = newAlerts.filter(a => a.sev === "red");
  const restNew = newAlerts.filter(a => a.sev !== "red");

  const handleAddCustomAlert = async (e: React.FormEvent) => {
    e.preventDefault();
    const threshold = parseFloat(targetVal) || 0;
    if (threshold <= 0) return;

    await addCustomAlert(clientId, code.trim().toUpperCase(), threshold, direction);
    setShowAddModal(false);
    alert(`Custom price alert armed for ${code} at ${priceText(threshold)}.`);
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

    return (
      <div
        key={a.id}
        className={`flex gap-3.5 p-3.5 border border-line bg-white rounded-xl items-start ${isNew ? `shadow-shadow ${borderColors[a.sev] || ""}` : "opacity-70"}`}
      >
        {alertIco(a)}
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-ink leading-tight">
            {a.title}
          </div>
          <div className="text-xs text-mut mt-0.5 leading-normal">{a.sub}</div>
          <div className="text-[10.5px] text-mut-d mt-2 flex items-center gap-1.5">
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
          {/*
            This copy used to promise two things the product did not do. Email
            was one — there is no mailer in the codebase, on this path or any
            other — and it is gone rather than hedged. The expiry escalation was
            the other, and that one is now true: `lib/alerts/scan.ts` runs it,
            so the sentence stays. Do not put "email" back until something sends
            one.
          */}
          <div className="font-mono text-xs tracking-wider uppercase text-mut">In-platform &middot; read when you open them</div>
          <h1 className="font-disp font-medium text-[26px] mt-0.5">Alerts</h1>
          <p className="text-xs text-mut mt-1 leading-normal max-w-[50em]">
            Expiry alerts escalate at 30, 14, 7, 3 and 1 days. Unlisted options that are
            in the money inside their exercise window are flagged red — those are not
            exercised automatically. Checked each morning after the market opens.
          </p>
        </div>
        <button
          onClick={() => setShowAddModal(true)}
          className="btn bg-navy text-white hover:bg-slate-800 font-semibold py-2 px-4.5 rounded-[10px] text-xs cursor-pointer"
        >
          + Custom price alert
        </button>
      </div>

      <GlossaryStrip />

      {/* KPI Cards Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {/*
          "New" is simply what is unread, straight from the server. It holds
          still while the page is open because the read is written on the way
          out, not on the way in — see app/components/useAlertsRead.ts.
        */}
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">New</div>
          <div className="font-disp font-medium text-lg sm:text-2xl tabular-nums mt-1 text-ink">{newAlerts.length}</div>
          <div className={`text-xs mt-1 font-semibold ${newAlerts.length > 0 ? "text-green-d" : "text-mut"}`}>
            {newAlerts.length > 0 ? "since you last looked" : "all caught up"}
          </div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Critical (&le;3d / window)</div>
          <div className="font-disp font-medium text-lg sm:text-2xl tabular-nums mt-1 text-ink">
            {critical.length}
          </div>
          <div className="text-xs text-mut mt-1">requires action</div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">In the money</div>
          <div className="font-disp font-medium text-lg sm:text-2xl tabular-nums mt-1 text-ink">
            {visibleAlerts.filter(a => a.kind === "itm").length}
          </div>
          <div className="text-xs text-mut mt-1">option thresholds</div>
        </div>
        {/*
          This card claimed "In-app + email · manual ack required" and neither
          half was true. There is no mailer in the codebase — the header copy
          above already had "email" struck out for exactly that reason and this
          card was missed — and acknowledging is gone: opening the bell or this
          page is what marks an alert read.
        */}
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Delivery</div>
          <div className="font-disp font-medium text-lg sm:text-2xl tabular-nums mt-1 text-ink">In-app</div>
          <div className="text-xs text-mut mt-1">read when you open them</div>
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
              {/* Said "and in your email". Nothing sends one — see the Delivery card. */}
              No alerts yet. Expiry windows, in-the-money options and your own price
              triggers all land here.
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
            <h3 className="font-disp font-medium text-lg text-ink">Create price alert</h3>
            <p className="text-xs text-mut">
              Set custom price triggers for your watched stocks.
            </p>

            <div className="space-y-3">
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
