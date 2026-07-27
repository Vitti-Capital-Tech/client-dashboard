import { getAccountHoldings, summariseHoldings } from "@/lib/data/holdings";
import { HoldingsClient, Kpi } from "./HoldingsClient";

/**
 * Staff holdings register — firm-wide client holdings and P&L, sourced from the
 * broker imports (scripts/import-holdings.mjs + scripts/import-trades.mjs).
 *
 * Server Component: reads through the DAL, which reads through RLS. Staff see
 * every account; the same query under a client session returns only theirs.
 */

const money = (n: number) =>
  (n < 0 ? "-$" : "$") +
  Math.abs(n).toLocaleString("en-AU", { maximumFractionDigits: 0 });

export default async function StaffHoldingsPage() {
  const accounts = await getAccountHoldings();
  const totals = summariseHoldings(accounts);

  return (
    <div className="space-y-4 text-ink font-body select-none">
      <div>
        <div className="font-mono text-xs tracking-wider uppercase text-mut">
          Client holdings register
        </div>
        <h1 className="font-disp font-medium text-[26px] mt-0.5">
          Holdings &amp; P&amp;L
        </h1>
        <p className="text-xs text-mut mt-1">
          Every account&rsquo;s current positions valued at the latest snapshot
          price, with realised P&amp;L replayed from the settled trade ledger.
          Companies roll up by ordinary ASX code &mdash; options and instalment
          receipts sit under their parent.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2.5">
        <Kpi
          label="Accounts"
          value={String(totals.accountCount)}
          sub={`${totals.positionCount} position lines`}
        />
        <Kpi label="Cost base" value={money(totals.costBase)} />
        <Kpi label="Market value" value={money(totals.marketValue)} />
        <Kpi
          label="Unrealised"
          value={money(totals.unrealizedPl)}
          sub={`${totals.unrealizedPct >= 0 ? "+" : ""}${totals.unrealizedPct.toFixed(1)}% on cost`}
          tone={totals.unrealizedPl >= 0 ? "gain" : "loss"}
        />
        <Kpi
          label="Realised"
          value={money(totals.realizedPl)}
          sub="settled trades only"
          tone={totals.realizedPl >= 0 ? "gain" : "loss"}
        />
        <Kpi
          label="Total P&L"
          value={money(totals.totalPl)}
          tone={totals.totalPl >= 0 ? "gain" : "loss"}
        />
      </div>

      {/* Never let an overstated number pass as a clean one. */}
      {totals.withWarnings > 0 && (
        <div className="border border-[#f0d9c9] bg-loss-bg/50 rounded-[12px] px-4 py-2.5 text-[11.5px] text-loss-d">
          <strong className="font-bold">
            {totals.withWarnings} account
            {totals.withWarnings === 1 ? " has" : "s have"} holdings with no cost
            basis.
          </strong>{" "}
          The trade ledger records sales of units it never saw bought, so its
          history starts mid-stream. Those proceeds are counted against zero
          cost, which overstates realised P&amp;L. Load an earlier trade export
          or an opening balance to correct it.
        </div>
      )}

      {accounts.length === 0 ? (
        <div className="card bg-white border border-line rounded-[14px] shadow-shadow px-5 py-10 text-center">
          <div className="font-disp text-[17px]">No holdings imported yet</div>
          <p className="text-xs text-mut mt-2 max-w-md mx-auto">
            Run the broker importers to populate this register:
          </p>
          <pre className="mt-3 inline-block text-left font-mono text-[11px] text-mut bg-paper-2 border border-line rounded-[10px] px-3.5 py-2.5 leading-relaxed">
            {`node --env-file=.env.local \\\n  scripts/import-holdings.mjs <ClientHoldings…csv>\n\nnode --env-file=.env.local \\\n  scripts/import-trades.mjs <contract-notes.csv>`}
          </pre>
        </div>
      ) : (
        <HoldingsClient accounts={accounts} />
      )}
    </div>
  );
}
