import { getActiveAccountId, getActiveClientId } from "@/lib/session";
import {
  getAccounts,
  getClientPositions,
  getSignals,
  getClientTrades,
  getSecurityCommentary,
  type SignalRow,
} from "@/lib/data/queries";
import { getClientStoredPnl } from "@/lib/data/pnl";
import { getClientPnlOverrides } from "@/lib/data/holdings";
import { clientSummary, type ClientSummary } from "@/lib/pnl/client-portfolio";
import { offLedgerBuyLines } from "@/lib/pnl/off-ledger-buys";
import type { LedgerLine } from "@/lib/import/trades";
import { PositionsClient } from "./PositionsClient";

/**
 * Server Component: the client's own portfolio.
 *
 * ── Two sources, on purpose, answering different questions ──────────────────
 * `positions` is the current holdings snapshot and answers "what do I hold and
 * what is it worth right now". The stored P&L rows answer "what have these
 * holdings made", including parcels already sold — which mark-to-market on
 * current holdings cannot know about, and which is why the client's own P&L
 * used to be a thinner number than the one their adviser was reading.
 *
 * The figures come from the same place the staff console reads, through the
 * same rollup and with the same corrections applied, so the two screens agree.
 * See `lib/pnl/client-portfolio.ts` for what is deliberately left behind.
 *
 * ── Why the rows arrive pre-scoped, one set per account ─────────────────────
 * The page carries the staff console's own account filter — All accounts, or
 * one of them — and Holdings, Historical P&L and Options all follow it. The
 * holdings and the ledger can be filtered in the browser, because a position
 * and a contract note each state which account they belong to.
 *
 * The P&L summary rows cannot, and the reason is the overrides: a desk
 * correction is stored PER ACCOUNT, and `storedToSummaryRows` resolves it while
 * building the row. Filtering finished rows would apply one account's
 * correction to another's figures, which is precisely the arithmetic the
 * staff page avoids by scoping the stored rows first. So each scope is built
 * here, the same way, and the browser picks one.
 *
 * That is also what keeps `note` — the desk's free-text reason, kept for the
 * audit trail — out of the payload entirely rather than merely off the screen.
 * `clientSummary` blanks it, and it can only do that on the server.
 *
 * ── A client only ever reads their own rows ─────────────────────────────────
 * Every getter filters on the id from `getActiveClientId()`, resolved from the
 * client's verified JWT email and never from a cookie, and `pnl_summary` /
 * `pnl_overrides` / `positions` / `trades` all carry RLS of
 * `is_staff() OR client_id = current_client_id()`.
 */
export default async function ClientPositionsPage() {
  const [activeAccountId, clientId] = await Promise.all([
    getActiveAccountId(),
    getActiveClientId(),
  ]);

  const [
    accounts,
    positions,
    signals,
    storedPnl,
    overrides,
    trades,
    commentaryByCode,
  ] = await Promise.all([
    getAccounts(clientId),
    // The client's WHOLE book, not one account's: the account filter lives in
    // the island now, so the page cannot know which account is being asked for.
    clientId ? getClientPositions(clientId) : Promise.resolve([]),
    getSignals(),
    clientId ? getClientStoredPnl(clientId) : Promise.resolve([]),
    clientId ? getClientPnlOverrides(clientId) : Promise.resolve([]),
    clientId ? getClientTrades(clientId) : Promise.resolve([]),
    getSecurityCommentary(),
  ]);

  const signalMap: Record<string, SignalRow> = Object.fromEntries(
    signals.map((s) => [s.code, s]),
  );

  /**
   * The summary rows the filter can select between.
   *
   * `all` is always built — it is what a single-account client sees, and what
   * the Analytics tab reads whichever account is selected. Per-account scopes
   * are built only where there is more than one account to choose from, which
   * is also the only case where the filter renders at all.
   */
  const summaryByScope: Record<string, ClientSummary> = {
    all: clientSummary(storedPnl, overrides),
  };

  /**
   * The purchases the contract-note ledger never recorded — a placement reaches
   * the client as a sale with no matching buy — recovered per scope so the
   * realised table and the by-month chart can cost those sales.
   *
   * Built HERE rather than in the island for the same reason as above and one
   * more: the difference has to be taken against the PRE-override stored
   * figures. A desk correction reaches the realised figures separately, through
   * `overrideDeltas`, and taking it into account twice would move the client's
   * realised P&L by the size of the correction all over again.
   * `clientSummary` deliberately does not ship those pre-override values.
   *
   * See lib/pnl/off-ledger-buys.ts for what the difference is and why.
   */
  const offLedgerByScope: Record<string, LedgerLine[]> = {
    all: offLedgerBuyLines(storedPnl, trades),
  };

  if (accounts.length > 1) {
    for (const a of accounts) {
      const accountStored = storedPnl.filter((r) => r.accountId === a.id);
      const accountTrades = trades.filter((t) => t.accountId === a.id);
      summaryByScope[a.id] = clientSummary(
        accountStored,
        overrides.filter((o) => o.accountId === a.id),
      );
      offLedgerByScope[a.id] = offLedgerBuyLines(accountStored, accountTrades);
    }
  }

  return (
    <PositionsClient
      accounts={accounts}
      activeAccountId={activeAccountId}
      positions={positions}
      signals={signalMap}
      summaryByScope={summaryByScope}
      offLedgerByScope={offLedgerByScope}
      trades={trades}
      commentary={Object.fromEntries(commentaryByCode)}
    />
  );
}
