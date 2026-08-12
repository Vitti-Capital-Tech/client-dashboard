import test from "node:test";
import assert from "node:assert/strict";

import {
  clientStateMatches,
  ensureMailSubscription,
  isPlacementMailSubject,
  mailResource,
  needsRenewal,
  notificationUrl,
  parseMailNotifications,
  subscriptionExpiry,
  webhookClientState,
} from "./mail-hook.ts";
import type { GraphCall } from "./tracker-writer.ts";

/**
 * Tests for the instant trigger.
 *
 * The subjects below are real ones out of `ecm@vitti.capital`'s Sent Items. What
 * matters here is telling a deal announcement apart from the other mail in the
 * same folder, and refusing a notification that cannot prove it came from Graph —
 * this endpoint is public by necessity, so the `clientState` check is the whole
 * boundary.
 */

const withEnv = (vars: Record<string, string | undefined>, fn: () => void) => {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

test("mail hook: a deal announcement is told apart from the rest of the folder", () => {
  // Real subjects. The alerts land in the same folder as the announcements, and a
  // sync per sent message would poll the upstream for nothing several times a day.
  assert.equal(
    isPlacementMailSubject("[APPROVAL REQUIRED] Normandy Minerals Limited (ASX: NMD) - High-Grade Gold IPO"),
    true,
  );
  assert.equal(
    isPlacementMailSubject("[APPROVAL REQUIRED] Sports Entertainment Group (ASX: SEG) - Transformational"),
    true,
  );
  assert.equal(isPlacementMailSubject("[ALERT] Unapproved sender blocked"), false);
  assert.equal(isPlacementMailSubject("Your meeting recap - Daily Technical Standup Call"), false);
  assert.equal(isPlacementMailSubject("Client Holdings"), false);
  assert.equal(isPlacementMailSubject(""), false);
  assert.equal(isPlacementMailSubject(null), false);
});

test("mail hook: the subject match is case-insensitive and configurable", () => {
  assert.equal(isPlacementMailSubject("[approval required] something"), true);
  assert.equal(isPlacementMailSubject("PLACEMENT READY: ABC", "placement ready"), true);
});

test("mail hook: clientState is derived from CRON_SECRET but never equal to it", () => {
  // It is stored inside Graph and sent to us on every notification, so it must not
  // be the string that also authorises the ingest routes.
  withEnv({ CRON_SECRET: "s3cret", GRAPH_WEBHOOK_SECRET: undefined }, () => {
    const state = webhookClientState();
    assert.ok(state);
    assert.notEqual(state, "s3cret");
    assert.equal(state, webhookClientState(), "stable across calls");
    assert.match(state!, /^[a-f0-9]{64}$/);
  });
});

test("mail hook: a notification with the wrong clientState is refused", () => {
  withEnv({ CRON_SECRET: "s3cret", GRAPH_WEBHOOK_SECRET: undefined }, () => {
    const good = webhookClientState()!;
    assert.equal(clientStateMatches(good), true);
    assert.equal(clientStateMatches("s3cret"), false, "the cron secret is not the clientState");
    assert.equal(clientStateMatches(good.slice(0, -1) + "0"), false);
    assert.equal(clientStateMatches(""), false);
    assert.equal(clientStateMatches(undefined), false);
    assert.equal(clientStateMatches("short"), false, "a length mismatch must not throw");
  });
});

test("mail hook: with no CRON_SECRET nothing can authenticate", () => {
  // An unset secret denies everything rather than defaulting open, matching the
  // cron routes.
  withEnv({ CRON_SECRET: undefined, GRAPH_WEBHOOK_SECRET: undefined }, () => {
    assert.equal(webhookClientState(), null);
    assert.equal(clientStateMatches("anything"), false);
  });
});

test("mail hook: Graph's notification envelope is read, junk is dropped", () => {
  const parsed = parseMailNotifications({
    value: [
      { subscriptionId: "s1", clientState: "x", changeType: "created", resource: "Users/u/Messages/m" },
      null,
      "not an object",
      { subscriptionId: "s2", clientState: "y" },
    ],
  });
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].resource, "Users/u/Messages/m");

  assert.deepEqual(parseMailNotifications({}), []);
  assert.deepEqual(parseMailNotifications(null), []);
  assert.deepEqual(parseMailNotifications({ value: "nope" }), []);
});

