import { getActiveAccountId, getActiveClientId } from "@/lib/session";
import {
  getPositions,
  getAccount,
  getSignals,
  getClientOptions,
  type SignalRow,
} from "@/lib/data/queries";
import { getClientStoredPnl } from "@/lib/data/pnl";
import { getClientPnlOverrides } from "@/lib/data/holdings";
import { clientPortfolio } from "@/lib/pnl/client-portfolio";
import { unlistedValue } from "@/lib/data/compute";
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
 * The figures now come from the same place the staff console reads, through the
 * same rollup and with the same corrections applied, so the two screens agree.
 * See `lib/pnl/client-portfolio.ts` for what is deliberately left behind.
 *
 * ── Client-scoped, and account-scoped, and not the same thing ───────────────
 * Holdings stay ACCOUNT-scoped: a client with several accounts switches between
 * them, and the holdings table is about one of them. The P&L is CLIENT-scoped,
 * matching the staff view, which aggregates a client's accounts — a portfolio
 * return that silently covered one of three accounts would be the wrong number
 * with no way to tell.
 *
 * Either way a client only ever reads their own rows: the getters filter on the
 * id from `getActiveClientId()` (resolved from their verified JWT email, never a
 * cookie), and `pnl_summary` / `pnl_overrides` / `positions` all carry RLS of
 * `is_staff() OR client_id = current_client_id()`.
 */
export default async function ClientPositionsPage() {
  const [accountId, clientId] = await Promise.all([
    getActiveAccountId(),
    getActiveClientId(),
  ]);

  const [positions, options, account, signals, storedPnl, overrides] = await Promise.all([
    getPositions(accountId),
    getClientOptions(clientId),
    getAccount(accountId),
    getSignals(),
    clientId ? getClientStoredPnl(clientId) : Promise.resolve([]),
    clientId ? getClientPnlOverrides(clientId) : Promise.resolve([]),
  ]);

  const cash = account?.cash ?? 0;
  const unlisted = unlistedValue(options);
  const signalMap: Record<string, SignalRow> = Object.fromEntries(
    signals.map((s) => [s.code, s]),
  );

  return (
    <PositionsClient
      positions={positions}
      cash={cash}
      unlisted={unlisted}
      signals={signalMap}
      portfolio={clientPortfolio(storedPnl, overrides)}
    />
  );
}
