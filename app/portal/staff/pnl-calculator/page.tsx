import React from "react";
import { PnlCalculatorClient } from "./PnlCalculatorClient";

export const metadata = {
  title: "PNL Calculator | Admin Portal | Vitti Capital",
  description: "In-memory trade ledger parsing and P&L calculator.",
};

export default function PnlCalculatorPage() {
  return <PnlCalculatorClient />;
}
