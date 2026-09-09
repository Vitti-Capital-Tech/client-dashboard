import { PortalSkeleton } from "@/app/components/PortalSkeleton";

/**
 * The route-level fallback, for navigations the shell does not drive: a typed
 * URL, a reload, the browser's back button. Clicking a nav item is handled in
 * `PortalShell`, which cannot wait for this one — see the comment there.
 */
export default function PortalLoading() {
  return <PortalSkeleton />;
}
