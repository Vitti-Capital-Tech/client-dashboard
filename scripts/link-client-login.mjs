// Give a client row a login address — and take it away again.
// ----------------------------------------------------------------------------
// Two things have to line up before a client can sign in, and they live in
// different places, which is why doing this by hand goes wrong:
//
//   1. `clients.email` must equal the address  → lib/session.ts resolves the
//      client row from it, and the RLS helper `current_client_id()` does the
//      same in Postgres. Without it a signed-in client is authenticated and
//      attached to nothing.
//   2. An `auth.users` row must exist for it   → `signInWithOtp` runs with
//      `shouldCreateUser: false`, so an address nobody provisioned gets the
//      same "code sent" answer as one that was, and no email.
//
// Staff never need this: `@vitti.capital` addresses provision themselves on
// first sign-in (`ensureStaffAccount`). It is clients — and testing the client
// portal as a real client rather than as staff inspecting one — that need both
// halves done together.
//
// Requires the SERVICE ROLE key:
//   node --env-file=.env.local scripts/link-client-login.mjs <client-id> <email>
//   node --env-file=.env.local scripts/link-client-login.mjs <client-id> --unlink
//
// Or via npm:
//   npm run client:login -- <client-id> <email>
// ----------------------------------------------------------------------------

import { createClient } from "@supabase/supabase-js";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const [clientId, second] = process.argv.slice(2);
const unlink = second === "--unlink";
const email = unlink ? null : second?.trim().toLowerCase();

const usage =
  "Usage:\n" +
  "  node --env-file=.env.local scripts/link-client-login.mjs <client-id> <email>\n" +
  "  node --env-file=.env.local scripts/link-client-login.mjs <client-id> --unlink";

if (!url || !serviceKey) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.\n" + usage);
  process.exit(1);
}
if (!clientId || !second) {
  console.error(usage);
  process.exit(1);
}
if (!unlink && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error(`Not an email address: ${second}\n\n${usage}`);
  process.exit(1);
}

// A Vitti address would be stamped `admin` by the auth.users trigger, so the
// person would land in the staff console no matter what `clients.email` says —
// and the client portal would go untested while looking like it had been. This
// is the mistake worth refusing outright rather than explaining afterwards.
if (!unlink && email.endsWith("@vitti.capital")) {
  console.error(
    `${email} is a Vitti address, so it becomes STAFF and will never see the\n` +
      "client portal. Use an address on a domain you can receive mail at —\n" +
      "a personal mailbox, or a +alias on one.",
  );
  process.exit(1);
}

const db = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: client, error: lookupError } = await db
  .from("clients")
  .select("id,display_name,email")
  .eq("id", clientId)
  .maybeSingle();

if (lookupError) {
  console.error(`Could not read the client: ${lookupError.message}`);
  process.exit(1);
}
if (!client) {
  console.error(`No client with id ${clientId}.`);
  process.exit(1);
}

if (unlink) {
  const had = client.email;
  if (!had) {
    console.log(`${client.display_name} has no login address. Nothing to remove.`);
    process.exit(0);
  }

  const { error } = await db.from("clients").update({ email: null }).eq("id", clientId);
  if (error) {
    console.error(`Could not clear the address: ${error.message}`);
    process.exit(1);
  }

  console.log(`\n  ${client.display_name}\n  login address removed (was ${had})\n`);
  console.log(
    "  The auth user is left in place — deleting one is not something this\n" +
      "  script should do by implication. Remove it from the Supabase dashboard\n" +
      "  (Authentication → Users) if it was only ever for a test.\n",
  );
  process.exit(0);
}

// `clients.email` is UNIQUE, so this would fail anyway — but a constraint
// violation names a column, and this names the client the address is already
// attached to, which is the thing you actually need to know.
const { data: taken } = await db
  .from("clients")
  .select("id,display_name")
  .eq("email", email)
  .maybeSingle();

if (taken && taken.id !== clientId) {
  console.error(`${email} is already the login for ${taken.display_name}.`);
  process.exit(1);
}

const { error: updateError } = await db
  .from("clients")
  .update({ email })
  .eq("id", clientId);

if (updateError) {
  console.error(`Could not set the address: ${updateError.message}`);
  process.exit(1);
}

// Provisioned here rather than left to `seed:auth`, because half of this done is
// worse than none: the address resolves a client row, asks for a code, and never
// gets one.
const { error: createError } = await db.auth.admin.createUser({
  email,
  email_confirm: true,
});

const already = createError?.code === "email_exists" || createError?.status === 422;
if (createError && !already) {
  console.error(
    `clients.email was set, but the auth user could not be created: ${createError.message}\n` +
      "Fix that and re-run — the address cannot sign in until both halves exist.",
  );
  process.exit(1);
}

console.log(`\n  ${client.display_name}`);
console.log(`  login address: ${email}${client.email ? `  (was ${client.email})` : ""}`);
console.log(`  auth user:     ${already ? "already existed" : "created"}\n`);
console.log("  They can now request a code at /login and will land on the client portal.");
console.log(`  To undo:  npm run client:login -- ${clientId} --unlink\n`);
