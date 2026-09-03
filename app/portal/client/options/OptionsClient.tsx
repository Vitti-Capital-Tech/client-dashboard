"use client";

import { useMemo, useState } from "react";
import type { OptionTableItem } from "@/lib/options/from-stored-pnl";
import { MoneynessBadge, StrikeSpot } from "@/app/components/MoneynessBadge";
import { TablePagination } from "@/app/components/TablePagination";

/**
 * The client's options register — the same table the desk reads.
 *
 * ── Why it is the same table ────────────────────────────────────────────────
 * It used to be a different one: its own columns, its own card view, and its own
 * idea of what a row was. That is how the two screens came to disagree about
 * whether a client held any options at all (see `lib/options/from-stored-pnl.ts`
 * — the client tab read a table nothing writes). Sharing the derivation fixed
 * the data; sharing the columns is what stops the next divergence, because a
 * client and their adviser now point at the same numbers in the same order.
 *
 * The one column dropped is **Account** — every row here is this client's, so a
 * column repeating that says nothing. The desk's account switcher goes with it.
 */

const money2 = (n: number) =>
  n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money4 = (n: number) =>
  n.toLocaleString("en-AU", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const fmtQty = (n: number) => Math.round(n).toLocaleString("en-AU");

type FilterTab = "all" | "listed" | "unlisted" | "itm" | "gain" | "loss";

const TABS: { key: FilterTab; label: string }[] = [
  { key: "all", label: "All options" },
  { key: "listed", label: "Listed" },
  { key: "unlisted", label: "Unlisted" },
  { key: "itm", label: "In the money" },
  { key: "gain", label: "Gain" },
  { key: "loss", label: "Loss" },
];

function matchesTab(o: OptionTableItem, tab: FilterTab): boolean {
  switch (tab) {
    case "listed":
      return o.isListed;
    case "unlisted":
      return o.isUnlisted;
    case "itm":
      return o.money.isItm;
    case "gain":
      return o.pnl > 0;
    case "loss":
      return o.pnl < 0;
    default:
      return true;
  }
}

export function OptionsClient({ options }: { options: OptionTableItem[] }) {
  const [tab, setTab] = useState<FilterTab>("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const counts = useMemo(
    () =>
      TABS.reduce<Record<FilterTab, number>>(
        (acc, t) => {
          acc[t.key] = options.filter((o) => matchesTab(o, t.key)).length;
          return acc;
        },
        { all: 0, listed: 0, unlisted: 0, itm: 0, gain: 0, loss: 0 },
      ),
    [options],
  );

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return options.filter(
      (o) =>
        matchesTab(o, tab) &&
        (!q ||
          o.ticker.toLowerCase().includes(q) ||
          o.company.toLowerCase().includes(q) ||
          (o.parentTicker ?? "").toLowerCase().includes(q)),
    );
  }, [options, tab, search]);

  /** Totals are for what is ON SCREEN after filtering — the header says so. */
  const totals = useMemo(
    () =>
      rows.reduce(
        (t, o) => ({
          qty: t.qty + o.quantity,
          intrinsic: t.intrinsic + (o.money.moneyness === "unknown" ? 0 : o.money.intrinsicValue),
          val: t.val + o.marketValue,
          pnl: t.pnl + o.pnl,
        }),
        { qty: 0, intrinsic: 0, val: 0, pnl: 0 },
      ),
    [rows],
  );

  const listedCount = counts.listed;
  const unlistedCount = counts.unlisted;
  const totalValue = useMemo(() => options.reduce((s, o) => s + o.marketValue, 0), [options]);
  const totalPnl = useMemo(() => options.reduce((s, o) => s + o.pnl, 0), [options]);

  const paged = rows.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div>
        <div className="font-mono text-xs tracking-wider uppercase text-mut">
          Listed &amp; unlisted
        </div>
        <h1 className="font-disp font-medium text-[26px] mt-0.5 text-ink">Options</h1>
        <p className="text-xs text-mut mt-1 max-w-[52em] leading-normal">
          Every option series on your register, across your accounts. Unlisted grants
          are not auto-exercised — watch the expiry window.
        </p>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] font-medium text-mut uppercase tracking-wider">
            Total options value
          </div>
          <div className="font-disp font-medium text-2xl mt-1 text-ink">
            ${money2(totalValue)}
          </div>
          <div className="text-xs text-mut mt-1">{options.length} series</div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] font-medium text-mut uppercase tracking-wider">
            Unrealised P&amp;L
          </div>
          <div
            className={`font-disp font-medium text-2xl mt-1 ${totalPnl >= 0 ? "text-gain" : "text-loss-d"}`}
          >
            {totalPnl < 0 ? "-" : "+"}${money2(Math.abs(totalPnl))}
          </div>
          <div className="text-xs text-mut mt-1">across all series</div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] font-medium text-mut uppercase tracking-wider">
            Listed options
          </div>
          <div className="font-disp font-medium text-2xl mt-1 text-ink">{listedCount}</div>
          <div className="text-xs text-mut mt-1">quoted on ASX</div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] font-medium text-mut uppercase tracking-wider">
            Unlisted options
          </div>
          <div className="font-disp font-medium text-2xl mt-1 text-ink">{unlistedCount}</div>
          <div className="text-xs text-mut mt-1">placement grants</div>
        </div>
      </div>

      {/* Filters + search */}
      <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4.5 py-3.5 border-b border-line">
          <div className="flex flex-wrap gap-1.5">
            {TABS.map((t) => (
              <button
                key={t.key}
                onClick={() => {
                  setTab(t.key);
                  setPage(1);
                }}
                className={`text-xs font-semibold px-3 py-1.5 rounded-full cursor-pointer transition-colors ${
                  tab === t.key
                    ? "bg-navy text-white"
                    : "bg-paper-2 text-mut hover:text-ink"
                }`}
              >
                {t.label}
                <span className="ml-1.5 font-mono opacity-70">{counts[t.key]}</span>
              </button>
            ))}
          </div>

          <input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search series or company"
            aria-label="Search options"
            className="w-52 border border-line-2 bg-white rounded-[9px] px-3 py-2 text-xs focus:border-green focus:outline-none transition-colors"
          />
        </div>

        {/* The desk's own columns, minus Account. */}
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-line text-mut select-none bg-paper/40 font-medium">
                <th className="px-4 py-2.5 whitespace-nowrap">Series</th>
                <th className="px-4 py-2.5">Company / Description</th>
                <th className="px-4 py-2.5 whitespace-nowrap">Type</th>
                <th
                  className="px-4 py-2.5 text-right whitespace-nowrap"
                  title="Options held — the count the exercise value is struck on"
                >
                  Quantity
                </th>
                <th
                  className="px-4 py-2.5 whitespace-nowrap"
                  title="Exercise price → underlying price. Unlisted grants only — a listed series trades on its own market."
                >
                  Strike &rarr; Spot
                </th>
                <th
                  className="px-4 py-2.5 text-right whitespace-nowrap"
                  title="Qty × (Spot − Strike), floored at zero. Unlisted grants only."
                >
                  Exercise Value
                </th>
                <th className="px-4 py-2.5 text-right whitespace-nowrap">Current Value</th>
                <th className="px-4 py-2.5 text-right whitespace-nowrap">Unreal. P&amp;L</th>
                <th className="px-4 py-2.5 whitespace-nowrap">Terms / Valuation Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line/60">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="text-center text-mut py-12">
                    {search.trim() || tab !== "all"
                      ? "Nothing matches that filter."
                      : "There are no option series on your register yet."}
                  </td>
                </tr>
              ) : (
                <>
                  {paged.map((o) => {
                    const isUp = o.pnl >= 0;
                    return (
                      <tr key={o.id} className="hover:bg-paper/40">
                        {/* Series / Ticker */}
                        <td className="px-4 py-3 whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono px-1.5 py-0.5 rounded bg-paper-2 border border-line/60 font-bold text-ink text-[11.5px]">
                              {o.ticker}
                            </span>
                            {o.parentTicker && o.parentTicker !== o.ticker && (
                              <span className="text-[10px] font-mono text-mut">
                                &rarr; {o.parentTicker}
                              </span>
                            )}
                          </div>
                        </td>

                        {/* Company / Description */}
                        <td className="px-4 py-3">
                          <div className="font-medium text-ink truncate max-w-xs" title={o.company}>
                            {o.company}
                          </div>
                        </td>

                        {/* Type + moneyness */}
                        <td className="px-4 py-3 whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`text-[10.5px] font-semibold rounded-full px-2.5 py-0.5 inline-block ${
                                o.isUnlisted
                                  ? "bg-[#ece9f3] text-[#5c5775] border border-[#d8d3e5]"
                                  : "bg-paper-2 text-ink border border-line/60"
                              }`}
                            >
                              {o.isUnlisted ? "Unlisted Option" : "Listed Option"}
                            </span>
                            <MoneynessBadge
                              money={o.money}
                              title={
                                o.money.isItm
                                  ? `In the money by $${money4(o.money.intrinsicPerOption)} per option`
                                  : undefined
                              }
                            />
                          </div>
                        </td>

                        {/* Quantity */}
                        <td className="px-4 py-3 text-right font-mono text-ink whitespace-nowrap font-medium">
                          {o.quantity > 0 ? fmtQty(o.quantity) : "—"}
                        </td>

                        {/* Strike against spot — what the badge is a verdict on */}
                        <td className="px-4 py-3 whitespace-nowrap">
                          <StrikeSpot strike={o.strike} spot={o.underlyingPrice} money4={money4} />
                        </td>

                        {/* Exercise value */}
                        <td
                          className={`px-4 py-3 text-right font-mono whitespace-nowrap ${
                            o.money.isItm ? "text-gain font-semibold" : "text-mut"
                          }`}
                          title={
                            o.money.moneyness === "unknown"
                              ? o.isUnlisted
                                ? "No strike on record for this grant"
                                : "Listed series — marked to its own market, see Current Value"
                              : `${fmtQty(o.quantity)} × $${money4(o.money.intrinsicPerOption)}`
                          }
                        >
                          {o.money.moneyness === "unknown"
                            ? "—"
                            : `$${money2(o.money.intrinsicValue)}`}
                        </td>

                        {/* Current Value */}
                        <td className="px-4 py-3 text-right font-mono font-semibold text-ink whitespace-nowrap">
                          ${money2(o.marketValue)}
                        </td>

                        {/* Unrealised P&L */}
                        <td
                          className={`px-4 py-3 text-right font-mono font-semibold whitespace-nowrap ${
                            isUp ? "text-gain" : "text-loss-d"
                          }`}
                        >
                          {o.pnl < 0 ? "-" : "+"}${money2(Math.abs(o.pnl))}
                        </td>

                        {/* Terms & Valuation Notes */}
                        <td
                          className="px-4 py-3 text-mut text-[11px] font-mono max-w-sm truncate"
                          title={o.termsNote || o.company}
                        >
                          {o.termsNote || o.pricingMethod || "—"}
                        </td>
                      </tr>
                    );
                  })}

                  {/* Total for the current filter, not the page — a footer that
                      changed every time you paged would be a different number
                      each look. */}
                  <tr className="border-t-2 border-line bg-paper/60 font-semibold select-none">
                    <td className="px-4 py-3" colSpan={3}>
                      Total ({rows.length})
                    </td>
                    <td className="px-4 py-3 text-right font-mono">{fmtQty(totals.qty)}</td>
                    <td className="px-4 py-3" />
                    <td className="px-4 py-3 text-right font-mono text-gain">
                      ${money2(totals.intrinsic)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-ink">
                      ${money2(totals.val)}
                    </td>
                    <td
                      className={`px-4 py-3 text-right font-mono ${
                        totals.pnl >= 0 ? "text-gain" : "text-loss-d"
                      }`}
                    >
                      {totals.pnl < 0 ? "-" : "+"}${money2(Math.abs(totals.pnl))}
                    </td>
                    <td className="px-4 py-3" />
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>

        <TablePagination
          totalItems={rows.length}
          currentPage={page}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={(size) => {
            setPageSize(size);
            setPage(1);
          }}
          pageSizeOptions={[10, 25, 50, 100, 1000]}
          itemLabel="series"
        />
      </div>

      <p className="text-xs text-mut bg-paper-2 rounded-[9px] p-3 leading-relaxed">
        Unlisted grants are valued by the desk — at exercise value where they are in
        the money, and with a Black-Scholes model otherwise. The Terms column names
        which applied. To lodge an exercise instruction, speak to your adviser.
      </p>
    </div>
  );
}
