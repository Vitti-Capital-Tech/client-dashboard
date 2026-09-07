import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

/**
 * The one place a link in a Supabase auth email may land.
 *
 * ── Why this app had no callback route until now ────────────────────────────
 * Every credential here is a 6-digit code typed into a form (§8.32), so there
 * was nothing for a link to do — `supabase/email-templates/magic-link.html`
 * deliberately omits `{{ .ConfirmationURL }}` for exactly that reason, since a
 * link that cannot work is the thing people click first.
 *
 * Changing a login email is the one flow that cannot be a typed code. The change
 * has to be confirmed from BOTH the old and the new mailbox
 * (`double_confirm_changes`), and the new address is not a registered user yet —
 * so there is no `verifyOtp` call the app could make on its behalf and no form
 * to put the code into. Supabase sends links; this is where they arrive.
 *
 * ── What it will and will not do ────────────────────────────────────────────
 * `email_change` only. A route that accepted every `type` would become a second
 * way to sign in — a bearer token in a URL, sitting in browser history and
 * referrer headers — alongside the code flow that was chosen precisely to avoid
 * that. `recovery` in particular is refused: password reset already has a form.
 *
 * The token is verified server-side, so the session cookie is written by the
 * server client's adapter rather than parsed out of a URL fragment in the
 * browser. `token_hash` (not the older `#access_token=` fragment) is what makes
 * that possible.
 */

/** Only the email-change confirmations. Anything else is not this route's job. */
const ALLOWED: EmailOtpType[] = ["email_change"];

export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  const settled = (params: string) =>
    NextResponse.redirect(`${origin}/portal/client/settings?${params}`);

  if (!tokenHash || !type) {
    return settled("email=invalid");
  }
  if (!ALLOWED.includes(type)) {
    console.warn("auth/confirm: refused type %s", type);
    return settled("email=invalid");
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });

  if (error) {
    // Expired, already used, or the other half of the pair not yet confirmed.
    // One answer for all three: the person's next step is the same either way,
    // and distinguishing them tells a stranger holding a stale link which kind
    // of stale it is.
    console.warn("auth/confirm: %s failed — %s", type, error.message);
    return settled("email=invalid");
  }

  // `clients.email` is NOT updated here. It follows `auth.users.email` through a
  // trigger, because this route only sees whichever confirmation happens to be
  // last, and with double confirmation that may be the old address, the new one,
  // or neither if the person finishes on their phone. The trigger observes the
  // actual change inside the same transaction. See
  // 20260907090000_client_settings.sql.
  return settled("email=confirmed");
}
