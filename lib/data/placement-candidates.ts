import "server-only";
import { cache } from "react";
import { createClient } from "../supabase/server";

/**
 * Reads of the deal-mail inbox (`placement_candidates`).
 *
 * A candidate is a deal the broker mail told us about, not a deal the desk can
 * take money against — the upstream feed carries a ticker, a subject and a prose
 * summary, and nothing a bid could be measured against. See the migration for
 * why that is two tables rather than one.
 *
 * Staff-only by RLS. These rows are the desk's own deal flow: which raises it
 * was offered, and which it passed on.
 */

export type PlacementCandidateRow = {
  id: string;
  ticker: string;
  company: string;
  /** 'Placement' | 'IPO', as classified upstream. */
  dealType: string;
  subject: string;
  summary: string;
  receivedAt: string;
  firstSeenAt: string;
  /** Set once promoted — the deal this mail became. */
  placementId: string | null;
  promotedAt: string | null;
  promotedBy: string | null;
  dismissedAt: string | null;
  dismissedBy: string | null;
  dismissReason: string | null;
};

/** As PostgREST returns it. */
type CandidateRecord = {
  id: string;
  ticker: string;
  company: string | null;
  deal_type: string;
  subject: string | null;
  summary: string | null;
  received_at: string;
  first_seen_at: string;
  placement_id: string | null;
  promoted_at: string | null;
  promoted_by: string | null;
  dismissed_at: string | null;
  dismissed_by: string | null;
  dismiss_reason: string | null;
};

/**
 * The inbox, newest first.
 *
 * Everything is returned — promoted and dismissed included — and the split is
 * left to the caller. A decided candidate is the trail from a mail to the deal
 * it became, and hiding it in the query would mean the only way to answer "did
 * we ever see this one?" is a SQL console.
 */
export const getPlacementCandidates = cache(
  async (limit = 60): Promise<PlacementCandidateRow[]> => {
    const supabase = await createClient();

    const { data, error } = await supabase
      .from("placement_candidates")
      .select("*")
      .order("received_at", { ascending: false })
      .limit(limit);
    if (error) throw error;

    return ((data ?? []) as CandidateRecord[]).map((c) => ({
      id: c.id,
      ticker: c.ticker,
      company: c.company || c.ticker,
      dealType: c.deal_type,
      subject: c.subject ?? "",
      summary: c.summary ?? "",
      receivedAt: c.received_at,
      firstSeenAt: c.first_seen_at,
      placementId: c.placement_id,
      promotedAt: c.promoted_at,
      promotedBy: c.promoted_by,
      dismissedAt: c.dismissed_at,
      dismissedBy: c.dismissed_by,
      dismissReason: c.dismiss_reason,
    }));
  },
);
