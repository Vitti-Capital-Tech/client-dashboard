"use client";

import { useEffect, useRef } from "react";
import type { AlertRow } from "@/lib/data/queries";
import { markAlertsRead } from "@/app/actions/alerts";

/**
 * Reading the list is what marks it read. Nobody clicks anything.
 *
 * ── What this replaced ──────────────────────────────────────────────────────
 * An "Ack" button on every row. The badge could only be cleared by clicking it
 * once per alert, which on the staff console meant 141 clicks, which meant
 * nobody ever did — so the console shipped a permanently red counter that had
 * stopped meaning anything. A notification you must confirm having read is a
 * chore, not a notification.
 *
 * ── Why on CLOSE and not on open ────────────────────────────────────────────
 * Marking read on open is the obvious version and it fights the reader. The
 * server write comes back, `read` flips true on every row, and the highlighting
 * that told them *which three of these forty are new* disappears while they are
 * still looking at it. Avoiding that means snapshotting the ids at open and
 * rendering from the snapshot rather than from the data — a second, shadow copy
 * of read state living in component state, kept in step by hand.
 *
 * Deferring the write to when the panel closes gets the same result with none
 * of it. For the whole time the list is open, `!alert.read` IS the answer to
 * "is this new", straight from the server, and the New/Earlier split needs
 * nothing but that. The badge clears on the way out, which is also when anyone
 * would look at it again.
 *
 * It fails safe, too: a closed laptop or a crashed tab leaves the alerts unread
 * and they are shown again. The opposite failure — swallowing an unread expiry
 * warning — is the one that matters here.
 *
 * ── Why the cutoff is the newest alert, not `now()` ─────────────────────────
 * An alert can land while the panel is open; the realtime channel is what makes
 * that likely. Passing the newest timestamp the reader was actually SHOWN is
 * the accurate statement of what they saw. In practice the newest row is always
 * on screen — it is sorted to the top — so this marks exactly the list they had
 * in front of them and nothing that arrived behind it.
 *
 * ── Why the ref ─────────────────────────────────────────────────────────────
 * The cleanup needs the rows as they were at the moment of closing, but it must
 * fire ONLY on closing. Depending on `alerts` would re-run the whole effect —
 * and so mark read — on every render instead. So the rows are mirrored into a
 * ref by an effect that runs on every render, and the cleanup reads that.
 *
 * In dev, StrictMode's double-mount fires the cleanup once for a view that
 * starts open (the alerts pages, where `active` is `true` from the first
 * render), so those mark read on arrival rather than on leaving. Production
 * mounts once and does not.
 *
 * @param alerts the rows this view is displaying, newest first
 * @param active whether the view is open — a drawer's state, or `true` for a
 *               page, which is open by virtue of having been navigated to
 */
export function useAlertsRead(alerts: AlertRow[], active: boolean): void {
  const shown = useRef<{ newest: string | null; anyUnread: boolean }>({
    newest: null,
    anyUnread: false,
  });

  useEffect(() => {
    shown.current = {
      newest: alerts[0]?.ts ?? null,
      anyUnread: alerts.some((a) => !a.read),
    };
  });

  useEffect(() => {
    if (!active) return;

    return () => {
      const { newest, anyUnread } = shown.current;
      // Nothing unread means nothing to write. Without this, every close of an
      // already-read drawer costs a round trip and a full layout revalidation.
      if (!newest || !anyUnread) return;

      // Deliberately not awaited and deliberately not surfaced. This is
      // bookkeeping the reader did not ask for, on a view they have just
      // closed: if the write fails the alerts stay unread and they see them
      // again, which is the safe direction to fail in.
      void markAlertsRead(newest).catch((err) => {
        console.warn("[alerts] could not mark read:", err);
      });
    };
  }, [active]);
}
