import { getClients, getPlacements } from "@/lib/data/queries";
import { StaffPlacementsClient } from "./StaffPlacementsClient";

// Server Component: placements bookmanager. Fetches placements + clients from
// the DAL and hands plain serializable props to the client island, which holds
// all the manage/allocation/settlement interactivity.
export default async function StaffPlacementsPage() {
  const [placements, clients] = await Promise.all([
    getPlacements(),
    getClients(),
  ]);

  return <StaffPlacementsClient placements={placements} clients={clients} />;
}
