import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";

/**
 * The one place a link in a Supabase auth email may land.
 *
 * ── LEGACY as of the code-based email change ────────────────────────────────
 * Nothing issues these links any more. `double_confirm_changes` is off and
 * `change-email-address.html` now carries a six-digit `{{ .Token }}` that
 * `confirmEmailChange` verifies from the settings page, so the whole flow is a
 * typed code like every other credential here.
 *
 * This route is kept because links issued BEFORE that switch are still valid
 * until they expire (`otp_expiry`), and a client mid-change would otherwise
 * click a dead URL. Once no such link can remain, this file and the
 * `?email=confirmed|invalid` banner it redirects to can both go.
 *
 * ── Why the link existed at all ─────────────────────────────────────────────
 * Every credential here is a 6-digit code typed into a form (§8.32), so there
 * was nothing for a link to do — `supabase/email-templates/magic-link.html`
 * deliberately omits `{{ .ConfirmationURL }}` for exactly that reason, since a
 * link that cannot work is the thing people click first.
 *
 * Under DOUBLE confirmation an email change could not be a typed code: both the
 * old and the new mailbox had to confirm, and the last confirmation might come
 * days later from a device with no session and no form to type into. Removing
 * the old address from the flow is what made the code possible — and is also
 * what it costs, since that second mailbox was the thing stopping someone with
 * an open session from moving the login. See LLD §8.39.
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

  // The `client_emails` row is NOT updated here. It follows `auth.users.email`
  // through a trigger, because this route only sees whichever confirmation
  // happens to be last, and with double confirmation that may be the old
  // address, the new one, or neither if the person finishes on their phone. The
  // trigger observes the actual change inside the same transaction, and moves
  // the row for the address that actually moved — which matters now that a
  // client may hold several. See 20260907090000_client_settings.sql and
  // 20260911090000_client_emails.sql.
  return settled("email=confirmed");
}
