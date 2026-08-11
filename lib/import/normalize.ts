/**
 * Field-level normalizers shared by both broker importers.
 *
 * Every function here is pure and total: given junk it returns a sentinel or
 * throws with the offending value in the message. The importers turn those
 * throws into a per-row rejection report rather than aborting the run.
 */

// ---------------------------------------------------------------------------
// Security codes
// ---------------------------------------------------------------------------

/**
 * The ordinary (parent) ASX code for any security code.
 *
 * ASX ordinary codes are exactly three characters and may contain digits —
 * 'ADN', 'AT4', 'PC2', 'BM1'. Derivatives extend that root with a suffix:
 *   EOSXX → EOS   (instalment placement receipt)
 *   ACWXX → ACW
 *   PC2ZZ → PC2
 *   ADNOD → ADN   (listed option, expiry-coded)
 *   AT4OE → AT4
 *
 * So the rule is "first three characters", NOT "strip a trailing XX". Stripping
 * literal suffixes would mangle real three-letter codes (LDX is Lumos
 * Diagnostics, not LD + X) and would miss the option suffixes entirely.
 */
/**
 * A foreign listing, qualified by its exchange — `RKLB:NAS`, `BRAI:NAS`.
 *
 * These behave nothing like an ASX code. `BRAI` is a whole NASDAQ ticker, not
 * `BRA` plus a derivative suffix, so every rule below that slices to three
 * characters has to step aside for them: doing otherwise would invent a parent
 * (`BRA`) and silently merge unrelated instruments under it.
 *
 * Deliberately permissive about the exchange part. Only `:NAS` appears today,
 * and hard-coding it would mean the next market the desk touches fails the same
 * way this one did — as an unreadable code, with the holding dropped.
 */
export const EXCHANGE_QUALIFIED = /^[A-Z0-9.]{1,12}:[A-Z]{2,4}$/;

/** True for `RKLB:NAS` and the like; false for every ASX code. */
export function isExchangeQualified(rawCode: string): boolean {
  return EXCHANGE_QUALIFIED.test(String(rawCode ?? "").trim().toUpperCase());
}

export function parentCode(rawCode: string): string {
  const code = rawCode.trim().toUpperCase();

  // A foreign listing is its own parent — there is no ordinary underneath it.
  if (EXCHANGE_QUALIFIED.test(code)) return code;

  if (!/^[A-Z0-9]{3,6}$/.test(code)) {
    throw new Error(`Unrecognised security code: "${rawCode}"`);
  }
  return code.slice(0, 3);
}

/** True when the code is a derivative of its parent rather than the ordinary itself. */
export function isDerivative(rawCode: string): boolean {
  const code = rawCode.trim().toUpperCase();
  // Length is the ASX tell (`ADNOD` is longer than `ADN`). A foreign ticker is
  // simply longer than three characters and means nothing by it.
  if (EXCHANGE_QUALIFIED.test(code)) return false;
  return code.length > 3;
}

/**
 * Instrument class from the broker's Security Type / Security Class pair,
 * falling back to the code shape when the snapshot columns are absent (the
 * trade ledger has a `Description` instead).
 */
