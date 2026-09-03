import { createHash, timingSafeEqual } from "node:crypto";
import type { GraphCall } from "./tracker-writer.ts";

/**
 * The instant trigger, without touching the upstream system.
 *
 * ── The signal ───────────────────────────────────────────────────────────────
 * Nothing pushes deals to this application, and the obvious fix — have the EC2
 * pipeline call us — needs a change to somebody else's code. It turns out not to
 * be necessary. That pipeline already announces itself: the moment it finishes
 * classifying and summarising a broker mail, it SENDS an approval email from
 * `ecm@vitti.capital`, and that mailbox is one this app already reads.
 *
 * The times line up exactly, which is what makes it trustworthy rather than a
 * guess. Every candidate in the table has a `[APPROVAL REQUIRED]` mail in Sent
 * Items at the same second as its `received_at`:
 *
 *   NMD  mail 04:18   received_at 04:18:03
 *   SEG  mail 02:20   received_at 02:20:56
 *   PGF  mail 02:31   received_at 02:31:38
 *
 * So a Graph change notification on that folder is a true push: Graph calls us
 * within seconds, we pull the deal, and the upstream is not asked to do anything
 * it was not already doing.
 *
 * ── But the mail can outrun the feed, and once it did by 40 minutes ──────────
 * Those three are same-second, and most are. They are not a guarantee. Sending
 * the approval mail and listing the deal on `GET /api/placements/{date}` are two
 * separate acts upstream, and on 3 September 2026 they came apart: NGY's mail
 * went out at 23:25 UTC and the feed had not yet created the `2026-09-03` date
 * bucket that deal belongs in — the upstream files by SYDNEY date, and 23:25 UTC
 * is 09:25 the next morning there. The webhook fired, matched the subject, read
 * the feed and found nothing new. So did the 00:00 sweep. The deal only appeared
 * when the NEXT mail (FBR, 00:06:40) triggered a run at 00:07, by which time the
 * bucket existed with both deals in it.
 *
 * Two consequences, both handled rather than assumed away:
 *
 *   • the ingest reads two dates, not one, so a bucket that is not the newest is
 *     still read — see the route
 *   • the tracker write is a queue keyed on `tracker_written_at`, not on which
 *     run first saw a deal, so whichever run finally sees it still gets the tab
 *     written — see `tracker-state.ts`
 *
 * The webhook is therefore a latency optimisation with a real floor, and the
 * hourly schedule is load-bearing rather than decorative.
 *
 * ── Sent Items, not the Inbox ────────────────────────────────────────────────
 * The broker's own mail lands in the Inbox ~2 minutes EARLIER (NMD at 04:16), and
 * that is the tempting trigger because it is faster. It is also too early: the
 * upstream has not summarised the deal yet, so the sync would find nothing and
 * the tracker row would wait for the hourly sweep anyway. The approval mail is
 * the upstream saying "this one is ready", which is the event actually worth
 * reacting to.
 *
 * `[ALERT] Unapproved sender blocked` goes to the same folder, hence the subject
 * filter rather than reacting to every sent message.
 */

/** Mail subscriptions cannot outlive this. Graph's own ceiling, in minutes. */
const MAX_SUBSCRIPTION_MINUTES = 4230;

/** Renew when less than this is left, so an hourly caller never cuts it close. */
const RENEW_WITHIN_MS = 12 * 60 * 60 * 1000;

/** The upstream's own marker for "a deal is classified and ready". */
export const DEFAULT_SUBJECT_PATTERN = "APPROVAL REQUIRED";

export function subjectPattern(): string {
  return process.env.PLACEMENT_MAIL_SUBJECT_PATTERN?.trim() || DEFAULT_SUBJECT_PATTERN;
}

/**
 * Does this mail mean a new deal is ready?
 *
 * Matched case-insensitively on the subject. Deliberately not a full regex from
 * config: the pattern is compared, not executed, so a bad value in an env var
 * cannot become a catastrophic backtrack on every notification.
 */
export function isPlacementMailSubject(subject: string | null | undefined, pattern = subjectPattern()): boolean {
  if (!subject) return false;
  return subject.toLowerCase().includes(pattern.toLowerCase());
}

/**
 * The secret Graph echoes back on every notification.
 *
 * Derived from `CRON_SECRET` rather than added as another variable to set — but
 * derived, never equal to it: `clientState` is stored inside Graph and sent to us
 * on every call, so it must not be the string that also authorises the ingest
 * routes. Overridable for the case where they should be rotated separately.
 */
export function webhookClientState(): string | null {
  const override = process.env.GRAPH_WEBHOOK_SECRET?.trim();
  if (override) return override;
  const base = process.env.CRON_SECRET?.trim();
  if (!base) return null;
  return createHash("sha256").update(`${base}:graph-mail-hook`).digest("hex");
}

