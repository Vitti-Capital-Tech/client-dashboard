"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

/**
 * `(2) Vitti Capital` in the browser tab while alerts are unread.
 *
 * ── Why it is worth the component ───────────────────────────────────────────
 * The bell already carries the count, and the bell is only visible on the tab
 * the client is looking at. A portal left open in a background tab — which is
 * how a client who checks their portfolio through the day actually uses it —
 * shows nothing at all. The tab title is the one surface that is visible when
 * the page is not.
 *
 * ── Why the base title is recovered rather than stored ──────────────────────
 * Next owns the title: it is set from route metadata on every navigation, which
 * would overwrite a prefix written once at mount. So the effect reruns on
 * `pathname` as well as on the count, and each run strips any `(n) ` it finds
 * before writing a fresh one. Reading `document.title` rather than holding a
 * remembered copy means a route that sets its own title keeps it, and the count
 * rides in front of whatever is there.
 *
 * The strip-then-prefix order also makes the effect idempotent: running it
 * twice cannot produce `(2) (2) Vitti Capital`.
 *
 * ── What it deliberately does not do ────────────────────────────────────────
 * No favicon badge, no `document.title` flashing, no Notification API. A
 * flashing tab is a thing people close, and a browser notification permission
 * prompt on a portfolio screen is a prompt that gets denied once and then
 * cannot be asked for again. The count is quiet and always correct, which is
 * the useful half.
 */
const PREFIX = /^\(\d+\)\s*/;

export function TabUnreadCount({ count }: { count: number }) {
  const pathname = usePathname();

  useEffect(() => {
    const base = document.title.replace(PREFIX, "");
    document.title = count > 0 ? `(${count}) ${base}` : base;

    // Leave the title clean if the shell unmounts — a stale count on a page
    // that no longer shows alerts is worse than no count.
    return () => {
      document.title = document.title.replace(PREFIX, "");
    };
  }, [count, pathname]);

  return null;
}
