import { NextResponse } from "next/server";
import { checkMailboxAccess } from "@/lib/ingest/graph-mail";
import { authorisedCronRequest } from "@/lib/ingest/cron-auth";

/**
 * Is the broker mailbox reachable?
 *
 * A read-only probe of the same path `/api/ingest/morning` takes — config,
 * Graph token, mailbox, folder, a filtered message count — that stops before
 * downloading a single attachment. Nothing is imported and nothing is written.
 *
 * It exists because the two other ways to find out are both bad: wait for the
 * 9am cron and read the failure afterwards, or trigger a real ingest and have
 * it apply files while you were only testing credentials.
 *
 * Same `CRON_SECRET` as the ingest: the response names the mailbox, the sender
 * allowlist and recent subject lines, which is not something to hand out.
 *
 *   curl -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/ingest/health
 */

export const dynamic = "force-dynamic";
// Only network round trips to Graph — no parsing, no import.
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!authorisedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const result = await checkMailboxAccess();

  // 503 rather than 500 on failure: nothing is broken in this app, a dependency
  // it needs is not reachable or not configured yet.
  return NextResponse.json(result, { status: result.ok ? 200 : 503 });
}
