import { NextResponse } from "next/server";
import { authorisedCronRequest } from "@/lib/ingest/cron-auth";
import { runManualSettlementCheck } from "@/lib/placements/manual-settlement-run";

/**
 * Run the manual-settlement watch now, by hand.
 *
 * The scheduled run happens inside `/api/alerts/live` (hourly, 7am–7pm Sydney,
 * weekdays); this route skips that clock so the watch can be tested or forced
 * with a curl. Each announcement is still mailed only once.
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
    const report = await runManualSettlementCheck();
    return NextResponse.json(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[manual-settlement]", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return handle(request);
}

/** GET so the watch can be triggered by hand with the bearer token. pg_cron sends POST. */
export async function GET(request: Request) {
  return handle(request);
}
