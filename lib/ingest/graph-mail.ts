import "server-only";
import { getMicrosoftAccessToken } from "../remote-sheets.ts";

/**
 * Reading the broker's morning mail through Microsoft Graph.
 *
 * ── Which mailbox ────────────────────────────────────────────────────────────
 * `BROKER_MAILBOX` — an address with an actual MAILBOX behind it. A
 * distribution list will not work and cannot be made to: a DL forwards to its
 * members and stores nothing, so there is no mailbox for Graph to open. If the
 * broker mail arrives via a DL, point this at a shared mailbox (or an
 * individual's) that is a MEMBER of that list.
 *
 * ── Which mail ───────────────────────────────────────────────────────────────
 * Sender first (`BROKER_SENDER_ALLOWLIST`), then optionally subject
 * (`BROKER_SUBJECT_PATTERN`), then a received-time watermark. Sender is the
 * primary filter because a subject line carries a date and gets reworded; the
 * allowlist is a comma-separated env var rather than a constant so a change of
 * address is a config edit, not a deploy.
 *
 * None of these decide WHICH IMPORTER runs — that is settled by the CSV headers
 * (`detectCsvKind`). A mail filter says "this is worth opening"; only the
 * columns say "this is a holdings snapshot".
 *
 * ── Least privilege ──────────────────────────────────────────────────────────
 * `Mail.Read` as an application permission grants access to EVERY mailbox in
 * the tenant. Scope the app registration with an ApplicationAccessPolicy
 * restricted to this one mailbox; otherwise a compromise of the client secret
 * reads the whole company's mail.
 */

const GRAPH = "https://graph.microsoft.com/v1.0";

export type BrokerAttachment = {
  messageId: string;
  attachmentId: string;
  receivedAt: string;
  sender: string;
  subject: string;
  filename: string;
  sizeBytes: number;
  /** Decoded file contents. These exports are CSV, so text is the useful form. */
  content: string;
};

export type MailboxConfig = {
  mailbox: string;
  folder: string | null;
  senders: string[];
  subjectPattern: RegExp | null;
};

/** Reads the ingest configuration, or explains precisely what is missing. */
export function mailboxConfig(): { ok: true; config: MailboxConfig } | { ok: false; error: string } {
  const mailbox = process.env.BROKER_MAILBOX?.trim();
  if (!mailbox) {
    return {
      ok: false,
      error:
        "BROKER_MAILBOX is not set. It must be an address with a real mailbox — " +
        "a distribution list has nothing to read.",
    };
  }

  const senders = (process.env.BROKER_SENDER_ALLOWLIST ?? "")
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (senders.length === 0) {
    return {
      ok: false,
      error:
        "BROKER_SENDER_ALLOWLIST is empty. Ingesting attachments from any sender " +
        "would let anyone who can mail this address write to the database.",
    };
  }

  let subjectPattern: RegExp | null = null;
  const raw = process.env.BROKER_SUBJECT_PATTERN?.trim();
  if (raw) {
    try {
      subjectPattern = new RegExp(raw, "i");
    } catch {
      return { ok: false, error: `BROKER_SUBJECT_PATTERN is not a valid regex: ${raw}` };
    }
  }

  return {
    ok: true,
    config: {
      mailbox,
      folder: process.env.BROKER_MAIL_FOLDER?.trim() || null,
      senders,
      subjectPattern,
    },
  };
}

export type MailboxCheck = {
  ok: boolean;
  /** Each step in order, so a failure names which one broke. */
  steps: { step: string; ok: boolean; detail: string }[];
  hint?: string;
};

/**
 * Verify the mailbox is reachable, WITHOUT importing anything.
 *
 * Exists because the alternative ways to find out are both bad: wait for the
 * 9am cron and read the failure afterwards, or trigger a real ingest and have
 * it apply files while you were only testing credentials. This walks the same
 * path the ingest walks — config → token → mailbox → folder → a filtered
 * message count — and stops there. It never downloads an attachment.
 *
 * Each step is reported separately because "it doesn't work" has five quite
 * different causes here, and the fix for each is in a different console.
 */
