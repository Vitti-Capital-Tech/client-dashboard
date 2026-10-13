import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fetchAnnouncements,
  isManualSettlement,
  isoFromExcelSerial,
  manualRowsFromValues,
  manualSettlementMail,
  manualWatchDue,
  matchAlerts,
  parseAnnouncementsHtml,
  runManualSettlementWatch,
  type Announcement,
  type ManualSettlementDeps,
} from "./manual-settlement.ts";
import { excelSerialDate } from "./tracker-format.ts";
import type { GraphCall } from "./tracker-writer.ts";

const serial = (iso: string) => excelSerialDate(iso)!;

/** Overview B..F as Graph returns `values`: counter, ticker, issued, type, settlement. */
const OVERVIEW: unknown[][] = [
  [212, "GG1", serial("2026-09-29"), "", serial("2026-10-07")],
  [213, "AAU", serial("2026-09-30"), "Manual", serial("2026-10-08")],
  [214, "P1E", serial("2026-10-01"), "", serial("2026-10-08")],
  [217, "Yatima", serial("2026-10-12"), "Manual & Private", serial("2026-10-26")],
  [218, "", "", "", ""],
];

const PROPOSED: Announcement = {
  documentKey: "03149993",
  headline: "Proposed issue of securities - AAU",
  releasedOn: "2026-10-08",
  releasedTime: "9:40 am",
  url: "https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=03149993",
};

/** Two rows of ASX's announcements search, as served (trimmed whitespace). */
const SEARCH_HTML = `
<table summary="Most recent company announcements">
  <tr><th>Date</th><th>Price sens.</th><th>Headline</th></tr>
  <tr>
    <td>
      08/10/2026<br>
      <span class="dates-time">9:40 am</span>
    </td>
    <td class="pricesens" style="vertical-align: middle"></td>
    <td>
      <a style="text-decoration: none;" target="_blank" href="/asx/v2/statistics/displayAnnouncement.do?display=pdf&amp;idsId=03149993">
        Proposed issue of securities - AAU<br>
        <img src="/asx/v2/markets/image/pdf_icon.png" height="16" width="16">
        <span class="page">5 pages</span>
      </a>
    </td>
  </tr>
  <tr>
    <td>
      07/10/2026<br>
      <span class="dates-time">4:12 pm</span>
    </td>
    <td class="pricesens"></td>
    <td>
      <a href="/asx/v2/statistics/displayAnnouncement.do?display=pdf&amp;idsId=03149001">
        Director&#39;s Interest &amp; Notice<br>
      </a>
    </td>
  </tr>
</table>`;

test("manual settlement: only a plain `Manual` counts", () => {
  assert.equal(isManualSettlement("Manual"), true);
  assert.equal(isManualSettlement("  manual "), true);
  assert.equal(isManualSettlement("Manual & Private"), false);
  assert.equal(isManualSettlement(""), false);
  assert.equal(isManualSettlement(null), false);
});

test("manual settlement: Excel serials round-trip to the same calendar date", () => {
  assert.equal(isoFromExcelSerial(serial("2026-10-08")), "2026-10-08");
  assert.equal(isoFromExcelSerial(""), null);
  assert.equal(isoFromExcelSerial("#DIV/0!"), null);
});

test("manual settlement: the Overview yields AAU and nothing else", () => {
  assert.deepEqual(manualRowsFromValues(OVERVIEW), [
    { counter: 213, ticker: "AAU", settlementDate: "2026-10-08" },
  ]);
});

test("manual settlement: a 3B on or after settlement matches, one before does not", () => {
  const rows = manualRowsFromValues(OVERVIEW);
  // The day BEFORE settlement — a previous raise.
  const before: Announcement = { ...PROPOSED, documentKey: "old", releasedOn: "2026-10-07" };
  const other: Announcement = {
    ...PROPOSED,
    documentKey: "other",
    headline: "Application for quotation of securities - AAU",
  };
  const alerts = matchAlerts(rows, new Map([["AAU", [other, PROPOSED, before]]]));
  assert.deepEqual(
    alerts.map((a) => a.announcement.documentKey),
    [PROPOSED.documentKey],
  );
});

