import assert from "node:assert/strict";
import { test } from "node:test";
import { accountClaimMail, accountMergeMail, staffMailConfig } from "./staff-mail.ts";

/**
 * The desk alert, minus the network.
 *
 * `sendStaffMail` is a Graph call and is not exercised here. What these pin is
 * everything that decides WHETHER a mail is attempted and WHAT it says — the
 * gating (an unconfigured deployment must behave as though this file does not
 * exist) and the escaping (a client types their own name and note, and both go
 * into HTML that lands in a staff mailbox).
 */

/** Set env for one test and put it back, whatever the test does. */
function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("with no recipient configured the feature is simply off", () => {
  // Not an error. A deployment that has not set this gets exactly the
  // behaviour it had before desk alerts existed.
  withEnv({ STAFF_NOTIFY_TO: undefined, STAFF_NOTIFY_FROM: "desk@vitti.capital" }, () => {
    const cfg = staffMailConfig();
    assert.equal(cfg.ok, false);
    assert.match(cfg.ok === false ? cfg.reason : "", /STAFF_NOTIFY_TO/);
  });
});

test("recipients split on commas and semicolons, and blanks are dropped", () => {
  withEnv(
    { STAFF_NOTIFY_TO: " a@vitti.capital , b@vitti.capital ;; ", STAFF_NOTIFY_FROM: "d@vitti.capital" },
    () => {
      const cfg = staffMailConfig();
      assert.equal(cfg.ok, true);
      assert.deepEqual(cfg.ok && cfg.config.to, ["a@vitti.capital", "b@vitti.capital"]);
    },
  );
});

test("the sender falls back to the broker mailbox the app already reaches", () => {
  withEnv(
    {
      STAFF_NOTIFY_TO: "desk@vitti.capital",
      STAFF_NOTIFY_FROM: undefined,
      BROKER_MAILBOX: "broker@vitti.capital",
    },
    () => {
      const cfg = staffMailConfig();
      assert.equal(cfg.ok && cfg.config.from, "broker@vitti.capital");
    },
  );
});

test("configured recipients but no sender is a refusal, not a guess", () => {
  withEnv(
    {
      STAFF_NOTIFY_TO: "desk@vitti.capital",
      STAFF_NOTIFY_FROM: undefined,
      BROKER_MAILBOX: undefined,
    },
    () => {
      assert.equal(staffMailConfig().ok, false);
    },
  );
});

test("a client with no accounts is flagged as locked out, in the subject", () => {
  /**
   * The distinction the desk acts on: one client cannot open the portal at all
   * until this is approved, the other is already using it and is adding to it.
   */
  const first = accountClaimMail({
    clientName: "Endeavour Family Office",
    clientEmail: "principal@example.com",
    accountNumber: "114716",
    isFirstAccount: true,
  });
  assert.match(first.subject, /New client waiting for approval/);
  assert.match(first.html, /cannot use the portal/);

  const later = accountClaimMail({
    clientName: "Endeavour Family Office",
    clientEmail: "principal@example.com",
    accountNumber: "220001",
    isFirstAccount: false,
  });
  assert.match(later.subject, /wants account 220001/);
  assert.match(later.html, /existing client/i);
});

test("a merge alert names both sides, so the desk knows the direction", () => {
  const mail = accountMergeMail({
    clientName: "J Smith",
    clientEmail: "j@example.com",
    sourceLabel: "Personal",
    targetLabel: "SMSF",
    note: "Same beneficial owner",
  });
  assert.match(mail.subject, /Personal into SMSF/);
  assert.match(mail.html, /Personal → SMSF/);
  assert.match(mail.html, /Same beneficial owner/);
});

test("a client's own text is escaped before it reaches a staff mailbox", () => {
  /**
   * The name and the note are both chosen by the client. Interpolated raw, a
   * note carrying markup would render as markup in the desk's mail client.
   */
  const mail = accountClaimMail({
    clientName: '<script>alert("x")</script>',
    clientEmail: "a@b.com",
    accountNumber: "114716",
    note: '<img src=x onerror="alert(1)">',
    isFirstAccount: false,
  });

  assert.equal(mail.html.includes("<script>"), false);
  assert.equal(mail.html.includes("<img "), false);
  assert.match(mail.html, /&lt;script&gt;/);
  assert.match(mail.html, /&lt;img/);
});

test("an empty note is left out rather than printed as a blank row", () => {
  const withNote = accountMergeMail({
    clientName: "J Smith",
    clientEmail: null,
    sourceLabel: "A",
    targetLabel: "B",
    note: "please",
  });
  const without = accountMergeMail({
    clientName: "J Smith",
    clientEmail: null,
    sourceLabel: "A",
    targetLabel: "B",
    note: null,
  });
  assert.match(withNote.html, /Their note/);
  assert.equal(without.html.includes("Their note"), false);
  // A client with no address on file must not print an empty Email row either.
  assert.equal(without.html.includes("Email"), false);
});

test("the deep link appears only when the deployment knows its own address", () => {
  const linked = accountClaimMail({
    clientName: "J Smith",
    clientEmail: null,
    accountNumber: "114716",
    isFirstAccount: true,
    appUrl: "https://portal.vitti.capital",
  });
  assert.match(linked.html, /https:\/\/portal\.vitti\.capital\/portal\/staff\/merge-requests/);

  const unlinked = accountClaimMail({
    clientName: "J Smith",
    clientEmail: null,
    accountNumber: "114716",
    isFirstAccount: true,
  });
  // No invented URL — it says where to go instead.
  assert.equal(unlinked.html.includes("http"), false);
  assert.match(unlinked.html, /Merge requests/);
});
