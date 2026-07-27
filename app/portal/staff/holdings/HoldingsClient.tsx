"use client";

import React, { useMemo, useState } from "react";
import type { AccountHoldings, HoldingGroup } from "@/lib/data/holdings";

/**
 * Admin holdings register. Three levels, collapsed by default because the firm
 * view is 36 accounts deep:
 *   account  →  company (parent code)  →  instrument (ordinary / options)
 *
 * The instrument level only renders when a company is held in more than one
 * form, so the common single-line case stays flat.
 */

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const money = (n: number, dp = 0) =>
  (n < 0 ? "-$" : "$") +
  Math.abs(n).toLocaleString("en-AU", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });

const units = (n: number) =>
  n.toLocaleString("en-AU", { maximumFractionDigits: 4 });

const price = (n: number | null) =>
  n === null ? "—" : `$${n.toLocaleString("en-AU", { minimumFractionDigits: 3, maximumFractionDigits: 6 })}`;

const pct = (pl: number, base: number) =>
  base === 0 ? "—" : `${pl >= 0 ? "+" : ""}${((pl / base) * 100).toFixed(1)}%`;

/** Gain/loss colour. Zero is neutral — a flat position is not a win. */
function plClass(n: number): string {
  if (n > 0.005) return "text-gain";
  if (n < -0.005) return "text-loss";
  return "text-mut";
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

function Kpi({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "neutral" | "gain" | "loss";
}) {
  const toneClass =
    tone === "gain" ? "text-gain" : tone === "loss" ? "text-loss" : "text-ink";
  return (
    <div className="bg-white border border-line rounded-[14px] shadow-shadow px-4 py-3">
      <div className="font-mono text-[10px] tracking-wider uppercase text-mut">
        {label}
      </div>
      <div className={`font-mono text-[19px] mt-1 tabular-nums ${toneClass}`}>
        {value}
      </div>
      {sub && <div className="text-[11px] text-mut mt-0.5">{sub}</div>}
    </div>
  );
}

/** Data-quality marker. Deliberately visible: silent bad numbers are worse. */
function Flag({ kind }: { kind: "short" | "partial" | "noprice" }) {
  const map = {
    short: {
      cls: "bg-loss-bg text-loss-d",
      text: "no cost basis",
      title:
        "The ledger sold units it never saw bought — history starts mid-stream. " +
        "Proceeds are counted against zero cost, so realized P&L is overstated " +
        "until an earlier trade export or opening balance is loaded.",
    },
    partial: {
      cls: "bg-amber-bg text-amber-d",
      text: "approx.",
      title:
        "A sale closed part of a parcel that was accumulated at more than one " +
        "price. Valued at weighted-average cost; exact figures need parcel-level " +
        "(FIFO) matching.",
    },
    noprice: {
      cls: "bg-paper-2 text-mut",
      text: "no price",
      title:
        "No market price in the latest holdings snapshot, so this line is " +
        "excluded from market value and unrealized P&L.",
    },
  }[kind];

  return (
    <span
      title={map.title}
      className={`ml-1.5 align-middle rounded-full px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide cursor-help ${map.cls}`}
    >
      {map.text}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Company rollup row (+ instrument breakdown)
// ---------------------------------------------------------------------------

function GroupRows({ group }: { group: HoldingGroup }) {
  const rz = group.realized;
  const multi = group.lines.length > 1;
  const closed = group.lines.length === 0;

  return (
    <>
      <tr className="border-t border-[#f4f2ec] hover:bg-[#faf9f5] transition-colors">
        <td className="pl-10 pr-3 py-2.5">
          <span className="font-mono font-bold text-[12px] text-ink">
            {group.parent}
          </span>
          {closed && (
            <span
              title="Fully exited — realized P&L only, no current holding."
              className="ml-1.5 rounded-full bg-paper-2 px-1.5 py-0.5 text-[9.5px] font-bold uppercase tracking-wide text-mut cursor-help"
            >
              closed
            </span>
          )}
          <div className="text-[11px] text-mut mt-0.5 truncate max-w-[240px]">
            {group.name}
          </div>
        </td>

        <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums text-mut">
          {multi || closed ? "—" : units(group.lines[0].qty)}
        </td>
        <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums text-mut">
          {multi || closed ? "—" : price(group.lines[0].last)}
        </td>
        <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums">
          {money(group.costBase)}
        </td>
        <td className="px-3 py-2.5 text-right font-mono text-[12px] tabular-nums">
          {money(group.marketValue)}
        </td>
        <td
          className={`px-3 py-2.5 text-right font-mono text-[12px] tabular-nums ${plClass(group.unrealizedPl)}`}
        >
          {closed ? "—" : money(group.unrealizedPl)}
          {!closed && (
            <div className="text-[10px] opacity-70">
              {pct(group.unrealizedPl, group.costBase)}
            </div>
          )}
        </td>
        <td
          className={`px-3 py-2.5 text-right font-mono text-[12px] tabular-nums ${rz ? plClass(rz.realizedPl) : "text-mut"}`}
        >
          {rz ? money(rz.realizedPl) : "—"}
          {rz && (
            <div className="text-[10px] text-mut">
              {rz.tradeCount} trade{rz.tradeCount === 1 ? "" : "s"}
              {rz.shortHistory && <Flag kind="short" />}
              {!rz.shortHistory && rz.hasPartial && <Flag kind="partial" />}
            </div>
          )}
        </td>
        <td
          className={`px-4.5 py-2.5 text-right font-mono text-[12px] font-bold tabular-nums ${plClass(group.totalPl)}`}
        >
          {money(group.totalPl)}
        </td>
      </tr>

      {/* Instrument breakdown — only when the company is held in several forms.
          Units are shown per line and never summed: an option and an ordinary
          share are different instruments at different prices. */}
      {multi &&
        group.lines.map((line) => (
          <tr key={line.code} className="bg-[#fcfbf8] text-[11px]">
            <td className="pl-16 pr-3 py-1.5">
              <span className="font-mono text-mut">{line.code}</span>
              <span className="ml-2 text-mut-d">
                {line.securityClass ?? (line.isDerivative ? "Derivative" : "Ordinary")}
              </span>
              {line.last === null && <Flag kind="noprice" />}
            </td>
            <td className="px-3 py-1.5 text-right font-mono tabular-nums text-mut">
              {units(line.qty)}
            </td>
            <td className="px-3 py-1.5 text-right font-mono tabular-nums text-mut">
              {price(line.last)}
            </td>
            <td className="px-3 py-1.5 text-right font-mono tabular-nums text-mut">
              {money(line.costBase)}
            </td>
            <td className="px-3 py-1.5 text-right font-mono tabular-nums text-mut">
              {money(line.marketValue)}
            </td>
            <td
              className={`px-3 py-1.5 text-right font-mono tabular-nums ${plClass(line.unrealizedPl)}`}
            >
              {line.last === null ? "—" : money(line.unrealizedPl)}
            </td>
            <td className="px-3 py-1.5" />
            <td className="px-4.5 py-1.5" />
          </tr>
        ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function HoldingsClient({ accounts }: { accounts: AccountHoldings[] }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [onlyWarnings, setOnlyWarnings] = useState(false);

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return accounts.filter((a) => {
      if (onlyWarnings && !a.hasWarnings) return false;
      if (!q) return true;
      return (
        a.clientName.toLowerCase().includes(q) ||
        a.label.toLowerCase().includes(q) ||
        (a.accountRef ?? "").toLowerCase().includes(q) ||
        (a.adviserName ?? "").toLowerCase().includes(q) ||
        a.groups.some(
          (g) =>
            g.parent.toLowerCase().includes(q) ||
            g.name.toLowerCase().includes(q),
        )
      );
    });
  }, [accounts, query, onlyWarnings]);

  // When searching for a ticker, opening every match saves a lot of clicking.
  const allOpen = filtered.length > 0 && filtered.every((a) => open.has(a.accountId));
  const toggleAll = () =>
    setOpen(allOpen ? new Set() : new Set(filtered.map((a) => a.accountId)));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search client, account number, adviser or ticker…"
          className="flex-1 min-w-[260px] bg-white border border-line rounded-[10px] px-3 py-2 text-xs text-ink placeholder:text-mut-d outline-none focus:border-line-2"
        />
        <button
          onClick={toggleAll}
          className="border border-line bg-white rounded-[10px] px-3 py-2 text-[11px] font-semibold text-mut hover:text-ink hover:border-line-2 transition-colors"
        >
          {allOpen ? "Collapse all" : "Expand all"}
        </button>
        <label className="flex items-center gap-1.5 text-[11px] text-mut select-none cursor-pointer">
          <input
            type="checkbox"
            checked={onlyWarnings}
            onChange={(e) => setOnlyWarnings(e.target.checked)}
            className="accent-[#c98a2b]"
          />
          Only data-quality warnings
        </label>
        <span className="text-[11px] text-mut font-mono">
          {filtered.length}/{accounts.length}
        </span>
      </div>

      <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs font-medium">
            <thead>
              <tr className="border-b border-line text-mut select-none">
                <th className="px-4.5 py-3 font-semibold uppercase tracking-wider text-[10.5px]">
                  Account
                </th>
                <th className="px-3 py-3 font-semibold uppercase tracking-wider text-[10.5px] text-right">
                  Units
                </th>
                <th className="px-3 py-3 font-semibold uppercase tracking-wider text-[10.5px] text-right">
                  Price
                </th>
                <th className="px-3 py-3 font-semibold uppercase tracking-wider text-[10.5px] text-right">
                  Cost base
                </th>
                <th className="px-3 py-3 font-semibold uppercase tracking-wider text-[10.5px] text-right">
                  Market value
                </th>
                <th className="px-3 py-3 font-semibold uppercase tracking-wider text-[10.5px] text-right">
                  Unrealised
                </th>
                <th className="px-3 py-3 font-semibold uppercase tracking-wider text-[10.5px] text-right">
                  Realised
                </th>
                <th className="px-4.5 py-3 font-semibold uppercase tracking-wider text-[10.5px] text-right">
                  Total P&amp;L
                </th>
              </tr>
            </thead>

            <tbody>
              {filtered.map((a) => {
                const isOpen = open.has(a.accountId);
                return (
                  <React.Fragment key={a.accountId}>
                    <tr
                      onClick={() => toggle(a.accountId)}
                      className="border-t border-line hover:bg-[#faf9f5] cursor-pointer transition-colors"
                    >
                      <td className="px-4.5 py-3">
                        <div className="flex items-center gap-2">
                          <span
                            className={`text-mut-d text-[9px] transition-transform ${isOpen ? "rotate-90" : ""}`}
                          >
                            ▶
                          </span>
                          <div>
                            <div className="font-bold text-ink">
                              {a.clientName}
                              {a.hasWarnings && <Flag kind="short" />}
                            </div>
                            <div className="text-[11px] text-mut mt-0.5">
                              <span className="font-mono">{a.accountRef ?? "—"}</span>
                              {a.adviserName && ` · ${a.adviserName}`}
                              {" · "}
                              {a.groups.length} holding
                              {a.groups.length === 1 ? "" : "s"}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3" />
                      <td className="px-3 py-3" />
                      <td className="px-3 py-3 text-right font-mono text-[13px] tabular-nums text-mut">
                        {money(a.costBase)}
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-[13px] tabular-nums font-bold">
                        {money(a.marketValue)}
                      </td>
                      <td
                        className={`px-3 py-3 text-right font-mono text-[13px] tabular-nums ${plClass(a.unrealizedPl)}`}
                      >
                        {money(a.unrealizedPl)}
                        <div className="text-[10px] opacity-70">
                          {pct(a.unrealizedPl, a.costBase)}
                        </div>
                      </td>
                      <td
                        className={`px-3 py-3 text-right font-mono text-[13px] tabular-nums ${plClass(a.realizedPl)}`}
                      >
                        {a.realizedPl === 0 ? "—" : money(a.realizedPl)}
                      </td>
                      <td
                        className={`px-4.5 py-3 text-right font-mono text-[13px] font-bold tabular-nums ${plClass(a.totalPl)}`}
                      >
                        {money(a.totalPl)}
                      </td>
                    </tr>

                    {isOpen &&
                      a.groups.map((g) => (
                        <GroupRows key={`${a.accountId}:${g.parent}`} group={g} />
                      ))}
                  </React.Fragment>
                );
              })}

              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4.5 py-10 text-center text-mut">
                    No accounts match “{query}”.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export { Kpi };
