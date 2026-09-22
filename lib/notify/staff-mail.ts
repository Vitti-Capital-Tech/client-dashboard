/**
 * Mail to the desk when a client is waiting on them.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * A client who registers, or who adds a second account to an existing login,
 * raises a request and then sees "awaiting approval". Nothing tells the desk.
 * The request sits on `/portal/staff/merge-requests`, which is a page somebody
 * has to think to open — so the wait was as long as it took a staff member to
 * wonder whether anything was queued. For a client whose first experience of
 * the portal is a locked screen, that is the whole product.
 *
 * ── Why Microsoft Graph and not an email provider ───────────────────────────
 * The app already holds a Microsoft app registration and uses it to READ the
 * broker mailbox (`lib/ingest/graph-mail.ts`, `getMicrosoftAccessToken`). The
 * same client-credentials token sends mail, so this needs no new provider, no
 * second API key, no new sending domain to warm up, and no DNS work: the mail
 * leaves a vitti.capital mailbox that already exists and already passes its own
 * SPF/DKIM.
 *
 * It does need ONE thing granted in Azure that reading did not: the
 * `Mail.Send` APPLICATION permission on the same app registration, with admin
 * consent. Until that is granted every send fails with 403 and this module says
 * so in the log rather than silently doing nothing. See README §4.11.
 *
 * ── Why a failure here must never reach the client ──────────────────────────
 * The mail is a convenience for the desk. The REQUEST is the thing that
 * matters, and it is already written and committed by the time this runs. A
 * mailbox that is down, a token that expired, a permission nobody granted yet —
 * none of those are reasons to tell a client their account request failed, or
 * to make them wait on an SMTP round trip. So every entry point returns a
 * result instead of throwing, and the callers run it inside `after()`.
 *
 * ── Off unless configured ───────────────────────────────────────────────────
 * No `STAFF_NOTIFY_TO`, no mail — the same shape as the weekly commentary being
 * gated on `ANTHROPIC_API_KEY`. A deployment that has not set it gets the
 * behaviour it had before this file existed, rather than an error on every
 * account request.
 */

/**
 * ── Why the token helper is imported on demand ──────────────────────────────
 * `lib/remote-sheets.ts` starts with `import "server-only"`, which throws the
 * moment the module is loaded outside a Server Component — including under
 * `node --test`. Pulling it in at the top would make the pure half of this file
 * (the config gate and the two message builders, which is the half worth
 * testing) untestable along with it. The same arrangement, for the same reason,
 * as `lib/ingest/morning.ts` and `lib/commentary/run.ts`.
 */

const GRAPH = "https://graph.microsoft.com/v1.0";

export type StaffMailConfig = {
  /** Where the alert goes. At least one address. */
  to: string[];
  /** The mailbox it is sent FROM — must exist in the tenant. */
  from: string;
  /** Base URL for the deep link, when the deployment knows its own address. */
  appUrl: string | null;
};

/**
 * Read the configuration, or say why there is none.
 *
 * `STAFF_NOTIFY_FROM` falls back to `BROKER_MAILBOX` because that is a mailbox
 * this tenant demonstrably owns and the app already reaches — one fewer thing
 * to get wrong, and a sender the desk will recognise.
 */
export function staffMailConfig():
  | { ok: true; config: StaffMailConfig }
  | { ok: false; reason: string } {
  const to = (process.env.STAFF_NOTIFY_TO ?? "")
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (to.length === 0) {
    return { ok: false, reason: "STAFF_NOTIFY_TO is not set — desk alerts are off." };
  }

  const from = (process.env.STAFF_NOTIFY_FROM || process.env.BROKER_MAILBOX || "").trim();
  if (!from) {
    return {
      ok: false,
      reason: "Neither STAFF_NOTIFY_FROM nor BROKER_MAILBOX is set — nothing to send from.",
    };
  }

  const appUrl = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "").trim() || null;

  return { ok: true, config: { to, from, appUrl } };
}

/** What the desk is told. Built purely, so the wording is testable. */
export type StaffMail = { subject: string; html: string };

/**
 * Escape before interpolation, every time.
 *
 * A client chooses their own name and types their own note, and both go into
 * this HTML. Unescaped, a note containing markup would render as markup in a
 * staff mailbox — and the desk reading a request is exactly the audience worth
 * not handing crafted content to.
 */
