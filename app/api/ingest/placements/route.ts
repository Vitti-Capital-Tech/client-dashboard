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
 *
 * `?tracker=N` raises how many owed tabs one run will attempt. The default is 2
 * because a tab is minutes of Graph calls against a 13 MB workbook and this route
 * has 60 seconds — but nothing is lost to a run that is killed part-way, since
 * each deal is marked as it settles and the rest stay queued. Raise it only for a
 * catch-up somebody is watching.
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

  const params = new URL(request.url).searchParams;
  const days = Number(params.get("days")) || undefined;
  // How many owed tabs this run may attempt. The default is small because a tab
  // is minutes of Graph calls and this route has 60 seconds; raise it by hand for
  // a catch-up run that is being watched.
  const trackerLimit = Number(params.get("tracker")) || undefined;

  // The same ingest the mail webhook runs — see `ingest-run.ts` for why it is one
  // function rather than two that drift.
  const { ok: ingestOk, candidates, tracker } = await runPlacementIngest({ days, trackerLimit });

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
  // run retries it, because the deal stays owed a tab until it has one
  // (`tracker_written_at IS NULL`). That retry was a claim this comment made and
  // the code did not honour until 3 September 2026 — the write only ever looked
  // at candidates the SAME run had stored, so a failure was permanent and the
  // desk built the tabs by hand. `tracker-state.ts` is why it is now true.
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