/** Constant-time, and length-checked separately so the compare cannot throw. */
export function clientStateMatches(received: string | null | undefined): boolean {
  const expected = webhookClientState();
  if (!expected || !received) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** The app's own public origin — Graph has to be able to reach it. */
export function publicOrigin(): string | null {
  const explicit = process.env.APP_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  // Vercel sets this on every deployment, so the common case needs no config.
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  return vercel ? `https://${vercel.replace(/\/+$/, "")}` : null;
}

export function notificationUrl(): string | null {
  const origin = publicOrigin();
  return origin ? `${origin}/api/ingest/placements/mail-hook` : null;
}

/** The folder whose new messages mean a deal is ready. */
export function mailResource(mailbox: string): string {
  return `users/${mailbox}/mailFolders('SentItems')/messages`;
}

/** One notification, as Graph sends it. */
export type MailNotification = {
  subscriptionId?: string;
  clientState?: string;
  changeType?: string;
  /** `Users/{id}/Messages/{id}` — the thing that changed. */
  resource?: string;
};

export function parseMailNotifications(body: unknown): MailNotification[] {
  const value = (body as { value?: unknown[] } | null)?.value;
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is MailNotification => !!v && typeof v === "object");
}

/** ISO expiry for a new or renewed subscription, a little under Graph's ceiling. */
export function subscriptionExpiry(now: Date): string {
  return new Date(now.getTime() + (MAX_SUBSCRIPTION_MINUTES - 30) * 60_000).toISOString();
}

export function needsRenewal(expiration: string | undefined, now: Date): boolean {
  if (!expiration) return true;
  const at = Date.parse(expiration);
  if (!Number.isFinite(at)) return true;
  return at - now.getTime() < RENEW_WITHIN_MS;
}

export type SubscriptionState = {
  ok: boolean;
  action: "created" | "renewed" | "current" | "skipped" | "failed";
  id?: string;
  expiresAt?: string;
  detail?: string;
};

/**
 * Make sure the subscription exists and is not about to lapse.
 *
 * Called from the hourly ingest rather than from a cron of its own. A mail
 * subscription dies after ~3 days no matter what, so upkeep is not optional, and
 * an hourly caller that renews with 12 hours to spare cannot be the reason one
 * expires. One less scheduled thing to forget.
 */
export async function ensureMailSubscription(deps: {
  graph: GraphCall;
  mailbox: string;
  now?: Date;
}): Promise<SubscriptionState> {
  const now = deps.now ?? new Date();
  const url = notificationUrl();
  const clientState = webhookClientState();

  if (!url) {
    return {
      ok: true,
      action: "skipped",
      detail: "No APP_URL / VERCEL_PROJECT_PRODUCTION_URL, so Graph has nowhere to call.",
    };
  }
  if (!clientState) {
    return { ok: true, action: "skipped", detail: "No CRON_SECRET to derive a clientState from." };
  }

  const resource = mailResource(deps.mailbox);

  const existing = await deps.graph("/subscriptions");
  if (!existing.ok) {
    return { ok: false, action: "failed", detail: "Could not list Graph subscriptions." };
  }

  const mine = ((existing.body as { value?: (SubscriptionRecord | null)[] } | null)?.value ?? [])
    .filter((s): s is SubscriptionRecord => !!s)
    .find((s) => s.notificationUrl === url && s.resource?.toLowerCase() === resource.toLowerCase());

  if (mine && !needsRenewal(mine.expirationDateTime, now)) {
    return { ok: true, action: "current", id: mine.id, expiresAt: mine.expirationDateTime };
  }

  const expiry = subscriptionExpiry(now);

  if (mine) {
    const renewed = await deps.graph(`/subscriptions/${mine.id}`, {
      method: "PATCH",
      body: { expirationDateTime: expiry },
    });
    if (renewed.ok) return { ok: true, action: "renewed", id: mine.id, expiresAt: expiry };
    // A subscription Graph will not renew is one to replace, not to keep asking
    // about — it may have already been reaped at the far end.
    await deps.graph(`/subscriptions/${mine.id}`, { method: "DELETE" });
  }

  const created = await deps.graph("/subscriptions", {
    method: "POST",
    body: {
      changeType: "created",
      notificationUrl: url,
      resource,
      expirationDateTime: expiry,
      clientState,
      latestSupportedTlsVersion: "v1_2",
    },
  });

  if (!created.ok) {
    return {
      ok: false,
      action: "failed",
      detail:
        graphMessage(created.body) ??
        "Graph refused the subscription. It must be able to reach the notification URL and " +
          "validate it within 10 seconds, so the app has to be deployed and public.",
    };
  }

  const body = created.body as SubscriptionRecord | null;
  return { ok: true, action: "created", id: body?.id, expiresAt: body?.expirationDateTime ?? expiry };
}

type SubscriptionRecord = {
  id?: string;
  resource?: string;
  notificationUrl?: string;
  expirationDateTime?: string;
};

function graphMessage(body: unknown): string | undefined {
  const err = (body as { error?: { message?: string } } | null)?.error;
  return err?.message?.trim() || undefined;
}
