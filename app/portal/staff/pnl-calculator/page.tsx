import React from "react";
import { PnlCalculatorClient } from "./PnlCalculatorClient";

export const metadata = {
  title: "PNL Calculator | Admin Portal | Vitti Capital",
  description: "In-memory trade ledger parsing and P&L calculator.",
};

/**
 * Server actions called from this page inherit this budget, and the standing Placement
 * Tracker load needs more than the platform default (10s on Hobby, 15s on Pro).
 *
 * Measured on the real workbooks: ~6s to download both from SharePoint plus ~10.7s to
 * parse them, so ~17s on a cold cache. 60s leaves headroom for a slow link without
 * letting a genuinely stuck request hang around. Warm cache hits return in ~0ms, so this
 * ceiling is only ever reached once per server instance.
 */
export const maxDuration = 60;

export default function PnlCalculatorPage() {
  return <PnlCalculatorClient />;
}