test("mail hook: the subscription watches Sent Items, not the Inbox", () => {
  // The broker's own mail hits the Inbox ~2 minutes earlier, which is too early:
  // the upstream has not summarised the deal yet, so the sync would find nothing.
  assert.equal(
    mailResource("ecm@vitti.capital"),
    "users/ecm@vitti.capital/mailFolders('SentItems')/messages",
  );
});

test("mail hook: expiry stays under Graph's ceiling and renews with hours to spare", () => {
  const now = new Date("2026-08-12T00:00:00Z");
  const expiry = Date.parse(subscriptionExpiry(now));
  const minutes = (expiry - now.getTime()) / 60_000;
  assert.ok(minutes < 4230, "Graph refuses anything past 4230 minutes for mail");
  assert.ok(minutes > 4000, "but not so short that renewal becomes frequent");

  assert.equal(needsRenewal(undefined, now), true);
  assert.equal(needsRenewal("not a date", now), true);
  assert.equal(needsRenewal("2026-08-12T06:00:00Z", now), true, "6h left — renew");
  assert.equal(needsRenewal("2026-08-14T00:00:00Z", now), false, "2 days left — leave it");
});

test("mail hook: the notification URL falls back to Vercel's own domain", () => {
  withEnv({ APP_URL: undefined, VERCEL_PROJECT_PRODUCTION_URL: "dash.vercel.app" }, () => {
    assert.equal(notificationUrl(), "https://dash.vercel.app/api/ingest/placements/mail-hook");
  });
  withEnv({ APP_URL: "https://vitti.example/", VERCEL_PROJECT_PRODUCTION_URL: undefined }, () => {
    assert.equal(
      notificationUrl(),
      "https://vitti.example/api/ingest/placements/mail-hook",
      "a trailing slash on APP_URL must not produce a double slash",
    );
  });
  withEnv({ APP_URL: undefined, VERCEL_PROJECT_PRODUCTION_URL: undefined }, () => {
    assert.equal(notificationUrl(), null);
  });
});

/* ---------------------------------------------------------------- */
/* Subscription upkeep                                               */
/* ---------------------------------------------------------------- */

function fakeGraph(subscriptions: Record<string, unknown>[], fail?: RegExp) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const graph: GraphCall = async (path, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, path, body: init.body });
    if (fail?.test(path) && method !== "GET") {
      return { ok: false, status: 400, body: { error: { message: "refused" } } };
    }
    if (method === "GET" && path === "/subscriptions") {
      return { ok: true, status: 200, body: { value: subscriptions } };
    }
    if (method === "POST" && path === "/subscriptions") {
      return { ok: true, status: 201, body: { id: "new-sub", expirationDateTime: "later" } };
    }
    return { ok: true, status: 200, body: {} };
  };
  return { graph, calls };
}

/** The subscription tests all need a secret and a reachable URL. */
function arrangeEnv() {
  process.env.CRON_SECRET = "s3cret";
  process.env.APP_URL = "https://dash.example";
  delete process.env.GRAPH_WEBHOOK_SECRET;
}

test("mail hook: with no subscription one is created, watching Sent Items", async () => {
  arrangeEnv();
  const { graph, calls } = fakeGraph([]);
  const res = await ensureMailSubscription({ graph, mailbox: "ecm@vitti.capital" });

  assert.equal(res.action, "created");
  const created = calls.find((c) => c.method === "POST")!;
  const body = created.body as Record<string, string>;
  assert.equal(body.changeType, "created");
  assert.equal(body.resource, "users/ecm@vitti.capital/mailFolders('SentItems')/messages");
  assert.equal(body.notificationUrl, "https://dash.example/api/ingest/placements/mail-hook");
  assert.equal(body.clientState, webhookClientState());
});

