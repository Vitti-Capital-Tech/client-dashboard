import type { PlacementType } from "./deal-types.ts";

/**
 * Read what the deal-mail summary DOES say about the terms.
 *
 * ── Why this exists, given §8.28 says the feed carries no terms ───────────────
 * The API response carries no term FIELDS — `{ticker, company, deal_type,
 * subject, summary, received_at}` and nothing else. But the summary text itself
 * opens with a labelled header the upstream LLM writes for every deal:
 *
 *     Company: PM Capital Global Opportunities Fund (PGF:ASX)
 *     Deal Type: Placement
 *     Raise: $175M
 *     Price: $3.07/share (10.8% disc)
 *     Last Close: $3.44/share
 *     Bids Close: 12pm AEST 12 August 2026
 *     Settlement: 19 August 2026
 *
 *     - ASX-listed investment company providing exposure to …
 *
 * So the operator has been retyping figures that are on the screen in front of
 * them. This module reads that header so the promote form can seed itself.
 *
 * ── What this is NOT allowed to do ───────────────────────────────────────────
 * These are SUGGESTIONS, not terms. The text is LLM-generated from an email, so
 * a parse is a reading of a summary of a document — two removes from the offer
 * itself. Three rules follow, and each is load-bearing:
 *
 *  1. **Never guess.** A field that is not confidently found is left absent, not
 *     zero. A blank asks to be filled; a 0 looks answered.
 *  2. **The minimum bid is never read from here**, not even if some future
 *     summary mentions one — none of the real ones do. It is the figure a bid is
 *     accepted or rejected against, and the one field guaranteed to have been
 *     looked at by a person is the one that was always empty.
 *  3. **The form marks what came from here**, so the operator confirms a value
 *     rather than inherits it.
 *
 * Deliberately free of `server-only` and of React: it is a pure function over a
 * string, called from the client component and covered by tests against real
 * summaries.
 */

export type SummaryTerms = {
  /** Company name with the `(PGF:ASX)` tail removed. */
  name?: string;
  type?: PlacementType;
  price?: number;
  raiseMillions?: number;
  /** Attaching options, when the Price line carries a `+ …` clause. */
  opts?: string;
  /** `yyyy-mm-dd`, ready for a date input. */
  closeDate?: string;
  /** Also `yyyy-mm-dd`. The date the client portal counts a payment down to. */
  settleDate?: string;
};

/**
 * The header, as a label → value map.
 *
 * Stops at the first bullet, and that is not tidiness: bullets contain colons
 * ("Key risks include native title and land access: …"), so reading the whole
 * body as labelled lines would invent fields out of prose.
 */
function headerFields(summary: string): Map<string, string> {
  const fields = new Map<string, string>();

  for (const raw of summary.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^[-•*]/.test(line)) break;

    const at = line.indexOf(":");
    if (at < 1) continue;

    const label = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();
    // A label is a couple of words. Anything longer is a sentence that happens
    // to contain a colon, and the value would be nonsense.
    if (!value || label.split(/\s+/).length > 3) continue;
    if (!fields.has(label)) fields.set(label, value);
  }

  return fields;
}

