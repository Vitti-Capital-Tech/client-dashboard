import { getActiveClientId } from "@/lib/session";
import {
  getWatchlist,
  getPlacements,
  getRecommendations,
} from "@/lib/data/queries";
import { WatchlistClient } from "./WatchlistClient";

// Server Component: resolves the active client from the session, fetches via the
// DAL, then hands data to the interactive client island.
export default async function ClientWatchlistPage() {
  const clientId = await getActiveClientId();

  const [watchlist, placements, recos] = await Promise.all([
    getWatchlist(clientId),
    getPlacements(),
    getRecommendations(),
  ]);

  return (
    <WatchlistClient
      watchlist={watchlist}
      placements={placements}
      recos={recos}
      clientId={clientId}
    />
  );
}
