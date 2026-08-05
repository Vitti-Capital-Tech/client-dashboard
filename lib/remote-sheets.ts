import "server-only";
import { createSign } from "node:crypto";
// Explicit .ts extension, matching the rest of lib/: Node strips types natively and
// resolves these modules directly (scripts/ and node --test both rely on it), and a
// bare specifier only works through the bundler.
import { classifyLink, normalizeExcelUrl } from "./remote-sheets-url.ts";

/**
 * Authenticated fetching of remote spreadsheets for the P&L calculator.
 *
 * The calculator lets staff paste a link to a Placement Tracker instead of
 * uploading the file. A plain `fetch()` only ever works for links shared as
 * "anyone with the link" — a *private* Google Sheet answers 401 (or serves the
 * sign-in HTML page with a 200), which is the failure this module removes.
 *
 * Two credential sets are supported, both machine-to-machine so no staff member
 * has to complete an interactive OAuth flow:
 *
 *   Google  — a service account (JWT bearer grant). Share the sheet with the
 *             service account's email as Viewer and it becomes readable.
 *   Microsoft — an Entra ID (Azure AD) app registration using the client
 *             credentials grant against Microsoft Graph.
 *
 * Either can be absent. When credentials for a host are missing — or the file
 * was never shared with the service account — we fall back to the anonymous
 * fetch so public links keep working exactly as before, and the caller gets a
 * `hint` describing the one-time setup step that would fix it.
 *
 * Bearer tokens are only ever attached to the provider's own API hosts, never
 * to the pasted URL itself.
 */

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_DRIVE_API = "https://www.googleapis.com/drive/v3";
const GRAPH_API = "https://graph.microsoft.com/v1.0";

export interface RemoteFetchResult {
  ok: boolean;
  buffer?: Buffer;
  filename?: string;
  /** Which path produced the bytes — surfaced in the UI so staff can tell
   *  an authenticated read from a public one. */
  source?: "google-service-account" | "microsoft-graph" | "public-link";
  error?: string;
  /** Actionable next step when `ok` is false (setup instruction, share step). */
  hint?: string;
}

/* ------------------------------------------------------------------ */
/* Credentials                                                         */
/* ------------------------------------------------------------------ */

function googleCreds(): { email: string; privateKey: string } | null {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (!email || !rawKey) return null;

  // .env files commonly carry the PEM as a single line with escaped newlines.
  const privateKey = rawKey.replace(/\\n/g, "\n").trim();
  if (!privateKey.includes("BEGIN")) return null;
  return { email, privateKey };
}

function microsoftCreds():
  | { tenantId: string; clientId: string; clientSecret: string }
  | null {
  const tenantId = process.env.MICROSOFT_TENANT_ID?.trim();
  const clientId = process.env.MICROSOFT_CLIENT_ID?.trim();
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET?.trim();
  if (!tenantId || !clientId || !clientSecret) return null;
  return { tenantId, clientId, clientSecret };
}

/** The address a private sheet has to be shared with. Shown in error hints. */
export function googleServiceAccountEmail(): string | null {
  return googleCreds()?.email ?? null;
}

