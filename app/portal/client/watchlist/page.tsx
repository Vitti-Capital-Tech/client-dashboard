import { getActiveClientId } from "@/lib/session";
import {
  getWatchlist,
  getPlacements,
  getRecommendations,
} from "@/lib/data/queries";
import { getQuotes } from "@/lib/asx/quotes";
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

  /**
   * Live prices, because the register cannot answer for a watchlist.
   *
   * `securities.last_price` is written by the holdings import, so it exists
   * only for things somebody already holds — and a watchlist is a list of
   * things they do not. It is also as old as the last import, and a watchlist
   * is opened to see where a price is now.
   */
  const quotes = await getQuotes(
    watchlist.map((w) => w.code).filter((c): c is string => Boolean(c)),
  );
  const priced = watchlist.map((w) => {
    const q = w.code ? quotes.get(w.code) : undefined;
    return { ...w, last: q?.last ?? w.last, changePct: q?.changePct ?? null };
  });

  return (
    <WatchlistClient
      watchlist={priced}
      placements={placements}
      recos={recos}
      clientId={clientId}
    />
  );
}