export async function checkMailboxAccess(): Promise<MailboxCheck> {
  const steps: MailboxCheck["steps"] = [];
  const fail = (hint?: string): MailboxCheck => ({ ok: false, steps, hint });

  const cfg = mailboxConfig();
  if (!cfg.ok) {
    steps.push({ step: "config", ok: false, detail: cfg.error });
    return fail("Set the missing variable in .env.local (or the host's env UI).");
  }
  const { mailbox, folder, senders, subjectPattern } = cfg.config;
  steps.push({
    step: "config",
    ok: true,
    detail:
      `mailbox=${mailbox} · folder=${folder ?? "(whole mailbox)"} · ` +
      `senders=${senders.join(", ")} · subject=${subjectPattern?.source ?? "(any)"}`,
  });

  const token = await getMicrosoftAccessToken();
  if (!token) {
    steps.push({ step: "graph-token", ok: false, detail: "No token returned." });
    return fail(
      "Check MICROSOFT_TENANT_ID / MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET. " +
        "A secret that has expired fails exactly like a wrong one.",
    );
  }
  steps.push({ step: "graph-token", ok: true, detail: "Client-credentials token obtained." });

  // Reading the mailbox's own resource is the cheapest thing that distinguishes
  // "no mailbox" from "no permission" — the two failures that look identical
  // from the message list.
  const who = await graph(
    token,
    `/users/${encodeURIComponent(mailbox)}/mailFolders/inbox?$select=id,displayName,totalItemCount`,
  );
  if (!who.ok) {
    const body = await who.text().catch(() => "");
    steps.push({
      step: "mailbox",
      ok: false,
      detail: `HTTP ${who.status} ${body.slice(0, 300)}`,
    });
    return fail(
      who.status === 404
        ? `${mailbox} has no mailbox Graph can open — it is most likely a distribution list. ` +
          `Point BROKER_MAILBOX at a shared or individual mailbox that RECEIVES this mail.`
        : who.status === 403
          ? `Mail.Read is missing, unconsented, or the ApplicationAccessPolicy excludes ${mailbox}.`
          : "Unexpected Graph error — see the detail above.",
    );
  }
  steps.push({ step: "mailbox", ok: true, detail: `Inbox readable on ${mailbox}.` });

  let base = `/users/${encodeURIComponent(mailbox)}`;
  if (folder) {
    const folderId = await resolveFolderId(token, mailbox, folder);
    if (!folderId) {
      steps.push({ step: "folder", ok: false, detail: `Folder "${folder}" not found.` });
      return fail(
        `Create the folder "${folder}" in ${mailbox} and add a rule filing the broker's ` +
          `mail into it — or clear BROKER_MAIL_FOLDER to scan the whole mailbox.`,
      );
    }
    base += `/mailFolders/${folderId}`;
    steps.push({ step: "folder", ok: true, detail: `Resolved "${folder}".` });
  } else {
    steps.push({
      step: "folder",
      ok: true,
      detail: "No folder configured — the whole mailbox will be scanned.",
    });
  }

  // The real query, through the same degradation ladder the ingest uses — so
  // this reports what the ingest will actually be able to do, not what an
  // easier query could. An empty result is not an error; it is the answer "the
  // sender address does not match what is arriving", which is worth knowing
  // before the morning rather than after.
  const probe = await listMessages(token, base, { senders, since: null, top: 10 });
  if (!probe.ok) {
    const body = await probe.res.text().catch(() => "");
    steps.push({
      step: "messages",
      ok: false,
      detail: `HTTP ${probe.res.status} ${body.slice(0, 300)}`,
    });
    return fail(
      probe.res.status === 400 && body.includes("InefficientFilter")
        ? "Exchange refused even the reduced query. Set BROKER_MAIL_FOLDER and add a mail " +
          "rule filing the broker's mail into it — a smaller folder is what makes the " +
          "filter acceptable."
        : "The mailbox opened but the filtered query failed — see the detail above.",
    );
  }

  const all = ((await probe.res.json()) as {
    value?: {
      subject: string | null;
      receivedDateTime: string;
      from?: { emailAddress?: { address?: string } };
    }[];
  }).value ?? [];

  // Re-applied here for the same reason the ingest re-applies it: the server
  // filter may have been dropped to get the query accepted.
  const found = all.filter((m) =>
    senders.includes((m.from?.emailAddress?.address ?? "").toLowerCase()),
  );

  // Subjects are reported verbatim so BROKER_SUBJECT_PATTERN can be written
  // against what actually arrives rather than what someone remembers.
  const subjectMatches = subjectPattern
    ? found.filter((m) => subjectPattern.test(m.subject ?? "")).length
    : found.length;

  steps.push({
    step: "subject-filter",
    ok: !subjectPattern || subjectMatches > 0,
    detail: subjectPattern
      ? `${subjectMatches} of ${found.length} recent message(s) match /${subjectPattern.source}/i.` +
        (subjectMatches < found.length
          ? " The rest would be SKIPPED — check that is intended."
          : "")
      : "No subject filter — every message from an allowlisted sender is considered.",
  });

  steps.push({
    step: "messages",
    ok: true,
    detail:
      found.length === 0
        ? `No mail with attachments from ${senders.join(", ")}.`
        : `${found.length} recent match(es): ` +
          found.map((m) => `"${m.subject ?? "(no subject)"}" @ ${m.receivedDateTime}`).join(" · "),
  });

  return {
    ok: true,
    steps,
    hint:
      found.length === 0
        ? "Everything is configured and readable, but nothing matches the sender allowlist yet. " +
          "Check BROKER_SENDER_ALLOWLIST against the actual From address, and that the mail " +
          "rule is filing into the configured folder."
        : undefined,
  };
}

