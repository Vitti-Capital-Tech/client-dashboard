// Seed Supabase Auth users for the demo (Stage 7).
// ----------------------------------------------------------------------------
// Creates one auth user per seeded client + one staff user, stamping the role
// into app_metadata.role ('client' | 'admin') — which is what lib/session.ts
// reads to decide the workspace. Idempotent: re-running updates existing users
// (role + password) instead of erroring.
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

// Client emails MUST match clients.email in the DB (see the add_client_email
// migration) so lib/session.ts can resolve the client row from the auth email.
const USERS = [
  { email: "james@halloran.com.au", role: "client" },
  { email: "margaret.chen@outlook.com", role: "client" },
  { email: "office@endeavourfo.com.au", role: "client" },
  { email: "david.okafor@gmail.com", role: "client" },
  { email: "goyal.s@vitti.capital", role: "admin" },
];

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

  console.log(`\nDone. All demo users use password: ${DEMO_PASSWORD}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
