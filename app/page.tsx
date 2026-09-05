import { redirect } from "next/navigation";

/**
 * There is no landing page.
 *
 * `/` used to be a marketing splash — a headline, two descriptive cards, and a
 * link to `/login`. It was removed deliberately: this is a portal for existing
 * wholesale clients and the desk that runs their money, not a product anyone
 * arrives at cold. Everybody who loads `/` is here to sign in, and the splash
 * was one click between them and the form.
 *
 * A redirect rather than rendering the login form at `/` as well: one page, one
 * URL. Two routes serving the same form would mean two things to keep in step,
 * and `/login` is the one the proxy already redirects unauthenticated portal
 * traffic to.
 *
 * A signed-in visitor is not special-cased here — they land on `/login` and the
 * proxy forwards them to their portal from there, which is the same logic in one
 * place rather than two.
 */
export default function Home() {
  redirect("/login");
}