/* ------------------------------------------------------------------ */
/* Access tokens (cached in-process until shortly before expiry)       */
/* ------------------------------------------------------------------ */

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function cachedToken(key: string): string | null {
  const hit = tokenCache.get(key);
  // 60s of slack so a token can't expire mid-request.
  if (hit && hit.expiresAt - 60_000 > Date.now()) return hit.token;
  return null;
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Mints a Google access token with the service account's own signed JWT
 * (the `urn:ietf:params:oauth:grant-type:jwt-bearer` grant), so no interactive
 * consent and no googleapis dependency is needed.
 */
async function getGoogleAccessToken(): Promise<string | null> {
  const creds = googleCreds();
  if (!creds) return null;

  const cacheKey = `google:${creds.email}`;
  const hit = cachedToken(cacheKey);
  if (hit) return hit;

  const nowSec = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = base64Url(
    JSON.stringify({
      iss: creds.email,
      // drive.readonly covers both native Sheets export and binary downloads.
      scope: "https://www.googleapis.com/auth/drive.readonly",
      aud: GOOGLE_TOKEN_URL,
      iat: nowSec,
      exp: nowSec + 3600,
    })
  );

  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claim}`);
  const signature = base64Url(signer.sign(creds.privateKey));
  const assertion = `${header}.${claim}.${signature}`;

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("Google service account token request failed:", res.status, body);
    return null;
  }

  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) return null;

  tokenCache.set(cacheKey, {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  });
  return json.access_token;
}

/** Mints an app-only Microsoft Graph token via the client credentials grant. */
async function getMicrosoftAccessToken(): Promise<string | null> {
  const creds = microsoftCreds();
  if (!creds) return null;

  const cacheKey = `microsoft:${creds.tenantId}:${creds.clientId}`;
  const hit = cachedToken(cacheKey);
  if (hit) return hit;

  const res = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(creds.tenantId)}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        scope: "https://graph.microsoft.com/.default",
        grant_type: "client_credentials",
      }),
      cache: "no-store",
    }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error("Microsoft Graph token request failed:", res.status, body);
    return null;
  }

  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) return null;

  tokenCache.set(cacheKey, {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  });
  return json.access_token;
}

/* ------------------------------------------------------------------ */
/* Response validation                                                 */
/* ------------------------------------------------------------------ */

/**
 * A sign-in or permission page often arrives as HTTP 200 with HTML, which
 * ExcelJS would reject with a confusing "invalid zip" error. Real .xlsx bytes
 * start with the ZIP magic "PK\x03\x04"; legacy .xls starts with 0xD0CF11E0.
 */
function looksLikeSpreadsheet(buffer: Buffer): boolean {
  if (buffer.length < 8) return false;
  const isZip = buffer[0] === 0x50 && buffer[1] === 0x4b;
  const isOle =
    buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0;
  return isZip || isOle;
}

function isCsvLike(buffer: Buffer, contentType: string): boolean {
  if (/text\/csv/i.test(contentType)) return true;
  const head = buffer.toString("utf-8", 0, Math.min(buffer.length, 500)).toLowerCase();
  return !head.includes("<!doctype") && !head.includes("<html") && head.includes(",");
}

/* ------------------------------------------------------------------ */
/* Provider fetchers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Reads a Drive file with the service account. Native Google Sheets must be
 * converted through `/export`; an uploaded .xlsx is downloaded with `alt=media`
 * — so metadata decides which call to make.
 */
async function fetchFromGoogle(fileId: string): Promise<RemoteFetchResult> {
  const token = await getGoogleAccessToken();
  if (!token) {
    return {
      ok: false,
      error: "Google service account is not configured on the server.",
      hint:
        "Set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY in .env.local, then share the sheet with that address as Viewer.",
    };
  }

  const authHeaders = { Authorization: `Bearer ${token}` };

  const metaRes = await fetch(
    `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=name,mimeType&supportsAllDrives=true`,
    { headers: authHeaders, cache: "no-store" }
  );

  if (metaRes.status === 404 || metaRes.status === 403) {
    const email = googleServiceAccountEmail();
    return {
      ok: false,
      error: "The service account does not have access to this file.",
      hint: email
        ? `Open the sheet → Share → add ${email} as Viewer, then retry.`
        : "Share the sheet with the configured service account as Viewer, then retry.",
    };
  }

  if (!metaRes.ok) {
    const body = await metaRes.text().catch(() => "");
    return {
      ok: false,
      error: `Google Drive rejected the request (HTTP ${metaRes.status}).`,
      hint: body.slice(0, 200) || undefined,
    };
  }

  const meta = (await metaRes.json()) as { name?: string; mimeType?: string };
  const isNativeSheet = meta.mimeType === "application/vnd.google-apps.spreadsheet";

  const downloadUrl = isNativeSheet
    ? `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(XLSX_MIME)}`
    : `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;

  const fileRes = await fetch(downloadUrl, { headers: authHeaders, cache: "no-store" });

  if (!fileRes.ok) {
    const body = await fileRes.text().catch(() => "");
    if (body.includes("exportSizeLimitExceeded")) {
      return {
        ok: false,
        error: "This Google Sheet is too large for Drive to export (10 MB limit).",
        hint: "Download it as .xlsx and upload the file directly.",
      };
    }
    return {
      ok: false,
      error: `Failed to download the file from Google Drive (HTTP ${fileRes.status}).`,
      hint: body.slice(0, 200) || undefined,
    };
  }

  const buffer = Buffer.from(await fileRes.arrayBuffer());
  const baseName = meta.name || "placement-tracker";
  const filename = isNativeSheet ? `${baseName}.xlsx` : baseName;

  return { ok: true, buffer, filename, source: "google-service-account" };
}

/**
 * Reads a SharePoint / OneDrive item with Microsoft Graph. Graph resolves any
 * sharing link — including 1drv.ms short links — through the `/shares`
 * endpoint once the URL is encoded into a share ID.
 */
