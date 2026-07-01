import { getActiveClientId } from "@/lib/session";
import {
  getPositions,
  getOptions,
  getClient,
  getSignals,
  type SignalRow,
} from "@/lib/data/queries";
import { unlistedValue } from "@/lib/data/compute";
import { PositionsClient } from "./PositionsClient";

// Server Component: resolves the active client from the session, fetches via the
// DAL, then hands data to the interactive client island.
export default async function ClientPositionsPage() {
  const clientId = await getActiveClientId();

  const [positions, options, client, signals] = await Promise.all([
    getPositions(clientId),
    getOptions(clientId),
    getClient(clientId),
    getSignals(),
  ]);

  const cash = client?.cash ?? 0;
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
