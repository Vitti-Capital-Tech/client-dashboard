// Mint a sign-in link for one address, WITHOUT sending an email.
// ----------------------------------------------------------------------------
// Break-glass for the failure mode that OTP-only login creates: the code is the
// only credential, so if the mail provider is down or a mailbox is unreachable,
// nobody can get in — including every admin. There is no password to fall back
// on, by design (see app/actions/session.ts).
//
// `generateLink` builds the same verification the login email would carry and
// RETURNS it instead of delivering it. So a service-role holder can read out a
// link over a channel that still works, and normal login stays the only path
// that involves no secrets.
//
// It also carries the 6-digit code, so it can be read out over the phone to
// somebody sitting on the login screen rather than sending a URL at all.
//
// Requires the SERVICE ROLE key — never ship this to a browser:
//   NEXT_PUBLIC_SUPABASE_URL      — already in .env.local
//   SUPABASE_SERVICE_ROLE_KEY     — Supabase dashboard → Project Settings → API
//
// Run:  node --env-file=.env.local scripts/login-link.mjs someone@example.com
// ----------------------------------------------------------------------------

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const email = process.argv[2]?.trim().toLowerCase();

if (!url || !serviceKey) {
  console.error(
    "Missing env. Need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.\n" +
      "Run with: node --env-file=.env.local scripts/login-link.mjs you@example.com",
  );
  process.exit(1);
}

if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error("Usage: node --env-file=.env.local scripts/login-link.mjs you@example.com");
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// `magiclink` rather than `signup`: it refuses an address that does not exist,
// which is the right answer here. This script must never be the thing that
// quietly creates an account — provisioning is seed-auth-users.mjs.
const { data, error } = await admin.auth.admin.generateLink({
  type: "magiclink",
  email,
});

if (error) {
  console.error(`Could not generate a link for ${email}: ${error.message}`);
  process.exit(1);
}

const role = data.user?.app_metadata?.role ?? "(unstamped)";

console.log(`\n  ${email}  ·  role=${role}\n`);
console.log(`  Code:  ${data.properties?.email_otp ?? "(none returned)"}`);
console.log(`  Link:  ${data.properties?.action_link ?? "(none returned)"}\n`);
console.log(
  "  Treat both as a password: either one signs this person in. They expire on\n" +
    "  the project's OTP expiry, and using one invalidates it.\n",
);
