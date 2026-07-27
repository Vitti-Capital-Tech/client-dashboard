/**
 * Minimal RFC 4180 CSV reader for broker exports.
 *
 * Deliberately dependency-free: the broker files are plain comma-separated
 * text, and the fields that actually contain commas (client addresses, joint
 * account names) are properly double-quoted, so a real parser is ~40 lines.
 * Adding a spreadsheet library for this would be more surface area than value.
 *
 * No `server-only` import and no `@/` path aliases anywhere in lib/import —
 * these modules are loaded both by the Next server and by the plain-Node CLI
 * importers in scripts/, which resolve neither.
 */

/** Split CSV text into raw rows, honouring quoted fields and embedded newlines. */
export function parseCsv(text: string): string[][] {
  // Strip a UTF-8 BOM — Excel writes one and it would poison the first header.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (quoted) {
      if (ch === '"') {
        // "" inside a quoted field is a literal quote.
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else if (ch !== "\r") {
      field += ch;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Drop trailing blank lines.
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

export type CsvRow = Record<string, string>;

/**
 * Parse into header-keyed records. Headers are trimmed, so a column exported as
 * `"Holding Qty "` is addressable as `Holding Qty` — the broker pads several.
 */
export function parseCsvRecords(text: string): {
  headers: string[];
  rows: CsvRow[];
} {
  const raw = parseCsv(text);
  if (raw.length === 0) return { headers: [], rows: [] };

  const headers = raw[0].map((h) => h.trim());
  const rows = raw.slice(1).map((cells) => {
    const rec: CsvRow = {};
    headers.forEach((h, i) => {
      rec[h] = (cells[i] ?? "").trim();
    });
    return rec;
  });

  return { headers, rows };
}

/**
 * Assert the export has the columns we read. Broker exports change shape
 * between versions; failing loudly at row 0 beats importing 280 rows of
 * silent nulls because a column was renamed.
 */
export function requireHeaders(headers: string[], required: string[]): void {
  const present = new Set(headers);
  const missing = required.filter((h) => !present.has(h));
  if (missing.length > 0) {
    throw new Error(
      `CSV is missing expected column(s): ${missing.join(", ")}\n` +
        `Found: ${headers.join(", ")}`,
    );
  }
}
