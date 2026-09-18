"use client";

import { useEffect, useState } from "react";
import { relative, absolute, stamp } from "@/lib/ui/when";

/**
 * "3h ago", and still right an hour later.
 *
 * ── Why this is a component and not a call to `relative()` ──────────────────
 * Two problems, both of which come from the fact that relative time depends on
 * *when you look*.
 *
 * The first is a drawer left open. An adviser opens the bell at 9am and leaves
 * the tab up all day; every row goes on claiming "just now" until something
 * else re-renders it. The interval below re-reads the clock each minute, which
 * is as often as the shortest unit printed can change.
 *
 * The second is hydration. This renders on the server first, and "now" there is
 * a different instant from "now" in the browser a second later — enough to turn
 * "just now" into "1m ago" between the two passes and have React complain the
 * markup does not match. So the server pass deliberately prints the ABSOLUTE
 * date, which is the same string on both machines, and the first effect swaps
 * in the relative form. `suppressHydrationWarning` covers the swap, and also
 * the timezone gap underneath it: the server formats in UTC and the browser in
 * the reader's zone, which the rest of this app already lives with.
 *
 * The exact timestamp stays available on hover for anyone reconciling an alert
 * against a contract note.
 */
export function TimeAgo({ iso, className }: { iso: string; className?: string }) {
  // Not `relative(iso, Date.now())`: see the hydration note above. The first
  // paint is the date, and it is replaced before anyone reads it.
  const [text, setText] = useState(() => absolute(iso, Date.now()));

  useEffect(() => {
    const tick = () => setText(relative(iso, Date.now()));
    tick();
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [iso]);

  return (
    <time dateTime={iso} title={stamp(iso)} className={className} suppressHydrationWarning>
      {text}
    </time>
  );
}
