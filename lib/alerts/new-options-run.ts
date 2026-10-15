import "server-only";

import { createAdminClient } from "../supabase/admin";
import { selectAll, type AdminDb } from "../import/runner.ts";
import { toStoredPnlRow, type PnlSummaryDbRow } from "../data/pnl";
import { optionsFromSources } from "../options/from-stored-pnl";
import { sendStaffMail } from "../notify/staff-mail.ts";
import {
  NEW_OPTIONS_TO_VAR,
  runNewOptionsWatch,
  type NewOptionsReport,
  type RegisterLine,
} from "./new-options.ts";

/**
 * Production wiring for the new-option watch: the register exactly as the
 * Options screens build it (`optionsFromSources` over `pnl_summary`), named
 * with `clients` and `accounts`, the `option_register_seen` table as the
 * ledger, and the desk mailer pointed at `MANUAL_SETTLEMENT_NOTIFY_TO`.
 */

const LEDGER = "option_register_seen";
const CHUNK = 500;

export async function runNewOptionsCheck(
  db: AdminDb = createAdminClient(),
): Promise<NewOptionsReport | { skipped: string }> {
  if (!(process.env[NEW_OPTIONS_TO_VAR] ?? "").trim()) {
    return { skipped: `${NEW_OPTIONS_TO_VAR} is not set — the watch is off.` };
  }

  return runNewOptionsWatch({
    load: async () => {
      const [pnlRows, clients, accounts] = await Promise.all([
        selectAll<PnlSummaryDbRow>(db, "pnl_summary", "*"),
        selectAll<{ id: string; display_name: string }>(db, "clients", "id, display_name"),
        selectAll<{ id: string; label: string; external_ref: string | null }>(
          db,
          "accounts",
          "id, label, external_ref",
        ),
      ]);
      const clientName = new Map(clients.map((c) => [c.id, c.display_name]));
      const accountName = new Map(
        accounts.map((a) => [a.id, `${a.label || "Account"}${a.external_ref ? ` · #${a.external_ref}` : ""}`]),
      );

      const lines = new Map<string, RegisterLine>();
      for (const o of optionsFromSources(pnlRows.map(toStoredPnlRow))) {
        // Expired and exercised grants are history, not something that just arrived.
        if (o.status !== "live" && o.status !== "pending") continue;
        lines.set(o.id, {
          key: o.id,
          accountId: o.accountId,
          client: clientName.get(o.clientId) ?? "Client",
          account: accountName.get(o.accountId) ?? "Account",
          ticker: o.ticker,
          company: o.company,
          isUnlisted: o.isUnlisted,
          quantity: o.quantity,
          expiryDate: o.expiryDate,
        });
      }
      return [...lines.values()];
    },

    ledgerEmpty: async () => {
      const { count, error } = await db.from(LEDGER).select("option_key", { count: "exact", head: true });
      if (error) throw new Error(`${LEDGER}: ${error.message}`);
      return (count ?? 0) === 0;
    },

    claim: async (lines) => {
      const inserted = new Set<string>();
      for (let i = 0; i < lines.length; i += CHUNK) {
        const { data, error } = await db
          .from(LEDGER)
          .upsert(
            lines.slice(i, i + CHUNK).map((l) => ({
              option_key: l.key,
              account_id: l.accountId,
              ticker: l.ticker,
            })),
            { onConflict: "option_key", ignoreDuplicates: true },
          )
          .select("option_key");
        if (error) throw new Error(`${LEDGER}: ${error.message}`);
        for (const r of (data ?? []) as { option_key: string }[]) inserted.add(r.option_key);
      }
      return inserted;
    },

    release: async (keys) => {
      for (let i = 0; i < keys.length; i += CHUNK) {
        await db.from(LEDGER).delete().in("option_key", keys.slice(i, i + CHUNK));
      }
    },

    send: (mail) => sendStaffMail(mail, NEW_OPTIONS_TO_VAR),
  });
}
