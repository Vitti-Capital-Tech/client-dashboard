// Provision Supabase Auth users.
// ----------------------------------------------------------------------------
// Creates the auth users who are allowed to sign in. Idempotent: re-running
// leaves an existing user alone rather than erroring.
//
// NO PASSWORD is set, and no role is stamped here:
//
//   • Sign-in is a one-time code emailed to the address (app/actions/session.ts).
//     A password would be a second, weaker way in that no screen shows and
//     nobody rotates — and `signInWithPassword` stays callable against the API
//     whether or not a form for it exists.
//   • `app_metadata.role` is derived from the email domain by a trigger on
//     auth.users (…_role_from_email_domain.sql). Anything passed here would be
//     overwritten by it, so passing it would only describe the rule twice.
//
// This script is the guest list for CLIENTS. `signInWithOtp` runs with
// `shouldCreateUser: false`, so a client address that is not created here cannot
// log in and cannot be created by typing it into the form.
//
// Staff do not need it: `@vitti.capital` addresses provision themselves on their
// first code request (see `ensureStaffAccount` in app/actions/session.ts), since
// only somebody who can read mail on the firm's own domain can finish that
// sign-in. Running this for a staff address is harmless — it just gets there
// first.
//
// Only staff are seeded. Client logins now come from the broker import
// (scripts/import-holdings.mjs), which creates clients WITHOUT an email —
// so there is nothing to authenticate against until one is attached. Staff see
// every account through is_staff(), so the admin workspace works regardless.
//
// Requires the SERVICE ROLE key (never ship this to the browser):
//   NEXT_PUBLIC_SUPABASE_URL      — already in .env.local
//   SUPABASE_SERVICE_ROLE_KEY     — from Supabase dashboard → Project Settings → API
//
// Run:  node --env-file=.env.local scripts/seed-auth-users.mjs
// ----------------------------------------------------------------------------

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error(
    "Missing env. Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.\n" +
      "Run with: node --env-file=.env.local scripts/seed-auth-users.mjs",
  );
  process.exit(1);
}

// A client user's email MUST match clients.email in the DB (see the
// add_client_email migration) so lib/session.ts can resolve the client row from
// the auth email. Staff addresses need no such row — they see everything through
// is_staff(). The domain decides which workspace an address lands in.
const ROSTER = ["goyal.s@vitti.capital"];

/**
 * Addresses passed on the command line are provisioned too:
 *
 *   npm run seed:auth -- someone@vitti.capital another@client.com
 *
 * Because `signInWithOtp` runs with `shouldCreateUser: false`, an address that
 * was never provisioned gets the same "code sent" answer as one that was — and
 * no email. That is deliberate (the login form must not reveal who holds an
 * account) and it makes "I never got a code" the single most likely support
 * call, so adding someone has to be quicker than editing a committed list.
 */
const EXTRA = process.argv
  .slice(2)
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const invalid = EXTRA.filter((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
if (invalid.length > 0) {
  console.error(`Not an email address: ${invalid.join(", ")}`);
  process.exit(1);
}

const USERS = [...new Set([...ROSTER, ...EXTRA])];

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Build an email → id map of existing users (paginated).
async function existingUsers() {
  const map = new Map();
  let page = 1;
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({
      page,
      perPage: 1000,
    });
    if (error) throw error;
    for (const u of data.users) map.set(u.email?.toLowerCase(), u.id);
    if (data.users.length < 1000) break;
    page += 1;
  }
  return map;
}

async function main() {
  const found = await existingUsers();

  for (const address of USERS) {
    const email = address.trim().toLowerCase();

    if (found.has(email)) {
      // Deliberately not updated. There is nothing left here to refresh — no
      // password, and the role belongs to the trigger — so a write would only
      // risk disturbing a live account.
      console.log(`exists   ${email}`);
      continue;
    }

    const { data, error } = await admin.auth.admin.createUser({
      email,
      // Confirmed on creation: these addresses are provisioned by staff who
      // already know whose they are, and an unconfirmed user cannot be sent a
      // login code.
      email_confirm: true,
    });
    if (error) throw error;
    console.log(
      `created  ${email.padEnd(30)} role=${data.user?.app_metadata?.role ?? "?"}`,
    );
  }

  console.log(
    "\nDone. These addresses can now request a login code. No passwords exist;\n" +
      "if mail is down, mint one directly with scripts/login-link.mjs.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
