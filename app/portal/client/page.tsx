import { getActiveClientId, getActiveAccountId } from "@/lib/session";
import {
  getClient,
  getAccount,
  getPositions,
  getOptions,
  getMarketIndices,
  getPlacements,
  getResearchNotes,
  getAlerts,
  getSignals,
  type SignalRow,
} from "@/lib/data/queries";
import { DashboardClient } from "./DashboardClient";

// Server Component: resolves the active client + account from the session,
// fetches via the DAL, then hands raw data to the interactive client island.
// Holdings are account-scoped; alerts/bids stay person-scoped.
export default async function ClientDashboardPage() {
  const clientId = await getActiveClientId();
  const accountId = await getActiveAccountId();

  const [
    client,
    account,
    positions,
    options,
    indices,
    placements,
    notes,
    alerts,
    signals,
  ] = await Promise.all([
    getClient(clientId),
    getAccount(accountId),
    getPositions(accountId),
    getOptions(accountId),
    getMarketIndices(),
    getPlacements(),
    getResearchNotes(),
    getAlerts(clientId),
    getSignals(),
  ]);

  const cash = account?.cash ?? 0;

  const signalMap: Record<string, SignalRow> = Object.fromEntries(
    signals.map((s) => [s.code, s]),
  );

  // Morning-note time: derive from the latest research note's published ISO
  // stamp, formatted like the markets page (en-AU, Sydney, lowercased, no
  // spaces). Falls back gracefully when no note exists.
  const note = notes[0];
  const noteTime = note
    ? new Date(note.published)
        .toLocaleTimeString("en-AU", {
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
          timeZone: "Australia/Sydney",
        })
        .replace(/\s/g, "")
        .toLowerCase()
    : "—";

  return (
    <DashboardClient
      clientId={clientId}
      clientName={client?.name ?? ""}
      cash={cash}
      positions={positions}
      options={options}
      indices={indices}
      placements={placements}
      alerts={alerts}
      signals={signalMap}
      noteTime={noteTime}
    />
  );
}