test("manual settlement: the mail names the ticker and the settlement date, escaped", () => {
  const mail = manualSettlementMail({
    counter: 213,
    ticker: "AAU",
    settlementDate: "2026-10-08",
    announcement: { ...PROPOSED, headline: "Proposed issue of securities - <b>AAU</b>" },
  });
  assert.match(mail.subject, /Proposed issue of securities — AAU/);
  assert.match(mail.subject, /8 Oct 2026/);
  assert.match(mail.html, /idsId=03149993/);
  assert.match(mail.html, /asxCode=AAU/);
  assert.match(mail.html, /9:40 am \(Sydney\)/);
  assert.ok(mail.html.includes("securities - &lt;b&gt;AAU&lt;/b&gt;"), "headline is escaped");
});

test("manual settlement: ASX's search table is parsed into announcements", () => {
  assert.deepEqual(parseAnnouncementsHtml(SEARCH_HTML), [
    PROPOSED,
    {
      documentKey: "03149001",
      headline: "Director's Interest & Notice",
      releasedOn: "2026-10-07",
      releasedTime: "4:12 pm",
      url: "https://www.asx.com.au/asx/v2/statistics/displayAnnouncement.do?display=pdf&idsId=03149001",
    },
  ]);
});

test("manual settlement: a fetch failure is null rather than a throw", async () => {
  const ok = (async () => new Response(SEARCH_HTML)) as unknown as typeof fetch;
  assert.equal((await fetchAnnouncements("AAU", ok))?.length, 2);

  const down = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
  assert.equal(await fetchAnnouncements("AAU", down), null);
});

test("manual settlement: due on the first tick of each hour, 7am-7pm Sydney, weekdays", () => {
  // Tue 13 Oct 2026, AEDT (UTC+11).
  assert.equal(manualWatchDue(new Date("2026-10-12T22:03:00Z")), true, "9:03am");
  assert.equal(manualWatchDue(new Date("2026-10-12T22:13:00Z")), false, "9:13am");
  assert.equal(manualWatchDue(new Date("2026-10-12T19:03:00Z")), false, "6:03am");
  assert.equal(manualWatchDue(new Date("2026-10-13T07:05:00Z")), true, "6:05pm");
  assert.equal(manualWatchDue(new Date("2026-10-13T08:05:00Z")), false, "7:05pm");
  // Sat 17 Oct 2026, 9:03am.
  assert.equal(manualWatchDue(new Date("2026-10-16T22:03:00Z")), false, "weekend");
});

/** A run against a fake Overview, feed, ledger and mailer. */
function fakeDeps(over: Partial<ManualSettlementDeps> = {}) {
  const claimed = new Set<string>();
  const sent: string[] = [];
  const graph: GraphCall = async (path) => {
    assert.match(path, /2026%20Overview.*B4:F400/);
    return { ok: true, status: 200, body: { values: OVERVIEW } };
  };
  const deps: ManualSettlementDeps = {
    today: "2026-10-13",
    graph,
    target: async (year) => ({ driveId: "d", itemId: "i", overviewSheet: `${year} Overview` }),
    announcements: async (ticker) => (ticker === "AAU" ? [PROPOSED] : []),
    claim: async (a) => {
      if (claimed.has(a.announcement.documentKey)) return false;
      claimed.add(a.announcement.documentKey);
      return true;
    },
    release: async (key) => {
      claimed.delete(key);
    },
    send: async (mail) => {
      sent.push(mail.subject);
      return { sent: true, to: ["desk@example.com"] };
    },
    ...over,
  };
  return { deps, claimed, sent };
}

test("manual settlement: a run mails once, and a second run stays silent", async () => {
  const { deps, sent } = fakeDeps();
  const first = await runManualSettlementWatch(deps);
  assert.deepEqual(first.watched, [{ ticker: "AAU", settlementDate: "2026-10-08" }]);
  assert.equal(first.sent.length, 1);

  const second = await runManualSettlementWatch(deps);
  assert.equal(second.sent.length, 0);
  assert.equal(sent.length, 1);
});

test("manual settlement: a failed send gives the claim back for the next run", async () => {
  const { deps, claimed } = fakeDeps({
    send: async () => ({ sent: false, reason: "403" }),
  });
  const report = await runManualSettlementWatch(deps);
  assert.equal(report.sent.length, 0);
  assert.deepEqual(report.failed, [{ ticker: "AAU", reason: "403" }]);
  assert.equal(claimed.size, 0);
});

test("manual settlement: a settlement older than the window is not watched", async () => {
  const { deps } = fakeDeps({ today: "2026-11-30" });
  const report = await runManualSettlementWatch(deps);
  assert.deepEqual(report.watched, []);
});
