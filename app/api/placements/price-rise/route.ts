import { NextResponse } from "next/server";
import { authorisedCronRequest } from "@/lib/ingest/cron-auth";
import { runPriceRiseUpdate } from "@/lib/placements/price-rise-run";

/**
 * Refresh the Placement Tracker's Price Rise column now, by hand.
 *
 * The scheduled run happens inside `/api/alerts/live` at 12pm Sydney on trading
 * days; this route skips that clock so the column can be refreshed or tested
 * with a curl.
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
    return NextResponse.json(await runPriceRiseUpdate());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[price-rise]", message);
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
