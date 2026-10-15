import { NextResponse } from "next/server";
import { runNewOptionsCheck } from "@/lib/alerts/new-options-run";
import { authorisedCronRequest } from "@/lib/ingest/cron-auth";

/**
 * Run the new-option watch now, by hand.
 *
 * The scheduled run happens inside `/api/alerts/live` (hourly, 7am–4pm Sydney,
 * weekdays); this route skips that clock so the watch can be tested or forced
 * with a curl. Each new option is still mailed only once.
 *
 * `CRON_SECRET`, compared in constant time, as every cron route here.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request) {
  if (!authorisedCronRequest(request)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    return NextResponse.json(await runNewOptionsCheck());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[new-options]", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return handle(request);
}

/** GET so it can be triggered from a browser or curl with the bearer token. */
export async function GET(request: Request) {
  return handle(request);
}