/**
 * List candidate messages, degrading the query until Exchange accepts it.
 *
 * Exchange rejects a `$filter` it considers too expensive with **HTTP 400
 * `InefficientFilter`** — "the restriction or sort order is too complex". Which
 * queries qualify depends on the mailbox's size and indexes, not on anything
 * visible from here, so a single hand-tuned query is a guess that works on one
 * mailbox and fails on the next. Three attempts, each cheaper than the last:
 *
 *   1. sender + hasAttachments + watermark, newest first
 *   2. …without `$orderby` — combining a sort with a navigation-property
 *      filter (`from/emailAddress/address`) is the usual trigger
 *   3. …without the sender filter either, leaving only the indexed
 *      `receivedDateTime` and `hasAttachments`
 *
 * The sender allowlist is NOT weakened by attempt 3 — it is re-applied in
 * memory by the caller, which is the only place it has ever been enforced for
 * subject anyway. Server-side filtering is a bandwidth optimisation here, never
 * the security boundary.
 *
 * Ordering is likewise not lost: the caller sorts what it gets. `$orderby`
 * mattered only for choosing WHICH messages `$top` returns, which the watermark
 * already narrows to a handful.
 */
async function listMessages(
  token: string,
  base: string,
  opts: { senders: string[]; since: Date | null; top: number },
): Promise<{ ok: true; res: Response } | { ok: false; res: Response }> {
  const { senders, since, top } = opts;

  const senderClause = `(${senders
    .map((s) => `from/emailAddress/address eq '${s.replace(/'/g, "''")}'`)
    .join(" or ")})`;
  const windowClause = since ? `receivedDateTime gt ${since.toISOString()}` : null;

  const attempts: { filter: string; order: boolean }[] = [
    { filter: ["hasAttachments eq true", windowClause, senderClause].filter(Boolean).join(" and "), order: true },
    { filter: ["hasAttachments eq true", windowClause, senderClause].filter(Boolean).join(" and "), order: false },
    { filter: ["hasAttachments eq true", windowClause].filter(Boolean).join(" and "), order: false },
  ];

  let last: Response | null = null;

  for (const [i, attempt] of attempts.entries()) {
    const res = await graph(
      token,
      `${base}/messages?$top=${top}` +
        `&$select=id,receivedDateTime,subject,from,hasAttachments` +
        (attempt.order ? `&$orderby=receivedDateTime desc` : "") +
        `&$filter=${encodeURIComponent(attempt.filter)}`,
    );

    if (res.ok) {
      if (i > 0) {
        console.warn(
          `Broker mail: Exchange rejected query ${i} as too complex; ` +
            `succeeded with the reduced form. Setting BROKER_MAIL_FOLDER would avoid this.`,
        );
      }
      return { ok: true, res };
    }

    // Only an InefficientFilter is worth retrying — a 403 or 404 will not
    // improve by asking for less, and retrying would just hide the real cause.
    const body = await res.clone().text().catch(() => "");
    if (!(res.status === 400 && body.includes("InefficientFilter"))) {
      return { ok: false, res };
    }
    last = res;
  }

  return { ok: false, res: last! };
}

async function graph(token: string, path: string): Promise<Response> {
  return fetch(`${GRAPH}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
}

/**
 * Resolve a mail folder by display name to its id.
 *
 * A named folder is strongly preferred over scanning the whole inbox: a busy
 * desk mailbox carries hundreds of unrelated messages a day, and a folder that
 * a mail rule fills gives the desk a way to REPLAY a missed file — drag it in
 * and the next run picks it up.
 */
async function resolveFolderId(
  token: string,
  mailbox: string,
  folderName: string,
): Promise<string | null> {
  const res = await graph(
    token,
    `/users/${encodeURIComponent(mailbox)}/mailFolders?$top=200&$select=id,displayName`,
  );
  if (!res.ok) return null;

  const json = (await res.json()) as { value?: { id: string; displayName: string }[] };
  const match = (json.value ?? []).find(
    (f) => f.displayName.toLowerCase() === folderName.toLowerCase(),
  );
  return match?.id ?? null;
}

export type FetchResult = {
  ok: boolean;
  attachments: BrokerAttachment[];
  messagesSeen: number;
  error?: string;
};

