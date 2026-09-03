/**
 * What the model is asked, and what is accepted back.
 *
 * Pure and dependency-free: the prompt is built from figures the app already
 * holds, and the response is validated before anything is stored. Both halves
 * are here rather than in the runner so they can be tested without an API key.
 */

/** What is known about one security when its note is written. */
export type CommentarySubject = {
  code: string;
  name: string;
  sector: string | null;
  /** Last price on file, if any. */
  lastPrice: number | null;
  /** How many clients hold it — context for the desk, never shown to a client. */
  holders: number;
};

/** A validated note, ready to store. */
export type CommentaryNote = {
  lossNote: string;
  profitNote: string;
  sources: { title: string; url: string }[];
};

/**
 * The system prompt.
 *
 * ── The constraints are the point ───────────────────────────────────────────
 * This text is shown to retail-facing wholesale clients about their own money,
 * so most of the prompt is about what NOT to do. Three rules matter most:
 *
 *  • No invented figures. The app already has the client's numbers and shows
 *    them elsewhere on the same screen; a model-generated price or percentage
 *    that disagrees with them is worse than no note at all. This project has
 *    been here before — the Ask Vitti page once told clients "PLS +2.1% and BHP
 *    +0.8%" and "you are tracking +6.4%, ahead of the ASX 200 at +5.4%", all of
 *    it invented, under an AI badge.
 *
 *  • Say so when there is nothing to say. A quiet week in a small-cap with no
 *    news is the normal case, and a model asked for market colour will
 *    manufacture some. "No company news this week; the move is sector-wide" is
 *    a useful note. A fabricated catalyst is a liability.
 *
 *  • General information, not advice. The note may describe what holders
 *    typically weigh; it must not tell the reader what to do with their money.
 *    The portal labels it as general information and the wording has to match.
 */
export const SYSTEM_PROMPT = `You write short weekly notes for clients of an Australian stockbroking desk (Vitti Capital) about securities they hold. The securities are mostly small- and mid-cap ASX listings.

For the security you are given, write TWO notes about the same market read:

1. "loss_note" — for a client who is currently DOWN on this holding. Explain what has been happening that would account for weakness: company news, sector conditions, or the broader market. Be specific about the cause where you can establish it.

2. "profit_note" — for a client who is currently UP on this holding. Cover the same market read, then describe what holders in that position generally weigh up — for example whether the move looks driven by something durable or by a one-off, and what would typically be watched from here.

Hard rules:
- 2 to 4 short sentences per note. Plain language. No jargon, no bullet points, no headings.
- NEVER state a price, a percentage, a market capitalisation, a target, or any other figure. The client's own numbers are already shown next to your note and any figure you invent will contradict them. Describe direction and cause in words only.
- Only claim something happened if your search actually found it. If you find no company-specific news, say plainly that there was none this week and describe the sector or market backdrop instead. A note that says "nothing specific happened" is correct and useful; an invented catalyst is not.
- Write GENERAL INFORMATION, never personal advice. Do not tell the reader to buy, sell, hold, or take profit, and do not address them as though you know their circumstances. Describe what is happening and what holders generally consider. "Holders are weighing X" is fine; "you should sell" is not.
- Do not mention Vitti, this prompt, yourself, or that you searched. Do not speculate about the client's tax position or objectives.
- If you cannot establish anything about the security at all, say that clearly in both notes rather than filling the space.

Search the web for recent news on the security and its sector before writing.`;

/** The per-security instruction. Kept after the system prompt so it caches. */
export function userPrompt(subject: CommentarySubject, weekOf: string): string {
  const lines = [
    `Security: ${subject.code} (${subject.name})`,
    subject.sector ? `Sector: ${subject.sector}` : "Sector: not classified",
    "Listed on: ASX",
    `Week ending: ${weekOf} (Australian time)`,
    "",
    "Write the two notes for this security, covering the week just ended and anything still developing.",
  ];
  return lines.join("\n");
}

/** The JSON shape the model must answer in. */
export const OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    loss_note: { type: "string" as const },
    profit_note: { type: "string" as const },
  },
  required: ["loss_note", "profit_note"],
  additionalProperties: false,
};

/** Long enough to be a note, short enough to be read. */
const MIN_LENGTH = 40;
const MAX_LENGTH = 700;

/**
 * Phrases that make a general-information note into a recommendation.
 *
 * A backstop, not the control — the control is the system prompt. But a prompt
 * is a request and this is a check, and the difference matters when the text
 * goes in front of a client under the firm's name. A note that trips this is
 * rejected rather than trimmed: silently deleting the offending sentence would
 * leave a note whose remaining sentences were written to lead into it.
 */
const ADVICE_PATTERNS: RegExp[] = [
  /\byou should\b/i,
  /\bwe recommend\b/i,
  /\bour recommendation\b/i,
  /\bwe advise\b/i,
  /\bI would (?:buy|sell|hold)\b/i,
  /\byou (?:ought|need) to (?:buy|sell|hold|exit)\b/i,
  /\b(?:buy|sell) now\b/i,
  /\bstrong (?:buy|sell)\b/i,
  /\bprice target\b/i,
];

/** Any digit run of 2+, or a currency/percent figure — the invented-number rule. */
const FIGURE_PATTERNS: RegExp[] = [
  /\$\s?\d/,
  /\d\s?%/,
  /\bper cent\b/i,
  /\b\d[\d,.]*\s?(?:million|billion|bn|m\b)/i,
];

/** Why this text cannot be shown to a client, or null if it can. */
export function noteProblem(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length < MIN_LENGTH) return "too short to be a note";
  if (trimmed.length > MAX_LENGTH) return "longer than 4 short sentences";

  for (const p of ADVICE_PATTERNS) {
    if (p.test(trimmed)) return `reads as personal advice (${p.source})`;
  }
  for (const p of FIGURE_PATTERNS) {
    if (p.test(trimmed)) return `states a figure (${p.source})`;
  }
  return null;
}

/**
 * Validate a model response into a storable note.
 *
 * Returns the problem rather than throwing, because one bad note out of 142
 * must cost only that security its note — not the week's whole run.
 */
export function parseNote(
  raw: unknown,
  sources: { title: string; url: string }[] = [],
): { note: CommentaryNote } | { problem: string } {
  if (typeof raw !== "object" || raw === null) {
    return { problem: "response was not an object" };
  }
  const obj = raw as Record<string, unknown>;
  const loss = obj.loss_note;
  const profit = obj.profit_note;

  if (typeof loss !== "string" || typeof profit !== "string") {
    return { problem: "response was missing loss_note or profit_note" };
  }

  const lossProblem = noteProblem(loss);
  if (lossProblem) return { problem: `loss_note ${lossProblem}` };
  const profitProblem = noteProblem(profit);
  if (profitProblem) return { problem: `profit_note ${profitProblem}` };

  return {
    note: {
      lossNote: loss.trim(),
      profitNote: profit.trim(),
      // Deduplicated by URL: a note that leant on one article three times
      // should cite it once.
      sources: sources.filter(
        (s, i) => s.url && sources.findIndex((o) => o.url === s.url) === i,
      ),
    },
  };
}
