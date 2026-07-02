import { getClients, getClientOptions } from "@/lib/data/queries";
import { StaffOptionsClient } from "./StaffOptionsClient";

// Server Component: options tracker across all clients (all their accounts),
// fetched via the DAL. All interactivity (filters, modal) lives in the island.
export default async function StaffOptionsPage() {
  const clients = await getClients();
  const optionsByClient = await Promise.all(
    clients.map((c) => getClientOptions(c.id)),
  );
  const options = optionsByClient.flat();

  return <StaffOptionsClient options={options} clients={clients} />;
}
