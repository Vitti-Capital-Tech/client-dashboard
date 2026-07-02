import { getActiveAccountId } from "@/lib/session";
import { getOptions } from "@/lib/data/queries";
import { OptionsClient } from "./OptionsClient";

// Server Component: resolves the active account from the session, fetches via
// the DAL, then hands data to the interactive client island.
export default async function ClientOptionsPage() {
  const accountId = await getActiveAccountId();
  const options = await getOptions(accountId);

  return <OptionsClient options={options} />;
}
