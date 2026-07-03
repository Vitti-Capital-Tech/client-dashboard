import { getMergeRequests } from "@/lib/data/queries";
import { MergeRequestsClient } from "./MergeRequestsClient";

// Server Component (staff): all account-merge requests (pending first via the
// DAL's desc order is by requested_at — we split pending in the island).
export default async function StaffMergeRequestsPage() {
  const requests = await getMergeRequests();
  return <MergeRequestsClient requests={requests} />;
}
