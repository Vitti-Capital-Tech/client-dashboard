/**
 * This deployment's own public origin, e.g. `https://client.vitticapital.ai`.
 *
 * Lived in `lib/placements/mail-hook.ts` until an auth flow needed it too. It
 * was never a placements concern — Graph needed a callback URL, and now the
 * email-change confirmation needs one — so it moved somewhere neither feature
 * owns. `mail-hook.ts` re-exports it, so its callers and tests are unchanged.
 *
 * `APP_URL` first, so a deployment can state its own name; then Vercel's
 * production URL, which is set on every deployment and means the common case
 * needs no configuration at all.
 *
 * Returns `null` rather than a guess when neither is set. A caller that needs an
 * absolute URL — and both of them do, since these end up in somebody else's
 * mailbox — should refuse rather than send a link to a host it invented.
 */
export function publicOrigin(): string | null {
  const explicit = process.env.APP_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  return vercel ? `https://${vercel.replace(/\/+$/, "")}` : null;
}

/**
 * Where an auth email's confirmation link should come back to.
 *
 * Passed to Supabase as `emailRedirectTo` so the template does not have to name
 * an environment. `{{ .SiteURL }}` is ONE project-level value, and this project
 * serves local development and production from the same Supabase instance — so
 * a template built on it sends every client a link to whichever environment
 * happened to be configured last. That is not hypothetical: it mailed
 * `localhost:3000`.
 *
 * The address must also be in Supabase's **Redirect URLs** allow-list. GoTrue
 * silently falls back to the Site URL for anything not on it, so a missing entry
 * looks exactly like this function not being called.
 */
export function authConfirmUrl(): string | null {
  const origin = publicOrigin();
  return origin ? `${origin}/auth/confirm` : null;
}
