import React from "react";
import type { OptionMoneyness } from "@/lib/options/moneyness";

/**
 * The ITM / ATM / OTM pill, and the strike-against-spot line that justifies it.
 *
 * Shared by the client profile's Options tab and the staff Options register so
 * a series reads the same on both. A badge that says ITM on one screen and
 * nothing on the other is worse than no badge: the desk cannot tell which
 * screen is stale.
 *
 * Renders NOTHING when moneyness is unknown. A row whose strike the tracker
 * could not parse has no verdict to report, and "OTM" would read as a finding
 * rather than as missing data.
 */

const TONE: Record<string, string> = {
  ITM: "bg-green-bg text-green-d border border-green-d/20",
  ATM: "bg-amber-bg text-amber-d border border-amber-d/20",
  OTM: "bg-paper-2 text-mut border border-line/60",
};

export function MoneynessBadge({
  money,
  title,
}: {
  money: OptionMoneyness;
  title?: string;
}) {
  if (money.moneyness === "unknown") return null;

  return (
    <span
      title={title}
      className={`pill text-[10px] font-bold rounded-full px-1.5 py-0.5 whitespace-nowrap inline-block tracking-wide ${
        TONE[money.moneyness]
      }`}
    >
      {money.moneyness}
    </span>
  );
}

/**
 * `$0.14 → $0.22` — the two numbers the badge is a verdict on, side by side, so
 * the claim can be checked without opening anything.
 */
export function StrikeSpot({
  strike,
  spot,
  money4,
}: {
  strike: number | null;
  spot: number | null;
  money4: (n: number) => string;
}) {
  if (strike == null && spot == null) {
    return <span className="text-mut-d">—</span>;
  }

  return (
    <span className="font-mono text-[11px] whitespace-nowrap">
      <span className="text-mut" title="Exercise price">
        {strike == null ? "—" : `$${money4(strike)}`}
      </span>
      <span className="text-mut-d mx-1">&rarr;</span>
      <span className="text-ink font-semibold" title="Underlying price">
        {spot == null ? "—" : `$${money4(spot)}`}
      </span>
    </span>
  );
}