function esc(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Shared chrome, so both alerts read as one thing from one system. */
function wrap(heading: string, rows: [string, string | null][], appUrl: string | null): string {
  const cells = rows
    .filter(([, v]) => v !== null && v !== "")
    .map(
      ([k, v]) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#6b675e;font-size:13px;white-space:nowrap">${esc(k)}</td>` +
        `<td style="padding:4px 0;color:#1a1a1a;font-size:13px"><b>${esc(v)}</b></td></tr>`,
    )
    .join("");

  const link = appUrl
    ? `<p style="margin:18px 0 0"><a href="${esc(appUrl)}/portal/staff/merge-requests" ` +
      `style="background:#1f3a5f;color:#fff;text-decoration:none;padding:9px 16px;` +
      `border-radius:7px;font-size:13px;font-weight:600;display:inline-block">Open the request</a></p>`
    : `<p style="margin:18px 0 0;color:#6b675e;font-size:13px">` +
      `Approve it under <b>Staff → Merge requests</b>.</p>`;

  return (
    `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px">` +
    `<p style="margin:0 0 14px;font-size:15px;color:#1a1a1a"><b>${esc(heading)}</b></p>` +
    `<table style="border-collapse:collapse">${cells}</table>` +
    link +
    `<p style="margin:22px 0 0;color:#9a958a;font-size:11.5px">` +
    `Sent by the Vitti client portal because a client is waiting on an approval.</p>` +
    `</div>`
  );
}

/** A client asking to attach a broker account — at sign-up, or a later one. */
export function accountClaimMail(input: {
  clientName: string;
  clientEmail: string | null;
  accountNumber: string;
  note?: string | null;
  /** True when the client has no accounts yet, i.e. they cannot use the portal. */
  isFirstAccount: boolean;
  appUrl?: string | null;
}): StaffMail {
  // The distinction is the whole point of the subject line: one client is
  // locked out of the portal entirely, the other is already using it.
  const subject = input.isFirstAccount
    ? `New client waiting for approval — ${input.clientName} (account ${input.accountNumber})`
    : `Account request — ${input.clientName} wants account ${input.accountNumber}`;

  const heading = input.isFirstAccount
    ? "A new client has registered and cannot use the portal until this is approved."
    : "An existing client has asked to add another account to their login.";

  return {
    subject,
    html: wrap(
      heading,
      [
        ["Client", input.clientName],
        ["Email", input.clientEmail],
        ["Account number", input.accountNumber],
        ["Their note", input.note ?? null],
      ],
      input.appUrl ?? null,
    ),
  };
}

/** A client asking to merge two accounts they already hold. */
export function accountMergeMail(input: {
  clientName: string;
  clientEmail: string | null;
  sourceLabel: string;
  targetLabel: string;
  note?: string | null;
  appUrl?: string | null;
}): StaffMail {
  return {
    subject: `Merge request — ${input.clientName}: ${input.sourceLabel} into ${input.targetLabel}`,
    html: wrap(
      "A client has asked for two of their accounts to be merged.",
      [
        ["Client", input.clientName],
        ["Email", input.clientEmail],
        ["Merge", `${input.sourceLabel} → ${input.targetLabel}`],
        ["Their note", input.note ?? null],
      ],
      input.appUrl ?? null,
    ),
  };
}

export type SendResult =
  | { sent: true; to: string[] }
  | { sent: false; reason: string };

/**
 * Send one alert to the desk. Never throws.
 *
 * `saveToSentItems` is false: these are machine alerts and filing hundreds of
 * them in a human mailbox's Sent folder makes that folder useless for the
 * person who actually uses it. The audit log already records that the request
 * happened; this mail is a nudge, not a record.
 */
export async function sendStaffMail(mail: StaffMail): Promise<SendResult> {
  const cfg = staffMailConfig();
  if (!cfg.ok) return { sent: false, reason: cfg.reason };

  try {
    const { getMicrosoftAccessToken } = await import("../remote-sheets.ts");
    const token = await getMicrosoftAccessToken();
    if (!token) {
      return { sent: false, reason: "No Microsoft Graph token — check MICROSOFT_* credentials." };
    }

    const res = await fetch(
      `${GRAPH}/users/${encodeURIComponent(cfg.config.from)}/sendMail`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            subject: mail.subject,
            body: { contentType: "HTML", content: mail.html },
            toRecipients: cfg.config.to.map((address) => ({ emailAddress: { address } })),
          },
          saveToSentItems: false,
        }),
        cache: "no-store",
      },
    );

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // 403 here is nearly always the one Azure permission this needs and
      // reading did not, so the log says which rather than printing a status.
      const hint =
        res.status === 403
          ? " — the app registration is missing the Mail.Send application permission (admin consent required)."
          : "";
      const reason = `Graph sendMail failed: ${res.status}${hint} ${body.slice(0, 300)}`;
      console.error("[staff-mail]", reason);
      return { sent: false, reason };
    }

    return { sent: true, to: cfg.config.to };
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Unknown error sending desk mail.";
    console.error("[staff-mail]", reason);
    return { sent: false, reason };
  }
}
