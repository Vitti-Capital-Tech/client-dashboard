"use client";

import { useMemo, useState } from "react";
import type {
  Position,
  SignalRow,
  SecurityCommentaryRow,
} from "@/lib/data/queries";
import {
  posValue,
  posCost,
  posPL,
  realizedBetween,
  monthsBack,
} from "@/lib/data/compute";
import type { SellAttribution } from "@/lib/import/trades";
import type { ClientPortfolio } from "@/lib/pnl/client-portfolio";
import { sectorMix, type SectorScope } from "@/lib/pnl/sector-mix";
import { TablePagination } from "@/app/components/TablePagination";

const money0 = (n: number) => `$${Math.round(n).toLocaleString("en-AU")}`;
const qty0 = (n: number) => (n ? Math.round(n).toLocaleString("en-AU") : "—");

/**
 * A return as a percentage of cost, or null when there is no cost to divide by.
 *
 * Free placement options have a cost base of zero, so `pl / cost` was `Infinity`
 * — and `0 / 0` was `NaN`. Both reached the screen: the Top movers table read
 * `+Infinity%` on three rows and `+NaN%` on a fourth, and because it SORTED by
 * that percentage the infinities took every top slot, so the one thing the table
 * exists to show was pushed off it entirely.
 */
const returnPct = (pl: number, cost: number): number | null =>
  cost > 0 && Number.isFinite(pl / cost) ? (pl / cost) * 100 : null;

