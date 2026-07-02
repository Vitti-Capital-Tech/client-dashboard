import { getActiveAccountId } from "@/lib/session";
import {
  getPositions,
  getOptions,
  getAccount,
  getSignals,
  type SignalRow,
} from "@/lib/data/queries";
import { unlistedValue } from "@/lib/data/compute";
import { PositionsClient } from "./PositionsClient";

// Server Component: resolves the active account from the session, fetches via
// the DAL, then hands data to the interactive client island.
export default async function ClientPositionsPage() {
  const accountId = await getActiveAccountId();

  const [positions, options, account, signals] = await Promise.all([
    getPositions(accountId),
    getOptions(accountId),
    getAccount(accountId),
    getSignals(),
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
    />
  );
}
