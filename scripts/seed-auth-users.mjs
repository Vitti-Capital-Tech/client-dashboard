// Seed the Supabase Auth staff user.
// ----------------------------------------------------------------------------
// Stamps the workspace role into app_metadata.role ('admin'), which is what
// lib/session.ts reads to decide the workspace. Idempotent: re-running updates
// the existing user (role + password) instead of erroring.
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

const DEMO_PASSWORD = "demo1234";

// A client user's email MUST match clients.email in the DB (see the
// add_client_email migration) so lib/session.ts can resolve the client row from
// the auth email. Add entries here with role 'client' once real client logins
// are issued.
const USERS = [{ email: "goyal.s@vitti.capital", role: "admin" }];

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

  for (const { email, role } of USERS) {
    const id = found.get(email.toLowerCase());
    if (id) {
      const { error } = await admin.auth.admin.updateUserById(id, {
        password: DEMO_PASSWORD,
        app_metadata: { role },
      });
      if (error) throw error;
      console.log(`updated  ${email.padEnd(28)} role=${role}`);
    } else {
      const { error } = await admin.auth.admin.createUser({
        email,
        password: DEMO_PASSWORD,
        email_confirm: true, // skip the confirmation email for the demo
        app_metadata: { role },
      });
      if (error) throw error;
      console.log(`created  ${email.padEnd(28)} role=${role}`);
    }
  }

  console.log(`\nDone. Seeded users use password: ${DEMO_PASSWORD}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
