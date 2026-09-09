import { redirect } from "next/navigation";

/**
 * There is no separate staff sign-in any more.
 *
 * There were two doors: this one refused client addresses and pointed at
 * /login, and /login refused Vitti addresses and pointed here. Between them
 * they asked people to sort themselves into a category the database was going
 * to decide anyway — `role_from_email_domain` reads the domain, a trigger
 * stamps `app_metadata.role`, and sign-in lands you wherever that says. The
 * only thing the split reliably produced was somebody being told they had
 * knocked on the wrong door.
 *
 * The reasons behind the split are still handled, just not by a second page:
 * staff are provisioned on their first code request, and the password and
 * reset flows refuse Vitti addresses inside the actions themselves — which is
 * where a rule belongs, since a page was never a boundary.
 *
 * Kept as a redirect rather than deleted: this URL is in browser histories and
 * probably a bookmark or two, and a 404 for a staff member trying to sign in is
 * a poor way to explain a UI decision.
 */
export default function StaffLoginPage() {
  redirect("/login");
}
