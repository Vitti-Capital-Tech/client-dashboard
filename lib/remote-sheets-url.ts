/**
 * Pure URL helpers for remote spreadsheet links.
 *
 * Split out of `lib/remote-sheets.ts` so they carry no `server-only` guard and
 * stay unit-testable — that module holds the credentials and network calls.
 */

export type LinkKind =
  | { provider: "google"; fileId: string }
  | { provider: "microsoft" }
  | { provider: "other" };

/**
 * Identifies which provider a pasted link belongs to, so the caller knows which
 * credentials (if any) can read it privately.
 */
export function classifyLink(rawUrl: string): LinkKind {
  const url = rawUrl.trim();

  const sheetsMatch = url.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (sheetsMatch?.[1]) return { provider: "google", fileId: sheetsMatch[1] };

  const driveFileMatch = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9-_]+)/);
  if (driveFileMatch?.[1]) return { provider: "google", fileId: driveFileMatch[1] };

  // drive.google.com/open?id=... and /uc?export=download&id=... variants
  const driveIdMatch = url.match(
    /drive\.google\.com\/[^?]*\?(?:[^#]*&)?id=([a-zA-Z0-9-_]+)/
  );
  if (driveIdMatch?.[1]) return { provider: "google", fileId: driveIdMatch[1] };

  if (
    /sharepoint\.com/i.test(url) ||
    /1drv\.ms/i.test(url) ||
    /onedrive\.live\.com/i.test(url)
  ) {
    return { provider: "microsoft" };
  }

  return { provider: "other" };
}

/**
 * Normalizes a Google Sheets / Drive / SharePoint link to a direct download URL
 * for the *unauthenticated* path. Only resolves for publicly shared links.
 */
export function normalizeExcelUrl(rawUrl: string): string {
  const url = rawUrl.trim();
  const kind = classifyLink(url);

  if (kind.provider === "google") {
    if (/spreadsheets\/d\//.test(url)) {
      return `https://docs.google.com/spreadsheets/d/${kind.fileId}/export?format=xlsx`;
    }
    return `https://drive.google.com/uc?export=download&id=${kind.fileId}`;
  }

  if (kind.provider === "microsoft") {
    let converted = url.replace(/\/doc2?\.aspx/i, "/download.aspx");
    if (!converted.includes("download=1")) {
      const sep = converted.includes("?") ? "&" : "?";
      converted = `${converted}${sep}download=1`;
    }
    return converted;
  }

  return url;
}
