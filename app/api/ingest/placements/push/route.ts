import { NextResponse } from "next/server";
import { storeCandidates, type CandidateFeedItem } from "@/lib/placements/candidates";
import { authorisedCronRequest } from "@/lib/ingest/cron-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { writeOwedDealsToTracker } from "@/lib/placements/ingest-run";

/**
 * The instant path: upstream hands us a deal the moment it classifies one.
 *
 * ── Why this exists when the sync already works ──────────────────────────────
 * Nothing sends placements to this application — it asks for them. So "as soon
 * as a deal arrives" is a claim about how often we ask, and the honest ceiling
 * on a schedule is the interval. Polling every minute would not fix that; it
 * would just be rude to an upstream that does a market-data lookup per ticker
 * and an LLM call per summary on every read.
 *
 * The other system already knows the exact moment: `Placement_Email` classifies
 * a broker mail, writes it to SQLite and has the finished object in hand. One
 * HTTP call from there is the whole difference between "within the hour" and
 * "within a second", and it costs that system nothing it has not already done.
 *
 * ── Push for latency, poll for completeness ──────────────────────────────────
 * This does NOT replace the scheduled sync, and the cron entry stays. A webhook
 * that fails is silent by nature — the sender is not watching, and a deal that
 * was pushed once and dropped is gone. The schedule is the backstop that finds
 * it later, and because both paths share `storeCandidates` they agree about what
 * "new" means, so the desk's inbox does not grow the same deal twice.
 *
 * The tracker is a queue rather than a consequence of either path (see
 * `tracker-state.ts`): whichever door a deal comes through, it is owed a tab
 * until it has one, and the duplicate guard — ticker AND issue date, re-read off
 * the Overview immediately before the write — is what stops a second one.
 *
 * ── Shape ────────────────────────────────────────────────────────────────────
 * The body is what `GET /api/placements/{date}` already returns for one deal —
 * either a single object or `{placements: [...]}` — so the sender can forward
 * the object it built rather than reshape it. Same `CRON_SECRET` bearer as the
 * scheduled routes: there is no user here either.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Everything a candidate needs. `summary` is what the tracker is filled from. */
function readItems(body: unknown): CandidateFeedItem[] | null {
  const raw = Array.isArray(body)
    ? body
    : Array.isArray((body as { placements?: unknown[] })?.placements)
      ? (body as { placements: unknown[] }).placements
      : body && typeof body === "object"
        ? [body]
        : null;
  if (!raw) return null;

  const items: CandidateFeedItem[] = [];
  for (const entry of raw) {
    const o = entry as Partial<CandidateFeedItem> | null;
    // A ticker and a received_at are the two fields nothing downstream can be
    // reconstructed without: one identifies the stock, the other files the deal
    // under a year and dates its tracker row.
    if (!o?.ticker?.trim() || !o?.received_at?.trim()) return null;
    items.push({
      ticker: o.ticker,
      company: o.company ?? "",
      deal_type: o.deal_type ?? "Placement",
      subject: o.subject ?? "",
      summary: o.summary ?? "",
      received_at: o.received_at,
    });
  }
  return items;
}

export async function POST(request: Request) {
  if (!authorisedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }

  const items = readItems(body);
  if (!items) {
    return NextResponse.json(
      {
        error:
          "Send one deal object, or {placements: [...]}. Each needs at least a " +
          "ticker and a received_at; summary is what the tracker row is filled from.",
      },
      { status: 400 },
    );
  }
  if (items.length === 0) {
    return NextResponse.json({ ok: true, stored: 0, fresh: 0, tracker: null });
  }

  // Stored first, tracker second, and that order is not arbitrary: the desk's
  // inbox is the thing that must not lose a deal. A tracker that cannot be
  // written is recoverable from a stored candidate; the reverse is not.
  const db = createAdminClient();
  const { seen, fresh } = await storeCandidates(items, { db });

  // The queue, not this request's own arrivals. A push that stores a deal and
  // then fails to write its tab used to leave that deal unwritable forever,
  // because the hourly sweep only ever looked at what IT had just stored.
  const tracker = await writeOwedDealsToTracker({ db });
  const ok = tracker?.ok !== false;

  return NextResponse.json(
    { ok, stored: seen, fresh, tracker },
    // A blocked tracker is a 500 so the SENDER sees it. This is the only signal
    // it gets — there is nobody watching a webhook the way a cron dashboard is
    // watched, and a push that reports success while writing nothing is how a
    // month goes by before anyone notices.
    { status: ok ? 200 : 500 },
  );
}

