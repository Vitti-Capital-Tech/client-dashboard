import { getActiveClientId } from "@/lib/session";
import { getClientOptions } from "@/lib/data/queries";
import { getClientStoredPnl } from "@/lib/data/pnl";
import { optionsFromSources, toClientOptionViews } from "@/lib/options/from-stored-pnl";
import { OptionsClient } from "./OptionsClient";

/**
 * Server Component: the client's own options register.
 *
 * ── Why this reads stored P&L and not `option_holdings` ─────────────────────
 * It used to read `option_holdings` for the active account, and that table has
 * never held a row: it was demo-seed data, and nothing in the broker import or
 * the Placement Tracker pipeline writes it. So the tab was empty for every
 * client in the database — which nobody noticed until the first real client
 * signed in, because staff were looking at the console, which reads the stored
 * P&L rows where the option positions actually arrive.
 *
 * Both screens now derive the register from the same rows by the same rules
 * (`lib/options/from-stored-pnl.ts`). `option_holdings` is still read, so that
 * anything ever entered there shows up rather than being silently dropped.
 *
 * ── A client sees only their own rows ───────────────────────────────────────
 * Enforced twice, and the second one is the one that counts:
 *
 *   • both getters filter on `client_id` explicitly, and the id comes from
 *     `getActiveClientId()`, which for a client resolves from their verified JWT
 *     email — never from a cookie (that path is staff-only);
 *   • `pnl_summary` and `option_holdings` carry RLS policies of
 *     `is_staff() OR client_id = current_client_id()`, so Postgres refuses
 *     another client's rows whatever this page asks for.
 *
 * `getActiveClientId()` returns "" for a signed-in user with no matching client
 * row. That is rendered as an empty register rather than passed to the getters,
 * because "" is not a client id and asking for it would be a query written on
 * the assumption that it cannot match anything.
 */
export default async function ClientOptionsPage() {
  const clientId = await getActiveClientId();
  if (!clientId) return <OptionsClient options={[]} />;

  const [storedPnl, holdings] = await Promise.all([
    getClientStoredPnl(clientId),
    getClientOptions(clientId),
  ]);

  const options = toClientOptionViews(optionsFromSources(storedPnl, holdings));

  return <OptionsClient options={options} />;
}
