import { getClients, getPlacements, getAccounts } from "@/lib/data/queries";
import { getPlacementCandidates } from "@/lib/data/placement-candidates";
import { StaffPlacementsClient } from "./StaffPlacementsClient";
import { DealMailInbox } from "./DealMailInbox";

// Server Component: placements bookmanager. Fetches placements + clients from
// the DAL and hands plain serializable props to the client island, which holds
// all the manage/allocation/settlement interactivity.
//
// `accounts` is every account, not one client's: a bid is booked against an
// ACCOUNT (bids are unique per placement × account), and a client can hold
// several, so the booking control has to name which one. Both the deal book and
// the mail inbox book bids, so both get the list.
export default async function StaffPlacementsPage() {
  const [placements, clients, accounts, candidates] = await Promise.all([
    getPlacements(),
    getClients(),
    getAccounts(),
    getPlacementCandidates(),
  ]);

  return (
    <div className="space-y-4">
      <DealMailInbox candidates={candidates} clients={clients} accounts={accounts} />
      <StaffPlacementsClient
        placements={placements}
        clients={clients}
        accounts={accounts}
      />
    </div>
  );
}
