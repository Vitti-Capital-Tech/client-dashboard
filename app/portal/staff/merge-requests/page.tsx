import { getMergeRequests, getAccountClaims } from "@/lib/data/queries";
import { MergeRequestsClient } from "./MergeRequestsClient";

// Server Component (staff): every client-account request awaiting the desk —
// claims over an existing account and merges between two of a client's own.
// Both are fetched whole (pending first is split in the island) because the
// decided history is what makes an approval reversible by hand.
export default async function StaffMergeRequestsPage() {
  const [requests, claims] = await Promise.all([
    getMergeRequests(),
    getAccountClaims(),
  ]);
  return <MergeRequestsClient requests={requests} claims={claims} />;
}