/**
 * Every CSV attachment on broker mail received after `since`.
 *
 * `since` is exclusive and comes from the last successful run. Re-reading a
 * message costs nothing — both importers are idempotent and the attachment
 * table dedupes on Graph's own ids — so the watermark is an optimisation, and
 * is deliberately allowed to be conservative (earlier) rather than risk a gap.
 */
export async function fetchBrokerAttachments(
  since: Date | null,
  opts: { maxMessages?: number } = {},
): Promise<FetchResult> {
  const cfg = mailboxConfig();
  if (!cfg.ok) return { ok: false, attachments: [], messagesSeen: 0, error: cfg.error };

  const { mailbox, folder, senders, subjectPattern } = cfg.config;

  const token = await getMicrosoftAccessToken();
  if (!token) {
    return {
      ok: false,
      attachments: [],
      messagesSeen: 0,
      error:
        "Could not obtain a Microsoft Graph token. Check MICROSOFT_TENANT_ID / " +
        "MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET.",
    };
  }

  let base = `/users/${encodeURIComponent(mailbox)}`;
  if (folder) {
    const folderId = await resolveFolderId(token, mailbox, folder);
    if (!folderId) {
      return {
        ok: false,
        attachments: [],
        messagesSeen: 0,
        error: `Mail folder "${folder}" not found in ${mailbox}.`,
      };
    }
    base += `/mailFolders/${folderId}`;
  }

  const top = opts.maxMessages ?? 50;

  const listRes = await listMessages(token, base, { senders, since, top });
  if (!listRes.ok) {
    const body = await listRes.res.text().catch(() => "");
    const status = listRes.res.status;
    // 404 on a valid-looking address is the distribution-list symptom, and it is
    // worth naming outright — it is otherwise a long afternoon.
    const hint =
      status === 404
        ? ` — ${mailbox} may be a distribution list rather than a mailbox, or the ` +
          `app has no ApplicationAccessPolicy covering it.`
        : status === 400 && body.includes("InefficientFilter")
          ? ` — Exchange refused even the reduced query. Set BROKER_MAIL_FOLDER so a ` +
            `mail rule narrows the scan to one folder.`
          : "";
    return {
      ok: false,
      attachments: [],
      messagesSeen: 0,
      error: `Graph message list failed (${status})${hint} ${body.slice(0, 300)}`,
    };
  }

  const messages = ((await listRes.res.json()) as {
    value?: {
      id: string;
      receivedDateTime: string;
      subject: string | null;
      from?: { emailAddress?: { address?: string } };
    }[];
  }).value ?? [];

  // The sender allowlist is re-applied HERE, unconditionally.
  //
  // `listMessages` may have had to drop it from the server-side query to get
  // past Exchange's InefficientFilter, so the server filter is a bandwidth
  // optimisation and never the boundary. Enforcing it in one place, on every
  // path, is what stops "the query degraded" from quietly becoming "we now
  // import attachments from anyone who can mail this address".
  const wanted = messages.filter((m) => {
    const from = (m.from?.emailAddress?.address ?? "").toLowerCase();
    if (!senders.includes(from)) return false;
    return !subjectPattern || subjectPattern.test(m.subject ?? "");
  });

  const attachments: BrokerAttachment[] = [];

  for (const m of wanted) {
    const attRes = await graph(
      token,
      `/users/${encodeURIComponent(mailbox)}/messages/${m.id}/attachments`,
    );
    if (!attRes.ok) {
      console.error(`Graph attachment list failed for message ${m.id}: ${attRes.status}`);
      continue;
    }

    const items = ((await attRes.json()) as {
      value?: {
        id: string;
        name: string;
        size: number;
        contentBytes?: string;
        "@odata.type"?: string;
      }[];
    }).value ?? [];

    for (const a of items) {
      // Only file attachments carry bytes; an item attachment is a forwarded
      // message and has none.
      if (!a.contentBytes) continue;
      // A cheap pre-filter only. The headers still decide what the file IS —
      // this just avoids decoding signature images and PDFs.
      if (!/\.csv$/i.test(a.name)) continue;

      attachments.push({
        messageId: m.id,
        attachmentId: a.id,
        receivedAt: m.receivedDateTime,
        sender: m.from?.emailAddress?.address ?? "",
        subject: m.subject ?? "",
        filename: a.name,
        sizeBytes: a.size ?? 0,
        content: Buffer.from(a.contentBytes, "base64").toString("utf8"),
      });
    }
  }

  // Oldest first: a holdings snapshot creates the accounts a trade ledger needs,
  // and processing this morning's mail before last Friday's would apply an older
  // full-replace snapshot on top of a newer one.
  attachments.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));

  return { ok: true, attachments, messagesSeen: wanted.length };
}