test("mail hook: a healthy subscription is left alone", async () => {
  arrangeEnv();
  const now = new Date("2026-08-12T00:00:00Z");
  const { graph, calls } = fakeGraph([
    {
      id: "sub-1",
      resource: "users/ecm@vitti.capital/mailFolders('SentItems')/messages",
      notificationUrl: "https://dash.example/api/ingest/placements/mail-hook",
      expirationDateTime: "2026-08-14T00:00:00Z",
    },
  ]);

  const res = await ensureMailSubscription({ graph, mailbox: "ecm@vitti.capital", now });
  assert.equal(res.action, "current");
  assert.equal(calls.filter((c) => c.method !== "GET").length, 0, "nothing was changed");
});

test("mail hook: one about to lapse is renewed, not duplicated", async () => {
  arrangeEnv();
  const now = new Date("2026-08-12T00:00:00Z");
  const { graph, calls } = fakeGraph([
    {
      id: "sub-1",
      resource: "users/ecm@vitti.capital/mailFolders('SentItems')/messages",
      notificationUrl: "https://dash.example/api/ingest/placements/mail-hook",
      expirationDateTime: "2026-08-12T04:00:00Z",
    },
  ]);

  const res = await ensureMailSubscription({ graph, mailbox: "ecm@vitti.capital", now });
  assert.equal(res.action, "renewed");
  assert.equal(res.id, "sub-1");
  assert.equal(calls.filter((c) => c.method === "POST" && c.path === "/subscriptions").length, 0);
});

test("mail hook: a subscription Graph will not renew is replaced", async () => {
  // It may already have been reaped at the far end, in which case PATCHing it
  // forever would leave the instant path quietly dead.
  const now = new Date("2026-08-12T00:00:00Z");
  const { graph, calls } = fakeGraph(
    [
      {
        id: "stale",
        resource: "users/ecm@vitti.capital/mailFolders('SentItems')/messages",
        notificationUrl: "https://dash.example/api/ingest/placements/mail-hook",
        expirationDateTime: "2026-08-12T01:00:00Z",
      },
    ],
    /subscriptions\/stale$/,
  );

  const res = await ensureMailSubscription({ graph, mailbox: "ecm@vitti.capital", now });
  assert.equal(res.action, "created");
  assert.ok(calls.some((c) => c.method === "DELETE"), "the dead one is removed first");
});

test("mail hook: another app's subscription on the same mailbox is not touched", async () => {
  arrangeEnv();
  const { graph, calls } = fakeGraph([
    {
      id: "someone-else",
      resource: "users/ecm@vitti.capital/mailFolders('SentItems')/messages",
      notificationUrl: "https://other-app.example/hook",
      expirationDateTime: "2026-12-01T00:00:00Z",
    },
  ]);

  const res = await ensureMailSubscription({ graph, mailbox: "ecm@vitti.capital" });
  assert.equal(res.action, "created", "ours is created alongside theirs");
  assert.equal(calls.some((c) => c.path.includes("someone-else")), false);
});

test("mail hook: without a reachable URL upkeep is skipped, not failed", async () => {
  const saved = process.env.APP_URL;
  delete process.env.APP_URL;
  const savedVercel = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  try {
    const { graph, calls } = fakeGraph([]);
    const res = await ensureMailSubscription({ graph, mailbox: "ecm@vitti.capital" });
    assert.equal(res.ok, true, "a deployment without a public URL is not a failure");
    assert.equal(res.action, "skipped");
    assert.equal(calls.length, 0, "Graph is not even called");
  } finally {
    if (saved) process.env.APP_URL = saved;
    if (savedVercel) process.env.VERCEL_PROJECT_PRODUCTION_URL = savedVercel;
  }
});

test("mail hook: a refused subscription reports why", async () => {
  arrangeEnv();
  const { graph } = fakeGraph([], /^\/subscriptions$/);
  const res = await ensureMailSubscription({ graph, mailbox: "ecm@vitti.capital" });
  assert.equal(res.ok, false);
  assert.equal(res.action, "failed");
  assert.match(res.detail ?? "", /refused/);
});
