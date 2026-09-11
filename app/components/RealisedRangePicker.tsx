"use client";

import { monthsBack } from "@/lib/data/compute";
import { RANGE_PRESETS } from "@/lib/pnl/realised-window";

export type DateRange = { from: string; to: string };

const dateStr = (iso: string) =>
  iso
    ? new Date(`${iso}T00:00:00`).toLocaleDateString("en-AU", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "";

/**
 * The period every figure on a Historical P&L tab is taken over.
 *
 * Shared by the client's Portfolio and the desk console, which show the same
 * table: the presets, the bounds and the sentence underneath all have to mean
 * the same thing on both, and two copies of them is how that quietly stops
 * being true.
 *
 * Presentational only — the range itself lives in the page that owns the
 * figures, because picking one changes WHICH rows the table is showing and only
 * that page can rebuild them.
 */
export function RealisedRangePicker({
  range,
  firstSaleDate,
  lastSaleDate,
  onPick,
  /**
   * Does the all-time view list open positions too?
   *
   * The desk's does and the client's does not, and the sentence has to say
   * which — "positions you still hold are on Holdings, not here" is true of one
   * of these screens and actively misleading on the other.
   */
  allTimeIncludesOpen = false,
}: {
  range: DateRange | null;
  firstSaleDate: string;
  lastSaleDate: string;
  onPick: (next: DateRange | null) => void;
  allTimeIncludesOpen?: boolean;
}) {
  const isAllTime = range === null;
  const rangeFrom = range?.from ?? firstSaleDate;
  const rangeTo = range?.to ?? lastSaleDate;

  /**
   * Which preset, if any, the current range corresponds to — for the pills.
   *
   * All time has its own pill. Without the guard, a book whose sale history
   * happens to be almost exactly a year long would light both it and `1Y`,
   * which is two answers to "what am I looking at".
   */
  const activePreset =
    isAllTime || !lastSaleDate || rangeTo !== lastSaleDate
      ? null
      : (RANGE_PRESETS.find((p) => monthsBack(lastSaleDate, p.months).from === rangeFrom)
          ?.label ?? null);

  const pill = (on: boolean) =>
    `text-[11.5px] font-semibold px-2.5 py-1.5 rounded-[7px] cursor-pointer transition-colors ${
      on ? "bg-navy text-white" : "bg-white border border-line text-mut hover:text-ink"
    }`;

  return (
    <div className="px-4.5 py-3 border-b border-line bg-paper-2/40 space-y-2.5 select-none">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" onClick={() => onPick(null)} className={pill(isAllTime)}>
            All time
          </button>
          {RANGE_PRESETS.map((p) => (
            <button
              key={p.label}
              type="button"
              onClick={() => lastSaleDate && onPick(monthsBack(lastSaleDate, p.months))}
              className={pill(activePreset === p.label)}
            >
              {p.label}
            </button>
          ))}
        </div>

        {/* `min`/`max` are pinned to the sale history, so the range cannot be
            dragged somewhere there was never anything to realise. */}
        <div className="flex items-end gap-3">
          <div className="space-y-1">
            <label
              htmlFor="pnl-from"
              className="block text-[10px] font-semibold uppercase tracking-wider text-mut"
            >
              From
            </label>
            <input
              id="pnl-from"
              type="date"
              value={rangeFrom}
              min={firstSaleDate}
              max={lastSaleDate}
              onChange={(e) => onPick({ from: e.target.value, to: rangeTo })}
              className="border border-line-2 bg-white rounded-[8px] px-2.5 py-1.5 text-[11.5px] font-mono focus:border-green focus:outline-none"
            />
          </div>
          <div className="space-y-1">
            <label
              htmlFor="pnl-to"
              className="block text-[10px] font-semibold uppercase tracking-wider text-mut"
            >
              To
            </label>
            <input
              id="pnl-to"
              type="date"
              value={rangeTo}
              min={firstSaleDate}
              max={lastSaleDate}
              onChange={(e) => onPick({ from: rangeFrom, to: e.target.value })}
              className="border border-line-2 bg-white rounded-[8px] px-2.5 py-1.5 text-[11.5px] font-mono focus:border-green focus:outline-none"
            />
          </div>
        </div>
      </div>

      <p className="text-[11px] text-mut leading-normal">
        {isAllTime ? (
          <>
            {allTimeIncludesOpen ? (
              <>
                Every parcel on file, sold or still held. Sales run{" "}
                {dateStr(firstSaleDate)} – {dateStr(lastSaleDate)}
              </>
            ) : (
              <>
                Every parcel that has sold, in full or in part. Sales run{" "}
                {dateStr(firstSaleDate)} – {dateStr(lastSaleDate)}
              </>
            )}{" "}
            — narrow the period to see just what was <b>realised</b> in it.
            {!allTimeIncludesOpen && (
              <>
                {" "}
                Positions you still hold — shares and option grants alike — are on{" "}
                <b>Holdings</b> above, not here.
              </>
            )}
          </>
        ) : (
          <>
            Showing what was <b>realised</b> between {dateStr(rangeFrom)} and{" "}
            {dateStr(rangeTo)}. Holdings still owned are not in these figures.
          </>
        )}
      </p>
    </div>
  );
}
