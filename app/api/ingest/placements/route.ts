import { NextResponse } from "next/server";
import { authorisedCronRequest } from "@/lib/ingest/cron-auth";
import { getMicrosoftAccessToken } from "@/lib/remote-sheets";
import { runPlacementIngest } from "@/lib/placements/ingest-run";
import { ensureMailSubscription } from "@/lib/placements/mail-hook";
import { graphCaller } from "@/lib/placements/tracker-writer";

/**
 * Cron entry point for the deal-mail sync.
 *
 * Pulls the placement/IPO summaries the upstream pipeline built from the broker
 * mail into `placement_candidates`, where the Placements tab reads them. Nothing
 * here creates a deal: a candidate is the desk's inbox, and turning one into a
 * biddable `placements` row is a human act that supplies the terms the mail
 * never carried (see the migration for why that separation exists).
 *
 * ── Separate from the morning ingest, deliberately ────────────────────────────
 * That job is already tight against its ceiling — a real run recomputed 24 of 43
 * accounts and left 19 queued — and its work is the one that must not be
 * crowded out. A deal summary arriving an hour later costs nothing; a client's
 * P&L not rebuilding costs the morning.
 *
 * ── Auth ──────────────────────────────────────────────────────────────────────
 * `CRON_SECRET`, compared in constant time — the same boundary as the morning
 * ingest, and the same reason: no user session stands behind this.
 *
 * ── Repeating is free ─────────────────────────────────────────────────────────
 * Candidates upsert on a content fingerprint, so a re-run converges rather than
 * duplicating. `?days=N` widens the window for a manual backfill; the default is
 * deliberately small because each date costs the upstream a market-data lookup
 * per ticker and possibly an LLM call.
 */

export const dynamic = "force-dynamic";

/**
 * 60s — the Hobby-plan ceiling. Generous for this: the work is a handful of
 * HTTP calls and one upsert. The upstream is the slow part, and only on a cache
 * miss.
 */
export const maxDuration = 60;


export async function GET(request: Request) {
  if (!authorisedCronRequest(request)) {
    return NextResponse.json({ error: "Unauthorised" }, { status: 401 });
  }

  const days = Number(new URL(request.url).searchParams.get("days")) || undefined;

  // The same ingest the mail webhook runs — see `ingest-run.ts` for why it is one
  // function rather than two that drift.
  const { ok: ingestOk, candidates, tracker } = await runPlacementIngest({ days });

  // Keeping the Graph mail subscription alive rides along here rather than on a
  // cron of its own. A mail subscription expires after ~3 days whatever happens,
  // so upkeep is not optional, and an hourly caller renewing with 12 hours to
  // spare cannot be the reason one lapses.
  const subscription = await keepMailHookAlive();

  // A BLOCKED tracker fails the run — a missing permission or a workbook that
  // cannot be found is the mechanism being broken, and the whole point of this job
  // is that nobody is watching it. Green cron runs while nothing is written for
  // three weeks is the exact failure this codebase refuses to ship elsewhere
  // ("could not reach the feed" must not read as "no new deals").
  //
  // One deal failing is different and stays a 200: it is reported, and the next
  // run retries it, because the candidate is stored and the workbook check will
  // still say it is missing.
  //
  // A subscription that cannot be established fails the run too. Without it the
  // instant path is dead and only this hourly job is left — which still works, and
  // is exactly why the failure has to be loud rather than inferred from latency.
  const ok = ingestOk && subscription.ok;

  return NextResponse.json(
    {
      ...candidates,
      tracker,
      subscription,
      notes: [
        ...candidates.notes,
        ...(tracker?.notes ?? []),
        `Mail hook: ${subscription.action}${subscription.detail ? ` — ${subscription.detail}` : ""}.`,
      ],
    },
    { status: ok ? 200 : 500 },
  );
}

/** Cron issues GET; POST is here so the desk can trigger a catch-up run. */
export const POST = GET;

async function keepMailHookAlive() {
  const mailbox = process.env.BROKER_MAILBOX?.trim();
  if (!mailbox) {
    return { ok: true as const, action: "skipped" as const, detail: "No BROKER_MAILBOX set." };
  }

  const token = await getMicrosoftAccessToken();
  if (!token) {
    return {
      ok: true as const,
      action: "skipped" as const,
      detail: "No Graph credentials, so there is no subscription to keep.",
    };
  }

  return ensureMailSubscription({ graph: graphCaller(token), mailbox });
}
