"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { RealtimeChannel } from "@supabase/supabase-js";
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
 * ── The bug this file shipped with, and the fix ─────────────────────────────
 * The first version subscribed on mount, synchronously. It connected, reported
 * no error, and delivered nothing — the badge only moved on a reload.
 *
 * The session is read from cookies and hydrated ASYNCHRONOUSLY. Subscribing
 * before that lands means the websocket authorises with the anon key, and
 * `alerts_select` is `is_staff() OR client_id = current_client_id()` — which for
 * anon is false for every row in the table. So RLS did exactly its job and
 * filtered the entire stream, and because an empty stream is what a quiet
 * database also looks like, nothing anywhere reported a problem.
 *
 * The session is therefore awaited, and its token handed to the realtime client
 * explicitly, BEFORE the channel is created. `onAuthStateChange` re-arms it: an
 * access token expires roughly hourly, and a portal left open all day would
 * otherwise go quiet again at the first refresh.
 *
 * ── Why `router.refresh()` and not client-side state ────────────────────────
 * The obvious version maps the payload into an `AlertRow` and prepends it to a
 * local array — a second implementation of the mapping `lib/data/queries.ts`
 * already owns, kept in step by hand. `router.refresh()` re-runs the Server
 * Component that fetched the alerts, so there is one path from row to screen
 * and the payload is never read or trusted.
 *
 * ── Scoping is RLS's job, not a filter's ────────────────────────────────────
 * No `filter:` clause. Supabase authorises `postgres_changes` against the same
 * policies as a query, so a client's socket carries only their own rows. A
 * filter here would state the scoping rule in a second, worse place.
 *
 * Renders nothing.
 */
export function AlertsLive() {
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();
    let channel: RealtimeChannel | null = null;
    let cancelled = false;

    /**
     * Kept out of the subscribe callback so a token refresh cannot resubscribe:
     * `setAuth` updates the existing socket's credentials in place, and tearing
     * the channel down on every hourly refresh would drop events in the gap.
     */
    const { data: authSub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.access_token) void supabase.realtime.setAuth(session.access_token);
    });

    void (async () => {
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      // No session means a signed-out or still-loading shell. Subscribing
      // anyway is what produced a silent stream; better to do nothing and let
      // the effect re-run when the page that has a session mounts.
      if (!token || cancelled) return;

      await supabase.realtime.setAuth(token);
      if (cancelled) return;

      channel = supabase
        .channel("alerts-live")
        .on(
          "postgres_changes",
          // INSERT only. An UPDATE is almost always this session acknowledging
          // one, and refreshing in response to your own click would fight the
          // optimistic update already on screen.
          { event: "INSERT", schema: "public", table: "alerts" },
          () => {
            // Before the refresh, not after: the chime should land with the
            // badge rather than a server round trip later.
            void playAlertChime();
            router.refresh();
          },
        )
        .subscribe((status) => {
          // A channel that cannot subscribe is the failure that looks exactly
          // like a quiet market. Say so once, in the console, rather than
          // leaving the next person to discover it the way this one was.
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            console.warn("[alerts] realtime channel:", status);
          }
        });
    })();

    return () => {
      cancelled = true;
      authSub.subscription.unsubscribe();
      if (channel) void supabase.removeChannel(channel);
    };
  }, [router]);

  return null;
}
