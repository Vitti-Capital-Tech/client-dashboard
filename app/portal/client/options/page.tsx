import { getActiveClientId } from "@/lib/session";
import { getOptions } from "@/lib/data/queries";
import { OptionsClient } from "./OptionsClient";

// Server Component: resolves the active client from the session, fetches via the
// DAL, then hands data to the interactive client island.
export default async function ClientOptionsPage() {
  const clientId = await getActiveClientId();
  const options = await getOptions(clientId);

  return <OptionsClient options={options} />;
}
