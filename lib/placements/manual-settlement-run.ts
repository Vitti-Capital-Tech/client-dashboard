import "server-only";
import { deskDate } from "../asx/session.ts";
import { sendStaffMail } from "../notify/staff-mail.ts";
import { getMicrosoftAccessToken } from "../remote-sheets.ts";
import { createAdminClient } from "../supabase/admin.ts";
import {
  MANUAL_SETTLEMENT_TO_VAR,
  fetchAnnouncements,
  runManualSettlementWatch,
  type ManualSettlementReport,
} from "./manual-settlement.ts";
import { graphCaller, resolveTrackerTarget, trackerUrls } from "./tracker-writer.ts";

/**
 * Production wiring for the manual-settlement watch: the real Graph token, the
 * real ASX feed, the `manual_settlement_alerts` table as the once-only ledger,
 * and the desk mailer pointed at `MANUAL_SETTLEMENT_NOTIFY_TO`.
 */
export async function runManualSettlementCheck(): Promise<ManualSettlementReport & { ok: boolean }> {
  const empty = { ok: true, watched: [], sent: [], failed: [] };

  if (!(process.env[MANUAL_SETTLEMENT_TO_VAR] ?? "").trim()) {
    return { ...empty, notes: [`${MANUAL_SETTLEMENT_TO_VAR} is not set — the watch is off.`] };
  }

  const urls = trackerUrls(process.env.PLACEMENT_TRACKER_URL);
  if (urls.length === 0) {
    return { ...empty, notes: ["No PLACEMENT_TRACKER_URL is set — nothing to watch."] };
  }

  const token = await getMicrosoftAccessToken();
  if (!token) {
    return { ...empty, ok: false, notes: ["No Microsoft Graph token — check MICROSOFT_* credentials."] };
  }

  const graph = graphCaller(token);
  const db = createAdminClient();

  const report = await runManualSettlementWatch({
    today: deskDate(),
    graph,
    target: (year) => resolveTrackerTarget(urls, year, graph),
    announcements: (ticker) => fetchAnnouncements(ticker),
    claim: async (alert) => {
      const { data, error } = await db
        .from("manual_settlement_alerts")
        .upsert(
          {
            document_key: alert.announcement.documentKey,
            ticker: alert.ticker,
            settlement_date: alert.settlementDate,
            headline: alert.announcement.headline,
            released_on: alert.announcement.releasedOn,
            url: alert.announcement.url,
          },
          { onConflict: "document_key", ignoreDuplicates: true },
        )
        .select("document_key");
      if (error) throw new Error(`manual_settlement_alerts: ${error.message}`);
      return (data?.length ?? 0) > 0;
    },
    release: async (documentKey) => {
      await db.from("manual_settlement_alerts").delete().eq("document_key", documentKey);
    },
    send: (mail) => sendStaffMail(mail, MANUAL_SETTLEMENT_TO_VAR),
  });

  for (const f of report.failed) console.error("[manual-settlement]", f.ticker, f.reason);
  return { ok: report.failed.length === 0, ...report };
}
