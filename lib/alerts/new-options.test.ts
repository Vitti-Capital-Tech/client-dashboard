import assert from "node:assert/strict";
import { test } from "node:test";
import {
  newOptionsMail,
  runNewOptionsWatch,
  type NewOptionsDeps,
  type RegisterLine,
} from "./new-options.ts";

const line = (ticker: string, over: Partial<RegisterLine> = {}): RegisterLine => ({
  key: `pnl-acc1:${ticker}`,
  accountId: "acc1",
  client: "Jane Citizen",
  account: "Citizen Super · #114716",
  ticker,
  company: `${ticker.slice(0, 3)} LIMITED`,
  isUnlisted: ticker.includes("-UO"),
  quantity: 100_000,
  expiryDate: "2028-06-30",
  ...over,
});

/** An in-memory ledger and mailer around a register the test controls. */
function fake(register: RegisterLine[], over: Partial<NewOptionsDeps> = {}) {
  const seen = new Set<string>();
  const mails: string[] = [];
  const deps: NewOptionsDeps = {
    load: async () => register,
    ledgerEmpty: async () => seen.size === 0,
    claim: async (lines) => {
      const inserted = new Set<string>();
      for (const l of lines) {
        if (!seen.has(l.key)) {
          seen.add(l.key);
          inserted.add(l.key);
        }
      }
      return inserted;
    },
    release: async (keys) => {
      for (const k of keys) seen.delete(k);
    },
    send: async (mail) => {
      mails.push(mail.subject);
      return { sent: true, to: ["desk@example.com"] };
    },
    ...over,
  };
  return { deps, seen, mails };
}

test("new options: the first run records the book as a baseline and mails nothing", async () => {
  const { deps, seen, mails } = fake([line("ZEUOB"), line("GRV-UO")]);
  const report = await runNewOptionsWatch(deps);
  assert.equal(report.baseline, true);
  assert.equal(seen.size, 2);
  assert.deepEqual(mails, []);
});

test("new options: an option appearing after the baseline is mailed once", async () => {
  const register = [line("ZEUOB")];
  const { deps, mails } = fake(register);
  await runNewOptionsWatch(deps); // baseline

  register.push(line("ADNOD"), line("AAU-UO", { accountId: "acc2", key: "pnl-acc2:AAU-UO" }));
  const first = await runNewOptionsWatch(deps);
  assert.equal(first.sent, true);
  assert.deepEqual(
    first.found.map((f) => f.ticker),
    ["ADNOD", "AAU-UO"],
  );
  assert.deepEqual(mails, ["ALERT: 2 new options on the register (1 listed, 1 unlisted)"]);

  const second = await runNewOptionsWatch(deps);
  assert.deepEqual(second.found, []);
  assert.equal(mails.length, 1);
});

test("new options: the same series in a second account is new for that account", async () => {
  const register = [line("ZEUOB")];
  const { deps } = fake(register);
  await runNewOptionsWatch(deps);

  register.push(line("ZEUOB", { accountId: "acc2", key: "pnl-acc2:ZEUOB", client: "John Smith" }));
  const report = await runNewOptionsWatch(deps);
  assert.equal(report.found.length, 1);
});

test("new options: a failed send releases the keys for the next run", async () => {
  const register = [line("ZEUOB")];
  const { deps, seen } = fake(register, {
    send: async () => ({ sent: false, reason: "403" }),
  });
  await runNewOptionsWatch(deps);

  register.push(line("ADNOD"));
  const report = await runNewOptionsWatch(deps);
  assert.equal(report.sent, false);
  assert.equal(report.error, "403");
  assert.equal(seen.has("pnl-acc1:ADNOD"), false);
});

test("new options: the mail lists each option with its client, escaped", () => {
  const mail = newOptionsMail([line("ADNOD", { client: "<Jane>" })]);
  assert.equal(mail.subject, "ALERT: 1 new option on the register (1 listed)");
  assert.match(mail.html, /ADNOD/);
  assert.match(mail.html, /&lt;Jane&gt;/);
  assert.match(mail.html, /100,000/);
  assert.match(mail.html, /30 Jun 2028/);
});
