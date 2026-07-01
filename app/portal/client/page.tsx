import { getActiveClientId } from "@/lib/session";
import {
  getClient,
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

// Server Component: resolves the active client from the session, fetches via the
// DAL, then hands raw data + clientId to the interactive client island (which
// computes with the client-safe helpers, matching PositionsClient).
export default async function ClientDashboardPage() {
  const clientId = await getActiveClientId();

  const [
    client,
    positions,
    options,
    indices,
    placements,
    notes,
    alerts,
    signals,
  ] = await Promise.all([
    getClient(clientId),
    getPositions(clientId),
    getOptions(clientId),
    getMarketIndices(),
    getPlacements(),
    getResearchNotes(),
    getAlerts(clientId),
    getSignals(),
  ]);

  const cash = client?.cash ?? 0;

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
