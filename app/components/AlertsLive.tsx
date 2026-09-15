"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { playAlertChime } from "./alertSound";

/**
 * Makes the alerts bell arrive rather than wait to be found.
 *
 * ── Why this is needed at all ───────────────────────────────────────────────
 * Alerts are now written by a cron scan rather than by the client's own
 * actions, which is the point of the feature and also its problem: the row
 * appears in Postgres while the page has been open for an hour, and the badge
 * goes on saying whatever it said at render. An alert about an exercise window
 * closing is worth very little if the client has to reload to be told.
 *
 * ── Why `router.refresh()` and not client-side state ────────────────────────
 * The obvious version subscribes, maps the payload into an `AlertRow` and
 * prepends it to a local array. That means a second implementation of the
 * mapping `lib/data/queries.ts` already owns, kept in step by hand, and a
 * drawer whose contents were assembled two different ways depending on whether
 * you reloaded. `router.refresh()` re-runs the Server Component that fetched
 * the alerts in the first place, so there is still exactly one path from row to
 * screen — the socket is a nudge, not a data source.
 *
 * It also means the payload itself is never trusted or read.
 *
 * ── Scoping is RLS's job, not a filter's ────────────────────────────────────
 * No `filter:` clause. Supabase authorises `postgres_changes` against the same
 * RLS policies as a query, so a client's socket only ever carries rows where
 * `client_id = current_client_id()`. Adding a filter here would put the
 * scoping rule in a second place, and the wrong one — a filter that drifted
 * would leak nothing (RLS still holds) but would silently stop delivering.
 *
 * Renders nothing.
 */
export function AlertsLive() {
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel("alerts-live")
      .on(
        "postgres_changes",
        // INSERT only. An UPDATE is almost always this session acknowledging
        // one, and refreshing in response to your own click would fight the
        // optimistic update already on screen.
        { event: "INSERT", schema: "public", table: "alerts" },
        () => {
          // Before the refresh, not after: the chime should land with the badge
          // rather than after a server round trip.
          playAlertChime();
          router.refresh();
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [router]);

  return null;
}
