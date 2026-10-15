import { esc, type SendResult, type StaffMail } from "../notify/staff-mail.ts";

/**
 * New-option watch: a listed or unlisted option that appears on the register
 * for an account that did not hold it before.
 *
 * ── Where "new" comes from ──────────────────────────────────────────────────
 * The register is `pnl_summary`, rebuilt by the P&L recompute after the
 * morning holdings ingest — listed series from the broker's holdings file,
 * unlisted grants (`-UO`) from the Placement Tracker. Those rows are deleted
 * and rewritten every run, so nothing on them says when an option first
 * appeared. `option_register_seen` is that memory: one row per register key
 * (`pnl-<account>:<ticker>`), written the first time the key is seen.
 *
 * ── The first run mails nothing ─────────────────────────────────────────────
 * With an empty ledger every option on the book would look new. So a run that
 * finds the ledger empty records the whole register as the baseline and sends
 * nothing; only options appearing after that are reported.
 *
 * ── Once per option ─────────────────────────────────────────────────────────
 * The new keys are claimed in the ledger BEFORE the mail goes out and released
 * if the send fails, so the next run retries and overlapping runs cannot both
 * mail the same option. A key is never removed after a successful mail, so an
 * option sold and bought back is not reported a second time.
 *
 * Free of `server-only`, with the database and the mailer injected.
 */

/** Recipients: the same people as the manual-settlement alert. */
export const NEW_OPTIONS_TO_VAR = "MANUAL_SETTLEMENT_NOTIFY_TO";

export type RegisterLine = {
  /** The register's own key, `pnl-<account>:<ticker>`. */
  key: string;
  accountId: string;
  client: string;
  /** `Label · #114716`. */
  account: string;
  ticker: string;
  company: string;
  isUnlisted: boolean;
  quantity: number;
  expiryDate: string | null;
};

export type NewOptionsDeps = {
  /** The current register — live and pending options only. */
  load: () => Promise<RegisterLine[]>;
  /** True when the ledger has no rows at all, i.e. this is the first run. */
  ledgerEmpty: () => Promise<boolean>;
  /** Record keys as seen. Returns the keys THIS call inserted. */
  claim: (lines: RegisterLine[]) => Promise<Set<string>>;
  /** Forget keys after a failed send, so the next run reports them again. */
  release: (keys: string[]) => Promise<void>;
  send: (mail: StaffMail) => Promise<SendResult>;
};

export type NewOptionsReport = {
  register: number;
  baseline: boolean;
  found: { ticker: string; account: string }[];
  sent: boolean;
  error?: string;
};

function fmtQty(n: number): string {
  return n > 0 ? Math.round(n).toLocaleString("en-AU") : "—";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** One mail for the run, a row per new option. */
export function newOptionsMail(lines: RegisterLine[]): StaffMail {
  const listed = lines.filter((l) => !l.isUnlisted).length;
  const unlisted = lines.length - listed;
  const mix = [listed && `${listed} listed`, unlisted && `${unlisted} unlisted`]
    .filter(Boolean)
    .join(", ");

  const sorted = [...lines].sort(
    (a, b) => a.ticker.localeCompare(b.ticker) || a.client.localeCompare(b.client),
  );

  const th = (t: string, right = false) =>
    `<th style="padding:6px 10px;border-bottom:1px solid #d8d3c7;color:#6b675e;font-size:12px;` +
    `font-weight:600;text-align:${right ? "right" : "left"};white-space:nowrap">${t}</th>`;
  const td = (t: string, right = false) =>
    `<td style="padding:6px 10px;border-bottom:1px solid #eeeae0;color:#1a1a1a;font-size:13px;` +
    `text-align:${right ? "right" : "left"}">${t}</td>`;

  const rows = sorted
    .map(
      (l) =>
        `<tr>${td(`<b>${esc(l.ticker)}</b>`)}${td(esc(l.company))}` +
        `${td(l.isUnlisted ? "Unlisted" : "Listed")}${td(esc(l.client))}${td(esc(l.account))}` +
        `${td(fmtQty(l.quantity), true)}${td(fmtDate(l.expiryDate))}</tr>`,
    )
    .join("");

  return {
    subject: `ALERT: ${lines.length} new option${lines.length === 1 ? "" : "s"} on the register (${mix})`,
    html:
      `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:860px">` +
      `<p style="margin:0 0 14px;font-size:15px;color:#b42318"><b>New options have appeared on ` +
      `client holdings after this morning's update.</b></p>` +
      `<table style="border-collapse:collapse">` +
      `<tr>${th("Ticker")}${th("Company")}${th("Type")}${th("Client")}${th("Account")}` +
      `${th("Quantity", true)}${th("Expiry")}</tr>${rows}</table>` +
      `<p style="margin:22px 0 0;color:#9a958a;font-size:11.5px">` +
      `Sent by the Vitti client portal's new-option watch.</p>` +
      `</div>`,
  };
}

export async function runNewOptionsWatch(deps: NewOptionsDeps): Promise<NewOptionsReport> {
  const lines = await deps.load();
  const report: NewOptionsReport = { register: lines.length, baseline: false, found: [], sent: false };
  if (lines.length === 0) return report;

  // First run: everything on the book becomes the baseline, nothing is mailed.
  if (await deps.ledgerEmpty()) {
    await deps.claim(lines);
    report.baseline = true;
    return report;
  }

  const claimed = await deps.claim(lines);
  const fresh = lines.filter((l) => claimed.has(l.key));
  report.found = fresh.map((l) => ({ ticker: l.ticker, account: l.account }));
  if (fresh.length === 0) return report;

  const result = await deps.send(newOptionsMail(fresh));
  if (result.sent) {
    report.sent = true;
  } else {
    await deps.release(fresh.map((l) => l.key));
    report.error = result.reason;
  }
  return report;
}
