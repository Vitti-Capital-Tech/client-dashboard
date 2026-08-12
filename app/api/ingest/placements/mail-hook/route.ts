import { after } from "next/server";
import { NextResponse } from "next/server";
import {
  clientStateMatches,
  isPlacementMailSubject,
  parseMailNotifications,
} from "@/lib/placements/mail-hook";
import { runPlacementIngest } from "@/lib/placements/ingest-run";
import { getMicrosoftAccessToken } from "@/lib/remote-sheets";
import { graphCaller } from "@/lib/placements/tracker-writer";

/**
 * Microsoft Graph calls this the moment the upstream announces a new deal.
 *
 * The trigger is the `[APPROVAL REQUIRED]` mail the EC2 pipeline sends itself
 * when it finishes classifying a broker mail — see `mail-hook.ts` for why that
 * particular message, and for the timestamps that prove it is the right one. The
 * result is a push trigger that needed no change to the upstream at all.
 *
 * ── Answer first, work afterwards ────────────────────────────────────────────
 * Graph wants a response in a few seconds and retries — then eventually drops the
 * subscription — if it does not get one. The ingest is slower than that: two
 * upstream reads, then several Graph calls against a 13 MB workbook. So the route
 * answers 202 immediately and does the work in `after()`, which on Vercel keeps
 * the invocation alive via `waitUntil`.
 *
 * ── Auth is `clientState`, not a bearer ──────────────────────────────────────
 * Graph will not send our `CRON_SECRET`; it echoes back the `clientState` given
 * when the subscription was created. That value is compared in constant time and
 * is derived from — never equal to — the cron secret, because unlike that one it
 * is stored inside Graph and travels on every notification.
 *
 * An unauthenticated caller therefore gets 202 and nothing happens. That is
 * deliberate: this URL is public by necessity, and a 401 would tell a prober that
 * the endpoint is real and worth hammering.
 */

export const dynamic = "force-dynamic";

/** The response is instant; `after()` gets the rest of this budget. */
export const maxDuration = 60;

/**
 * Graph's handshake. On creating a subscription it POSTs here with
 * `?validationToken=…` and expects that exact string back as `text/plain` within
 * 10 seconds — a JSON body, or any decoration, fails the validation and the
 * subscription is never created.
 */
function validationResponse(request: Request): Response | null {
  const token = new URL(request.url).searchParams.get("validationToken");
  if (!token) return null;
  return new Response(token, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function POST(request: Request) {
  const handshake = validationResponse(request);
  if (handshake) return handshake;

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // Graph only ever sends JSON here; anything else is not worth describing.
    return NextResponse.json({ ok: true }, { status: 202 });
  }

  const notifications = parseMailNotifications(body);
  const authentic = notifications.filter((n) => clientStateMatches(n.clientState));

  if (authentic.length === 0) {
    if (notifications.length > 0) {
      console.warn("mail-hook: %d notification(s) with a bad clientState", notifications.length);
    }
    return NextResponse.json({ ok: true }, { status: 202 });
  }

  after(async () => {
    try {
      const token = await getMicrosoftAccessToken();
      if (!token) {
        console.error("mail-hook: no Graph token, cannot read the message subjects");
        return;
      }
      const graph = graphCaller(token);

      // Read each changed message's subject before doing anything expensive. The
      // same folder receives `[ALERT] Unapproved sender blocked`, and a sync per
      // sent mail would poll the upstream for nothing several times a day.
      const subjects = await Promise.all(
        authentic.map(async (n) => {
          if (!n.resource) return null;
          const res = await graph(`/${n.resource.replace(/^\/+/, "")}?$select=subject`);
          if (!res.ok) return null;
          return (res.body as { subject?: string } | null)?.subject ?? null;
        }),
      );

      const relevant = subjects.filter((s) => isPlacementMailSubject(s));
      if (relevant.length === 0) {
        console.info("mail-hook: %d message(s), none a deal announcement", subjects.length);
        return;
      }

      // One ingest however many announcements arrived together: the sync reads the
      // upstream's newest date and picks up everything on it, so running it per
      // message would be the same work several times.
      const result = await runPlacementIngest({ days: 1 });
      console.info(
        "mail-hook: %s -> %d new candidate(s), tracker %j",
        relevant[0]?.slice(0, 60),
        result.candidates.fresh,
        result.tracker?.notes ?? "not run",
      );
    } catch (err) {
      // Nothing is listening for a throw here — Graph already has its 202 — so an
      // unlogged failure would be a deal that silently never arrived.
      console.error("mail-hook: ingest failed after notification:", err);
    }
  });

  return NextResponse.json({ ok: true, accepted: authentic.length }, { status: 202 });
}

/**
 * Graph sends the validation handshake as POST, but a GET here is how a human
 * checks the route is deployed at all. It says nothing about the subscription.
 */
export async function GET(request: Request) {
  return (
    validationResponse(request) ??
    NextResponse.json({ ok: true, hook: "placements mail-hook" }, { status: 200 })
  );
}
