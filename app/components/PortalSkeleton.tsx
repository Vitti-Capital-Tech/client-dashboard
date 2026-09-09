import { Skeleton } from "@/app/components/Skeleton";

/**
 * The shape of a portal page, before the page arrives.
 *
 * Shown from two places, which is why it is a component rather than living in
 * `loading.tsx`:
 *
 *   • `app/portal/loading.tsx`, the route-level Suspense fallback;
 *   • `PortalShell`, the moment a nav item is clicked — see the transition
 *     there for why waiting for the router is not good enough.
 *
 * One skeleton covers every portal route, client and staff, so its shape is
 * what they have in common — a heading, some figures, a table — rather than any
 * one page's exact layout.
 *
 * It draws no numbers, labels or headings. A skeleton with real-looking figures
 * is a page that lies for half a second, and on a screen showing somebody's
 * money that is not a trade worth making for a prettier wait. Grey blocks say
 * "not yet" and cannot say anything false.
 */
export function PortalSkeleton() {
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