/** First `$1.23` / `A$0.0045` style figure in a string. */
function money(text: string): number | undefined {
  const m = /(?:A\$|AU\$|US\$|\$)\s*([\d,]+(?:\.\d+)?)/.exec(text);
  if (!m) return undefined;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

/**
 * `12 August 2026` / `4 Aug 2026` → `2026-08-12`.
 *
 * Built from the matched parts rather than handed to `new Date()`: the line
 * reads `12pm AEST 12 August 2026`, and parsing a string with a timezone
 * abbreviation in it — then formatting it in the browser's zone — is how a
 * close date lands on the 11th for anyone west of the desk.
 */
function isoDate(text: string): string | undefined {
  const dayFirst = /\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/.exec(text);
  const monthFirst = /\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/.exec(text);

  let day: string, monthWord: string, year: string;
  if (dayFirst) [, day, monthWord, year] = dayFirst;
  else if (monthFirst) [, monthWord, day, year] = monthFirst;
  else return undefined;

  const month = MONTHS.indexOf(monthWord.slice(0, 3).toLowerCase()) + 1;
  if (month === 0) return undefined;

  const d = Number(day);
  const y = Number(year);
  if (d < 1 || d > 31 || y < 2000 || y > 2100) return undefined;

  return `${y}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * The raise, in millions.
 *
 * Takes the FIRST figure, which for a range (`$8.0M–$10.0M`) is the low end.
 * That is the conservative reading: `raise_millions` becomes the cap that
 * pro-rata scaling divides by, so the low end scales bids back further and
 * over-allocates nobody. `Up to $1M` and `A$0.5M (minimum)` both read correctly
 * as the only figure present.
 */
function raiseMillions(text: string): number | undefined {
  const scaled = /(?:A\$|AU\$|US\$|\$)?\s*([\d,]+(?:\.\d+)?)\s*(bn|[mb])\b/i.exec(text);
  if (scaled) {
    const n = Number(scaled[1].replace(/,/g, ""));
    if (!Number.isFinite(n)) return undefined;
    return /^b/i.test(scaled[2]) ? n * 1000 : n;
  }

  // No suffix — a raise written out in full, e.g. `$750,000`.
  const plain = money(text);
  return plain === undefined ? undefined : plain / 1_000_000;
}

/**
 * The feed's own `deal_type` and this one can disagree — a real GLL mail is
 * classified `IPO` upstream while its summary header says `Placement`, and the
 * summary is the one sitting next to the price and the close date. Neither is
 * authoritative, which is why the form defaults from this and stays editable.
 *
 * `IPO` has no equivalent in `placement_type`; `Pre-IPO` is the nearest, and
 * that mapping is a judgement rather than a translation. See `deal-types.ts`.
 */
function placementType(text: string): PlacementType | undefined {
  const t = text.toLowerCase();
  if (t.includes("spp") || t.includes("share purchase plan")) return "SPP";
  if (t.includes("rights")) return "Rights";
  if (t.includes("ipo")) return "Pre-IPO";
  if (t.includes("placement")) return "Placement";
  return undefined;
}

/** `PM Capital Global Opportunities Fund (PGF:ASX)` → the name without the tail. */
function companyName(text: string): string | undefined {
  const name = text.replace(/\s*\([^()]*ASX[^()]*\)\s*$/i, "").trim();
  return name || undefined;
}

export function parseSummaryTerms(summary: string): SummaryTerms {
  if (!summary?.trim()) return {};

  const fields = headerFields(summary);
  const pick = (...labels: string[]): string | undefined => {
    for (const l of labels) {
      const v = fields.get(l);
      if (v) return v;
    }
    return undefined;
  };

  const terms: SummaryTerms = {};

  const company = pick("company", "issuer");
  if (company) terms.name = companyName(company);

  const type = pick("deal type", "type", "offer type");
  if (type) terms.type = placementType(type);

  const raise = pick("raise", "raise size", "offer size", "amount");
  if (raise) {
    const m = raiseMillions(raise);
    // A raise of zero is not a raise; treat it as unreadable rather than as an
    // answer, since `0` in the form would look like someone had checked.
    if (m !== undefined && m > 0) terms.raiseMillions = m;
  }

  const priceLine = pick("price", "offer price", "issue price");
  if (priceLine) {
    // The figure attached to `/share`, not just the first dollar sign: the same
    // line can carry an option strike (`+ 1:2 free listed options (strike
    // A$0.07 …)`) and a discount, and the share price is the one being quoted.
    const perShare = /(?:A\$|AU\$|US\$|\$)\s*([\d,]+(?:\.\d+)?)\s*(?:\/|\s+per\s+)\s*share/i.exec(
      priceLine,
    );
    const price = perShare ? Number(perShare[1].replace(/,/g, "")) : money(priceLine);
    if (price !== undefined && price > 0) terms.price = price;

    // Attaching options come from the `+ …` clause only. They are also described
    // in the bullets ("one free attaching listed option, exercisable at …"), but
    // pulling terms out of prose is guessing, and this field is read back at
    // settlement to decide how many options to issue.
    const plus = priceLine.split(/\s+\+\s+/)[1]?.trim();
    if (plus) terms.opts = plus;
  }

  // Two dated lines, told apart by label rather than by pattern — settlement is
  // simply the later one, and a parser that matched on shape would swap them.
  const close = pick("bids close", "bid close", "offer close", "closes", "close");
  if (close) {
    const iso = isoDate(close);
    if (iso) terms.closeDate = iso;
  }

  const settle = pick("settlement", "settlement date", "settles", "allotment");
  if (settle) {
    const iso = isoDate(settle);
    if (iso) terms.settleDate = iso;
  }

  return terms;
}

/* ------------------------------------------------------------------ */
/* Attaching options, out of the summary's BULLETS                     */
/* ------------------------------------------------------------------ */

/**
 * The word that says which side of the ASX a grant sits on, when the summary
 * does not say — and it usually does not.
 *
 * Not a guess, and deliberately not omitted either. `parseAddOnSpec` reads a
 * cell with no `Unlisted` in it as LISTED and drops the grant, so a string that
 * simply left the word out would assert *listed* silently. This placeholder
 * lands on the same side — dropped, exactly as today's blank cell is — while
 * saying out loud that one word is still owed. Chosen so `UNLISTED_WORD`
 * (`/\bun\s*-?\s*l?isted/i`) cannot match it.
 */
export const ADD_ON_LISTING_UNKNOWN = "Listing?";

/** `five` → 5. Only as far as the real summaries actually go. */
const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function asNumber(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const word = WORD_NUMBERS[text.trim().toLowerCase()];
  if (word !== undefined) return word;
  const n = Number(text.replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * `2026-09-10` plus a 2.5-year term → `10/03/29`, the way the desk writes it.
 *
 * Measured against the desk's own cells rather than assumed: NGY's `2-year`
 * grant off a 3 Sep 2026 issue reads `03/09/28`, IPT's `2.5-year` off 10 Sep
 * 2026 reads `10/03/29`, and FBR's `five years` off 3 Sep 2026 reads `03/09/31`.
 * All three count from the ISSUE date, not from settlement — which is the one
 * part of this that could not have been reasoned out.
 *
 * The fractional part becomes whole months, and a day that does not exist in the
 * landing month (31 Jan + 1 month) is pulled back to that month's last day
 * rather than rolling into the next one.
 */
function expiryFromTerm(issueDate: string, years: number): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(issueDate.trim());
  if (!m) return undefined;

  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const wholeYears = Math.floor(years);
  const months = Math.round((years - wholeYears) * 12);

  const target = mo - 1 + months;
  const endYear = y + wholeYears + Math.floor(target / 12);
  const endMonth = ((target % 12) + 12) % 12;

  const lastDay = new Date(Date.UTC(endYear, endMonth + 1, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.min(d, lastDay))}/${pad(endMonth + 1)}/${String(endYear).slice(-2)}`;
}

/**
 * The attaching-options grant, composed from the summary's prose.
 *
 * ── Why this exists, when the module above says prose is guessing ─────────────
 * `parseSummaryTerms` takes attaching options from the `Price:` line's `+ …`
 * clause only, on the stated grounds that "pulling terms out of prose is
 * guessing". Right instinct, wrong place to stop: across the 30 summaries in the
 * table the options sit on the Price line **once** and in a bullet **four**
 * times. The common case was the unhandled one, so the desk retyped
 * `2:3 @ $ 0.06 Listed Exp 10/03/29` for every deal that had a grant — working
 * out the ratio, converting cents to dollars and adding the term to the issue
 * date by hand, on a tab the rest of which had filled itself in.
 *
 * ── What makes this a reading rather than a guess ────────────────────────────
 * Three fields are stated outright and only need transcribing — the ratio, the
 * strike and the term — and all three were checked against what the desk itself
 * wrote for IPT, NGY, W2V and FBR. They agree on all four.
 *
 * The listing status is the one field the summaries genuinely do not carry: the
 * desk chose Listed for W2V and NGY and Unlisted for FBR with nothing in any of
 * the three texts to separate them. So it is not inferred — see
 * `ADD_ON_LISTING_UNKNOWN` for what goes there instead and why that is the safe
 * direction rather than a cosmetic one.
 *
 * ── The guard matters more than the parsing ─────────────────────────────────
 * Nothing is emitted unless a ratio AND a strike AND a term are all found in ONE
 * bullet that is actually about an entitlement. A bullet that merely mentions
 * options is refused: BLZ's "CPS Capital holds 278,670,130 shares and
 * 106,341,638 options in BLZ — material conflict of interest to be considered"
 * matches every loose pattern and describes a broker's own holding. A partial
 * read is worth nothing here — the desk has to open the announcement either way
 * — while a wrong one mints option quantities against a client's P&L.
 */
export function attachingOptionsFromSummary(
  summary: string,
  issueDate: string | null | undefined,
): string | undefined {
  if (!issueDate) return undefined;

  for (const line of (summary ?? "").split("\n")) {
    const raw = line.trim();
    if (!raw || !/option/i.test(raw)) continue;

    // The bullet has to describe an ENTITLEMENT. "attaching" is how every real
    // one says so; the `for every N shares` / `each share` forms are accepted
    // alongside it in case a later summary drops the word.
    const isGrant =
      /attach/i.test(raw) ||
      /\bfor\s+every\b/i.test(raw) ||
      /\beach\b[^.]*\bshare\b/i.test(raw);
    if (!isGrant) continue;

    // ── Ratio ──────────────────────────────────────────────────────────────
    // `2 … options for every 3 … shares`, `1-for-2 … basis`, and the `each
    // placement share includes one option` form, which is 1:1 without ever
    // writing either number.
    const NUM = String.raw`\d+|one|two|three|four|five`;
    let ratio: string | undefined;

    const forEvery = new RegExp(
      String.raw`(${NUM})\s+(?:free[\s-]*)?(?:attaching\s+)?options?\s+for\s+every\s+(${NUM})\b`,
      "i",
    ).exec(raw);
    const dashed = /(\d+)\s*-?\s*(?:for|:)\s*-?\s*(\d+)\s*(?:basis|free|attaching|option)/i.exec(raw);
    const eachShare = new RegExp(
      String.raw`\beach\s+(?:placement\s+|new\s+)?share\b[^.]*?\b(${NUM})\s+(?:free[\s-]*)?(?:attaching[\s-]*)?options?`,
      "i",
    ).exec(raw);

    if (forEvery) {
      const [a, b] = [asNumber(forEvery[1]), asNumber(forEvery[2])];
      if (a && b) ratio = `${a}:${b}`;
    } else if (dashed) {
      const [a, b] = [asNumber(dashed[1]), asNumber(dashed[2])];
      if (a && b) ratio = `${a}:${b}`;
    } else if (eachShare) {
      const a = asNumber(eachShare[1]);
      if (a) ratio = `${a}:1`;
    }
    if (!ratio) continue;

    // ── Strike ─────────────────────────────────────────────────────────────
    // `exercise price A$0.06`, `strike price $0.075`, `exercisable at 4c`.
    // Cents are written without a dollar sign and have to be divided down: `4c`
    // filed as `$4.00` would value a grant at a hundred times its strike.
    const STRIKE_LEAD = String.raw`(?:exercise|strike|exercisable\s+at|exercis\w*\s+at)[^.]{0,30}?`;
    let strike: number | undefined;

    const dollars = new RegExp(
      STRIKE_LEAD + String.raw`(?:A\$|AU\$|US\$|\$)\s*([\d,]+(?:\.\d+)?)`,
      "i",
    ).exec(raw);
    const cents = new RegExp(STRIKE_LEAD + String.raw`([\d,]+(?:\.\d+)?)\s*c\b`, "i").exec(raw);

    if (dollars) strike = Number(dollars[1].replace(/,/g, ""));
    else if (cents) strike = Number(cents[1].replace(/,/g, "")) / 100;
    if (strike === undefined || !Number.isFinite(strike) || strike <= 0) continue;

    // ── Term → expiry ──────────────────────────────────────────────────────
    const term = /(\d+(?:\.\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)\s*-?\s*year/i.exec(raw);
    const years = asNumber(term?.[1]);
    if (!years) continue;
    const expiry = expiryFromTerm(issueDate, years);
    if (!expiry) continue;

    // ── Listing status, only when the bullet states it ─────────────────────
    const listing = /\bun\s*-?\s*l?isted/i.test(raw)
      ? "Unlisted"
      : /\b(?:to\s+be\s+)?listed\b/i.test(raw)
        ? "Listed"
        : ADD_ON_LISTING_UNKNOWN;

    // Spaced exactly as the desk's own cells are — `1:2 @ $ 0.075 Listed Exp
    // 08/09/28` — because `parseAddOnSpec` reads these back, and the shape it
    // has always been handed is the shape it is tested against.
    return `${ratio} @ $ ${strike} ${listing} Exp ${expiry}`;
  }

  return undefined;
}
