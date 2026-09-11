import { redirect } from "next/navigation";
import { getSession, getActiveClientId } from "@/lib/session";
import { getClient, getAccounts } from "@/lib/data/queries";
import { createClient } from "@/lib/supabase/server";
import { listLoginEmails } from "@/app/actions/emails";
import { SettingsClient } from "./SettingsClient";

/**
 * A client's own login settings.
 *
 * ── Why a Settings page and not a "profile" page ────────────────────────────
 * A profile page would have shown a client their name, their address and their
 * accounts — the first two they typed themselves, and the third is already the
 * Accounts page. It would have been a screen nobody opens twice.
 *
 * What is missing is not a place to READ those facts but a place to CHANGE them:
 * a password, the login address, and ending a session on a device you no longer
 * have. Those are the page. The read-only details are a header on top of them,
 * so you can see what you are changing.
 *
 * ── What is deliberately absent ─────────────────────────────────────────────
 * Notification preferences. Nothing in this application sends a client an email:
 * the alert engine writes rows to `alerts` that the portal renders, and the only
 * outbound mail in the system is Supabase Auth's own one-time codes. Switches
 * for mail nobody sends would be a page of controls that quietly do nothing —
 * worse than their absence, because the client would believe them.
 */
export default async function ClientSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const session = await getSession();
  if (!session) redirect("/login");

  // Staff have no `clients` row, no password (§8.32) and cannot change their
  // address onto or off the staff domain, so every control here would be
  // inapplicable or refused. Sent to their own console rather than shown a page
  // of disabled fields.
  if (session.role === "admin") redirect("/portal/staff");

  const clientId = await getActiveClientId();
  const supabase = await createClient();

  const [client, accounts, logins, hasPassword] = await Promise.all([
    getClient(clientId),
    getAccounts(clientId),
    listLoginEmails(),
    supabase.rpc("user_has_password").then(({ data, error }) => {
      if (error) {
        // Not fatal: the page still works, it just cannot tell which of the two
        // password forms to show. Assuming "has one" is the safer default — it
        // asks for a current password rather than letting one be set without a
        // check, and the action verifies it either way.
        console.error("settings: user_has_password failed — %s", error.message);
        return true;
      }
      return data === true;
    }),
  ]);

  const params = await searchParams;
  const emailNotice =
    params.email === "confirmed"
      ? "confirmed"
      : params.email === "invalid"
        ? "invalid"
        : null;

  return (
    <SettingsClient
      name={client?.name ?? "Client"}
      email={session.email}
      hasPassword={hasPassword}
      accounts={accounts.map((a) => ({
        id: a.id,
        label: a.label,
        externalRef: a.externalRef,
        accountType: a.accountType,
      }))}
      logins={logins}
      emailNotice={emailNotice}
    />
  );
}