async function fetchFromMicrosoft(rawUrl: string): Promise<RemoteFetchResult> {
  const token = await getMicrosoftAccessToken();
  if (!token) {
    return {
      ok: false,
      error: "Microsoft Graph credentials are not configured on the server.",
      hint:
        "Set MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET in .env.local (app needs the Files.Read.All application permission).",
    };
  }

  // Graph's documented share-ID encoding: "u!" + unpadded base64url of the URL.
  const shareId = `u!${base64Url(rawUrl.trim())}`;
  const authHeaders = { Authorization: `Bearer ${token}` };

  const metaRes = await fetch(
    `${GRAPH_API}/shares/${shareId}/driveItem?$select=name,size`,
    { headers: authHeaders, cache: "no-store" }
  );

  if (metaRes.status === 401 || metaRes.status === 403 || metaRes.status === 404) {
    return {
      ok: false,
      error: "Microsoft Graph could not open this link with the configured app.",
      hint:
        "Grant the app registration the Files.Read.All (and Sites.Read.All for SharePoint) application permission with admin consent, then retry.",
    };
  }

  if (!metaRes.ok) {
    const body = await metaRes.text().catch(() => "");
    return {
      ok: false,
      error: `Microsoft Graph rejected the request (HTTP ${metaRes.status}).`,
      hint: body.slice(0, 200) || undefined,
    };
  }

  const meta = (await metaRes.json()) as { name?: string };

  const fileRes = await fetch(`${GRAPH_API}/shares/${shareId}/driveItem/content`, {
    headers: authHeaders,
    redirect: "follow",
    cache: "no-store",
  });

  if (!fileRes.ok) {
    return {
      ok: false,
      error: `Failed to download the file from Microsoft Graph (HTTP ${fileRes.status}).`,
    };
  }

  const buffer = Buffer.from(await fileRes.arrayBuffer());
  return {
    ok: true,
    buffer,
    filename: meta.name || "placement-tracker.xlsx",
    source: "microsoft-graph",
  };
}

/** The original anonymous download — still correct for public links. */
async function fetchPublic(rawUrl: string): Promise<RemoteFetchResult> {
  const targetUrl = normalizeExcelUrl(rawUrl);
  const res = await fetch(targetUrl, {
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) ClientDashboard/1.0",
    },
    cache: "no-store",
  });

  if (!res.ok) {
    return {
      ok: false,
      error: `Failed to fetch URL (HTTP ${res.status}: ${res.statusText}).`,
      hint: "Private link? Configure a service account, or set sharing to 'Anyone with the link can view'.",
    };
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  const contentType = res.headers.get("content-type") || "";

  if (!looksLikeSpreadsheet(buffer) && !isCsvLike(buffer, contentType)) {
    return {
      ok: false,
      error:
        "The link returned a sign-in / permission page instead of a spreadsheet.",
      hint: "Private link? Configure a service account, or set sharing to 'Anyone with the link can view'.",
    };
  }

  const nameFromUrl = (() => {
    try {
      const last = new URL(targetUrl).pathname.split("/").filter(Boolean).pop();
      return last && /\.(xlsx|xls|csv)$/i.test(last) ? last : null;
    } catch {
      return null;
    }
  })();

  return {
    ok: true,
    buffer,
    filename: nameFromUrl || "placement-tracker.xlsx",
    source: "public-link",
  };
}

/* ------------------------------------------------------------------ */
/* Public entry point                                                  */
/* ------------------------------------------------------------------ */

/**
 * Downloads a spreadsheet from a pasted link, preferring an authenticated read
 * when credentials for that provider exist so *private* files work, and falling
 * back to the anonymous path otherwise.
 *
 * Never throws — every failure comes back as `{ ok: false, error, hint }`.
 */
export async function fetchRemoteSpreadsheet(
  rawUrl: string
): Promise<RemoteFetchResult> {
  const url = rawUrl?.trim();
  if (!url) {
    return { ok: false, error: "Please enter a valid file URL." };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "That does not look like a valid URL." };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, error: "Only http(s) links are supported." };
  }

  const kind = classifyLink(url);

  try {
    if (kind.provider === "google" && googleCreds()) {
      const authed = await fetchFromGoogle(kind.fileId);
      if (authed.ok) return authed;
      // A public link still resolves without credentials — try before giving up.
      const publicTry = await fetchPublic(url);
      return publicTry.ok ? publicTry : authed;
    }

    if (kind.provider === "microsoft" && microsoftCreds()) {
      const authed = await fetchFromMicrosoft(url);
      if (authed.ok) return authed;
      const publicTry = await fetchPublic(url);
      return publicTry.ok ? publicTry : authed;
    }

    const publicResult = await fetchPublic(url);
    if (publicResult.ok) return publicResult;

    // Anonymous fetch failed and we have no credentials for this provider —
    // say exactly which ones would fix it.
    if (kind.provider === "google") {
      return {
        ...publicResult,
        hint: "This looks like a private Google file. Set GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY in .env.local, then share the sheet with that address as Viewer.",
      };
    }
    if (kind.provider === "microsoft") {
      return {
        ...publicResult,
        hint: "This looks like a private SharePoint/OneDrive file. Set MICROSOFT_TENANT_ID, MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET in .env.local.",
      };
    }
    return publicResult;
  } catch (err) {
    console.error("Error fetching remote spreadsheet:", err);
    return {
      ok: false,
      error:
        err instanceof Error
          ? err.message
          : "Failed to download the file from that link.",
    };
  }
}