const pct1 = (n: number | null) => (n === null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`);

/**
 * Reusable donut / pie.
 *
 * `thick = size / 2` takes the inner radius to zero, so the same component
 * draws both and the cards on a row stay visually of a piece.
 *
 * `onHover` is optional. Where it is given, each slice becomes focusable and
 * reports itself on pointer AND on keyboard focus — a chart whose figures are
 * only reachable with a mouse simply has no figures for anyone using a
 * keyboard, and on a touch screen "hover" never happens at all, which is why
 * the caller also renders the same numbers in the legend.
 */
const DonutChart = ({
  segs,
  size = 128,
  thick = 18,
  onHover,
  activeLabel,
}: {
  segs: { label: string; v: number; col: string }[];
  size?: number;
  thick?: number;
  onHover?: (label: string | null) => void;
  activeLabel?: string | null;
}) => {
  const r = (size - thick) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const C = 2 * Math.PI * r;
  const total = segs.reduce((sum, s) => sum + s.v, 0);
  const segsWithOffsets = segs.map((s, idx) => {
    const frac = total ? s.v / total : 0;
    const len = frac * C;
    const offset = segs.slice(0, idx).reduce((sum, prev) => {
      const prevFrac = total ? prev.v / total : 0;
      return sum + prevFrac * C;
    }, 0);
    return { ...s, len, offset };
  });

  const interactive = Boolean(onHover);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      onMouseLeave={onHover ? () => onHover(null) : undefined}
      role={interactive ? "group" : undefined}
    >
      {segsWithOffsets.map((s, idx) => {
        const dimmed = interactive && activeLabel !== null && activeLabel !== s.label;
        return (
          <circle
            key={idx}
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={s.col}
            strokeWidth={thick}
            strokeDasharray={`${s.len} ${C - s.len}`}
            strokeDashoffset={-s.offset}
            transform={`rotate(-90 ${cx} ${cy})`}
            opacity={dimmed ? 0.32 : 1}
            style={
              interactive
                ? { cursor: "pointer", transition: "opacity 120ms" }
                : undefined
            }
            tabIndex={interactive ? 0 : undefined}
            onMouseEnter={onHover ? () => onHover(s.label) : undefined}
            onFocus={onHover ? () => onHover(s.label) : undefined}
            onBlur={onHover ? () => onHover(null) : undefined}
          >
            {/* A native tooltip as the floor: it works before any JS runs and
                on platforms where the hover state never fires. */}
            {interactive && <title>{s.label}</title>}
          </circle>
        );
      })}
    </svg>
  );
};

/**
 * Slice colours. Ordered so the first few are the most distinguishable from one
 * another, since most portfolios only fill three or four sectors.
 */
const palette = ["#1d202f", "#36bb91", "#c98a2b", "#5c5775", "#1f8e6b", "#9aa0b4", "#b8543f", "#4a7fb5"];

/** The presets, in the order they read: shortest window first. */
const RANGE_PRESETS: { label: string; months: number }[] = [
  { label: "3M", months: 3 },
  { label: "6M", months: 6 },
  { label: "1Y", months: 12 },
  { label: "3Y", months: 36 },
];

export function PositionsClient({
  positions,
  cash,
  unlisted,
  signals,
  portfolio,
  sells,
  sectorByTicker,
  commentary,
}: {
  positions: Position[];
  cash: number;
  unlisted: number;
  signals: Record<string, SignalRow>;
  /** The desk's own stored figures — see lib/pnl/client-portfolio.ts. */
  portfolio: ClientPortfolio;
  /**
   * Every sale, with the date its money was realised on, replayed on the server
   * through the importer's own cost-basis walk. What the date range is taken
   * over.
   */
  sells: SellAttribution[];
  /**
   * Ticker → sector, with a derivative already resolved to its ordinary's
   * sector by the caller. Passed in because the lookup needs `securities`,
   * which is server-only, and the chart re-buckets in the browser as its scope
   * toggles.
   */
  sectorByTicker: Record<string, string | null>;
  /**
   * This week's note per security, in both framings. Which one a holder is
   * shown depends on the sign of their own P&L on that holding — the note is
   * one market read, not two opinions.
   */
  commentary: Record<string, SecurityCommentaryRow>;
}) {
  const [tab, setTab] = useState<"holdings" | "pnl" | "analytics">("holdings");
  const [selectedHolding, setSelectedHolding] = useState<string | null>(null);

  // Search + paging per table. A client with a long history has hundreds of P&L
  // lines — one tested account has 334 — and scrolling is not a way to find a
  // ticker in that.
  const [holdSearch, setHoldSearch] = useState("");
  const [holdPage, setHoldPage] = useState(1);
  const [holdSize, setHoldSize] = useState(25);
  const [pnlSearch, setPnlSearch] = useState("");
  const [pnlPage, setPnlPage] = useState(1);
  const [pnlSize, setPnlSize] = useState(25);

  /**
   * The realised-P&L window.
   *
   * `to` defaults to the last day anything was actually sold rather than to
   * today. An account whose last sale was in June would otherwise open on a
   * range ending today, and every preset inside it would read $0 — a screen
   * that looks broken to the one client it matters most to. Where there are no
   * sales at all the card says so instead of drawing a picker over nothing.
   */
  const lastSaleDate = useMemo(
    () => sells.reduce((latest, s) => (s.tradeDate > latest ? s.tradeDate : latest), ""),
    [sells],
  );
  const firstSaleDate = useMemo(
    () =>
      sells.reduce(
        (earliest, s) => (!earliest || s.tradeDate < earliest ? s.tradeDate : earliest),
        "",
      ),
    [sells],
  );

  const defaultRange = useMemo(
    () => (lastSaleDate ? monthsBack(lastSaleDate, 12) : { from: "", to: "" }),
    [lastSaleDate],
  );
  const [rangeFrom, setRangeFrom] = useState(defaultRange.from);
  const [rangeTo, setRangeTo] = useState(defaultRange.to);

  const deltaByTicker = useMemo(
    () => new Map(portfolio.overrideDeltas),
    [portfolio.overrideDeltas],
  );
  const window_ = useMemo(
    () =>
      rangeFrom && rangeTo
        ? realizedBetween(sells, rangeFrom, rangeTo, deltaByTicker)
        : null,
    [sells, rangeFrom, rangeTo, deltaByTicker],
  );

  /** Which preset, if any, the current range corresponds to — for the pills. */
  const activePreset = useMemo(() => {
    if (!lastSaleDate || rangeTo !== lastSaleDate) return null;
    return (
      RANGE_PRESETS.find((p) => monthsBack(lastSaleDate, p.months).from === rangeFrom)
        ?.label ?? null
    );
  }, [lastSaleDate, rangeFrom, rangeTo]);

  const applyPreset = (months: number) => {
    if (!lastSaleDate) return;
    const { from, to } = monthsBack(lastSaleDate, months);
    setRangeFrom(from);
    setRangeTo(to);
  };

  const applyAllTime = () => {
    if (!firstSaleDate || !lastSaleDate) return;
    setRangeFrom(firstSaleDate);
    setRangeTo(lastSaleDate);
  };

  // ── Sector chart: which holdings, and which slice is being pointed at ──────
  const [sectorScope, setSectorScope] = useState<SectorScope>("held");
  const [hoveredSector, setHoveredSector] = useState<string | null>(null);

  /**
   * Today's market value for a still-held row, by ticker.
   *
   * The P&L rows are the source of truth for cost and result, but they carry no
   * live price; `positions` does. Summed rather than looked up, because a client
   * can hold the same security in more than one account and the P&L rows are
   * already rolled up across them.
   */
  const marketValueByTicker = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of positions) {
      map.set(p.code, (map.get(p.code) ?? 0) + posValue(p));
    }
    return map;
  }, [positions]);

  const mix = useMemo(
    () =>
      sectorMix(
        portfolio.rows,
        sectorScope,
        (ticker) => sectorByTicker[ticker] ?? null,
        (ticker) => marketValueByTicker.get(ticker) ?? null,
      ),
    [portfolio.rows, sectorScope, sectorByTicker, marketValueByTicker],
  );

  const sectorSegs = useMemo(
    () =>
      mix.buckets.map((b, i) => ({
        label: b.label,
        v: b.value,
        col: palette[i % palette.length],
      })),
    [mix.buckets],
  );

  /** The slice being pointed at, or the whole mix when nothing is. */
  const focusedBucket = hoveredSector
    ? mix.buckets.find((b) => b.label === hoveredSector) ?? null
    : null;

  // Custom states for trade execution inside modal
  const [isTradeModalOpen, setIsTradeModalOpen] = useState(false);
  const [tradeAction, setTradeAction] = useState<"Buy" | "Sell">("Buy");
  const [tradeAmount, setTradeAmount] = useState("10,000");

  // Market value of what is held right now. Cost base and P&L deliberately do
  // NOT come from here any more — see below.
  let tv = 0;
  positions.forEach(p => {
    tv += posValue(p);
  });

  // The desk's stored figures. Cost base and P&L come from here rather than from
  // `tv` above, so this page and the adviser's screen cannot report different
  // returns on the same holdings.
  const deskCost = portfolio.total.buyPrice;
  const deskPnl = portfolio.total.pnl;
  const deskPnlPct = deskCost > 0 ? (deskPnl / deskCost) * 100 : 0;

  const handleOpenHolding = (code: string) => {
    setSelectedHolding(code);
  };

  const handleCloseHolding = () => {
    setSelectedHolding(null);
  };

  const getActionPill = (action: string) => {
    const maps: Record<string, string> = {
      Add: "bg-green-bg text-green-d",
      Hold: "bg-paper-2 text-mut",
      Trim: "bg-amber-bg text-amber-d",
      "Take profit": "bg-amber-bg text-amber-d",
      Watch: "bg-[#ece9f3] text-[#5c5775]"
    };
    return (
      <span className={`pill px-2.5 py-0.5 rounded-full text-[11.5px] font-semibold tracking-wide ${maps[action] || "bg-paper-2 text-mut"}`}>
        {action}
      </span>
    );
  };

  // Run calculation for trade amount
  const tradeCalculatedShares = () => {
    const raw = tradeAmount.replace(/[^0-9]/g, "");
    const amt = raw ? parseInt(raw, 10) : 0;
    const p = positions.find(pos => pos.code === selectedHolding);
    if (!p || !p.last) return 0;
    return Math.round(amt / p.last);
  };

  const executeTradeOrder = () => {
    const p = positions.find(pos => pos.code === selectedHolding);
    if (!p) return;
    const raw = tradeAmount.replace(/[^0-9]/g, "");
    const amt = raw ? parseInt(raw, 10) : 0;
    if (!amt) return;

    // Simulate ordering (in reality we would mutate the DB, but since we are doing standard controlled simulation we can alert and log)
    alert(`Order placed: ${tradeAction === "Buy" ? "Buy" : "Sell"} ${tradeAction === "Buy" ? "$" : ""}${amt.toLocaleString("en-AU")} of ${selectedHolding} routed to the Vitti desk.`);

    setIsTradeModalOpen(false);
    handleCloseHolding();
  };

  // Render analytics view
  /**
   * The desk's own P&L table, for this client.
   *
   * Same rows, same rollup and same corrections as the staff console — see
   * lib/pnl/client-portfolio.ts — minus the desk's working notes. Sorted by
   * absolute P&L so the positions that moved the total are at the top, which is
   * the order somebody reads their own return in.
   */
  const holdingRows = useMemo(() => {
    const q = holdSearch.trim().toLowerCase();
    if (!q) return positions;
    return positions.filter(
      (p) =>
        p.code.toLowerCase().includes(q) || (p.name ?? "").toLowerCase().includes(q),
    );
  }, [positions, holdSearch]);

  const pnlRows = useMemo(() => {
    const q = pnlSearch.trim().toLowerCase();
    return [...portfolio.rows]
      .filter(
        (r) =>
          !q || r.ticker.toLowerCase().includes(q) || r.name.toLowerCase().includes(q),
      )
      .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl));
  }, [portfolio.rows, pnlSearch]);

  /**
   * Realised P&L over a date range.
   *
   * Captioned as REALISED throughout, and never as "your return over this
   * period". A date range can only describe money that actually changed hands:
   * unrealised P&L is a cost base against today's price, it belongs to no date,
   * and there is no price history here to value a holding as at an earlier one.
   * Labelling this as a period return would be the wrong number with no way for
   * the client to tell.
   */
  const renderRealisedWindow = () => {
    if (!lastSaleDate || !window_) {
      return (
        <div className="card bg-white border border-line rounded-[14px] shadow-shadow p-5">
          <b className="text-sm font-semibold text-ink">Realised over a period</b>
          <p className="text-xs text-mut mt-1.5 leading-relaxed">
            Nothing has been sold from your accounts yet, so there is no realised profit to
            show over a period. The table below covers everything you hold.
          </p>
        </div>
      );
    }

    const pl = window_.realizedPl;
    // A return needs something to divide by. Cost of what was sold is the right
    // denominator for realised P&L — not the portfolio's value, which includes
    // everything that was never sold in the window.
    const pct =
      window_.costOfSold > 0 && Number.isFinite(pl / window_.costOfSold)
        ? (pl / window_.costOfSold) * 100
        : null;

    const dateStr = (iso: string) =>
      new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-AU", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      });

    return (
      <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
        <div className="px-4.5 py-4 border-b border-line flex flex-wrap justify-between items-start gap-3">
          <div className="select-none">
            <b className="text-ink text-sm font-semibold">Realised over a period</b>
            <p className="text-xs text-mut mt-0.5 leading-normal">
              Profit on what was <b>sold</b> between these dates. Holdings you still own are
              not in this figure.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {RANGE_PRESETS.map((p) => (
              <button
                key={p.label}
                onClick={() => applyPreset(p.months)}
                className={`text-[11.5px] font-semibold px-2.5 py-1.5 rounded-[7px] cursor-pointer transition-colors ${
                  activePreset === p.label
                    ? "bg-navy text-white"
                    : "bg-paper-2 text-mut hover:text-ink"
                }`}
              >
                {p.label}
              </button>
            ))}
            <button
              onClick={applyAllTime}
              className={`text-[11.5px] font-semibold px-2.5 py-1.5 rounded-[7px] cursor-pointer transition-colors ${
                rangeFrom === firstSaleDate && rangeTo === lastSaleDate
                  ? "bg-navy text-white"
                  : "bg-paper-2 text-mut hover:text-ink"
              }`}
            >
              All
            </button>
          </div>
        </div>

        {/* The pickers. `min`/`max` are pinned to the sale history so the range
            cannot be dragged somewhere there was never anything to realise. */}
        <div className="px-4.5 py-3.5 border-b border-line flex flex-wrap items-end gap-3 bg-paper-2/40">
          <div className="space-y-1">
            <label htmlFor="pnl-from" className="block text-[10.5px] font-semibold uppercase tracking-wider text-mut">
              From
            </label>
            <input
              id="pnl-from"
              type="date"
              value={rangeFrom}
              min={firstSaleDate}
              max={lastSaleDate}
              onChange={(e) => setRangeFrom(e.target.value)}
              className="border border-line-2 bg-white rounded-[9px] px-3 py-2 text-xs font-mono focus:border-green focus:outline-none"
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="pnl-to" className="block text-[10.5px] font-semibold uppercase tracking-wider text-mut">
              To
            </label>
            <input
              id="pnl-to"
              type="date"
              value={rangeTo}
              min={firstSaleDate}
              max={lastSaleDate}
              onChange={(e) => setRangeTo(e.target.value)}
              className="border border-line-2 bg-white rounded-[9px] px-3 py-2 text-xs font-mono focus:border-green focus:outline-none"
            />
          </div>
          <p className="text-[11px] text-mut leading-normal flex-1 min-w-45">
            Sales on file run {dateStr(firstSaleDate)} – {dateStr(lastSaleDate)}.
          </p>
        </div>

        {/* Headline */}
        <div className="px-4.5 py-4 grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <div className="text-[10.5px] font-semibold uppercase tracking-wider text-mut">
              Realised P&amp;L
            </div>
            <div
              className={`font-mono font-bold text-xl mt-1 ${pl >= 0 ? "text-gain" : "text-loss-d"}`}
            >
              {pl >= 0 ? "+" : ""}
              {money0(pl)}
            </div>
            <div className="text-[11px] text-mut mt-0.5">
              {pct === null ? "—" : `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% on cost`}
            </div>
          </div>
          <div>
            <div className="text-[10.5px] font-semibold uppercase tracking-wider text-mut">
              Proceeds
            </div>
            <div className="font-mono font-semibold text-lg mt-1 text-ink">
              {money0(window_.proceeds)}
            </div>
          </div>
          <div>
            <div className="text-[10.5px] font-semibold uppercase tracking-wider text-mut">
              Cost of sold
            </div>
            <div className="font-mono font-semibold text-lg mt-1 text-ink">
              {money0(window_.costOfSold)}
            </div>
          </div>
          <div>
            <div className="text-[10.5px] font-semibold uppercase tracking-wider text-mut">
              Sales
            </div>
            <div className="font-mono font-semibold text-lg mt-1 text-ink">
              {window_.saleCount}
            </div>
          </div>
        </div>

        {/* Who moved it */}
        {window_.contributors.length > 0 && (
          <div className="overflow-x-auto border-t border-line">
            <table className="w-full border-collapse text-left text-[12.5px] font-medium">
              <thead>
                <tr className="border-b border-line text-mut select-none">
                  <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-2.5">
                    Holding
                  </th>
                  <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-2.5 text-right hidden sm:table-cell">
                    Units sold
                  </th>
                  <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-2.5 text-right hidden md:table-cell">
                    Cost
                  </th>
                  <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-2.5 text-right">
                    Proceeds
                  </th>
                  <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-2.5 text-right">
                    P&amp;L
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f0ede5]">
                {window_.contributors.map((c) => (
                  <tr key={c.parent} className="hover:bg-[#faf9f5]">
                    <td className="px-4.5 py-3">
                      <span className="code text-[13px] bg-paper-2 rounded-[5px] px-1.5 py-0.5">
                        {c.parent}
                      </span>
                      {c.noCostBasis && (
                        <div className="text-[10.5px] text-amber-d mt-1">
                          cost base not on file
                        </div>
                      )}
                    </td>
                    <td className="px-4.5 py-3 text-right font-mono hidden sm:table-cell">
                      {qty0(c.units)}
                    </td>
                    <td className="px-4.5 py-3 text-right font-mono hidden md:table-cell">
                      {money0(c.costOfSold)}
                    </td>
                    <td className="px-4.5 py-3 text-right font-mono">{money0(c.proceeds)}</td>
                    <td
                      className={`px-4.5 py-3 text-right font-mono font-semibold ${c.realizedPl >= 0 ? "text-gain" : "text-loss-d"}`}
                    >
                      {c.realizedPl >= 0 ? "+" : ""}
                      {money0(c.realizedPl)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {window_.saleCount === 0 && (
          <div className="px-4.5 py-6 text-center text-xs text-mut">
            Nothing was sold between {dateStr(window_.from)} and {dateStr(window_.to)}.
          </div>
        )}

        {/* Where profit has no cost behind it, the figure is overstated. Saying
            so is the difference between a number and a misleading one. */}
        {window_.hasUncosted && (
          <div className="px-4.5 py-3 border-t border-line text-xs text-mut leading-relaxed">
            Some of these sales have no purchase on file yet, so their profit is shown as the
            full proceeds and this total is higher than the real result. Vitti is confirming
            the cost base.
          </div>
        )}
      </div>
    );
  };

  /**
   * This week's note about one holding.
   *
   * ── Which of the two framings ───────────────────────────────────────────────
   * Chosen by the sign of the client's own unrealised P&L on the position, which
   * is the only thing that differs between two clients holding the same stock.
   * The market read underneath is identical for both, deliberately — see the
   * 20260904100000 migration.
   *
   * ── Labelled as general information, and dated ─────────────────────────────
   * The note is written from market conditions and the client's own figures,
   * not from their objectives or circumstances, so it is general information and
   * says so. It is also stamped with the week it was written: a note that
   * describes "this week" without saying which week is a note that quietly goes
   * stale, and the reader has no way to tell.
   */
  const renderCommentary = (position: Position) => {
    const note = commentary[position.code];
    if (!note) return null;

    const pl = posPL(position);
    // Flat counts as ahead: the note for a holder who is level reads as "what
    // to watch from here", which is right, where the loss framing would be
    // explaining a fall that has not happened.
    const text = pl < 0 ? note.lossNote : note.profitNote;

    const weekLabel = new Date(`${note.weekOf}T00:00:00Z`).toLocaleDateString("en-AU", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });

    return (
      <div className="rounded-[10px] border border-line bg-paper-2/50 p-3.5 space-y-2">
        <div className="flex items-baseline justify-between gap-2 flex-wrap">
          <b className="text-[12.5px] font-semibold text-ink">
            {pl < 0 ? "What has been weighing on this" : "Where this stands"}
          </b>
          <span className="text-[10px] font-mono text-mut whitespace-nowrap">
            week to {weekLabel}
          </span>
        </div>

        <p className="text-xs text-mut leading-relaxed">{text}</p>

        {note.sources.length > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 pt-0.5">
            {/* A market claim nobody can check is not worth showing a client. */}
            {note.sources.slice(0, 3).map((src) => (
              <a
                key={src.url}
                href={src.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10.5px] text-mut underline decoration-dotted hover:text-ink truncate max-w-45"
                title={src.title}
              >
                {src.title}
              </a>
            ))}
          </div>
        )}

        <p className="text-[10px] text-mut-d leading-normal">
          General information about the market, not personal advice. It does not take your
          objectives or circumstances into account.
          {note.editedBy ? ` Written by ${note.editedBy}.` : " Updated weekly."}
        </p>
      </div>
    );
  };

  /**
   * Sector split, over what is held now or over everything ever held.
   *
   * The two scopes are measured differently and the card says which: exposure
   * today is a market value, while a sold parcel has no market value at all and
   * only its cost base is still a fact about it. See lib/pnl/sector-mix.ts.
   *
   * P&L is on every legend row as well as on hover. A tooltip is not a place to
   * keep a number: it is unreachable on a touch screen, and this is the figure
   * the chart exists to show.
   */
  const renderSectorCard = () => {
    const measure = sectorScope === "held" ? "market value" : "amount invested";

    return (
      <div className="card bg-white border border-line rounded-[14px] p-5 shadow-shadow flex flex-col">
        <div className="flex justify-between items-start text-xs mb-3 gap-2 flex-wrap">
          <div>
            <b className="text-sm font-semibold text-ink">Sector split</b>
            <div className="text-[11px] text-mut mt-0.5">by {measure}</div>
          </div>

          <div className="inline-flex bg-paper-2 rounded-[8px] p-0.5 flex-none">
            <button
              onClick={() => {
                setSectorScope("held");
                setHoveredSector(null);
              }}
              className={`text-[11px] font-semibold px-2.5 py-1 rounded-[6px] cursor-pointer transition-colors ${
                sectorScope === "held" ? "bg-white text-ink shadow-shadow" : "text-mut hover:text-ink"
              }`}
            >
              Held now
            </button>
            <button
              onClick={() => {
                setSectorScope("alltime");
                setHoveredSector(null);
              }}
              className={`text-[11px] font-semibold px-2.5 py-1 rounded-[6px] cursor-pointer transition-colors ${
                sectorScope === "alltime" ? "bg-white text-ink shadow-shadow" : "text-mut hover:text-ink"
              }`}
            >
              Incl. past
            </button>
          </div>
        </div>

        {mix.buckets.length === 0 ? (
          <div className="flex-1 flex items-center">
            <p className="text-xs text-mut leading-relaxed">
              {sectorScope === "held"
                ? "Nothing held in your accounts right now."
                : "No holdings on file yet."}
            </p>
          </div>
        ) : mix.unclassified ? (
          <div className="flex-1 flex items-center">
            <p className="text-xs text-mut leading-relaxed">
              Sector classifications are not on file for these holdings yet, so there is
              nothing to break down. Your adviser can tell you the exposure in the meantime.
            </p>
          </div>
        ) : (
          <div className="flex gap-5 items-center flex-wrap">
            {/* A pie, not a donut: `thick = size / 2` takes the inner radius to
                zero, so the same component draws both and the two cards on this
                row stay visually of a piece. The centre is then given back by
                overlaying the readout on top. */}
            <div className="relative flex-none">
              <DonutChart
                segs={sectorSegs}
                size={128}
                thick={focusedBucket ? 44 : 64}
                onHover={setHoveredSector}
                activeLabel={hoveredSector}
              />
              {/* Only drawn while a slice is focused, because the ring only
                  opens up a hole then. */}
              {focusedBucket && (
                <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none px-6 text-center">
                  <div
                    className={`font-mono font-bold text-[13px] ${focusedBucket.pnl >= 0 ? "text-gain" : "text-loss-d"}`}
                  >
                    {focusedBucket.pnl >= 0 ? "+" : ""}
                    {money0(focusedBucket.pnl)}
                  </div>
                  <div className="text-[8.5px] text-mut uppercase font-semibold tracking-wide">
                    P&amp;L
                  </div>
                </div>
              )}
            </div>

            <div className="flex-1 min-w-45 space-y-1.5">
              {mix.buckets.map((b, i) => {
                const share = mix.total > 0 ? Math.round((b.value / mix.total) * 100) : 0;
                const focused = hoveredSector === b.label;
                return (
                  <button
                    key={b.label}
                    onMouseEnter={() => setHoveredSector(b.label)}
                    onMouseLeave={() => setHoveredSector(null)}
                    onFocus={() => setHoveredSector(b.label)}
                    onBlur={() => setHoveredSector(null)}
                    className={`w-full text-left rounded-[7px] px-1.5 py-1 transition-colors cursor-pointer ${
                      focused ? "bg-paper-2" : ""
                    }`}
                  >
                    <div className="flex items-center gap-2 text-xs font-medium text-ink">
                      <i
                        style={{ backgroundColor: palette[i % palette.length] }}
                        className="w-2.5 h-2.5 rounded-[3px] block flex-none"
                      />
                      <span className="truncate" title={b.label}>
                        {b.label}
                      </span>
                      <b className="ml-auto font-mono text-[13px] font-semibold whitespace-nowrap">
                        {share}%
                      </b>
                    </div>
                    <div className="flex items-baseline gap-2 pl-4.5 mt-0.5">
                      <span
                        className={`font-mono text-[11.5px] font-semibold ${b.pnl >= 0 ? "text-gain" : "text-loss-d"}`}
                      >
                        {b.pnl >= 0 ? "+" : ""}
                        {money0(b.pnl)}
                      </span>
                      <span className="text-[10.5px] text-mut">
                        {pct1(b.returnPct)} · {b.holdings} holding
                        {b.holdings === 1 ? "" : "s"}
                      </span>
                    </div>
                  </button>
                );
              })}

              <div className="flex items-center gap-2 pt-1.5 mt-1 border-t border-line text-xs">
                <span className="text-mut font-medium">Total</span>
                <span className="ml-auto font-mono text-[11.5px] text-mut">
                  {money0(mix.total)}
                </span>
                <span
                  className={`font-mono text-[11.5px] font-semibold ${mix.totalPnl >= 0 ? "text-gain" : "text-loss-d"}`}
                >
                  {mix.totalPnl >= 0 ? "+" : ""}
                  {money0(mix.totalPnl)}
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderPnl = () => {
    const rows = pnlRows;
    const page = rows.slice((pnlPage - 1) * pnlSize, (pnlPage - 1) * pnlSize + pnlSize);

    return (
      <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
        <div className="flex justify-between items-center px-4.5 py-4 border-b border-line bg-white select-none flex-wrap gap-2">
          <div>
            <b className="text-ink text-sm font-semibold">Profit &amp; loss</b>
            <p className="text-xs text-mut mt-0.5">
              Every parcel across your accounts — sold and still held.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="search"
              value={pnlSearch}
              onChange={(e) => {
                setPnlSearch(e.target.value);
                setPnlPage(1);
              }}
              placeholder="Search ticker or name"
              aria-label="Search profit and loss"
              className="w-46 border border-line-2 bg-white rounded-[9px] px-3 py-2 text-xs focus:border-green focus:outline-none transition-colors"
            />
            <span className="text-mut text-xs font-medium whitespace-nowrap">{rows.length} lines</span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-[12.5px] font-medium">
            <thead>
              <tr className="border-b border-line text-mut select-none">
                <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3">Holding</th>
                <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right hidden sm:table-cell">Bought</th>
                <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right hidden sm:table-cell">Sold</th>
                <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right hidden md:table-cell">Held</th>
                <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right">Cost</th>
                <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right">Proceeds / value</th>
                <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right">P&amp;L</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#f0ede5]">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center text-mut py-6">
                    {pnlSearch.trim()
                      ? `Nothing matches "${pnlSearch.trim()}".`
                      : "No figures yet. Your P&L appears once Vitti has processed your first contract notes."}
                  </td>
                </tr>
              ) : (
                page.map((r) => (
                  <tr key={`${r.ticker}-${r.type}`} className="hover:bg-[#faf9f5]">
                    <td className="px-4.5 py-3.5">
                      <span className="code text-[13px] bg-paper-2 rounded-[5px] px-1.5 py-0.5">{r.ticker}</span>
                      <div className="text-[10.5px] text-mut mt-1">
                        {r.name}
                        {r.openPosition && " · open"}
                        {r.type.toLowerCase().includes("option") && " · option"}
                      </div>
                    </td>
                    <td className="px-4.5 py-3.5 text-right font-mono hidden sm:table-cell">{qty0(r.buyQty)}</td>
                    <td className="px-4.5 py-3.5 text-right font-mono hidden sm:table-cell">{qty0(r.sellQty)}</td>
                    <td className="px-4.5 py-3.5 text-right font-mono hidden md:table-cell">{qty0(r.heldQty)}</td>
                    <td className="px-4.5 py-3.5 text-right font-mono">{money0(r.buyPrice)}</td>
                    <td className="px-4.5 py-3.5 text-right font-mono">{money0(r.sellOrCurrent)}</td>
                    <td className={`px-4.5 py-3.5 text-right font-mono font-semibold ${r.pnl >= 0 ? "text-gain" : "text-loss-d"}`}>
                      {r.pnl >= 0 ? "+" : ""}{money0(r.pnl)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr className="border-t-2 border-line bg-paper-2 font-semibold">
                  {/* Always the whole portfolio, never the page or the search
                      result — a footer that silently totalled 25 of 334 lines
                      would be a different number every time you paged. */}
                  <td className="px-4.5 py-3.5 text-ink" colSpan={4}>
                    Total{rows.length !== portfolio.rows.length ? " (all lines)" : ""}
                  </td>
                  <td className="px-4.5 py-3.5 text-right font-mono text-ink hidden sm:table-cell">{money0(portfolio.total.buyPrice)}</td>
                  <td className="px-4.5 py-3.5 text-right font-mono text-ink">{money0(portfolio.total.sellOrCurrent)}</td>
                  <td className={`px-4.5 py-3.5 text-right font-mono ${portfolio.total.pnl >= 0 ? "text-gain" : "text-loss-d"}`}>
                    {portfolio.total.pnl >= 0 ? "+" : ""}{money0(portfolio.total.pnl)}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        <TablePagination
          totalItems={rows.length}
          currentPage={pnlPage}
          pageSize={pnlSize}
          onPageChange={setPnlPage}
          onPageSizeChange={(size) => {
            setPnlSize(size);
            setPnlPage(1);
          }}
          pageSizeOptions={[10, 25, 50, 100, 1000]}
          itemLabel="lines"
        />

        {/* A total that quietly omits a holding is worse than one that says so. */}
        {portfolio.outsideTotal > 0 && (
          <div className="px-4.5 py-3 border-t border-line text-xs text-mut leading-relaxed">
            {portfolio.outsideTotal} line{portfolio.outsideTotal === 1 ? " is" : "s are"} outside
            the total while Vitti confirms {portfolio.outsideTotal === 1 ? "its" : "their"} cost
            base. Ask your adviser if you would like the detail.
          </div>
        )}
      </div>
    );
  };

  const renderAnalytics = () => {
    // `unlisted || totalAssets * 0.04` used to sit in the middle row — a
    // hardcoded 4% invented whenever the real figure was zero, and not included
    // in `totalAssets`, so the three shares read 100% / 4% / 0% and summed to
    // 104%. Real values only, and the percentages are taken against the sum of
    // the slices actually drawn, so they add up.
    const allocSegs = [
      { label: "Listed equities", v: tv, col: "#1d202f" },
      { label: "Unlisted / options", v: unlisted, col: "#36bb91" },
      { label: "Cash", v: cash, col: "#cfc9bb" },
    ];
    const allocTotal = allocSegs.reduce((sum, a) => sum + a.v, 0);
    const alloc = allocSegs.filter((a) => a.v > 0);
    const share = (v: number) => (allocTotal > 0 ? Math.round((v / allocTotal) * 100) : 0);

    /**
     * Where the P&L actually comes from — closed parcels vs still-held, and
     * equities vs option grants.
     *
     * This replaces a "Portfolio growth" card whose curve was a hardcoded SVG
     * path (`M0 96 L100 90 … L600 18`) under the caption "Up +6.4% over 12
     * months" — the same invented 6.4% the dashboard was showing. There is no
     * price history in this app to draw a growth curve from, and `pnl_runs` is a
     * record of when the desk RECOMPUTED rather than of how the market moved, so
     * charting it as growth would be a second wrong answer. This is the same
     * total, split four ways, and every number in it is one the desk stands
     * behind.
     */
    const isOption = (t: string) => t.toLowerCase().includes("option");
    const split = [
      {
        label: "Closed",
        v: portfolio.rows.filter((r) => !r.openPosition && !isOption(r.type)).reduce((n, r) => n + r.pnl, 0),
      },
      {
        label: "Still held",
        v: portfolio.rows.filter((r) => r.openPosition && !isOption(r.type)).reduce((n, r) => n + r.pnl, 0),
      },
      {
        label: "Options",
        v: portfolio.rows.filter((r) => isOption(r.type)).reduce((n, r) => n + r.pnl, 0),
      },
    ];
    const splitMax = Math.max(...split.map((x) => Math.abs(x.v)), 1);

    // Sorted by the SIZE of the move, not by percentage. Sorting by percentage
    // put the zero-cost rows — whose percentage was `Infinity` — in every top
    // slot, so the table showed free option grants instead of the positions that
    // actually moved the portfolio.
    const movers = positions
      .map(p => ({
        code: p.code,
        pl: posPL(p),
        plp: returnPct(posPL(p), posCost(p)),
      }))
      .sort((a, b) => Math.abs(b.pl) - Math.abs(a.pl));

    return (
      <div className="space-y-4 select-none">
        {/* Split grid for allocation and sector */}
        <div className="grid md:grid-cols-2 gap-4">
          <div className="card bg-white border border-line rounded-[14px] p-5 shadow-shadow">
            <div className="flex justify-between items-center text-xs mb-3">
              <b className="text-sm font-semibold text-ink">Asset allocation</b>
              <span className="text-mut font-mono">${Math.round(allocTotal).toLocaleString("en-AU")}</span>
            </div>

            <div className="flex gap-5 items-center flex-wrap">
              <div className="relative flex-none">
                <DonutChart segs={alloc} size={128} thick={18} />
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <div className="font-mono font-bold text-base text-ink">{share(tv)}%</div>
                  <div className="text-[9.5px] text-mut uppercase font-semibold">equities</div>
                </div>
              </div>

              <div className="flex-1 min-w-37.5 space-y-2">
                {alloc.length === 0 ? (
                  <p className="text-xs text-mut leading-relaxed">
                    Nothing held in this account right now.
                  </p>
                ) : (
                  alloc.map(a => (
                    <div key={a.label} className="flex items-center gap-2 text-xs font-medium text-ink">
                      <i style={{ backgroundColor: a.col }} className="w-2.5 h-2.5 rounded-[3px] block flex-none" />
                      <span>{a.label}</span>
                      <b className="ml-auto font-mono text-[13px] font-semibold">{share(a.v)}%</b>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {renderSectorCard()}
        </div>

        {/* Bottom split: Movers and Growth */}
        <div className="grid md:grid-cols-2 gap-4">
          <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
            <div className="flex justify-between items-center px-4.5 py-3 border-b border-line">
              <b className="text-sm font-semibold text-ink">Top movers</b>
              <span className="text-mut text-xs font-semibold">unrealised, this account</span>
            </div>
            <table className="w-full border-collapse text-left text-xs font-medium">
              <tbody className="divide-y divide-[#f0ede5]">
                {movers.slice(0, 5).map(m => {
                  const isUp = m.pl >= 0;
                  return (
                    <tr key={m.code}>
                      <td className="px-4.5 py-3"><span className="code text-[12.5px] bg-paper-2 rounded-[5px] px-1.5 py-0.5">{m.code}</span></td>
                      <td className={`px-4.5 py-3 text-right font-mono text-[13px] ${isUp ? "text-gain" : "text-loss-d"}`}>
                        {isUp ? "+" : ""}${Math.round(m.pl).toLocaleString("en-AU")}
                      </td>
                      <td className={`px-4.5 py-3 text-right font-mono text-[13px] ${m.plp === null ? "text-mut" : isUp ? "text-gain" : "text-loss-d"}`}>
                        {pct1(m.plp)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="card bg-white border border-line rounded-[14px] p-5 shadow-shadow space-y-3">
            <div className="flex justify-between items-center text-xs">
              <b className="text-sm font-semibold text-ink">Where the P&amp;L comes from</b>
              <span className="text-mut font-semibold">all accounts</span>
            </div>

            <div className="space-y-2.5 pt-1">
              {split.map((x) => {
                const up = x.v >= 0;
                return (
                  <div key={x.label} className="space-y-1">
                    <div className="flex justify-between items-baseline text-xs font-medium">
                      <span className="text-ink">{x.label}</span>
                      <b className={`font-mono text-[13px] ${up ? "text-gain" : "text-loss-d"}`}>
                        {up ? "+" : ""}{money0(x.v)}
                      </b>
                    </div>
                    {/* Centre line, so a loss reads as a bar going the other way
                        rather than as a smaller gain. */}
                    <div className="relative h-1.5 bg-paper-2 rounded-full overflow-hidden">
                      <div
                        className="absolute top-0 h-full rounded-full"
                        style={{
                          width: `${(Math.abs(x.v) / splitMax) * 50}%`,
                          left: up ? "50%" : undefined,
                          right: up ? undefined : "50%",
                          backgroundColor: up ? "var(--color-green)" : "var(--color-loss)",
                        }}
                      />
                      <div className="absolute left-1/2 top-0 h-full w-px bg-line-2" />
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="flex justify-between items-baseline text-xs pt-2 border-t border-line">
              <span className="text-mut font-semibold">Total</span>
              <b className={`font-mono text-[13px] ${deskPnl >= 0 ? "text-gain" : "text-loss-d"}`}>
                {deskPnl >= 0 ? "+" : ""}{money0(deskPnl)}
              </b>
            </div>
          </div>
        </div>
      </div>
    );
  };

  const selectedStock = positions.find(pos => pos.code === selectedHolding);
  const advice = selectedHolding ? signals[selectedHolding] : null;

  return (
    <div className="space-y-4">
      {/* Page Header */}
      <div className="flex justify-between items-end gap-3 flex-wrap">
        <div>
          <div className="font-mono text-xs tracking-wider uppercase text-mut">Listed equities &middot; broker feed</div>
          <h1 className="font-disp font-medium text-[26px] mt-0.5 text-ink">Portfolio</h1>
        </div>

        {/* Tabs switcher */}
        <div className="inline-flex bg-paper-2 rounded-[9px] p-0.75">
          <button
            onClick={() => setTab("holdings")}
            className={`text-xs font-semibold px-4 py-2 rounded-[7px] cursor-pointer transition-colors ${tab === "holdings" ? "bg-white text-ink shadow-shadow" : "text-mut hover:text-ink"}`}
          >
            Holdings
          </button>
          <button
            onClick={() => setTab("pnl")}
            className={`text-xs font-semibold px-4 py-2 rounded-[7px] cursor-pointer transition-colors ${tab === "pnl" ? "bg-white text-ink shadow-shadow" : "text-mut hover:text-ink"}`}
          >
            Profit &amp; loss
          </button>
          <button
            onClick={() => setTab("analytics")}
            className={`text-xs font-semibold px-4 py-2 rounded-[7px] cursor-pointer transition-colors ${tab === "analytics" ? "bg-white text-ink shadow-shadow" : "text-mut hover:text-ink"}`}
          >
            Analytics
          </button>
        </div>
      </div>

      {/* KPI Cards Grid

          The first three are the desk's own Grand Total and are the SAME
          question — cost, what it came to, the difference. They were briefly
          shown beside "Market value", which is a different question entirely
          (current holdings of ONE account at last price), and the pair read as a
          catastrophe: $3,289 next to a $9.9M lifetime cost base. Comparable
          figures sit together; the account's current value is labelled as what
          it is and put last. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Cost base</div>
          <div className="font-disp font-medium text-2xl mt-1 text-ink">{money0(deskCost)}</div>
          <div className="text-xs text-mut mt-1">invested, all accounts</div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Proceeds &amp; value</div>
          <div className="font-disp font-medium text-2xl mt-1 text-ink">{money0(portfolio.total.sellOrCurrent)}</div>
          <div className="text-xs text-mut mt-1">sold, plus what is still held</div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">Profit &amp; loss</div>
          <div className={`font-disp font-medium text-2xl mt-1 ${deskPnl >= 0 ? "text-gain" : "text-loss-d"}`}>
            {deskPnl >= 0 ? "+" : ""}{money0(deskPnl)}
          </div>
          <div className={`text-xs mt-1 font-mono ${deskPnl >= 0 ? "text-gain" : "text-loss-d"}`}>
            {deskPnl >= 0 ? "+" : ""}{deskPnlPct.toFixed(1)}% &middot; realised + open
          </div>
        </div>
        <div className="card bg-white border border-line rounded-[14px] p-4.5 shadow-shadow">
          <div className="text-[11px] tracking-wider uppercase text-mut font-semibold">This account now</div>
          <div className="font-disp font-medium text-2xl mt-1 text-ink">${Math.round(tv + cash).toLocaleString("en-AU")}</div>
          <div className="text-xs text-mut mt-1">
            {positions.length} holding{positions.length === 1 ? "" : "s"} + cash, at last price
          </div>
        </div>
      </div>

      {/* Render selected Tab content */}
      {tab === "analytics" ? (
        renderAnalytics()
      ) : tab === "pnl" ? (
        // The dated window first: "what did I make recently" is the question
        // people arrive on this tab with, and the full parcel-by-parcel table
        // below it is the reference the answer can be checked against.
        <div className="space-y-4">
          {renderRealisedWindow()}
          {renderPnl()}
        </div>
      ) : (
        <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
          <div className="flex justify-between items-center px-4.5 py-4 border-b border-line bg-white select-none flex-wrap gap-2">
            <div>
              <b className="text-ink text-sm font-semibold">Holdings</b>
              <p className="text-xs text-mut mt-0.5">Tap a holding for Vitti&apos;s view</p>
            </div>
            <input
              type="search"
              value={holdSearch}
              onChange={(e) => {
                setHoldSearch(e.target.value);
                setHoldPage(1);
              }}
              placeholder="Search ticker or name"
              aria-label="Search holdings"
              className="w-46 border border-line-2 bg-white rounded-[9px] px-3 py-2 text-xs focus:border-green focus:outline-none transition-colors"
            />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-[12.5px] font-medium">
              <thead>
                <tr className="border-b border-line text-mut select-none">
                  <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3">Code</th>
                  <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 hidden sm:table-cell">Holding</th>
                  <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right">Qty</th>
                  <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right hidden sm:table-cell">Last</th>
                  <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right">Value</th>
                  <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-right">Unreal. P&amp;L</th>
                  <th className="font-semibold text-[10.5px] uppercase tracking-wider px-4.5 py-3 text-center">Vitti View</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#f0ede5]">
                {holdingRows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="text-center text-mut py-6">
                      {holdSearch.trim()
                        ? `Nothing matches "${holdSearch.trim()}".`
                        : "No holdings in this account."}
                    </td>
                  </tr>
                )}
                {holdingRows
                  .slice((holdPage - 1) * holdSize, (holdPage - 1) * holdSize + holdSize)
                  .map(p => {
                  const pl = posPL(p);
                  const plp = returnPct(pl, posCost(p));
                  const val = posValue(p);
                  const isUp = pl >= 0;
                  const sg = signals[p.code];
                  return (
                    <tr
                      key={p.code}
                      onClick={() => handleOpenHolding(p.code)}
                      className="hover:bg-[#faf9f5] cursor-pointer transition-colors"
                    >
                      <td className="px-4.5 py-3">
                        <span className="code text-[13px] bg-paper-2 rounded-[5px] px-1.5 py-0.5">{p.code}</span>
                        {/* There is a weekly note behind this row. Without a
                            hint, a note that only exists inside a modal is a
                            note nobody knows to open. */}
                        {commentary[p.code] && (
                          <span
                            className="ml-1.5 align-middle inline-block w-1.5 h-1.5 rounded-full bg-green"
                            title="A note on this holding was written this week — open the row to read it"
                            aria-label="Weekly note available"
                          />
                        )}
                      </td>
                      <td className="px-4.5 py-3 hidden sm:table-cell text-mut">
                        <span className="text-ink font-semibold">{p.name}</span>
                        <div className="text-[10.5px] mt-0.5">{p.sector ?? "—"}</div>
                      </td>
                      <td className="px-4.5 py-3 text-right font-mono">{p.qty.toLocaleString("en-AU")}</td>
                      <td className="px-4.5 py-3 text-right font-mono hidden sm:table-cell">${(p.last ?? 0).toFixed(2)}</td>
                      <td className="px-4.5 py-3 text-right font-mono font-semibold">${Math.round(val).toLocaleString("en-AU")}</td>
                      <td className={`px-4.5 py-3 text-right font-mono ${isUp ? "text-gain" : "text-loss-d"}`}>
                        ${Math.round(pl).toLocaleString("en-AU")}
                        <div className="text-[10.5px]">{pct1(plp)}</div>
                      </td>
                      <td className="px-4.5 py-3 text-center">
                        {getActionPill(sg ? sg.action : "Hold")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <TablePagination
            totalItems={holdingRows.length}
            currentPage={holdPage}
            pageSize={holdSize}
            onPageChange={setHoldPage}
            onPageSizeChange={(size) => {
              setHoldSize(size);
              setHoldPage(1);
            }}
            pageSizeOptions={[10, 25, 50, 100, 1000]}
            itemLabel="holdings"
          />
        </div>
      )}

      {/* Holdings Detailed Advice Modal */}
      {selectedStock && (
        <div className="fixed inset-0 bg-navy/55 backdrop-blur-[2px] z-50 flex items-center justify-center p-4.5 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-110 w-full p-6 shadow-shadow-lg text-ink space-y-4 my-auto max-h-[92vh] overflow-y-auto">
            <div className="flex items-center gap-2.5">
              <span className="code text-lg bg-paper-2 rounded-[5px] px-2 py-0.5">{selectedHolding}</span>
              {advice && getActionPill(advice.action)}
            </div>

            <div>
              <h3 className="font-disp font-medium text-lg leading-tight text-ink">{selectedStock.name}</h3>
            </div>

            <div className="divide-y divide-line">
              <div className="flex justify-between py-2 text-xs">
                <span className="text-mut font-semibold">Your holding</span>
                <b className="font-mono text-ink font-semibold">
                  {selectedStock.qty.toLocaleString("en-AU")} &middot; ${Math.round(posValue(selectedStock)).toLocaleString("en-AU")}
                </b>
              </div>
              <div className="flex justify-between py-2 text-xs">
                <span className="text-mut font-semibold">Unrealised P&amp;L</span>
                <b className={`font-mono font-semibold ${posPL(selectedStock) >= 0 ? "text-gain" : "text-loss-d"}`}>
                  {posPL(selectedStock) >= 0 ? "+" : ""}${Math.round(posPL(selectedStock)).toLocaleString("en-AU")} ({(posPL(selectedStock) / posCost(selectedStock) * 100).toFixed(1)}%)
                </b>
              </div>
              {advice && (
                <div className="flex justify-between py-2 text-xs">
                  <span className="text-mut font-semibold">Vitti target</span>
                  <b className="font-mono text-ink font-semibold">
                    {advice.target && selectedStock.last
                      ? `$${advice.target.toFixed(2)} · +${Math.round((advice.target / selectedStock.last - 1) * 100)}%`
                      : "—"}
                  </b>
                </div>
              )}
            </div>

            {advice && (
              <div className="space-y-1">
                <div className="font-semibold text-[13.5px] leading-snug">{advice.headline}</div>
                <p className="text-xs text-mut leading-relaxed">{advice.detail}</p>
              </div>
            )}

            {renderCommentary(selectedStock)}

            <div className="flex gap-2.5 pt-2">
              <button
                onClick={handleCloseHolding}
                className="btn border border-line rounded-[10px] py-2 px-4 hover:border-mut text-xs font-semibold cursor-pointer flex-1"
              >
                Close
              </button>

              {advice?.action === "Add" && (
                <button
                  onClick={() => {
                    setTradeAction("Buy");
                    setIsTradeModalOpen(true);
                  }}
                  className="btn bg-green text-[#08130e] hover:shadow-lg rounded-[10px] py-2 px-4 text-xs font-semibold cursor-pointer flex-1.5"
                >
                  Add to position &rarr;
                </button>
              )}

              {(advice?.action === "Trim" || advice?.action === "Take profit") && (
                <button
                  onClick={() => {
                    setTradeAction("Sell");
                    setIsTradeModalOpen(true);
                  }}
                  className="btn bg-navy text-white hover:bg-slate-800 rounded-[10px] py-2 px-4 text-xs font-semibold cursor-pointer flex-1.5"
                >
                  Trim &rarr;
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Trade Execution Modal */}
      {isTradeModalOpen && selectedStock && (
        <div className="fixed inset-0 bg-navy/55 backdrop-blur-[2px] z-50 flex items-center justify-center p-4.5 overflow-y-auto">
          <div className="bg-white rounded-2xl max-w-110 w-full p-6 shadow-shadow-lg text-ink space-y-4 my-auto max-h-[92vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="font-disp font-medium text-lg text-ink">
              Route {tradeAction === "Buy" ? "Buy" : "Sell"} Order to Desk
            </h3>
            <p className="text-xs text-mut">
              {selectedStock.name} &middot; last close ${(selectedStock.last ?? 0).toFixed(2)}
            </p>

            <div className="space-y-1">
              <label className="block text-xs font-semibold text-ink">Amount to {tradeAction === "Buy" ? "invest" : "sell"} (AUD)</label>
              <input
                type="text"
                value={tradeAmount}
                onChange={e => setTradeAmount(e.target.value.replace(/[^0-9,]/g, ""))}
                className="w-full border border-line-2 bg-white rounded-[9px] px-3.5 py-2.5 font-mono text-sm focus:border-green focus:outline-none"
              />
              <div className="text-[11px] text-mut mt-1">
                &asymp; {tradeCalculatedShares().toLocaleString("en-AU")} shares at ${(selectedStock.last ?? 0).toFixed(2)}
              </div>
            </div>

            <div className="text-xs text-mut bg-paper-2 rounded-[9px] p-3 leading-normal">
              Your order will be routed directly to the Vitti trading desk. Execution prices will be matched as close to the current market price as possible. Brokerage charges apply.
            </div>

            <div className="flex gap-2.5 pt-2">
              <button
                onClick={() => setIsTradeModalOpen(false)}
                className="btn border border-line rounded-[10px] py-2 px-4 hover:border-mut text-xs font-semibold cursor-pointer flex-1"
              >
                Back
              </button>
              <button
                onClick={executeTradeOrder}
                className="btn bg-green text-[#08130e] hover:shadow-lg rounded-[10px] py-2 px-4 text-xs font-semibold cursor-pointer flex-1.5"
              >
                Confirm with Desk
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
