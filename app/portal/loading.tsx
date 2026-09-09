import { Skeleton } from "@/app/components/Skeleton";

/**
 * What the content area shows while the next page is being fetched.
 *
 * ── Why switching tabs felt broken ─────────────────────────────────────────
 * Every portal page is dynamic and reads from Supabase, where a single round
 * trip has a measured floor of about 350ms from here — a page that makes five
 * of them is most of a second before it can render anything. Until now that
 * time was spent on the OLD page: you clicked Portfolio, nothing happened, and
 * then the screen changed all at once. Nothing was broken and it read as
 * broken, which is the same problem.
 *
 * A `loading.tsx` puts a Suspense boundary around everything below
 * `app/portal`, so the router swaps this in the moment a nav item is clicked
 * and streams the real page in behind it. The click now has an effect on the
 * same frame as the click.
 *
 * ── Why it sits here and not on each page ──────────────────────────────────
 * At this level the shell stays: the sidebar, the top bar and the alerts drawer
 * are the layout, they are above this boundary, and they stay interactive while
 * the content is fetched. Only the part that is actually changing is replaced.
 *
 * One skeleton covers every portal route, client and staff, so its shape is the
 * shape they have in common — a heading, some figures, a table — rather than
 * any one page's exact layout. A per-route `loading.tsx` beats this for a
 * specific screen; it drops in beside that page whenever a screen is worth one.
 *
 * ── What it deliberately does not do ───────────────────────────────────────
 * It draws no numbers, no labels and no headings. A skeleton with real-looking
 * figures in it is a page that lies for half a second, and on a screen showing
 * somebody's money that is not a trade worth making for a slightly prettier
 * wait. Grey blocks say "not yet" and cannot say anything false.
 */
export default function PortalLoading() {
  return (
    <div className="space-y-5" role="status" aria-label="Loading">
      {/* Page header: eyebrow, title, standfirst. */}
      <div className="space-y-2">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-6 w-52" />
        <Skeleton className="h-3 w-72 max-w-full" />
      </div>

      {/* The row of figures most portal pages open with. */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="card bg-white border border-line rounded-[14px] shadow-shadow p-4.5 space-y-2.5"
          >
            <Skeleton className="h-2.5 w-20" />
            <Skeleton className="h-6 w-28" />
            <Skeleton className="h-2.5 w-16" />
          </div>
        ))}
      </div>

      {/* And the table under them. Six rows: enough to read as a table, few
          enough that it is gone before anybody counts them. */}
      <div className="card bg-white border border-line rounded-[14px] shadow-shadow overflow-hidden">
        <div className="px-4.5 py-3.5 border-b border-line">
          <Skeleton className="h-3.5 w-36" />
        </div>
        <div className="divide-y divide-line">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex items-center gap-4 px-4.5 py-3.5">
              <Skeleton className="h-3 w-16 flex-none" />
              <Skeleton className="h-3 flex-1 max-w-64" />
              <Skeleton className="h-3 w-20 flex-none hidden sm:block" />
              <Skeleton className="h-3 w-16 flex-none ml-auto" />
            </div>
          ))}
        </div>
      </div>

      <span className="sr-only">Loading…</span>
    </div>
  );
}