export function securityClass(
  securityType: string | undefined,
  className: string | undefined,
  rawCode: string,
): string {
  const cls = (className ?? "").trim();
  if (cls) return cls;

  switch ((securityType ?? "").trim()) {
    case "01":
      return "Ordinary";
    case "40":
      return "Options";
    case "04":
      return "Allocation Interest";
    default:
      return isDerivative(rawCode) ? "Options" : "Ordinary";
  }
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/**
 * Coerce a broker numeric cell. Handles thousands separators, currency signs
 * and accounting-style negatives — "(1,234.50)" is -1234.50. Blank → 0.
 */
export function num(value: string | undefined): number {
  const raw = (value ?? "").trim();
  if (raw === "" || raw === "-") return 0;

  const negated = /^\(.*\)$/.test(raw);
  const cleaned = raw.replace(/[(),$\s]/g, "");
  const n = Number(cleaned);
  if (!Number.isFinite(n)) {
    throw new Error(`Expected a number, got "${value}"`);
  }
  return negated ? -n : n;
}

/** Like `num`, but a blank cell means "unknown" rather than zero. */
export function numOrNull(value: string | undefined): number | null {
  const raw = (value ?? "").trim();
  if (raw === "" || raw === "-") return null;
  return num(raw);
}

/** Round to cents. Guards the reducer's running totals against float drift. */
export function money(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * Parse a broker contract date to an ISO `YYYY-MM-DD` string.
 *
 * The export is DAY-FIRST — "21/05/26" is 21 May 2026, and "04/02/26" is
 * 4 February, not 2 April. Getting this backwards silently reorders the trade
 * ledger and therefore corrupts every weighted-average cost, so day-first is
 * asserted rather than inferred: a first component above 12 is proof, and any
 * ambiguous date is still read day-first because that is the file's format.
 *
 * Two-digit years pivot at 70 (26 → 2026, 98 → 1998).
 */
export function parseTradeDate(value: string): string {
  const raw = (value ?? "").trim();
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(raw);
  if (!m) throw new Error(`Unrecognised date: "${value}"`);

  const day = Number(m[1]);
  const month = Number(m[2]);
  let year = Number(m[3]);
  if (m[3].length === 2) year += year < 70 ? 2000 : 1900;

  if (month < 1 || month > 12) {
    throw new Error(`Date "${value}" is not day-first (month ${month} is invalid)`);
  }
  if (day < 1 || day > 31) throw new Error(`Invalid day in date "${value}"`);

  // Round-trip through UTC to reject impossible calendar dates (31 Feb etc.).
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(dt.getTime()) || dt.getUTCDate() !== day) {
    throw new Error(`Impossible date: "${value}"`);
  }
  return iso;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Collapse the broker's fixed-width padding into a single-spaced string. */
export function clean(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/** `undefined` for an empty cell, so it lands as SQL NULL rather than "". */
export function cleanOrNull(value: string | undefined): string | null {
  const s = clean(value);
  return s === "" ? null : s;
}

/**
 * Title-case a SHOUTING broker name for display: "SRI GURU NANAK PTY LTD" →
 * "Sri Guru Nanak Pty Ltd". Honorifics and company suffixes stay upper-case.
 */
const KEEP_UPPER = new Set([
  "PTY", "LTD", "SMSF", "ATF", "AFS", "NL", "AU", "USA", "UK", "&",
]);

export function titleCase(value: string): string {
  return clean(value)
    .split(" ")
    .map((word) => {
      const upper = word.toUpperCase();
      if (KEEP_UPPER.has(upper)) return upper;
      if (/^(MR|MRS|MS|DR|MISS)$/.test(upper)) return upper[0] + upper.slice(1).toLowerCase();
      return upper[0] + upper.slice(1).toLowerCase();
    })
    .join(" ");
}

/**
 * True for the broker's own internal accounts rather than a client's.
 *
 * Two of them reach the platform as ordinary accounts:
 *
 *   ERRORS - VITT - …            the suspense account
 *   PLACEMENT - VITTI CAPITAL …  the house account placements are transacted
 *                                through before being journalled out to clients
 *
 * Matched on the NAME, for the same reason `run-trades.ts` does: `ERRVITT` and
 * `PLACEVITT` are both non-numeric, so a rule based on the reference's shape
 * cannot tell either of them from the other — or from a real account.
 *
 * Names arrive here title-cased (`titleCase` runs before an account is created)
 * as often as SHOUTING from the raw file, hence the case-insensitive test.
 */
export function isNonClientAccount(name: string | null | undefined): boolean {
  return /^(ERRORS|PLACEMENT)\b/i.test(clean(name ?? ""));
}

/** Two-letter avatar initials from a display name. */
export function initialsOf(name: string): string {
  const words = clean(name)
    .replace(/\b(MR|MRS|MS|DR|MISS|PTY|LTD|THE)\b/gi, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}
